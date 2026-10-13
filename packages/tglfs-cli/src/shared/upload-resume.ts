/**
 * Planning for resuming an interrupted upload into its existing (incomplete) `tglfs:file` card.
 *
 * Pure and DOM-free: the web app runs the plan, and the Node tests exercise it with real serialized cards.
 *
 * Why a chunk boundary is a safe resume point (see also `upload-pipeline.ts`):
 * - The stored blob is `AES-CTR(key, IV-counter, gzip(plaintext))`, split into Telegram chunk messages of exactly
 *   `chunkSize` ciphertext bytes (the last one shorter). The compressed stream is a single gzip stream over the
 *   whole file, so the compressor state at a chunk boundary can only be rebuilt by re-compressing the plaintext
 *   from byte 0. The resume therefore re-reads and re-compresses the file from the start, discards the compressed
 *   bytes before the boundary, and encrypts/uploads only what comes after it.
 * - AES-CTR is position-wise: ciphertext byte `i` depends only on the key, the compressed byte `i` and the counter
 *   block `initialCounter + floor(i / 16)` (low 64 bits, wrapping — WebCrypto `length: 64`). Encryption buffers
 *   always start at 16-byte-aligned offsets, so restarting encryption at a boundary with
 *   `counterAtByteOffset(initialCounter, boundary)` yields byte-identical ciphertext. `chunkSize` must be a
 *   multiple of 16 (and of the upload part size), which the plan enforces.
 * - The plaintext is proven identical by the UFID (content hash) and size; the key by the password check; and the
 *   re-compressed bytes are proven identical to what is already stored by comparing re-encrypted windows (the start
 *   of the first chunk and the tail of every completed chunk) with bytes downloaded from Telegram. Anything that
 *   doesn't match refuses to resume — nothing is written.
 */

import { FILE_CARD_PREFIX, parseFileCardMessage } from "./file-cards.js"
import type { FileCardData } from "./file-cards.js"

/** Number of ciphertext bytes at the start of chunk 1 downloaded for the password check. */
export const RESUME_HEAD_WINDOW_BYTES = 4096

const AES_BLOCK_BYTES = 16
const COUNTER_LOW_MASK = (1n << 64n) - 1n

export type ResumeRefusalReason =
    | "not-a-file-card"
    | "malformed-card"
    | "unsupported-version"
    | "already-complete"
    | "invalid-iv"
    | "ufid-mismatch"
    | "size-mismatch"
    | "unsupported-chunk-size"
    | "missing-chunk"
    | "chunk-size-mismatch"

export type ResumeRefusal = {
    ok: false
    reason: ResumeRefusalReason
    message: string
}

export type ResumableFileCard = {
    /** Text before the JSON payload (normally `tglfs:file\n`), kept verbatim on edit. */
    prefix: string
    /** The parsed JSON payload, kept so unknown fields survive the edit. */
    raw: Record<string, unknown>
    data: FileCardData
    /** Protocol version of the stored record (1 = the unversioned shape). Edits keep this version. */
    version: number
    salt: Uint8Array
    initialCounter: Uint8Array
}

export type ResumeVerifyWindow = {
    /** 0-based index of the completed chunk the window lies in. */
    chunkIndex: number
    /** Byte offset inside that chunk's Telegram document. */
    offsetInChunk: number
    /** Byte offset in the whole ciphertext (= compressed) stream. */
    absoluteOffset: number
    length: number
}

export type UploadResumePlan = {
    /** Ciphertext bytes already stored in Telegram (completed chunks only). Upload continues from here. */
    resumeOffset: number
    /** 0-based index of the next chunk to upload. */
    nextChunkIndex: number
    /** Completed chunk message ids, in order. */
    completedChunks: number[]
    /** AES-CTR counter block for the first ciphertext byte at `resumeOffset`. */
    counter: Uint8Array
    /** Regions of already-stored ciphertext that must be re-produced byte-for-byte before anything new is sent. */
    verifyWindows: ResumeVerifyWindow[]
}

export type ResumePlanResult = { ok: true; plan: UploadResumePlan } | ResumeRefusal

export type ResumePlanInput = {
    /** UFID of the plaintext being uploaded now. */
    ufid: string
    /** Plaintext size of the file being uploaded now. */
    size: number
    /** Configured chunk size; completed chunks must all have exactly this size. */
    chunkSize: number
    /** Telegram upload part size (512 KiB). */
    partSize: number
    /** Document sizes of the card's chunk messages, in card order; `null` when a message is missing/not a document. */
    chunkDocumentSizes: ReadonlyArray<number | null>
}

