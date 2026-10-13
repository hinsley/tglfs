import assert from "node:assert/strict"
import test from "node:test"

import { deriveAESKeyFromPassword, incrementCounter64By } from "../src/crypto.js"
import { serializeFileCardMessage } from "../src/shared/file-cards.js"
import {
    ChunkedPartWriter,
    encryptCtrAt,
    runUploadPipeline,
    UploadResumeMismatchError,
} from "../src/shared/upload-pipeline.js"
import type { FinalizeChunkRequest, UploadChunkSink, UploadPartRequest } from "../src/shared/upload-pipeline.js"
import {
    coerceDocumentSize,
    counterAtByteOffset,
    looksLikeGzipHeader,
    parseResumableFileCard,
    planUploadResume,
    RESUME_HEAD_WINDOW_BYTES,
    serializeResumedFileCard,
} from "../src/shared/upload-resume.js"
import type { ResumableFileCard } from "../src/shared/upload-resume.js"

const UFID = "9f2c4a1b7e0d5c3a2b1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b"
const SALT = Uint8Array.from({ length: 16 }, (_, index) => 0x10 + index)
const COUNTER = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index)
const IV = Buffer.from([...SALT, ...COUNTER]).toString("base64")
const MIB = 1024 * 1024

// Real serialized shapes of the three readable file-card protocol versions, as stored in Telegram.
const V1_INCOMPLETE = `tglfs:file\n{"name":"movie.mkv","ufid":"${UFID}","size":7340032,"uploadComplete":false,"chunks":[901,902],"IV":"${IV}"}`
const V2_INCOMPLETE = `tglfs:file\n{"type":"tglfs:file","version":2,"name":"movie.mkv","ufid":"${UFID}","size":7340032,"uploadComplete":false,"chunks":[901,902],"IV":"${IV}"}`
const V3_INCOMPLETE = serializeFileCardMessage({
    name: "movie.mkv",
    ufid: UFID,
    size: 7340032,
    uploadComplete: false,
    chunks: [901, 902],
    IV,
    parentFolderId: "folder-42",
})

function parseOk(message: string): ResumableFileCard {
    const parsed = parseResumableFileCard(message)
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message)
    return (parsed as { ok: true; card: ResumableFileCard }).card
}

/* --------------------------------------------------------------------------------------------- counters */

test("counterAtByteOffset matches the chained incrementCounter64By used by uploads and downloads", () => {
    for (const blocks of [0, 1, 255, 256, 65535, 65536, 65539, 1_000_000, 0x7fffffff, 0xfffffffe]) {
        assert.deepEqual(
            Array.from(counterAtByteOffset(COUNTER, blocks * 16)),
            Array.from(incrementCounter64By(COUNTER, blocks)),
            `blocks=${blocks}`,
        )
    }
    // Chained 1 MiB steps (how the uploader advanced the counter) land on the same block as one big jump.
    let chained = new Uint8Array(COUNTER)
    for (let step = 0; step < 300; step += 1) chained = incrementCounter64By(chained, MIB / 16)
    assert.deepEqual(Array.from(counterAtByteOffset(COUNTER, 300 * MIB)), Array.from(chained))
})

test("counterAtByteOffset wraps within the low 64 bits and keeps the high 64 bits", () => {
    const nearWrap = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe])
    assert.deepEqual(
        Array.from(counterAtByteOffset(nearWrap, 3 * 16)),
        [1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 1],
    )
    // Offsets beyond 2^32 blocks (64 GiB) are handled exactly.
    const big = counterAtByteOffset(new Uint8Array(16), 2 ** 40 * 16)
    assert.deepEqual(Array.from(big), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0])
})

test("counterAtByteOffset rejects unaligned or invalid offsets", () => {
    assert.throws(() => counterAtByteOffset(COUNTER, 15))
    assert.throws(() => counterAtByteOffset(COUNTER, -16))
    assert.throws(() => counterAtByteOffset(COUNTER, 1.5))
    assert.throws(() => counterAtByteOffset(new Uint8Array(8), 16))
})

