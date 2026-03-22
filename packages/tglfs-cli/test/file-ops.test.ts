import assert from "node:assert/strict"
import test from "node:test"

import { detectFileMode } from "../src/file-ops.js"

test("detectFileMode falls back to the legacy probe when the current probe throws", async () => {
    const calls: string[] = []
    const result = await detectFileMode({ size: 8, ufid: "ufid-123" }, async (mode) => {
        calls.push(mode)
        if (mode === "current") {
            throw new Error("current failed")
        }
        return {
            bytesWritten: 8,
            computedUfid: "ufid-123",
        }
    })

    assert.deepEqual(calls, ["current", "legacy"])
    assert.equal(result.probe?.mode, "legacy")
    assert.equal(result.probe?.computedUfid, "ufid-123")
})

test("detectFileMode returns the current probe immediately when it matches", async () => {
    const calls: string[] = []
    const result = await detectFileMode({ size: 4, ufid: "ufid-456" }, async (mode) => {
        calls.push(mode)
        return {
            bytesWritten: 4,
            computedUfid: "ufid-456",
        }
    })

    assert.deepEqual(calls, ["current"])
    assert.equal(result.probe?.mode, "current")
})
