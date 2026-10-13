import assert from "node:assert/strict"
import test from "node:test"

import * as Transfers from "../../../src/web/transfers.ts"

function deferred<T = void>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve
        reject = innerReject
    })
    return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test.beforeEach(() => {
    Transfers.__resetTransfersForTests()
})

test("queued transfers run one at a time in order", async () => {
    const started: string[] = []
    const gates = [deferred(), deferred(), deferred()]
    const runs = ["a", "b", "c"].map((name, index) =>
        Transfers.enqueue({ direction: "upload", name, size: 10 }, async () => {
            started.push(name)
            await gates[index].promise
            return name
        }),
    )
    await tick()
    assert.deepEqual(started, ["a"])
    assert.deepEqual(Transfers.getTransfers().map((t) => t.status), ["active", "queued", "queued"])

    gates[0].resolve()
    assert.equal(await runs[0], "a")
    await tick()
    assert.deepEqual(started, ["a", "b"])

    gates[1].resolve()
    gates[2].resolve()
    assert.deepEqual(await Promise.all(runs), ["a", "b", "c"])
    assert.deepEqual(Transfers.getTransfers().map((t) => t.status), ["done", "done", "done"])
    assert.equal(Transfers.hasPendingTransfers(), false)
})

test("cancelling a queued transfer removes it without running the job", async () => {
    const gate = deferred()
    let secondRan = false
    const first = Transfers.enqueue({ direction: "download", name: "first" }, async () => gate.promise)
    const second = Transfers.enqueue({ direction: "download", name: "second" }, async () => {
        secondRan = true
    })
    await tick()
    const queued = Transfers.getTransfers().find((t) => t.name === "second")!
    assert.equal(queued.status, "queued")
    assert.equal(Transfers.cancel(queued.id), true)
    assert.deepEqual(Transfers.getTransfers().map((t) => t.name), ["first"])
    gate.resolve()
    await first
    assert.equal(await second, undefined)
    assert.equal(secondRan, false)
})

test("cancelling the active transfer aborts its signal and marks it cancelled", async () => {
    const reachedCheckpoint = deferred()
    const resume = deferred()
    let nextRan = false
    const active = Transfers.enqueue({ direction: "upload", name: "big" }, async (transfer) => {
        reachedCheckpoint.resolve()
        await resume.promise
        transfer.throwIfCancelled()
        throw new Error("should not get here")
    })
    const next = Transfers.enqueue({ direction: "upload", name: "next" }, async () => {
        nextRan = true
    })
    await reachedCheckpoint.promise
    const snapshot = Transfers.getTransfers()[0]
    assert.equal(Transfers.cancel(snapshot.id), true)
    assert.equal(Transfers.getTransfer(snapshot.id)?.cancelRequested, true)
    assert.equal(Transfers.getTransfer(snapshot.id)?.status, "active")
    resume.resolve()
    assert.equal(await active, undefined)
    await next
    assert.equal(Transfers.getTransfer(snapshot.id)?.status, "cancelled")
    assert.equal(nextRan, true)
})

test("non-cancellable transfers refuse cancellation", async () => {
    const task = Transfers.begin({ direction: "task", name: "migration", cancellable: false })
    assert.equal(task.snapshot().queued, false)
    assert.equal(task.snapshot().status, "active")
    assert.equal(Transfers.cancel(task.id), false)
    assert.equal(task.signal.aborted, false)
    task.complete({ message: "ok" })
    assert.equal(task.snapshot().status, "done")
    assert.equal(task.snapshot().message, "ok")
})

test("tasks do not block the queue lane", async () => {
    const task = Transfers.begin({ direction: "task", name: "migration" })
    let ran = false
    await Transfers.enqueue({ direction: "upload", name: "file" }, async () => {
        ran = true
    })
    assert.equal(ran, true)
    task.complete()
})

test("failures are recorded with their message and rethrown", async () => {
    await assert.rejects(
        Transfers.enqueue({ direction: "upload", name: "dup" }, async (transfer) => {
            transfer.update({ ufid: "abc" })
            throw new Error("duplicate UFID")
        }),
        /duplicate UFID/,
    )
    const [failed] = Transfers.getTransfers()
    assert.equal(failed.status, "failed")
    assert.equal(failed.message, "duplicate UFID")
    assert.equal(failed.ufid, "abc")
})

test("phases map into the overall fraction and summarize weights by size", async () => {
    const gate = deferred()
    const run = Transfers.enqueue({ direction: "upload", name: "one", size: 100 }, async (transfer) => {
        transfer.setPhase("Preparing", { span: [0, 0.1], total: 100 })
        transfer.update({ bytes: 50 })
        assert.equal(transfer.snapshot().fraction, 0.05)
        transfer.setPhase(null, { span: [0.1, 1], total: 100 })
        transfer.update({ bytes: 50 })
        assert.equal(transfer.snapshot().fraction, 0.55)
        await gate.promise
    })
    Transfers.enqueue({ direction: "upload", name: "two", size: 300 }, async () => {})
    await tick()
    const summary = Transfers.summarize()
    assert.equal(summary.batchTotal, 2)
    assert.equal(summary.batchPosition, 1)
    assert.equal(summary.queuedCount, 1)
    assert.equal(summary.fraction, (0.55 * 100) / 400)
    assert.deepEqual(summary.directions, ["upload"])
    gate.resolve()
    await run
})

test("a new batch starts when the lane is idle", async () => {
    await Transfers.enqueue({ direction: "upload", name: "old" }, async () => {})
    const gate = deferred()
    const run = Transfers.enqueue({ direction: "upload", name: "new" }, async () => gate.promise)
    await tick()
    const summary = Transfers.summarize()
    assert.equal(summary.batchTotal, 1)
    assert.equal(summary.batchPosition, 1)
    gate.resolve()
    await run
})

test("subscribers see the lifecycle and busy transitions", async () => {
    const events: string[] = []
    Transfers.subscribe((event) => {
        if (event.type === "busy") events.push(`busy:${event.busy}`)
        else if (event.type !== "progress") events.push(`${event.type}:${event.transfer.name}:${event.transfer.status}`)
    })
    await Transfers.enqueue({ direction: "download", name: "f" }, async (transfer) => {
        transfer.update({ bytes: 1 })
    })
    Transfers.clearFinished()
    assert.deepEqual(events, [
        "added:f:queued",
        "busy:true",
        "started:f:active",
        "finished:f:done",
        "busy:false",
        "removed:f:done",
    ])
    assert.deepEqual(Transfers.getTransfers(), [])
})

test("ETA is derived from phase throughput once enough time has elapsed", () => {
    let clock = 1_000
    Transfers.__resetTransfersForTests(() => clock)
    const transfer = Transfers.begin({ direction: "download", name: "eta", size: 1000 })
    transfer.setPhase(null, { total: 1000 })
    clock += 500
    transfer.update({ bytes: 100 })
    assert.equal(transfer.snapshot().etaSeconds, null)
    clock += 1500
    transfer.update({ bytes: 400 })
    // 400 bytes in 2 s => 200 B/s, 600 bytes left => 3 s.
    assert.equal(transfer.snapshot().etaSeconds, 3)
    transfer.complete()
})