/* ---------------------------------------------------------------------------------------- card parsing */

test("parseResumableFileCard reads incomplete v1 (unversioned), v2 and v3 cards", () => {
    const v1 = parseOk(V1_INCOMPLETE)
    assert.equal(v1.version, 1)
    assert.equal(v1.prefix, "tglfs:file\n")
    assert.deepEqual(v1.data.chunks, [901, 902])
    assert.deepEqual(Array.from(v1.salt), Array.from(SALT))
    assert.deepEqual(Array.from(v1.initialCounter), Array.from(COUNTER))

    assert.equal(parseOk(V2_INCOMPLETE).version, 2)

    const v3 = parseOk(V3_INCOMPLETE)
    assert.equal(v3.version, 3)
    assert.equal((v3.data as { parentFolderId?: string }).parentFolderId, "folder-42")
})

test("parseResumableFileCard fails closed on unknown versions and malformed cards", () => {
    const cases: Array<[string, string]> = [
        [V3_INCOMPLETE.replace('"version":3', '"version":4'), "unsupported-version"],
        [V3_INCOMPLETE.replace('"version":3', '"version":"3"'), "unsupported-version"],
        [V2_INCOMPLETE.replace('"version":2', '"version":1'), "unsupported-version"],
        [V3_INCOMPLETE.replace('"type":"tglfs:file"', '"type":"tglfs:folder"'), "malformed-card"],
        ["tglfs:file\n{\"name\":\"broken\"", "malformed-card"],
        ["tglfs:file\n[1,2,3]", "malformed-card"],
        ["tglfs:file no json", "malformed-card"],
        [V1_INCOMPLETE.replace('"chunks":[901,902]', '"chunks":"901"'), "malformed-card"],
        [V1_INCOMPLETE.replace('"chunks":[901,902]', '"chunks":[901,901]'), "malformed-card"],
        [V1_INCOMPLETE.replace('"chunks":[901,902]', '"chunks":[901,-2]'), "malformed-card"],
        [V1_INCOMPLETE.replace('"chunks":[901,902]', '"chunks":[901,2.5]'), "malformed-card"],
        [V1_INCOMPLETE.replace('"size":7340032', '"size":-1'), "malformed-card"],
        [V3_INCOMPLETE.replace('"parentFolderId":"folder-42"', '"parentFolderId":""'), "malformed-card"],
        [V1_INCOMPLETE.replace('"uploadComplete":false', '"uploadComplete":true'), "already-complete"],
        [V1_INCOMPLETE.replace(IV, "mock-iv"), "invalid-iv"],
        [V1_INCOMPLETE.replace(IV, Buffer.from(SALT).toString("base64")), "invalid-iv"],
        ["hello world", "not-a-file-card"],
        ['tglfs:folder\n{"type":"tglfs:folder"}', "not-a-file-card"],
    ]
    for (const [message, reason] of cases) {
        const parsed = parseResumableFileCard(message)
        assert.equal(parsed.ok, false, message)
        assert.equal((parsed as { reason: string }).reason, reason, message)
    }
    assert.equal(parseResumableFileCard(undefined).ok, false)
})

/* -------------------------------------------------------------------------------------------- planning */

const PART = 512 * 1024
const CHUNK = 2 * MIB