const REFUSAL_MESSAGES: Record<ResumeRefusalReason, string> = {
    "not-a-file-card": "That message isn't a TGLFS file card, so there's nothing to resume.",
    "malformed-card": "The interrupted upload's file card is damaged, so it can't be resumed safely.",
    "unsupported-version":
        "The interrupted upload was started by a newer version of TGLFS. Update TGLFS before resuming it.",
    "already-complete": "This upload has already finished — there's nothing left to resume.",
    "invalid-iv": "The interrupted upload's encryption details are damaged, so it can't be resumed safely.",
    "ufid-mismatch":
        "This file's contents don't match the interrupted upload. Choose the exact file you were uploading.",
    "size-mismatch": "This file isn't the same size as the interrupted upload. Choose the exact file you were uploading.",
    "unsupported-chunk-size":
        "The interrupted upload was split into pieces of a different size than this app uses, so it can't be resumed here.",
    "missing-chunk":
        "Some already-uploaded pieces are no longer in Telegram, so the upload can't be resumed. Delete the incomplete file and upload it again.",
    "chunk-size-mismatch":
        "The already-uploaded pieces don't have the expected size, so the upload can't be resumed safely. Delete the incomplete file and upload it again.",
}

export function describeResumeRefusal(reason: ResumeRefusalReason) {
    return REFUSAL_MESSAGES[reason]
}

function refuse(reason: ResumeRefusalReason): ResumeRefusal {
    return { ok: false, reason, message: REFUSAL_MESSAGES[reason] }
}

function decodeBase64(value: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
        return null
    }
    try {
        const binary = atob(value)
        return Uint8Array.from(binary, (char) => char.charCodeAt(0))
    } catch {
        return null
    }
}

/**
 * Returns the AES-CTR counter block for the ciphertext byte at `byteOffset`, given the card's initial counter.
 * Only the low 64 bits advance (wrapping), matching WebCrypto `{ name: "AES-CTR", length: 64 }` and
 * `incrementCounter64By`. `byteOffset` must be a multiple of 16.
 */
export function counterAtByteOffset(initialCounter: Uint8Array, byteOffset: number): Uint8Array {
    if (initialCounter.length !== AES_BLOCK_BYTES) {
        throw new Error("AES-CTR counter blocks are 16 bytes.")
    }
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset % AES_BLOCK_BYTES !== 0) {
        throw new Error(`AES-CTR offsets must be non-negative multiples of 16 (got ${byteOffset}).`)
    }
    const result = new Uint8Array(initialCounter)
    let low = 0n
    for (let index = 8; index < 16; index += 1) {
        low = (low << 8n) | BigInt(result[index])
    }
    low = (low + BigInt(byteOffset / AES_BLOCK_BYTES)) & COUNTER_LOW_MASK
    for (let index = 15; index >= 8; index -= 1) {
        result[index] = Number(low & 0xffn)
        low >>= 8n
    }
    return result
}

/**
 * Parses a stored file-card message for resuming. Fails closed on anything that isn't a supported, well-formed,
 * incomplete card (unknown future versions included).
 */
export function parseResumableFileCard(message: unknown): { ok: true; card: ResumableFileCard } | ResumeRefusal {
    if (typeof message !== "string" || !message.startsWith(FILE_CARD_PREFIX)) {
        return refuse("not-a-file-card")
    }
    const jsonStart = message.indexOf("{")
    if (jsonStart < 0) {
        return refuse("malformed-card")
    }
    let raw: unknown
    try {
        raw = JSON.parse(message.substring(jsonStart))
    } catch {
        return refuse("malformed-card")
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return refuse("malformed-card")
    }
    const record = raw as Record<string, unknown>
    if (record.type !== undefined && record.type !== FILE_CARD_PREFIX) {
        return refuse("malformed-card")
    }
    if (record.version !== undefined && record.version !== 2 && record.version !== 3) {
        // Includes an explicit `version: 1`: only the *unversioned* shape is v1.
        return refuse("unsupported-version")
    }
    const data = parseFileCardMessage(message)
    if (!data) {
        return refuse("malformed-card")
    }
    const seen = new Set<number>()
    for (const chunk of data.chunks) {
        if (!Number.isSafeInteger(chunk) || chunk <= 0 || seen.has(chunk)) {
            return refuse("malformed-card")
        }
        seen.add(chunk)
    }
    if (!Number.isSafeInteger(data.size) || data.size < 0) {
        return refuse("malformed-card")
    }
    if (data.uploadComplete) {
        return refuse("already-complete")
    }
    const iv = decodeBase64(data.IV)
    if (!iv || iv.length !== 32) {
        return refuse("invalid-iv")
    }
    return {
        ok: true,
        card: {
            prefix: message.substring(0, jsonStart),
            raw: record,
            data,
            version: data.version,
            salt: iv.slice(0, 16),
            initialCounter: iv.slice(16),
        },
    }
}

