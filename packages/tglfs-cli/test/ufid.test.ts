import assert from "node:assert/strict"
import test from "node:test"

import { computeUfidFromBytes } from "../src/ufid.js"

test("UFID matches the existing web stream algorithm", async () => {
    const bytes = new TextEncoder().encode("TGLFS UFID parity test payload.")
    ;(globalThis as typeof globalThis & { window?: typeof globalThis }).window = globalThis

    const webFileProcessing = await import("../../../src/web/fileProcessing.ts")
    const expected = await webFileProcessing.UFIDFromStream(new Blob([bytes]).stream())
    const actual = await computeUfidFromBytes(bytes)

    assert.equal(actual, expected)
})

test("empty payload UFID matches the existing web behavior", async () => {
    const bytes = new Uint8Array(0)
    ;(globalThis as typeof globalThis & { window?: typeof globalThis }).window = globalThis

    const webFileProcessing = await import("../../../src/web/fileProcessing.ts")
    const expected = await webFileProcessing.UFIDFromStream(new Blob([bytes]).stream())
    const actual = await computeUfidFromBytes(bytes)

    assert.equal(actual, expected)
})