test("planUploadResume continues after the last completed chunk", () => {
    const card = parseOk(V3_INCOMPLETE)
    const result = planUploadResume(card, {
        ufid: UFID,
        size: 7340032,
        chunkSize: CHUNK,
        partSize: PART,
        chunkDocumentSizes: [CHUNK, CHUNK],
    })
    assert.equal(result.ok, true)
    const plan = (result as Extract<typeof result, { ok: true }>).plan
    assert.equal(plan.resumeOffset, 2 * CHUNK)
    assert.equal(plan.nextChunkIndex, 2)
    assert.deepEqual(plan.completedChunks, [901, 902])
    assert.deepEqual(Array.from(plan.counter), Array.from(incrementCounter64By(COUNTER, (2 * CHUNK) / 16)))
    assert.deepEqual(plan.verifyWindows, [
        { chunkIndex: 0, offsetInChunk: 0, absoluteOffset: 0, length: RESUME_HEAD_WINDOW_BYTES },
        { chunkIndex: 0, offsetInChunk: CHUNK - PART, absoluteOffset: CHUNK - PART, length: PART },
        { chunkIndex: 1, offsetInChunk: CHUNK - PART, absoluteOffset: 2 * CHUNK - PART, length: PART },
    ])
    // Every window is a valid upload.getFile range: 4 KiB-aligned, and inside one 1 MiB block.
    for (const window of plan.verifyWindows) {
        assert.equal(window.offsetInChunk % 4096, 0)
        assert.equal(window.length % 4096, 0)
        assert.equal(MIB % window.length, 0)
        assert.equal(Math.floor(window.offsetInChunk / MIB), Math.floor((window.offsetInChunk + window.length - 1) / MIB))
    }
})

test("planUploadResume restarts at byte 0 into a card that has no chunks yet", () => {
    const card = parseOk(V1_INCOMPLETE.replace('"chunks":[901,902]', '"chunks":[]'))
    const result = planUploadResume(card, { ufid: UFID, size: 7340032, chunkSize: CHUNK, partSize: PART, chunkDocumentSizes: [] })
    assert.equal(result.ok, true)
    const plan = (result as Extract<typeof result, { ok: true }>).plan
    assert.equal(plan.resumeOffset, 0)
    assert.equal(plan.nextChunkIndex, 0)
    assert.deepEqual(plan.verifyWindows, [])
    assert.deepEqual(Array.from(plan.counter), Array.from(COUNTER))
})

test("planUploadResume refuses when anything doesn't line up", () => {
    const card = parseOk(V2_INCOMPLETE)
    const base = { ufid: UFID, size: 7340032, chunkSize: CHUNK, partSize: PART, chunkDocumentSizes: [CHUNK, CHUNK] }
    const cases: Array<[Partial<typeof base> & { chunkDocumentSizes?: Array<number | null> }, string]> = [
        [{ ufid: UFID.replace(/^9/, "8") }, "ufid-mismatch"],
        [{ size: 7340031 }, "size-mismatch"],
        [{ chunkSize: CHUNK + 4096 }, "unsupported-chunk-size"],
        [{ chunkSize: PART / 2 }, "unsupported-chunk-size"],
        [{ chunkSize: CHUNK, partSize: 1000 }, "unsupported-chunk-size"],
        [{ chunkDocumentSizes: [CHUNK, null] }, "missing-chunk"],
        [{ chunkDocumentSizes: [CHUNK] }, "missing-chunk"],
        [{ chunkDocumentSizes: [CHUNK, CHUNK - 16] }, "chunk-size-mismatch"],
        [{ chunkDocumentSizes: [4 * MIB, 4 * MIB] }, "chunk-size-mismatch"],
    ]
    for (const [override, reason] of cases) {
        const result = planUploadResume(card, { ...base, ...override })
        assert.equal(result.ok, false, JSON.stringify(override))
        assert.equal((result as { reason: string }).reason, reason, JSON.stringify(override))
        assert.ok((result as { message: string }).message.length > 0)
    }
})

/* ------------------------------------------------------------------------------------------- card edits */

test("serializeResumedFileCard keeps v1 cards unversioned and only changes chunks/uploadComplete", () => {
    const card = parseOk(V1_INCOMPLETE)
    const message = serializeResumedFileCard(card, { chunks: [901, 902, 903], uploadComplete: true })
    assert.equal(
        message,
        `tglfs:file\n{"name":"movie.mkv","ufid":"${UFID}","size":7340032,"uploadComplete":true,"chunks":[901,902,903],"IV":"${IV}"}`,
    )
})