/**
 * Decides where an interrupted upload continues, or why it can't. Completed chunk messages are durable resume
 * points; parts of an unfinished chunk are discarded and re-sent.
 */
export function planUploadResume(card: ResumableFileCard, input: ResumePlanInput): ResumePlanResult {
    if (input.ufid !== card.data.ufid) {
        return refuse("ufid-mismatch")
    }
    if (input.size !== card.data.size) {
        return refuse("size-mismatch")
    }
    const { chunkSize, partSize } = input
    if (
        !Number.isSafeInteger(chunkSize) ||
        !Number.isSafeInteger(partSize) ||
        partSize <= 0 ||
        chunkSize < partSize ||
        partSize % AES_BLOCK_BYTES !== 0 ||
        chunkSize % partSize !== 0 ||
        chunkSize % AES_BLOCK_BYTES !== 0
    ) {
        return refuse("unsupported-chunk-size")
    }
    const completedChunks = card.data.chunks.slice()
    if (input.chunkDocumentSizes.length !== completedChunks.length) {
        return refuse("missing-chunk")
    }
    for (const documentSize of input.chunkDocumentSizes) {
        if (documentSize === null) {
            return refuse("missing-chunk")
        }
    }
    for (const documentSize of input.chunkDocumentSizes) {
        if (documentSize !== chunkSize) {
            return refuse("chunk-size-mismatch")
        }
    }
    const resumeOffset = completedChunks.length * chunkSize
    if (!Number.isSafeInteger(resumeOffset)) {
        return refuse("unsupported-chunk-size")
    }

    const verifyWindows: ResumeVerifyWindow[] = []
    if (completedChunks.length > 0) {
        verifyWindows.push({
            chunkIndex: 0,
            offsetInChunk: 0,
            absoluteOffset: 0,
            length: Math.min(RESUME_HEAD_WINDOW_BYTES, chunkSize),
        })
        // One upload part at the end of every completed chunk: part-aligned, so it is also a valid
        // `upload.getFile` range (multiple of 4 KiB, within one 1 MiB block).
        const tailLength = Math.min(partSize, chunkSize)
        for (let chunkIndex = 0; chunkIndex < completedChunks.length; chunkIndex += 1) {
            const offsetInChunk = chunkSize - tailLength
            verifyWindows.push({
                chunkIndex,
                offsetInChunk,
                absoluteOffset: chunkIndex * chunkSize + offsetInChunk,
                length: tailLength,
            })
        }
    }

    return {
        ok: true,
        plan: {
            resumeOffset,
            nextChunkIndex: completedChunks.length,
            completedChunks,
            counter: counterAtByteOffset(card.initialCounter, resumeOffset),
            verifyWindows,
        },
    }
}

/**
 * Serializes the card with an updated chunk list / completion flag, keeping its prefix, protocol version, key
 * order and any unknown fields exactly as stored. Throws if the result would not parse back as the same version.
 */
export function serializeResumedFileCard(
    card: ResumableFileCard,
    update: { chunks: readonly number[]; uploadComplete: boolean },
): string {
    const next = { ...card.raw, chunks: update.chunks.slice(), uploadComplete: update.uploadComplete }
    const message = `${card.prefix}${JSON.stringify(next)}`
    const reparsed = parseFileCardMessage(message)
    if (!reparsed || reparsed.version !== card.version || reparsed.ufid !== card.data.ufid) {
        throw new Error("Refusing to edit the file card: the updated record would not keep its protocol version.")
    }
    return message
}

/** True when `bytes` start with a gzip member header (what a correctly decrypted TGLFS blob starts with). */
export function looksLikeGzipHeader(bytes: Uint8Array) {
    return bytes.length >= 4 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08 && (bytes[3] & 0xe0) === 0
}

/** Telegram document sizes arrive as numbers, bigints or GramJS BigInteger objects. */
export function coerceDocumentSize(value: unknown): number | null {
    let size: number
    if (typeof value === "number") {
        size = value
    } else if (typeof value === "bigint") {
        size = Number(value)
    } else if (value && typeof value === "object" && typeof (value as { toJSNumber?: unknown }).toJSNumber === "function") {
        size = (value as { toJSNumber(): number }).toJSNumber()
    } else if (typeof value === "string" && value.trim() !== "") {
        size = Number(value)
    } else {
        return null
    }
    return Number.isSafeInteger(size) && size >= 0 ? size : null
}
