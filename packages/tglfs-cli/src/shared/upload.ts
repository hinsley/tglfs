import { Buffer } from "buffer"

import { deriveAESKeyFromPassword, ENCRYPTION_CHUNK_SIZE, incrementCounter64By } from "../crypto.js"
import { computeUfidFromStream } from "../ufid.js"
import { UPLOAD_PART_SIZE } from "./constants.js"
import { serializeFileCardMessage } from "./file-cards.js"
import { lookupFileCardByUfid } from "./telegram-files.js"
import type { FileCardData, FileCardRecord } from "./file-cards.js"

type UploadApiLike = {
    messages: {
        EditMessage: new (args: any) => any
    }
    upload: {
        SaveBigFilePart: new (args: any) => any
    }
    InputFileBig: new (args: any) => any
}

type UploadClient = {
    sendMessage(peer: string, options: { message: string }): Promise<any>
    sendFile(peer: string, options: { file: any }): Promise<any>
    invoke(request: any): Promise<any>
    getMessages(peer: string, options: unknown): Promise<any[]>
}

export type UploadSource = {
    name: string
    size: number
    stream(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

export type UploadProgress = {
    bytesProcessed: number
    totalBytes: number
}

export type UploadCurrentFormatOptions = {
    Api: UploadApiLike
    peer?: string
    chunkSize: number
    password: string
    source: UploadSource
    onUfidProgress?: (progress: UploadProgress) => void
    onUploadProgress?: (progress: UploadProgress) => void
}

export class DuplicateUfidError extends Error {
    readonly ufid: string

    constructor(ufid: string) {
        super(`A file with UFID ${ufid} already exists.`)
        this.name = "DuplicateUfidError"
        this.ufid = ufid
    }
}

function createUploadFileId() {
    const random = globalThis.crypto.getRandomValues(new Uint32Array(2))
    return (BigInt(random[0] & 0x001fffff) << 32n) | BigInt(random[1])
}

function createIvBytes(salt: Uint8Array, counter: Uint8Array) {
    const bytes = new Uint8Array(salt.length + counter.length)
    bytes.set(salt, 0)
    bytes.set(counter, salt.length)
    return bytes
}

function resolvePeer(peer?: string) {
    return peer?.trim() ? peer.trim() : "me"
}

export async function uploadCurrentFormatSource(
    client: UploadClient,
    options: UploadCurrentFormatOptions,
): Promise<FileCardRecord> {
    if (options.chunkSize < UPLOAD_PART_SIZE) {
        throw new Error(
            `chunkSize (${options.chunkSize}) must be at least UPLOAD_PART_SIZE (${UPLOAD_PART_SIZE}).`,
        )
    }

    const peer = resolvePeer(options.peer)
    const totalBytes = options.source.size
    const ufid = await computeUfidFromStream(
        await options.source.stream(),
        (bytesProcessed, streamTotalBytes) => options.onUfidProgress?.({ bytesProcessed, totalBytes: streamTotalBytes }),
        totalBytes,
    )

    const duplicate = await lookupFileCardByUfid(client, ufid, { peer })
    if (duplicate) {
        throw new DuplicateUfidError(ufid)
    }

    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const initialCounter = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const aesKey = await deriveAESKeyFromPassword(options.password, salt)
    let encryptionCounter = new Uint8Array(initialCounter)
    let fileCardData: FileCardData = {
        name: options.source.name,
        ufid,
        size: totalBytes,
        uploadComplete: false,
        chunks: [],
        IV: Buffer.from(createIvBytes(salt, initialCounter)).toString("base64"),
    }

    const fileCardMessage = await client.sendMessage(peer, {
        message: serializeFileCardMessage(fileCardData),
    })

    let uploadBytesProcessed = 0
    const byteCounterStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            uploadBytesProcessed += chunk.length
            options.onUploadProgress?.({ bytesProcessed: uploadBytesProcessed, totalBytes })
            controller.enqueue(chunk)
        },
    })
    const sourceStream = await options.source.stream()
    const reader = sourceStream.pipeThrough(byteCounterStream).pipeThrough(new CompressionStream("gzip")).getReader()

    let chunkIndex = 0
    let chunkBytesWritten = 0
    let chunkFileId = createUploadFileId()
    let nextPartIndex = 0
    const partBuffer = new Uint8Array(UPLOAD_PART_SIZE)
    let partBufferLength = 0
    const encryptionBuffer = new Uint8Array(ENCRYPTION_CHUNK_SIZE)
    let encryptionBufferLength = 0

    const uploadPart = async (fileTotalParts: number) => {
        const bytes = partBuffer.subarray(0, partBufferLength)
        const result = await client.invoke(
            new options.Api.upload.SaveBigFilePart({
                fileId: chunkFileId,
                filePart: nextPartIndex,
                fileTotalParts,
                bytes: Buffer.from(bytes),
            }),
        )
        if (!result) {
            throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${nextPartIndex + 1}.`)
        }
        nextPartIndex += 1
        partBufferLength = 0
    }

    const finalizeChunk = async (uploadComplete: boolean) => {
        if (nextPartIndex === 0) {
            return
        }

        const uploadedChunk = new options.Api.InputFileBig({
            id: chunkFileId,
            parts: nextPartIndex,
            name: `${ufid}.chunk${chunkIndex + 1}`,
        })
        const chunkMessage = await client.sendFile(peer, { file: uploadedChunk })
        fileCardData = {
            ...fileCardData,
            uploadComplete,
            chunks: [...fileCardData.chunks, chunkMessage.id],
        }
        await client.invoke(
            new options.Api.messages.EditMessage({
                peer: fileCardMessage.peerId,
                id: fileCardMessage.id,
                message: serializeFileCardMessage(fileCardData),
            }),
        )

        chunkIndex += 1
        chunkBytesWritten = 0
        chunkFileId = createUploadFileId()
        nextPartIndex = 0
    }

    const appendEncryptedBytes = async (bytes: Uint8Array) => {
        let offset = 0

        while (offset < bytes.length) {
            const remainingChunkSpace = options.chunkSize - chunkBytesWritten
            const bytesToCopy = Math.min(bytes.length - offset, UPLOAD_PART_SIZE - partBufferLength, remainingChunkSpace)
            partBuffer.set(bytes.subarray(offset, offset + bytesToCopy), partBufferLength)
            offset += bytesToCopy
            partBufferLength += bytesToCopy
            chunkBytesWritten += bytesToCopy

            const partFull = partBufferLength === UPLOAD_PART_SIZE
            const chunkFull = chunkBytesWritten === options.chunkSize
            if (chunkFull) {
                await uploadPart(nextPartIndex + 1)
                await finalizeChunk(false)
                continue
            }
            if (partFull) {
                await uploadPart(-1)
            }
        }
    }

    while (true) {
        const { done, value } = await reader.read()
        if (done) {
            break
        }
        if (!value || value.length === 0) {
            continue
        }

        let valueOffset = 0
        while (valueOffset < value.length) {
            const bytesToCopy = Math.min(value.length - valueOffset, encryptionBuffer.length - encryptionBufferLength)
            encryptionBuffer.set(value.subarray(valueOffset, valueOffset + bytesToCopy), encryptionBufferLength)
            encryptionBufferLength += bytesToCopy
            valueOffset += bytesToCopy

            if (encryptionBufferLength === encryptionBuffer.length) {
                const encrypted = new Uint8Array(
                    await globalThis.crypto.subtle.encrypt(
                        { name: "AES-CTR", counter: encryptionCounter, length: 64 },
                        aesKey,
                        encryptionBuffer,
                    ),
                )
                encryptionCounter = incrementCounter64By(
                    encryptionCounter,
                    Math.ceil(encryptionBuffer.length / 16),
                )
                encryptionBufferLength = 0
                await appendEncryptedBytes(encrypted)
            }
        }
    }

    if (encryptionBufferLength > 0) {
        const encryptedTail = new Uint8Array(
            await globalThis.crypto.subtle.encrypt(
                { name: "AES-CTR", counter: encryptionCounter, length: 64 },
                aesKey,
                encryptionBuffer.subarray(0, encryptionBufferLength),
            ),
        )
        encryptionCounter = incrementCounter64By(encryptionCounter, Math.ceil(encryptionBufferLength / 16))
        encryptionBufferLength = 0
        await appendEncryptedBytes(encryptedTail)
    }

    if (partBufferLength > 0) {
        await uploadPart(nextPartIndex + 1)
    }
    await finalizeChunk(true)
    if (!fileCardData.uploadComplete) {
        fileCardData = {
            ...fileCardData,
            uploadComplete: true,
        }
        await client.invoke(
            new options.Api.messages.EditMessage({
                peer: fileCardMessage.peerId,
                id: fileCardMessage.id,
                message: serializeFileCardMessage(fileCardData),
            }),
        )
    }

    return {
        msgId: fileCardMessage.id,
        date: fileCardMessage.date,
        data: fileCardData,
    }
}
