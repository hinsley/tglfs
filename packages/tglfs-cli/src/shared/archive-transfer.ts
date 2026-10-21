import { Buffer } from "buffer"

import { deriveAESKeyFromPassword, ENCRYPTION_CHUNK_SIZE, incrementCounter, incrementCounter64By } from "../crypto.js"
import { UfidAccumulator } from "../ufid.js"
import { encodeArchiveStream, isArchiveStorageDescriptor, openArchive } from "./archive-format.js"
import type { ArchiveStorageDescriptor } from "./archive-format.js"
import { BUNDLED_CHUNK_SIZE, DOWNLOAD_PART_SIZE, TGLFS_ROOT_PARENT_ID, UPLOAD_PART_SIZE } from "./constants.js"
import { serializeFileCardMessage } from "./file-cards.js"
import type { FileCardData, FileCardRecord } from "./file-cards.js"
import { createFileCardV4Data } from "./protocol/file-card-v4.js"
import type { FileCardV4Data } from "./protocol/file-card-v4.js"

class ArchiveSourceError extends Error {}
class ArchiveTransportError extends Error {}
class ArchiveCleanupError extends Error {}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function transportRequest<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation()
    } catch (error) {
        throw new ArchiveTransportError(errorMessage(error), { cause: error })
    }
}

function sourceError(error: unknown): Error {
    if (error instanceof ArchiveTransportError || error instanceof ArchiveSourceError || (error instanceof Error && error.name === "AbortError")) return error
    return new ArchiveSourceError(errorMessage(error), { cause: error })
}

export type ArchiveTransferApi = {
    upload: {
        GetFile: new (args: any) => any
        SaveBigFilePart: new (args: any) => any
    }
    messages?: {
        DeleteMessages: new (args: any) => any
    }
    InputFileBig: new (args: any) => any
}

export type ArchiveTransferClient = {
    getMessages(peer: string, options: any): Promise<any[]>
    invoke(request: any): Promise<any>
    sendFile(peer: string, options: { file: any }): Promise<any>
    sendMessage(peer: string, options: { message: string }): Promise<any>
}

export type ArchiveTransferProgress = {
    phase: "reading" | "uploading" | "verifying"
    bytesProcessed: number
    totalBytes: number
}

export type ArchiveTransferOptions = {
    Api: ArchiveTransferApi
    getFileInfo(media: any): { location: any }
    peer?: string
    chunkSize?: number
    signal?: AbortSignal
    onProgress?: (progress: ArchiveTransferProgress) => void
}

export type ArchiveUploadSource = {
    name: string
    size: number
    stream(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

export type ArchiveUpgradeCapability = {
    supported: boolean
    reason: string
    current: boolean
}

export function getArchiveUpgradeCapability(data: FileCardData): ArchiveUpgradeCapability {
    const version = (data as { version?: unknown }).version
    if (version === 5 && "content" in data && data.content.archive) return { supported: false, current: true, reason: "This archive already supports browsing and resumable transfers." }
    if (version === 4 && "archive" in data && isArchiveStorageDescriptor(data.archive)) {
        return { supported: false, current: true, reason: "This archive already supports browsing." }
    }
    if (version !== 1 && version !== 2 && version !== 3) {
        return { supported: false, current: false, reason: "This file protocol version is not supported." }
    }
    if (!data.uploadComplete) {
        return { supported: false, current: false, reason: "The archive upload is incomplete." }
    }
    if (!/\.tar$/i.test(data.name)) {
        return { supported: false, current: false, reason: "Only tar archives can be upgraded for browsing." }
    }
    return { supported: true, current: false, reason: "Create a browsable copy while keeping the original." }
}

export function isUpgradeableArchive(data: FileCardData): boolean {
    return getArchiveUpgradeCapability(data).supported
}

function abortIfRequested(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new DOMException("Archive operation cancelled.", "AbortError")
    }
}

function emitProgress(options: ArchiveTransferOptions, progress: ArchiveTransferProgress) {
    try {
        options.onProgress?.(progress)
    } catch {
        // Display errors must not invalidate an uploaded archive.
    }
}

function documentSize(value: unknown): number {
    const size = typeof value === "number" ? value : Number(String(value))
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new ArchiveTransportError("The archive references a Telegram document with an invalid size.")
    }
    return size
}

