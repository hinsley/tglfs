/**
 * Streaming encrypt → part → chunk pipeline for the web upload, written so an interrupted upload can be resumed at
 * a chunk boundary with byte-identical ciphertext (see `upload-resume.ts` for the correctness argument).
 *
 * DOM-free: uses `globalThis.crypto.subtle`, so the Node tests drive exactly this code.
 *
 * Byte layout (unchanged from the original web uploader when `chunkSize` is a multiple of `partSize`):
 * - ciphertext = AES-CTR over the gzip stream, counter `initialCounter + offset / 16` (low 64 bits);
 * - each Telegram chunk holds exactly `chunkSize` ciphertext bytes (the last chunk holds the rest);
 * - each chunk is sent as `partSize` parts (the chunk's last part may be shorter).
 */

import { counterAtByteOffset } from "./upload-resume.js"
import type { ResumeVerifyWindow } from "./upload-resume.js"

export type UploadPartRequest = {
    fileId: bigint
    filePart: number
    /** -1 while more parts may follow, otherwise the chunk's part count. */
    fileTotalParts: number
    /** Only valid until the returned promise settles; copy it if you keep it. */
    bytes: Uint8Array
}

export type FinalizeChunkRequest = {
    fileId: bigint
    parts: number
    /** 0-based chunk index within the file. */
    chunkIndex: number
    /** Ciphertext bytes in the chunk. */
    size: number
    /** True for the file's final chunk (the card can be marked complete in the same edit). */
    last: boolean
}

export type UploadChunkSink = {
    savePart(request: UploadPartRequest): Promise<void>
    finalizeChunk(request: FinalizeChunkRequest): Promise<void>
}

export class UploadResumeMismatchError extends Error {
    readonly window: ResumeVerifyWindow | null

    constructor(message: string, window: ResumeVerifyWindow | null = null) {
        super(message)
        this.name = "UploadResumeMismatchError"
        this.window = window
    }
}

export const RESUME_COMPRESSION_MISMATCH_MESSAGE =
    "This browser doesn't reproduce the already-uploaded data byte for byte (its compressor differs from the one that started the upload), so the upload can't be resumed here. Nothing was changed. Delete the incomplete file and upload it again, or resume in the browser that started it."

function randomUploadFileId() {
    const random = globalThis.crypto.getRandomValues(new Uint32Array(2))
    return (BigInt(random[0] & 0x001fffff) << 32n) | BigInt(random[1])
}

/** Encrypts `bytes` as the ciphertext at `byteOffset` (a multiple of 16) of a stream started at `initialCounter`. */
export async function encryptCtrAt(
    key: CryptoKey,
    initialCounter: Uint8Array,
    byteOffset: number,
    bytes: Uint8Array,
): Promise<Uint8Array> {
    const counter = counterAtByteOffset(initialCounter, byteOffset)
    return new Uint8Array(
        await globalThis.crypto.subtle.encrypt({ name: "AES-CTR", counter: counter as BufferSource, length: 64 }, key, bytes as BufferSource),
    )
}

/** Buffers plaintext into `bufferSize` blocks and encrypts each at its absolute stream offset. */
export class CtrStreamEncryptor {
    private readonly buffer: Uint8Array
    private filled = 0
    private offset: number

    constructor(
        private readonly key: CryptoKey,
        private readonly initialCounter: Uint8Array,
        options: { startOffset: number; bufferSize: number },
    ) {
        if (options.bufferSize <= 0 || options.bufferSize % 16 !== 0) {
            throw new Error("The encryption buffer size must be a positive multiple of 16.")
        }
        if (options.startOffset % 16 !== 0) {
            throw new Error("Encryption can only start at a 16-byte-aligned offset.")
        }
        this.buffer = new Uint8Array(options.bufferSize)
        this.offset = options.startOffset
    }

    async push(bytes: Uint8Array, emit: (ciphertext: Uint8Array) => Promise<void>) {
        let index = 0
        while (index < bytes.length) {
            const count = Math.min(bytes.length - index, this.buffer.length - this.filled)
            this.buffer.set(bytes.subarray(index, index + count), this.filled)
            this.filled += count
            index += count
            if (this.filled === this.buffer.length) {
                await this.emitBuffer(emit)
            }
        }
    }

    async flush(emit: (ciphertext: Uint8Array) => Promise<void>) {
        if (this.filled > 0) {
            await this.emitBuffer(emit)
        }
    }