test("serializeResumedFileCard preserves unknown fields and the v2/v3 version", () => {
    const v2 = parseOk(V2_INCOMPLETE.replace('"IV"', '"futureHint":{"keep":[1,2]},"IV"'))
    const v2Message = serializeResumedFileCard(v2, { chunks: [901, 902, 903], uploadComplete: false })
    const v2Json = JSON.parse(v2Message.substring(v2Message.indexOf("{")))
    assert.equal(v2Json.version, 2)
    assert.equal("parentFolderId" in v2Json, false)
    assert.deepEqual(v2Json.futureHint, { keep: [1, 2] })
    assert.deepEqual(v2Json.chunks, [901, 902, 903])

    // A plain v3 card is written exactly as the normal uploader would write it.
    const v3 = parseOk(V3_INCOMPLETE)
    assert.equal(
        serializeResumedFileCard(v3, { chunks: [901, 902, 903], uploadComplete: true }),
        serializeFileCardMessage({
            name: "movie.mkv",
            ufid: UFID,
            size: 7340032,
            uploadComplete: true,
            chunks: [901, 902, 903],
            IV,
            parentFolderId: "folder-42",
        }),
    )
})

test("helpers: gzip header detection and Telegram document sizes", () => {
    assert.equal(looksLikeGzipHeader(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0, 0])), true)
    assert.equal(looksLikeGzipHeader(Uint8Array.from([0x1f, 0x8b, 0x08, 0xe0])), false)
    assert.equal(looksLikeGzipHeader(Uint8Array.from([0x00, 0x8b, 0x08, 0x00])), false)
    assert.equal(coerceDocumentSize(2097152), 2097152)
    assert.equal(coerceDocumentSize(2097152n), 2097152)
    assert.equal(coerceDocumentSize({ toJSNumber: () => 42 }), 42)
    assert.equal(coerceDocumentSize("42"), 42)
    assert.equal(coerceDocumentSize(undefined), null)
    assert.equal(coerceDocumentSize(-1), null)
})

/* ------------------------------------------------------------------- byte-exact resume (the key proof) */

async function testKey(password = "correct horse") {
    return deriveAESKeyFromPassword(password, SALT)
}

function testPlaintext(size: number) {
    // Half pseudo-random (incompressible), half repetitive text, so the gzip stream has varied block types.
    const bytes = new Uint8Array(size)
    let state = 0x12345678
    for (let index = 0; index < size; index += 1) {
        if (index % 200_000 < 100_000) {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0
            bytes[index] = state >>> 24
        } else {
            bytes[index] = "tglfs resume test line\n".charCodeAt(index % 23)
        }
    }
    return bytes
}

function streamOf(bytes: Uint8Array, pieceSize: number) {
    let offset = 0
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.length) {
                controller.close()
                return
            }
            controller.enqueue(bytes.slice(offset, offset + pieceSize))
            offset += pieceSize
        },
    })
}

function gzipReader(bytes: Uint8Array, pieceSize: number) {
    return streamOf(bytes, pieceSize).pipeThrough(new CompressionStream("gzip")).getReader()
}

function concat(pieces: Uint8Array[]) {
    const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0))
    let offset = 0
    for (const piece of pieces) {
        out.set(piece, offset)
        offset += piece.length
    }
    return out
}

/** Emulates Telegram: parts per upload id, assembled into chunk documents with Telegram's part-size rules. */
class FakeTelegram implements UploadChunkSink {
    readonly chunks: Uint8Array[] = []
    readonly log: string[] = []
    private parts = new Map<bigint, Map<number, Uint8Array>>()
    failAfterParts = Infinity
    private partsSaved = 0

    constructor(readonly partSize: number, initialChunks: Uint8Array[] = []) {
        this.chunks.push(...initialChunks)
    }