function validateChunkIds(chunks: number[]) {
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(chunks).size !== chunks.length) {
        throw new ArchiveTransportError("The archive has missing or invalid Telegram chunk references.")
    }
}

export async function createTelegramArchiveRangeReader(
    client: ArchiveTransferClient,
    chunks: number[],
    options: ArchiveTransferOptions,
) {
    validateChunkIds(chunks)
    const peer = options.peer?.trim() || "me"
    const documents: { id: number; message: any; offset: number; size: number }[] = []
    let totalSize = 0
    for (let start = 0; start < chunks.length; start += 100) {
        abortIfRequested(options.signal)
        const ids = chunks.slice(start, start + 100)
        const messages = await transportRequest(() => client.getMessages(peer, { ids, waitTime: 0 }))
        const messageMap = new Map(messages.filter(Boolean).map((message) => [message.id, message]))
        for (const id of ids) {
            const message = messageMap.get(id)
            if (!message?.media?.document) {
                throw new ArchiveTransportError(`Archive chunk message ${id} is missing or is not a Telegram document.`)
            }
            const size = documentSize(message.media.document.size)
            if (size === 0 || !Number.isSafeInteger(totalSize + size)) {
                throw new ArchiveTransportError(`Archive chunk message ${id} has an invalid size.`)
            }
            documents.push({ id, message, offset: totalSize, size })
            totalSize += size
        }
    }
    let cached: { id: number; offset: number; bytes: Uint8Array } | undefined
    const readRange = async (offset: number, length: number): Promise<Uint8Array> => {
        abortIfRequested(options.signal)
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > totalSize) {
            throw new Error("The requested archive byte range is invalid.")
        }
        const output = new Uint8Array(length)
        let written = 0
        let documentIndex = documents.findIndex((document) => offset < document.offset + document.size)
        while (written < length) {
            abortIfRequested(options.signal)
            const document = documents[documentIndex]
            if (!document) throw new Error("The archive byte range exceeds the available chunks.")
            const localOffset = offset + written - document.offset
            const pageOffset = Math.floor(localOffset / DOWNLOAD_PART_SIZE) * DOWNLOAD_PART_SIZE
            let page = cached
            if (!page || page.id !== document.id || page.offset !== pageOffset) {
                const part = await transportRequest(() => client.invoke(new options.Api.upload.GetFile({
                    location: options.getFileInfo(document.message.media).location,
                    offset: pageOffset,
                    limit: DOWNLOAD_PART_SIZE,
                    precise: false,
                    cdnSupported: false,
                })))
                abortIfRequested(options.signal)
                const bytes = part?.bytes
                if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > DOWNLOAD_PART_SIZE || bytes.length < Math.min(DOWNLOAD_PART_SIZE, document.size - pageOffset)) {
                    throw new ArchiveTransportError(`Telegram returned an incomplete response for archive chunk ${document.id}.`)
                }
                page = { id: document.id, offset: pageOffset, bytes }
                cached = page
            }
            const withinPage = localOffset - pageOffset
            const count = Math.min(length - written, page.bytes.length - withinPage, document.size - localOffset)
            if (count <= 0) throw new ArchiveTransportError("Telegram returned an invalid archive byte range.")
            output.set(page.bytes.subarray(withinPage, withinPage + count), written)
            written += count
            if (offset + written === document.offset + document.size) documentIndex += 1
        }
        return output
    }
    const stream = () => {
        let offset = 0
        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (offset === totalSize) {
                    controller.close()
                    return
                }
                try {
                    const bytes = await readRange(offset, Math.min(DOWNLOAD_PART_SIZE, totalSize - offset))
                    offset += bytes.length
                    controller.enqueue(bytes)
                } catch (error) {
                    controller.error(error)
                }
            },
        }, { highWaterMark: 0 })
    }
    return { size: totalSize, readRange, stream }
}