    private async emitBuffer(emit: (ciphertext: Uint8Array) => Promise<void>) {
        const ciphertext = await encryptCtrAt(this.key, this.initialCounter, this.offset, this.buffer.subarray(0, this.filled))
        this.offset += this.filled
        this.filled = 0
        await emit(ciphertext)
    }
}

/** Splits ciphertext into Telegram upload parts and chunk documents. */
export class ChunkedPartWriter {
    private readonly partBuffer: Uint8Array
    private partBytes = 0
    private partIndex = 0
    private chunkBytes = 0
    private chunkIndex: number
    private fileId: bigint

    constructor(
        private readonly sink: UploadChunkSink,
        private readonly options: {
            chunkSize: number
            partSize: number
            startChunkIndex?: number
            createFileId?: () => bigint
        },
    ) {
        if (options.partSize <= 0 || options.chunkSize < options.partSize) {
            throw new Error(`chunkSize (${options.chunkSize}) must be at least the upload part size (${options.partSize}).`)
        }
        this.partBuffer = new Uint8Array(options.partSize)
        this.chunkIndex = options.startChunkIndex ?? 0
        this.fileId = this.newFileId()
    }

    private newFileId() {
        return (this.options.createFileId ?? randomUploadFileId)()
    }

    async write(bytes: Uint8Array) {
        let index = 0
        while (index < bytes.length) {
            if (this.partBytes === this.partBuffer.length) {
                // A full part is held back until we know more data follows, so the final part of the file is
                // always sent with its real part count (never as an empty trailing part).
                await this.sendPart(-1)
            }
            const count = Math.min(
                bytes.length - index,
                this.partBuffer.length - this.partBytes,
                this.options.chunkSize - this.chunkBytes,
            )
            this.partBuffer.set(bytes.subarray(index, index + count), this.partBytes)
            this.partBytes += count
            this.chunkBytes += count
            index += count
            if (this.chunkBytes === this.options.chunkSize) {
                await this.sendPart(this.partIndex + 1)
                await this.finalize(false)
            }
        }
    }

    /** Sends whatever is pending as the file's final chunk. Returns false when nothing was pending. */
    async finish(): Promise<boolean> {
        if (this.partBytes === 0) {
            return false
        }
        await this.sendPart(this.partIndex + 1)
        await this.finalize(true)
        return true
    }

    private async sendPart(fileTotalParts: number) {
        await this.sink.savePart({
            fileId: this.fileId,
            filePart: this.partIndex,
            fileTotalParts,
            bytes: this.partBuffer.subarray(0, this.partBytes),
        })
        this.partIndex += 1
        this.partBytes = 0
    }

    private async finalize(last: boolean) {
        await this.sink.finalizeChunk({
            fileId: this.fileId,
            parts: this.partIndex,
            chunkIndex: this.chunkIndex,
            size: this.chunkBytes,
            last,
        })
        this.chunkIndex += 1
        this.chunkBytes = 0
        this.partIndex = 0
        this.fileId = this.newFileId()
    }
}

export type UploadPipelineResume = {
    /** Ciphertext offset of the first byte to upload (a chunk boundary). */
    offset: number
    /** Index of the first chunk to upload. */
    startChunkIndex: number
    /** Already-stored ciphertext ranges to reproduce and compare before anything new is sent. */
    verifyWindows: ResumeVerifyWindow[]
    /** Returns the stored ciphertext for a window (e.g. downloaded from Telegram). */
    fetchReference(window: ResumeVerifyWindow): Promise<Uint8Array>
    /** Progress while re-reading the already-uploaded prefix. */
    onFastForward?(compressedOffset: number, resumeOffset: number): void
    /** Called once every window matched and the stream reached the resume offset; nothing has been sent before it. */
    onResumePoint?(): void | Promise<void>
}

export type UploadPipelineOptions = {
    /** The gzip-compressed plaintext, from byte 0 (also when resuming). */
    compressed: ReadableStreamDefaultReader<Uint8Array>
    key: CryptoKey
    initialCounter: Uint8Array
    chunkSize: number
    partSize: number
    encryptionBufferSize: number
    sink: UploadChunkSink
    resume?: UploadPipelineResume
    /** Called before every read; throw to stop (e.g. on cancel). */
    checkpoint?(): void
    onCompressedBytes?(byteCount: number): void
    createFileId?: () => bigint
}

