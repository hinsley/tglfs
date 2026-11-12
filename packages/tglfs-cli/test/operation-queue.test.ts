import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { acquireCliSessionLock, accountQueueKey, createAccountQueueStore, formatQueueProgress } from "../src/operation-queue.js"

test("account queue keys do not expose account identifiers", () => {
    assert.equal(accountQueueKey(" +15550001111 "), accountQueueKey("+15550001111"))
    assert.match(accountQueueKey("+15550001111"), /^[a-f0-9]{32}$/)
    assert.notEqual(accountQueueKey("a"), accountQueueKey("b"))
})

test("shared account lock serializes concurrent CLI requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tglfs-queue-"))
    try {
        const a = createAccountQueueStore(dir, "one")
        const b = createAccountQueueStore(dir, "one")
        let running = 0
        let peak = 0
        await Promise.all([a, b].map(store => store.exclusive(async () => {
            running++
            peak = Math.max(peak, running)
            await new Promise(resolve => setTimeout(resolve, 30))
            running--
        })))
        assert.equal(peak, 1)
        assert.equal(running, 0)
    } finally { await rm(dir, { recursive: true, force: true }) }
})

test("cooldown is shared across instances and round trips without request data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tglfs-queue-"))
    try {
        const a = createAccountQueueStore(dir, "one")
        const b = createAccountQueueStore(dir, "one")
        assert.equal(await a.loadState(), null)
        const state = { type: "test", version: 1, waitUntil: 10000, adaptiveIntervalMs: 1000 }
        await a.exclusive(() => a.saveState(state))
        assert.deepEqual(await b.loadState(), state)
        assert.equal(JSON.parse(await readFile(a.statePath, "utf8")).version, 1)
        await writeFile(a.statePath, '{"type":"tglfs:operation-cooldown","version":99,"state":{}}')
        await assert.rejects(a.loadState(), /Unsupported/)
    } finally { await rm(dir, { recursive: true, force: true }) }
})

test("lock is released after operation rejection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tglfs-queue-"))
    try {
        const store = createAccountQueueStore(dir, "one")
        await assert.rejects(store.exclusive(async () => { throw new Error("expected") }), /expected/)
        assert.equal(await store.exclusive(async () => 42), 42)
    } finally { await rm(dir, { recursive: true, force: true }) }
})

test("minimal progress shows wait countdown and no speculative ETA", () => {
    assert.equal(formatQueueProgress({pending:3,running:false,paused:false,waitUntil:6000,completed:2,failed:0},1000),"Waiting 5s · 2 done · 3 pending")
    assert.match(formatQueueProgress({pending:3,running:false,paused:true,waitUntil:0,completed:2,failed:1},1000), /^Paused/)
})


test("a second account session waits until the first is released", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tglfs-session-"))
    try {
        const releaseFirst = await acquireCliSessionLock("one", dir)
        let secondEntered = false
        const second = acquireCliSessionLock("one", dir).then(release => { secondEntered = true; return release })
        await new Promise(resolve => setTimeout(resolve, 40))
        assert.equal(secondEntered, false)
        await releaseFirst()
        const releaseSecond = await second
        assert.equal(secondEntered, true)
        await releaseSecond()
    } finally { await rm(dir, { recursive: true, force: true }) }
})

test("stale lock fails closed without removing prior operation evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tglfs-stale-"))
    try {
        const store = createAccountQueueStore(dir, "one")
        await mkdir(store.lockPath, {recursive:true})
        await writeFile(join(store.lockPath, "owner.json"), JSON.stringify({pid:2147483647,token:"prior"}))
        await assert.rejects(store.exclusive(async () => assert.fail("must not execute")), /Interrupted operation lock/)
        assert.equal(JSON.parse(await readFile(join(store.lockPath,"owner.json"),"utf8")).token,"prior")
    } finally { await rm(dir, { recursive: true, force: true }) }
})
