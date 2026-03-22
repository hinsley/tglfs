import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { deriveAESKeyFromPassword, ENCRYPTION_CHUNK_SIZE, incrementCounter64By } from "../src/crypto.js"
import { CliError } from "../src/errors.js"
import { coerceTelegramDocumentSize, resolveChunkDocumentSize, restoreFileFromEncryptedParts } from "../src/download.js"
import type { FileCardData } from "../src/types.js"
import { computeUfidFromBytes } from "../src/ufid.js"

async function readAll(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []

    while (true) {
        const { done, value } = await reader.read()
        if (done) {
            break
        }
        if (value) {
            chunks.push(value)
        }
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
    }
    return combined
}

async function gzip(bytes: Uint8Array) {
    const compressionStream = new CompressionStream("gzip")
    const writer = compressionStream.writable.getWriter()
    await writer.write(bytes)
    await writer.close()
    return readAll(compressionStream.readable)
}

async function createFixture(plaintext: Uint8Array, password: string) {
    const compressed = await gzip(plaintext)
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
    const counter = Uint8Array.from({ length: 16 }, (_, index) => index + 33)
    const key = await deriveAESKeyFromPassword(password, salt)

    let encryptionCounter = new Uint8Array(counter)
    const encryptedChunks: Uint8Array[] = []
    for (let offset = 0; offset < compressed.length; offset += ENCRYPTION_CHUNK_SIZE) {
        const piece = compressed.subarray(offset, offset + ENCRYPTION_CHUNK_SIZE)
        const encrypted = new Uint8Array(
            await globalThis.crypto.subtle.encrypt(
                { name: "AES-CTR", counter: encryptionCounter, length: 64 },
                key,
                piece,
            ),
        )
        encryptedChunks.push(encrypted)
        encryptionCounter = incrementCounter64By(encryptionCounter, Math.ceil(piece.length / 16))
    }

    const combinedLength = encryptedChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const combined = new Uint8Array(combinedLength)
    let combinedOffset = 0
    for (const chunk of encryptedChunks) {
        combined.set(chunk, combinedOffset)
        combinedOffset += chunk.length
    }

    const iv = new Uint8Array(32)
    iv.set(salt, 0)
    iv.set(counter, 16)

    const data: FileCardData = {
        name: "fixture.txt",
        ufid: await computeUfidFromBytes(plaintext),
        size: plaintext.length,
        uploadComplete: true,
        chunks: [1],
        IV: Buffer.from(iv).toString("base64"),
    }

    async function* parts() {
        let offset = 0
        const sizes = [97, 2048, 16384]
        let index = 0
        while (offset < combined.length) {
            const size = sizes[index % sizes.length]
            yield combined.subarray(offset, offset + size)
            offset += size
            index += 1
        }
    }

    return { data, parts }
}

test("current-format encrypted fixtures restore to the original plaintext", async () => {
    const fixtureText = "Fixture payload for TGLFS CLI download parity.\n".repeat(64)
    const plaintext = new TextEncoder().encode(fixtureText)
    const fixture = await createFixture(plaintext, "secret")
    const dir = await mkdtemp(join(tmpdir(), "tglfs-cli-"))
    const outputPath = join(dir, "fixture.txt")
    const progressUpdates: number[] = []

    try {
        const result = await restoreFileFromEncryptedParts(
            fixture.data,
            "secret",
            outputPath,
            fixture.parts(),
            false,
            ({ bytesWritten }) => progressUpdates.push(bytesWritten),
        )

        const saved = new Uint8Array(await readFile(outputPath))
        assert.equal(result.bytesWritten, plaintext.length)
        assert.deepEqual(Array.from(saved), Array.from(plaintext))
        assert.ok(progressUpdates.length > 0)
        assert.equal(progressUpdates.at(-1), plaintext.length)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test("wrong passwords fail the restore pipeline", async () => {
    const plaintext = new TextEncoder().encode("Wrong password fixture payload.\n".repeat(32))
    const fixture = await createFixture(plaintext, "correct-horse")
    const dir = await mkdtemp(join(tmpdir(), "tglfs-cli-"))
    const outputPath = join(dir, "wrong-password.txt")

    try {
        await assert.rejects(
            () => restoreFileFromEncryptedParts(fixture.data, "wrong-battery", outputPath, fixture.parts()),
            (error: unknown) =>
                error instanceof CliError &&
                (error.code === "decryption_failed" || error.code === "ufid_mismatch"),
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test("UFID mismatches are reported after successful decryption", async () => {
    const plaintext = new TextEncoder().encode("UFID mismatch fixture payload.\n".repeat(16))
    const fixture = await createFixture(plaintext, "password")
    const dir = await mkdtemp(join(tmpdir(), "tglfs-cli-"))
    const outputPath = join(dir, "ufid-mismatch.txt")

    try {
        await assert.rejects(
            () =>
                restoreFileFromEncryptedParts(
                    { ...fixture.data, ufid: "not-the-right-ufid" },
                    "password",
                    outputPath,
                    fixture.parts(),
                ),
            (error: unknown) => error instanceof CliError && error.code === "ufid_mismatch",
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test("GramJS-style integer document sizes are accepted for chunk downloads", () => {
    const size = coerceTelegramDocumentSize({
        toString() {
            return "228396"
        },
    })

    assert.equal(size, 228396)
})

test("non-document chunk references are rejected with a precise invalid-file-card error", () => {
    assert.throws(
        () => resolveChunkDocumentSize({ id: 170396, className: "Message", message: "WOAH WTF" }, 170396, "ufid-123"),
        (error: unknown) =>
            error instanceof CliError &&
            error.code === "invalid_file_card" &&
            error.message.includes("170396") &&
            error.message.includes("not a Telegram document"),
    )
})