export async function openRemoteArchive(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions & { record: FileCardRecord; password: string },
) {
    if (options.record.data.version === 5 && options.record.data.content.archive) {
        const { openBlockFile } = await import("./block-transfer.js")
        const { asArchiveReader } = await import("./block-format.js")
        return asArchiveReader(await openBlockFile(client, { ...options, data: options.record.data }))
    }
    if (options.record.data.version !== 4 || !("archive" in options.record.data) || !options.record.data.uploadComplete) {
        throw new Error("This archive does not support browsing or has an incomplete upload.")
    }
    const reader = await openRemoteArchiveStorage(client, options.record.data.chunks, options.record.data.archive, options.password, options)
    if (reader.index.size !== options.record.data.size || reader.index.ufid !== options.record.data.ufid) {
        throw new Error("The encrypted archive index does not match its file card size or UFID.")
    }
    return reader
}

async function openRemoteArchiveStorage(
    client: ArchiveTransferClient,
    chunks: number[],
    storage: ArchiveStorageDescriptor,
    password: string,
    options: ArchiveTransferOptions,
) {
    const remote = await createTelegramArchiveRangeReader(client, chunks, options)
    if (remote.size !== storage.storedSize) {
        throw new Error("The archive document sizes do not match its storage descriptor.")
    }
    return openArchive(storage, password, remote.readRange, { signal: options.signal })
}

async function originalArchiveStream(
    client: ArchiveTransferClient,
    data: FileCardData,
    password: string,
    options: ArchiveTransferOptions,
    mode: "current" | "legacy",
): Promise<ReadableStream<Uint8Array>> {
    if (data.version !== 1 && data.version !== 2 && data.version !== 3) {
        throw new Error("This archive protocol version cannot be upgraded by this client.")
    }
    const iv = Uint8Array.from(Buffer.from(data.IV, "base64"))
    if (iv.length !== 32) throw new ArchiveSourceError("The original archive has an invalid encryption header.")
    const salt = iv.subarray(0, 16)
    let counter = iv.slice(16)
    const key = await deriveAESKeyFromPassword(password, salt)
    const remote = await createTelegramArchiveRangeReader(client, data.chunks, options)
    const reader = remote.stream().getReader()
    const buffer = new Uint8Array(ENCRYPTION_CHUNK_SIZE)
    let pending: Uint8Array | undefined
    let pendingOffset = 0
    let finished = false
    const decrypted = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                abortIfRequested(options.signal)
                let filled = 0
                while (filled < buffer.length && !finished) {
                    if (!pending || pendingOffset === pending.length) {
                        const { done, value } = await reader.read()
                        if (done) {
                            finished = true
                            break
                        }
                        pending = value
                        pendingOffset = 0
                    }
                    const count = Math.min(buffer.length - filled, pending.length - pendingOffset)
                    buffer.set(pending.subarray(pendingOffset, pendingOffset + count), filled)
                    pendingOffset += count
                    filled += count
                }
                if (filled === 0) {
                    controller.close()
                    reader.releaseLock()
                    return
                }
                const bytes = new Uint8Array(await globalThis.crypto.subtle.decrypt(
                    { name: "AES-CTR", counter, length: 64 }, key, buffer.subarray(0, filled),
                ))
                counter = mode === "legacy" ? incrementCounter(counter) : incrementCounter64By(counter, Math.ceil(filled / 16))
                controller.enqueue(bytes)
            } catch (error) {
                await reader.cancel(error).catch(() => {})
                controller.error(error)
            }
        },
        async cancel(reason) {
            await reader.cancel(reason)
        },
    }, { highWaterMark: 0 })
    const decompressedReader = decrypted.pipeThrough(new DecompressionStream("gzip")).getReader()
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                abortIfRequested(options.signal)
                const { done, value } = await decompressedReader.read()
                if (done) controller.close()
                else controller.enqueue(value)
            } catch (error) {
                controller.error(sourceError(error))
            }
        },
        async cancel(reason) {
            await decompressedReader.cancel(reason)
        },
    }, { highWaterMark: 0 })
}

