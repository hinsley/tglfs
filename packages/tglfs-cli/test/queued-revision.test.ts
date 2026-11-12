import assert from "node:assert/strict"
import test from "node:test"
import { assertQueuedRevision } from "../../../src/web/queuedRevision.ts"

test("a staged second rename cannot overwrite the first rename", () => {
    const original = { ufid: "test", name: "before", parentFolderId: "a" }
    const staged = JSON.stringify(original)
    assert.doesNotThrow(() => assertQueuedRevision(staged, original))
    assert.throws(() => assertQueuedRevision(staged, { ...original, name: "after" }), /changed since/)
})
test("staged move/delete rejects changed parent or missing item", () => {
    const original = { ufid: "test", name: "before", parentFolderId: "a" }
    assert.throws(() => assertQueuedRevision(JSON.stringify(original), { ...original, parentFolderId: "b" }), /changed since/)
    assert.throws(() => assertQueuedRevision(JSON.stringify(original), null), /changed since/)
})
