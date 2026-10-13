import assert from "node:assert/strict"
import { test } from "node:test"

import { classifyUndoCandidate, createMutationQueue } from "../../../src/web/undoSupport.ts"

const ROOT = "tglfs-root"

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

test("mutation queue runs tasks one at a time in submission order", async () => {
    const queue = createMutationQueue()
    const log: string[] = []
    const gate = deferred()

    const first = queue.run(async () => {
        log.push("first:start")
        await gate.promise
        log.push("first:end")
        return 1
    })
    const second = queue.run(async () => {
        log.push("second:start")
        log.push("second:end")
        return 2
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(log, ["first:start"])
    assert.equal(queue.inFlight(), 1)

    gate.resolve()
    assert.equal(await first, 1)
    assert.equal(await second, 2)
    assert.deepEqual(log, ["first:start", "first:end", "second:start", "second:end"])
    assert.equal(queue.inFlight(), 0)
})

test("mutation queue keeps going after a failed task and reports the failure to its caller", async () => {
    const queue = createMutationQueue()
    const failing = queue.run(async () => {
        throw new Error("boom")
    })
    const next = queue.run(async () => "ok")
    await assert.rejects(failing, /boom/)
    assert.equal(await next, "ok")
    assert.equal(queue.inFlight(), 0)
})

test("undo reverts an item that is exactly as the operation left it", () => {
    assert.equal(
        classifyUndoCandidate(
            { parentId: "folder-projects", name: "plan.md" },
            { expectedParentId: "folder-projects", expectedName: "plan.md", originParentId: ROOT },
        ),
        "revert",
    )
})

test("undo leaves an item that never moved alone without reporting a change", () => {
    assert.equal(
        classifyUndoCandidate(
            { parentId: ROOT, name: "plan.md" },
            { expectedParentId: "folder-projects", expectedName: "plan.md", originParentId: ROOT },
        ),
        "unchanged",
    )
})

test("undo never overwrites a newer move, rename or delete", () => {
    const expectation = { expectedParentId: "folder-projects", expectedName: "plan.md", originParentId: ROOT }
    assert.equal(classifyUndoCandidate({ parentId: "folder-archive", name: "plan.md" }, expectation), "changed")
    assert.equal(classifyUndoCandidate({ parentId: "folder-projects", name: "plan-v2.md" }, expectation), "changed")
    assert.equal(classifyUndoCandidate({ parentId: ROOT, name: "plan-v2.md" }, expectation), "changed")
    assert.equal(classifyUndoCandidate({ parentId: null, name: null }, expectation), "changed")
})