function createUploadFileId() {
    const random = globalThis.crypto.getRandomValues(new Uint32Array(2))
    return (BigInt(random[0] & 0x001fffff) << 32n) | BigInt(random[1])
}

function createTelegramUploadSink(client: ArchiveTransferClient, options: ArchiveTransferOptions, chunkIds: number[]) {
    const peer = options.peer?.trim() || "me"
    const chunkSize = options.chunkSize ?? BUNDLED_CHUNK_SIZE
    if (!Number.isSafeInteger(chunkSize) || chunkSize < UPLOAD_PART_SIZE || chunkSize % UPLOAD_PART_SIZE !== 0) {
        throw new Error("Archive chunk size must be a positive multiple of 512 KiB.")
    }
    const buffer = new Uint8Array(UPLOAD_PART_SIZE)
    let buffered = 0
    let chunkBytes = 0
    let partIndex = 0
    let fileId = createUploadFileId()
    const operationId = globalThis.crypto.randomUUID()
    const uploadPart = async (final: boolean) => {
        abortIfRequested(options.signal)
        const success = await transportRequest(() => client.invoke(new options.Api.upload.SaveBigFilePart({
            fileId, filePart: partIndex, fileTotalParts: final ? partIndex + 1 : -1,
            bytes: Buffer.from(buffer.subarray(0, buffered)),
        })))
        if (!success) throw new ArchiveTransportError("Telegram rejected an archive upload part.")
        partIndex += 1
        buffered = 0
    }
    const finishChunk = async () => {
        if (partIndex === 0) return
        abortIfRequested(options.signal)
        const message = await transportRequest(() => client.sendFile(peer, { file: new options.Api.InputFileBig({
            id: fileId, parts: partIndex, name: `${operationId}.archive-part${chunkIds.length + 1}`,
        }) }))
        if (!Number.isSafeInteger(message?.id) || message.id <= 0) {
            throw new ArchiveTransportError("Telegram did not return an archive chunk message id.")
        }
        chunkIds.push(message.id)
        fileId = createUploadFileId()
        partIndex = 0
        chunkBytes = 0
    }
    return {
        async write(bytes: Uint8Array) {
            let offset = 0
            while (offset < bytes.length) {
                abortIfRequested(options.signal)
                const count = Math.min(bytes.length - offset, buffer.length - buffered, chunkSize - chunkBytes)
                buffer.set(bytes.subarray(offset, offset + count), buffered)
                buffered += count
                chunkBytes += count
                offset += count
                if (buffered === buffer.length) await uploadPart(chunkBytes === chunkSize)
                if (chunkBytes === chunkSize) await finishChunk()
            }
        },
        async close() {
            if (buffered > 0) await uploadPart(true)
            await finishChunk()
        },
    }
}

