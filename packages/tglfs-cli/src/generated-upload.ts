import { Buffer } from "node:buffer"
import type { TelegramClient } from "telegram/client/TelegramClient.js"

import { deriveAESKeyFromPassword, ENCRYPTION_CHUNK_SIZE, incrementCounter64By } from "./crypto.js"
import { getGramJs } from "./gramjs.js"
import { TGLFS_ROOT_PARENT_ID, UPLOAD_PART_SIZE } from "./shared/constants.js"
import { createFileCardData, serializeFileCardMessage } from "./shared/file-cards.js"
import type { FileCardRecord } from "./shared/file-cards.js"
import { lookupFileCardByUfid } from "./shared/telegram-files.js"
import { UfidAccumulator } from "./ufid.js"

export type GeneratedUploadOptions = {
    name: string
    stream: ReadableStream<Uint8Array>
    chunkSize: number
    password: string
    parentFolderId?: string
    onProgress?: (bytesProcessed: number) => void
}

const DELETE_BATCH = 50
function createUploadFileId() {
    const random = globalThis.crypto.getRandomValues(new Uint32Array(2))
    return (BigInt(random[0] & 0x001fffff) << 32n) | BigInt(random[1])
}
function encodeIv(salt: Uint8Array, counter: Uint8Array) {
    const bytes = new Uint8Array(salt.length + counter.length)
    bytes.set(salt)
    bytes.set(counter, salt.length)
    return Buffer.from(bytes).toString("base64")
}

/**
 * Upload a one-shot generated stream without a replay pass. Temporary chunk
 * messages are finalized first; a complete ordinary file card is published last.
 */
export async function uploadGeneratedCurrentFormatStream(
    client: TelegramClient,
    options: GeneratedUploadOptions,
): Promise<FileCardRecord> {
    if (!options.name.trim()) throw new Error("Generated uploads require a file name.")
    if (options.chunkSize < UPLOAD_PART_SIZE) throw new Error("Configured chunk size is smaller than a Telegram upload part.")

    const { Api } = getGramJs()
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const initialCounter = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const key = await deriveAESKeyFromPassword(options.password, salt)
    let counter = new Uint8Array(initialCounter)
    const iv = encodeIv(salt, initialCounter)
    const uploadToken = createUploadFileId().toString(16)
    const chunkMessageIds: number[] = []
    const ufid = new UfidAccumulator()
    let plaintextBytes = 0

    const reader = options.stream
        .pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            async transform(chunk, controller) {
                if (!chunk.byteLength) return
                plaintextBytes += chunk.byteLength
                await ufid.update(chunk)
                options.onProgress?.(plaintextBytes)
                controller.enqueue(chunk)
            },
        }))
        .pipeThrough(new CompressionStream("gzip"))
        .getReader()

    let chunkIndex = 0
    let chunkBytes = 0
    let fileId = createUploadFileId()
    let partIndex = 0
    const partBuffer = new Uint8Array(UPLOAD_PART_SIZE)
    let partLength = 0
    const encryptionBuffer = new Uint8Array(ENCRYPTION_CHUNK_SIZE)
    let encryptionLength = 0

    const cleanupChunks = async () => {
        for (let offset = 0; offset < chunkMessageIds.length; offset += DELETE_BATCH) {
            try {
                await client.invoke(new Api.messages.DeleteMessages({ id: chunkMessageIds.slice(offset, offset + DELETE_BATCH) } as any))
            } catch (error) {
                console.warn("Unable to remove temporary generated-upload chunks", error)
            }
        }
        chunkMessageIds.length = 0
    }
    const uploadPart = async (totalParts: number) => {
        if (!partLength) return
        const ok = await client.invoke(new Api.upload.SaveBigFilePart({
            fileId,
            filePart: partIndex,
            fileTotalParts: totalParts,
            bytes: Buffer.from(partBuffer.subarray(0, partLength)),
        } as any))
        if (!ok) throw new Error(`Failed to upload generated chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
        partIndex += 1
        partLength = 0
    }
    const finalizeChunk = async () => {
        if (!partIndex) return
        const file = new Api.InputFileBig({ id: fileId, parts: partIndex, name: `pending-${uploadToken}.chunk${chunkIndex + 1}` })
        const message = await client.sendFile("me", { file })
        chunkMessageIds.push(message.id)
        chunkIndex += 1
        chunkBytes = 0
        fileId = createUploadFileId()
        partIndex = 0
    }
    const appendEncrypted = async (bytes: Uint8Array) => {
        let offset = 0
        while (offset < bytes.length) {
            const count = Math.min(bytes.length - offset, UPLOAD_PART_SIZE - partLength, options.chunkSize - chunkBytes)
            if (count <= 0) throw new Error("Generated upload reached an invalid chunk boundary.")
            partBuffer.set(bytes.subarray(offset, offset + count), partLength)
            offset += count
            partLength += count
            chunkBytes += count
            if (chunkBytes === options.chunkSize) {
                await uploadPart(partIndex + 1)
                await finalizeChunk()
            } else if (partLength === UPLOAD_PART_SIZE) {
                await uploadPart(-1)
            }
        }
    }
    const encryptBuffered = async (length: number) => {
        const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
            { name: "AES-CTR", counter, length: 64 },
            key,
            encryptionBuffer.subarray(0, length),
        ))
        counter = incrementCounter64By(counter, Math.ceil(length / 16))
        encryptionLength = 0
        await appendEncrypted(encrypted)
    }

    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue
            let offset = 0
            while (offset < value.length) {
                const count = Math.min(value.length - offset, encryptionBuffer.length - encryptionLength)
                encryptionBuffer.set(value.subarray(offset, offset + count), encryptionLength)
                encryptionLength += count
                offset += count
                if (encryptionLength === encryptionBuffer.length) await encryptBuffered(encryptionBuffer.length)
            }
        }
        if (encryptionLength) await encryptBuffered(encryptionLength)
        if (partLength) await uploadPart(partIndex + 1)
        await finalizeChunk()
        if (!chunkMessageIds.length) throw new Error("The generated MP4 produced no Telegram chunks.")

        const computedUfid = await ufid.digest()
        const duplicate = await lookupFileCardByUfid(client as any, computedUfid, { peer: "me" })
        if (duplicate) {
            await cleanupChunks()
            throw new Error(`A file with UFID ${computedUfid} already exists.`)
        }
        const data = createFileCardData({
            name: options.name,
            ufid: computedUfid,
            size: plaintextBytes,
            uploadComplete: true,
            chunks: [...chunkMessageIds],
            IV: iv,
            parentFolderId: options.parentFolderId?.trim() || TGLFS_ROOT_PARENT_ID,
        })
        const card = await client.sendMessage("me", { message: serializeFileCardMessage(data) })
        return { msgId: card.id, date: card.date, data }
    } catch (error) {
        try { await reader.cancel(error) } catch {}
        await cleanupChunks()
        throw error
    } finally {
        try { reader.releaseLock() } catch {}
    }
}