    async savePart(request: UploadPartRequest) {
        if (this.partsSaved >= this.failAfterParts) {
            const error = new Error("Transfer cancelled.")
            error.name = "AbortError"
            throw error
        }
        this.partsSaved += 1
        const parts = this.parts.get(request.fileId) ?? new Map<number, Uint8Array>()
        parts.set(request.filePart, request.bytes.slice())
        this.parts.set(request.fileId, parts)
        this.log.push(`part ${request.filePart} total ${request.fileTotalParts} len ${request.bytes.length}`)
    }

    async finalizeChunk(request: FinalizeChunkRequest) {
        const parts = this.parts.get(request.fileId)
        assert.ok(parts, "chunk finalized without parts")
        const pieces: Uint8Array[] = []
        for (let index = 0; index < request.parts; index += 1) {
            const part = parts.get(index)
            assert.ok(part, `FILE_PART_${index}_MISSING`)
            if (index < request.parts - 1) assert.equal(part.length, this.partSize, "non-final parts must be full")
            pieces.push(part)
        }
        const bytes = concat(pieces)
        assert.equal(bytes.length, request.size)
        assert.equal(request.chunkIndex, this.chunks.length, "chunks are finalized in order")
        this.chunks.push(bytes)
        this.log.push(`chunk ${request.chunkIndex} size ${request.size}${request.last ? " last" : ""}`)
    }
}

