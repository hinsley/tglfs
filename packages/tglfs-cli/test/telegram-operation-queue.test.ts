import assert from "node:assert/strict"
import test from "node:test"
import { TelegramOperationQueue, installTelegramOperationQueue, telegramMutationLabel, type PersistedState } from "../src/shared/telegram-operation-queue.js"
const tick = () => new Promise(r => setTimeout(r, 0))
function fake() {
    let time = 0
    return { now: () => time, sleep: async (ms: number) => {time += ms}, get time() {return time} }
}
test("serializes and accepts staging while active", async () => {
    const f = fake(); const q = new TelegramOperationQueue({...f, now: f.now, intervalMs: 10})
    let release!: () => void; const gate = new Promise<void>(r => release = r); const starts: string[] = []
    const a = q.enqueue(async () => {starts.push("a"); await gate})
    await tick(); const b = q.enqueue(async () => {starts.push("b")})
    assert.equal(q.snapshot().pending,1); assert.deepEqual(starts,["a"])
    release(); await Promise.all([a,b]); assert.deepEqual(starts,["a","b"]); assert.ok(f.time>=10)
})
test("persisted server cooldown applies after restart and across lock refresh", async () => {
    const f=fake(); let saved: PersistedState|null=null; const options={now:f.now,sleep:f.sleep,intervalMs:10,floodPaddingMs:10,saveState:async(s:PersistedState)=>{saved=s},loadState:async()=>saved}
    const q=new TelegramOperationQueue(options); let calls=0
    await q.enqueue(async()=>{if(++calls===1)throw {errorMessage:"FLOOD_WAIT_2",seconds:2}})
    assert.equal(calls,2); assert.ok(f.time>=2010); assert.equal(saved!.adaptiveIntervalMs,20)
    saved!.waitUntil=f.time+3000
    const q2=new TelegramOperationQueue(options); const before=f.time
    await q2.enqueue(async()=>null); assert.ok(f.time>=before+3000)
})
test("uncertain mutation is never replayed and queued work fails closed", async()=>{
    const f=fake();const q=new TelegramOperationQueue({now:f.now,sleep:f.sleep});let calls=0
    const a=q.enqueue(async()=>{calls++;throw new Error("network disconnected")});const b=q.enqueue(async()=>{calls++})
    const result=await Promise.allSettled([a,b]); assert.ok(result.every(r=>r.status==="rejected"));assert.equal(calls,1);assert.equal(q.snapshot().paused,true)
    await assert.rejects(q.enqueue(async()=>{}),/Queue stopped/)
})
test("pause supports staging and pending cancellation without cancelling running RPC",async()=>{
    const q=new TelegramOperationQueue({intervalMs:0});q.pause();let calls=0
    const a=q.enqueue(async()=>{calls++});q.cancelPending();await assert.rejects(a,/cancelled/);assert.equal(calls,0)
    const b=q.enqueue(async()=>{calls++});q.resume();await b;assert.equal(calls,1)
})
test("slow mode and premium waits preserve server minimum",async()=>{
    for(const errorMessage of ["SLOWMODE_WAIT_3","FLOOD_PREMIUM_WAIT_3"]){const f=fake();const q=new TelegramOperationQueue({now:f.now,sleep:f.sleep});let n=0;await q.enqueue(async()=>{if(!n++)throw {errorMessage}});assert.ok(f.time>=4000)}
})
test("limited flood retries stop, unknown state fails before mutation",async()=>{
    const f=fake();const q=new TelegramOperationQueue({now:f.now,sleep:f.sleep,maxFloodRetries:1});let n=0
    await assert.rejects(q.enqueue(async()=>{n++;throw {errorMessage:"FLOOD_WAIT_1"}}),/retry limit/);assert.equal(n,2)
    const bad=new TelegramOperationQueue({loadState:async()=>({type:"tglfs:operation-pacing",version:2}) as any});await assert.rejects(bad.enqueue(async()=>{throw new Error("should not run")}),/Unsupported/)
})
test("wrapper covers metadata and direct media parts but leaves reads alone",async()=>{
    let parts=0;const sender={send:async(_:any)=>{parts++}};const calls:string[]=[]
    const client={invoke:async(req:any)=>{calls.push(req.className)},getSender:async()=>sender,floodSleepThreshold:60}
    const f=fake();const q=installTelegramOperationQueue(client,{now:f.now,sleep:f.sleep,intervalMs:10})
    await client.invoke({className:"messages.GetHistory"}); assert.equal(q.snapshot().completed,0)
    await client.invoke({className:"messages.EditMessage"});await(await client.getSender()).send({className:"upload.SaveBigFilePart"})
    assert.equal(q.snapshot().completed,2);assert.equal(parts,1);assert.equal(client.floodSleepThreshold,0)
    assert.equal(telegramMutationLabel({className:"messages.DeleteMessages"}),"Deleting")
})

test("generic duration and wait-like errors never authorize mutation replay", async () => {
    for (const error of [
        {seconds: 2, message: "connection lost"},
        new Error("a wait of 2 seconds is required"),
        {cause: {seconds: 2}, errorMessage: "RPC_CALL_FAIL"},
        {errorMessage: "FLOOD_WAIT", seconds: Infinity},
    ]) {
        const f = fake(); const q = new TelegramOperationQueue({now: f.now, sleep: f.sleep}); let calls = 0
        await assert.rejects(q.enqueue(async () => { calls++; throw error }))
        assert.equal(calls, 1); assert.equal(q.snapshot().paused, true)
    }
})
test("explicit GramJS wait class with numeric seconds is retried", async () => {
    const f = fake(); const q = new TelegramOperationQueue({now: f.now, sleep: f.sleep}); let calls = 0
    await q.enqueue(async () => { if (++calls === 1) throw {name: "FloodWaitError", errorMessage: "FLOOD", seconds: 2} })
    assert.equal(calls, 2); assert.ok(f.time >= 3000)
})