export type UploadPipelineResult = {
    /** Total ciphertext (= compressed) length. */
    totalBytes: number
    /** False when the stream ended exactly at a chunk boundary, so no final chunk carried `last: true`. */
    finalChunkSent: boolean
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false
    }
    return true
}

export async function runUploadPipeline(options: UploadPipelineOptions): Promise<UploadPipelineResult> {
    const resume = options.resume
    const resumeOffset = resume?.offset ?? 0
    if (resume) {
        if (resumeOffset % options.chunkSize !== 0 || resume.startChunkIndex !== resumeOffset / options.chunkSize) {
            throw new Error("Uploads can only resume at a chunk boundary.")
        }
    }
    const encryptor = new CtrStreamEncryptor(options.key, options.initialCounter, {
        startOffset: resumeOffset,
        bufferSize: options.encryptionBufferSize,
    })
    const writer = new ChunkedPartWriter(options.sink, {
        chunkSize: options.chunkSize,
        partSize: options.partSize,
        startChunkIndex: resume?.startChunkIndex ?? 0,
        createFileId: options.createFileId,
    })
    const emit = (ciphertext: Uint8Array) => writer.write(ciphertext)

    const windows = (resume?.verifyWindows ?? [])
        .slice()
        .sort((a, b) => a.absoluteOffset - b.absoluteOffset)
        .map((window) => ({ window, buffer: null as Uint8Array | null, filled: 0, verified: false }))
    for (const { window } of windows) {
        if (window.absoluteOffset % 16 !== 0 || window.absoluteOffset + window.length > resumeOffset) {
            throw new Error("Resume verification windows must be 16-byte aligned and lie before the resume offset.")
        }
    }

    const verifyWindow = async (entry: (typeof windows)[number]) => {
        const reproduced = await encryptCtrAt(options.key, options.initialCounter, entry.window.absoluteOffset, entry.buffer!)
        const stored = await resume!.fetchReference(entry.window)
        if (!bytesEqual(reproduced, stored)) {
            throw new UploadResumeMismatchError(RESUME_COMPRESSION_MISMATCH_MESSAGE, entry.window)
        }
        entry.verified = true
        entry.buffer = null
    }

    /** Feeds re-compressed bytes that are already stored (before the resume offset) into the verify windows. */
    const consumeStoredPrefix = async (bytes: Uint8Array, at: number) => {
        const end = at + bytes.length
        for (const entry of windows) {
            if (entry.verified) continue
            const windowStart = entry.window.absoluteOffset
            const windowEnd = windowStart + entry.window.length
            if (windowStart >= end) break
            const from = Math.max(at, windowStart)
            const to = Math.min(end, windowEnd)
            if (from >= to) continue
            entry.buffer ??= new Uint8Array(entry.window.length)
            entry.buffer.set(bytes.subarray(from - at, to - at), from - windowStart)
            entry.filled += to - from
            if (entry.filled === entry.window.length) {
                await verifyWindow(entry)
            }
        }
    }

    let position = 0
    let resumed = !resume
    const reachResumePoint = async () => {
        if (resumed) return
        if (windows.some((entry) => !entry.verified)) {
            throw new UploadResumeMismatchError(RESUME_COMPRESSION_MISMATCH_MESSAGE)
        }
        resumed = true
        await resume?.onResumePoint?.()
    }
    if (resume && resumeOffset === 0) {
        await reachResumePoint()
    }

    while (true) {
        options.checkpoint?.()
        const { done, value } = await options.compressed.read()
        if (done) break
        if (!value || value.length === 0) continue
        options.onCompressedBytes?.(value.length)
        let index = 0
        if (position < resumeOffset) {
            const take = Math.min(value.length, resumeOffset - position)
            await consumeStoredPrefix(value.subarray(0, take), position)
            position += take
            index = take
            resume?.onFastForward?.(position, resumeOffset)
            if (position === resumeOffset) {
                await reachResumePoint()
            }
        }
        if (index < value.length) {
            await encryptor.push(value.subarray(index), emit)
            position += value.length - index
        }
    }

    if (position < resumeOffset) {
        // The re-compressed stream is shorter than what is already stored: it can't be the same stream.
        throw new UploadResumeMismatchError(RESUME_COMPRESSION_MISMATCH_MESSAGE)
    }
    await reachResumePoint()
    await encryptor.flush(emit)
    const finalChunkSent = await writer.finish()
    return { totalBytes: position, finalChunkSent }
}