async function decryptAndGunzip(key: CryptoKey, ciphertext: Uint8Array) {
    const compressed = await encryptCtrAt(key, COUNTER, 0, ciphertext)
    assert.ok(looksLikeGzipHeader(compressed))
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

const T_PART = 64 * 1024
const T_CHUNK = 256 * 1024

async function fullUpload(plaintext: Uint8Array, options: { encryptionBufferSize?: number; pieceSize?: number } = {}) {
    const key = await testKey()
    const telegram = new FakeTelegram(T_PART)
    const result = await runUploadPipeline({
        compressed: gzipReader(plaintext, options.pieceSize ?? 65536),
        key,
        initialCounter: COUNTER,
        chunkSize: T_CHUNK,
        partSize: T_PART,
        encryptionBufferSize: options.encryptionBufferSize ?? MIB,
        sink: telegram,
    })
    return { key, telegram, result }
}

test("CTR encryption split at any 16-byte boundary equals one-shot encryption (also across a counter wrap)", async () => {
    const key = await testKey()
    const data = testPlaintext(300_000)
    for (const counter of [COUNTER, Uint8Array.from([...COUNTER.subarray(0, 8), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf0])]) {
        const whole = await encryptCtrAt(key, counter, 0, data)
        for (const boundary of [16, 4096, 65536, 131072 + 48, 299_984]) {
            const head = await encryptCtrAt(key, counter, 0, data.subarray(0, boundary))
            const tail = await encryptCtrAt(key, counter, boundary, data.subarray(boundary))
            assert.deepEqual(concat([head, tail]), whole, `boundary ${boundary}`)
        }
    }
})

test("the pipeline's chunk layout matches the original web uploader's layout", async () => {
    // Faithful port of the pre-resume web uploader's part/chunk bookkeeping (byte counts only), so chunks written
    // by older versions are known to sit exactly where the resume plan expects them.
    const legacySplit = (total: number, chunkSize: number, partSize: number) => {
        const sizes: number[] = []
        let partBytesWritten = 0
        let chunkBytesWritten = 0
        let sentInChunk = 0
        const sendPart = (bytes: number) => void (sentInChunk += bytes)
        const finalizeChunk = () => {
            sizes.push(sentInChunk)
            sentInChunk = 0
        }
        for (let written = 0; written < total; ) {
            const step = Math.min(partSize - partBytesWritten, total - written)
            partBytesWritten += step
            written += step
            if (partBytesWritten === partSize) {
                const remainingChunkSpace = chunkSize - chunkBytesWritten
                if (remainingChunkSpace <= partSize) {
                    sendPart(remainingChunkSpace)
                    finalizeChunk()
                    partBytesWritten -= remainingChunkSpace
                    chunkBytesWritten = partSize - remainingChunkSpace
                } else {
                    sendPart(partSize)
                    partBytesWritten = 0
                    chunkBytesWritten += partSize
                }
            }
        }
        if (partBytesWritten > 0) {
            const remainingChunkSpace = chunkSize - chunkBytesWritten
            if (remainingChunkSpace <= partBytesWritten) {
                sendPart(remainingChunkSpace)
                finalizeChunk()
                partBytesWritten -= remainingChunkSpace
            }
            sendPart(partBytesWritten)
        }
        finalizeChunk()
        return sizes
    }
    for (const total of [1, 1000, T_PART - 1, T_PART + 1, T_CHUNK - 7, T_CHUNK + 5, 3 * T_CHUNK + 12345]) {
        const sizes: number[] = []
        const writer = new ChunkedPartWriter(
            { savePart: async () => {}, finalizeChunk: async (request) => void sizes.push(request.size) },
            { chunkSize: T_CHUNK, partSize: T_PART },
        )
        await writer.write(new Uint8Array(total))
        await writer.finish()
        assert.deepEqual(sizes, legacySplit(total, T_CHUNK, T_PART), `total ${total}`)
    }
})

test("ciphertext ending exactly on a part or chunk boundary never sends an empty or mis-counted part", async () => {
    const parts: UploadPartRequest[] = []
    const chunks: FinalizeChunkRequest[] = []
    const sink: UploadChunkSink = {
        savePart: async (request) => void parts.push({ ...request, bytes: request.bytes.slice() }),
        finalizeChunk: async (request) => void chunks.push(request),
    }
    const onParts = new ChunkedPartWriter(sink, { chunkSize: T_CHUNK, partSize: T_PART })
    await onParts.write(new Uint8Array(3 * T_PART))
    assert.equal(await onParts.finish(), true)
    assert.deepEqual(parts.map((part) => part.fileTotalParts), [-1, -1, 3])
    assert.deepEqual(chunks.map((chunk) => [chunk.parts, chunk.size, chunk.last]), [[3, 3 * T_PART, true]])

    parts.length = 0
    chunks.length = 0
    const onChunks = new ChunkedPartWriter(sink, { chunkSize: T_CHUNK, partSize: T_PART })
    await onChunks.write(new Uint8Array(2 * T_CHUNK))
    assert.equal(await onChunks.finish(), false, "no trailing chunk: the caller marks the card complete")
    assert.deepEqual(chunks.map((chunk) => [chunk.chunkIndex, chunk.parts, chunk.last]), [[0, 4, false], [1, 4, false]])
})

test("an upload interrupted mid-chunk and resumed from the plan yields byte-identical chunks", async () => {
    const plaintext = testPlaintext(1_700_000)
    const reference = await fullUpload(plaintext)
    const referenceCiphertext = concat(reference.telegram.chunks)
    assert.ok(reference.telegram.chunks.length >= 4, "fixture spans several chunks")
    assert.deepEqual(await decryptAndGunzip(reference.key, referenceCiphertext), plaintext)

    // Interrupted run: cancelled while sending the 3rd part of chunk 3 (two chunks are complete).
    const key = await testKey()
    const interrupted = new FakeTelegram(T_PART)
    interrupted.failAfterParts = 2 * (T_CHUNK / T_PART) + 2
    await assert.rejects(
        runUploadPipeline({
            compressed: gzipReader(plaintext, 65536),
            key,
            initialCounter: COUNTER,
            chunkSize: T_CHUNK,
            partSize: T_PART,
            encryptionBufferSize: MIB,
            sink: interrupted,
        }),
        { name: "AbortError" },
    )
    assert.equal(interrupted.chunks.length, 2)

    // The card as it was left in Telegram, then the plan for the same file.
    const chunkIds = [7001, 7002]
    const card = parseOk(
        serializeFileCardMessage({
            name: "fixture.bin",
            ufid: UFID,
            size: plaintext.length,
            uploadComplete: false,
            chunks: chunkIds,
            IV,
            parentFolderId: "folder-1",
        }),
    )
    const planned = planUploadResume(card, {
        ufid: UFID,
        size: plaintext.length,
        chunkSize: T_CHUNK,
        partSize: T_PART,
        chunkDocumentSizes: interrupted.chunks.map((chunk) => chunk.length),
    })
    assert.equal(planned.ok, true)
    const plan = (planned as Extract<typeof planned, { ok: true }>).plan
    assert.equal(plan.resumeOffset, 2 * T_CHUNK)

    // Password check as the web app does it: the first stored block decrypts to a gzip header.
    assert.equal(looksLikeGzipHeader(await encryptCtrAt(key, card.initialCounter, 0, interrupted.chunks[0].subarray(0, 16))), true)
    const wrongKey = await testKey("wrong password")
    assert.equal(looksLikeGzipHeader(await encryptCtrAt(wrongKey, card.initialCounter, 0, interrupted.chunks[0].subarray(0, 16))), false)

    // Resume with a different read granularity than the interrupted run (File.stream() chunking may differ).
    const resumed = new FakeTelegram(T_PART, interrupted.chunks)
    const events: string[] = []
    const fetched: number[] = []
    const result = await runUploadPipeline({
        compressed: gzipReader(plaintext, 10_007),
        key,
        initialCounter: card.initialCounter,
        chunkSize: T_CHUNK,
        partSize: T_PART,
        encryptionBufferSize: 48 * 1024,
        sink: {
            savePart: async (request) => {
                events.push("part")
                await resumed.savePart(request)
            },
            finalizeChunk: (request) => resumed.finalizeChunk(request),
        },
        resume: {
            offset: plan.resumeOffset,
            startChunkIndex: plan.nextChunkIndex,
            verifyWindows: plan.verifyWindows,
            fetchReference: async (window) => {
                fetched.push(window.absoluteOffset)
                return interrupted.chunks[window.chunkIndex].slice(window.offsetInChunk, window.offsetInChunk + window.length)
            },
            onResumePoint: () => void events.push("resume-point"),
        },
    })
    assert.equal(events[0], "resume-point", "nothing is sent before every stored window matched")
    assert.deepEqual(fetched, plan.verifyWindows.map((window) => window.absoluteOffset))
    assert.equal(result.totalBytes, referenceCiphertext.length)
    assert.equal(result.finalChunkSent, true)
    assert.deepEqual(resumed.chunks.map((chunk) => chunk.length), reference.telegram.chunks.map((chunk) => chunk.length))
    assert.deepEqual(concat(resumed.chunks), referenceCiphertext)
    assert.deepEqual(await decryptAndGunzip(key, concat(resumed.chunks)), plaintext)
})

test("a resumed upload whose re-encrypted bytes differ from what's stored stops before sending anything", async () => {
    const plaintext = testPlaintext(900_000)
    const reference = await fullUpload(plaintext)
    const stored = reference.telegram.chunks.slice(0, 2).map((chunk) => chunk.slice())
    const plan = {
        offset: 2 * T_CHUNK,
        startChunkIndex: 2,
        verifyWindows: [
            { chunkIndex: 0, offsetInChunk: 0, absoluteOffset: 0, length: 4096 },
            { chunkIndex: 0, offsetInChunk: T_CHUNK - T_PART, absoluteOffset: T_CHUNK - T_PART, length: T_PART },
            { chunkIndex: 1, offsetInChunk: T_CHUNK - T_PART, absoluteOffset: 2 * T_CHUNK - T_PART, length: T_PART },
        ],
    }
    const run = (storedChunks: Uint8Array[], input: Uint8Array, key: CryptoKey) => {
        let sent = 0
        const promise = runUploadPipeline({
            compressed: gzipReader(input, 65536),
            key,
            initialCounter: COUNTER,
            chunkSize: T_CHUNK,
            partSize: T_PART,
            encryptionBufferSize: MIB,
            sink: { savePart: async () => void sent++, finalizeChunk: async () => {} },
            resume: {
                ...plan,
                fetchReference: async (window) =>
                    storedChunks[window.chunkIndex].slice(window.offsetInChunk, window.offsetInChunk + window.length),
            },
        })
        return { promise, sent: () => sent }
    }

    // A flipped byte in the stored tail of chunk 2.
    const tampered = stored.map((chunk) => chunk.slice())
    tampered[1][T_CHUNK - 100] ^= 0x01
    const tamperedRun = run(tampered, plaintext, reference.key)
    await assert.rejects(tamperedRun.promise, UploadResumeMismatchError)
    assert.equal(tamperedRun.sent(), 0)

    // Different plaintext of the same length (would have a different UFID; here it proves the windows catch it).
    const other = plaintext.slice()
    other[400_000] ^= 0xff
    const otherRun = run(stored, other, reference.key)
    await assert.rejects(otherRun.promise, UploadResumeMismatchError)
    assert.equal(otherRun.sent(), 0)

    // A different key.
    const wrongKeyRun = run(stored, plaintext, await testKey("nope"))
    await assert.rejects(wrongKeyRun.promise, UploadResumeMismatchError)
    assert.equal(wrongKeyRun.sent(), 0)

    // A stream that ends before the resume offset can't be the stored one.
    const short = run(stored, plaintext.subarray(0, 100_000), reference.key)
    await assert.rejects(short.promise, UploadResumeMismatchError)
    assert.equal(short.sent(), 0)
})

test("a stream that ends exactly on a chunk boundary: no empty chunk, and a resume there sends nothing", async () => {
    // The pipeline treats its input as opaque bytes; use an exact multiple of the chunk size to hit the edge the old
    // uploader failed on (it sent an empty final chunk). Such a card is left with every chunk but no completion flag.
    const key = await testKey()
    const stream = testPlaintext(2 * T_CHUNK)
    const full = new FakeTelegram(T_PART)
    const fullResult = await runUploadPipeline({
        compressed: streamOf(stream, 50_000).getReader(),
        key,
        initialCounter: COUNTER,
        chunkSize: T_CHUNK,
        partSize: T_PART,
        encryptionBufferSize: MIB,
        sink: full,
    })
    assert.equal(fullResult.finalChunkSent, false, "caller marks the card complete separately")
    assert.equal(full.chunks.length, 2)

    let sent = 0
    const resumed = await runUploadPipeline({
        compressed: streamOf(stream, 30_000).getReader(),
        key,
        initialCounter: COUNTER,
        chunkSize: T_CHUNK,
        partSize: T_PART,
        encryptionBufferSize: MIB,
        sink: { savePart: async () => void sent++, finalizeChunk: async () => assert.fail("no chunk to send") },
        resume: {
            offset: 2 * T_CHUNK,
            startChunkIndex: 2,
            verifyWindows: [
                { chunkIndex: 0, offsetInChunk: 0, absoluteOffset: 0, length: 4096 },
                { chunkIndex: 1, offsetInChunk: T_CHUNK - T_PART, absoluteOffset: 2 * T_CHUNK - T_PART, length: T_PART },
            ],
            fetchReference: async (window) =>
                full.chunks[window.chunkIndex].slice(window.offsetInChunk, window.offsetInChunk + window.length),
        },
    })
    assert.equal(sent, 0)
    assert.equal(resumed.totalBytes, 2 * T_CHUNK)
    assert.equal(resumed.finalChunkSent, false)
})