export async function verifyRemoteArchive(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions & { data: FileCardV4Data; password: string },
) {
    const archive = await openRemoteArchiveStorage(client, options.data.chunks, options.data.archive, options.password, options)
    const accumulator = new UfidAccumulator()
    const reader = archive.stream().getReader()
    let bytesProcessed = 0
    try {
        while (true) {
            abortIfRequested(options.signal)
            const { done, value } = await reader.read()
            if (done) break
            if (!value?.length) continue
            bytesProcessed += value.length
            if (bytesProcessed > options.data.size) throw new Error("The upgraded archive exceeds its expected size.")
            await accumulator.update(value)
            emitProgress(options, { phase: "verifying", bytesProcessed, totalBytes: options.data.size })
        }
        const ufid = await accumulator.digest()
        if (bytesProcessed !== options.data.size || ufid !== options.data.ufid) {
            throw new Error("The upgraded archive failed its size or UFID verification.")
        }
        return { size: bytesProcessed, ufid }
    } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

export async function uploadIndexedArchive(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions & {
        source: ArchiveUploadSource
        password: string
        parentFolderId?: string
        upgradedFrom?: FileCardV4Data["upgradedFrom"]
        expectedUfid?: string
    },
): Promise<FileCardRecord> {
    abortIfRequested(options.signal)
    const peer = options.peer?.trim() || "me"
    const chunkIds: number[] = []
    const sink = createTelegramUploadSink(client, options, chunkIds)
    let published = false
    try {
        let sourceBytes = 0
        const source = (await options.source.stream()).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(bytes, controller) {
                sourceBytes += bytes.length
                if (sourceBytes > options.source.size) throw new ArchiveSourceError("The source archive exceeds its expected size.")
                controller.enqueue(bytes)
            },
        }))
        const encoded = await encodeArchiveStream(source, {
            password: options.password,
            signal: options.signal,
            onProgress(bytesProcessed) {
                emitProgress(options, { phase: "reading", bytesProcessed, totalBytes: options.source.size })
            },
        }, async (bytes) => {
            await sink.write(bytes)
            emitProgress(options, { phase: "uploading", bytesProcessed: sourceBytes, totalBytes: options.source.size })
        }).catch((error) => { throw sourceError(error) })
        if (encoded.size !== options.source.size || (options.expectedUfid !== undefined && encoded.ufid !== options.expectedUfid)) {
            throw new ArchiveSourceError("The source archive failed its size or UFID verification. Its original copy was preserved.")
        }
        await sink.close()
        const data = createFileCardV4Data({
            version: 4,
            name: options.source.name,
            size: encoded.size,
            ufid: encoded.ufid,
            uploadComplete: true,
            chunks: chunkIds,
            IV: "",
            parentFolderId: options.parentFolderId?.trim() || TGLFS_ROOT_PARENT_ID,
            archive: encoded.storage,
            ...(options.upgradedFrom ? { upgradedFrom: options.upgradedFrom } : {}),
        })
        await verifyRemoteArchive(client, { ...options, data })
        abortIfRequested(options.signal)
        published = true
        const message = await client.sendMessage(peer, { message: serializeFileCardMessage(data) })
        return { msgId: message.id, date: message.date, data }
    } catch (error) {
        if (!published && chunkIds.length > 0) {
            if (options.Api.messages?.DeleteMessages) {
                try {
                    for (let start = 0; start < chunkIds.length; start += 100) {
                        await client.invoke(new options.Api.messages.DeleteMessages({ id: chunkIds.slice(start, start + 100) }))
                    }
                } catch {
                    throw new ArchiveCleanupError(`${errorMessage(error)} Incomplete new upload chunks could not be removed: ${chunkIds.join(", ")}. The original archive was preserved.`, { cause: error })
                }
            } else {
                throw new ArchiveCleanupError(`${errorMessage(error)} Incomplete new upload chunks remain: ${chunkIds.join(", ")}. The original archive was preserved.`, { cause: error })
            }
        }
        throw error
    }
}

export async function upgradeArchive(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions & { source: FileCardRecord; password: string },
): Promise<FileCardRecord> {
    const capability = getArchiveUpgradeCapability(options.source.data)
    if (!capability.supported) throw new Error(capability.reason)
    const original = options.source.data
    const attempt = (mode: "current" | "legacy") => uploadIndexedArchive(client, {
        ...options,
        source: {
            name: original.name,
            size: original.size,
            stream: () => originalArchiveStream(client, original, options.password, options, mode),
        },
        parentFolderId: "parentFolderId" in original ? original.parentFolderId : TGLFS_ROOT_PARENT_ID,
        expectedUfid: original.ufid,
        upgradedFrom: {
            type: "tglfs:archive-source",
            version: 1,
            messageId: options.source.msgId,
            fileVersion: original.version,
            peer: options.peer?.trim() || "me",
            ufid: original.ufid,
        },
    })
    try {
        return await attempt("current")
    } catch (error) {
        abortIfRequested(options.signal)
        if (!(error instanceof ArchiveSourceError)) throw error
        return attempt("legacy")
    }
}
