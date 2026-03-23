import assert from "node:assert/strict"
import test from "node:test"

import { decodeIv, incrementCounter64By } from "../src/crypto.js"

test("counter advancement matches the existing web helper", async () => {
    const counter = Uint8Array.from({ length: 16 }, (_, index) => index)
    const webEncryption = await import("../../../src/web/encryption.ts")

    const actual = incrementCounter64By(counter, 65539)
    const expected = webEncryption.incrementCounter64By(counter, 65539)

    assert.deepEqual(Array.from(actual), Array.from(expected))
})

test("IV decoding splits salt and counter into 16-byte values", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index)
    const { salt, counter } = decodeIv(Buffer.from(bytes).toString("base64"))

    assert.equal(salt.length, 16)
    assert.equal(counter.length, 16)
    assert.deepEqual(Array.from(salt), Array.from(bytes.subarray(0, 16)))
    assert.deepEqual(Array.from(counter), Array.from(bytes.subarray(16)))
})
