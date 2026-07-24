import { Buffer } from "buffer"
import type * as Config from "../config"
import { getGramJs } from "../gramjs"
import * as Encryption from "./encryption"
import { UfidAccumulator } from "../../packages/tglfs-cli/src/ufid"
import { TGLFS_ROOT_PARENT_ID, UPLOAD_PART_SIZE } from "../../packages/tglfs-cli/src/shared/constants"
import {
    createFileCardData,
    serializeFileCardMessage,
    type FileCardRecord,
} from "../../packages/tglfs-cli/src/shared/file-cards"
import { lookupFileCardByUfid } from "../../packages/tglfs-cli/src/shared/telegram-files"

export type GeneratedUploadProgress = {
    plaintextBytes: number
}

export type GeneratedUploadOptions = {
    name: string
    stream: ReadableStream<Uint8Array>
    password: string
    parentFolderId?: string
    onProgress?: (progress: GeneratedUploadProgress) => void
}

const DELETE_BATCH_SIZE = 50

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

/**
 * Uploads a generated plaintext stream without replaying it or staging the
 * generated file. UFID and plaintext size are calculated inline. The final
 * file card is published only after all encrypted chunk messages exist.
 */
export async function uploadGeneratedFileStream(
    client: any,
    config: Config.Config,
    options: GeneratedUploadOptions,
): Promise<FileCardRecord> {
    if (config.chunkSize < UPLOAD_PART_SIZE) {
        throw new Error(`chunkSize (${config.chunkSize}) must be at least UPLOAD_PART_SIZE (${UPLOAD_PART_SIZE}).`)
    }
    if (!options.name.trim()) throw new Error("Generated uploads require a file name.")

    const { Api } = await getGramJs()
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const initialCounter = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const aesKey = await Encryption.deriveAESKeyFromPassword(options.password, salt)
    let encryptionCounter = new Uint8Array(initialCounter)
    const iv = Buffer.from(createIvBytes(salt, initialCounter)).toString("base64")

    const uploadToken = createUploadFileId().toString(16)
    const uploadedChunkMessageIds: number[] = []
    const ufidAccumulator = new UfidAccumulator()
    let plaintextBytes = 0

    const accountedStream = options.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
            if (!chunk.byteLength) return
            plaintextBytes += chunk.byteLength
            await ufidAccumulator.update(chunk)
            options.onProgress?.({ plaintextBytes })
            controller.enqueue(chunk)
        },
    }))
    const reader = accountedStream.pipeThrough(new CompressionStream("gzip")).getReader()

    let chunkIndex = 0
    let chunkBytesWritten = 0
    let chunkFileId = createUploadFileId()
    let nextPartIndex = 0
    const partBuffer = new Uint8Array(UPLOAD_PART_SIZE)
    let partBufferLength = 0
    const encryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)
    let encryptionBufferLength = 0

    const deleteUploadedChunks = async () => {
        for (let offset = 0; offset < uploadedChunkMessageIds.length; offset += DELETE_BATCH_SIZE) {
            const ids = uploadedChunkMessageIds.slice(offset, offset + DELETE_BATCH_SIZE)
            try {
                await client.invoke(new Api.messages.DeleteMessages({ id: ids }))
            } catch (error) {
                console.warn("Unable to remove temporary generated-upload chunks", error)
            }
        }
        uploadedChunkMessageIds.length = 0
    }

    const uploadPart = async (fileTotalParts: number) => {
        if (!partBufferLength) return
        const bytes = partBuffer.subarray(0, partBufferLength)
        const result = await client.invoke(new Api.upload.SaveBigFilePart({
            fileId: chunkFileId,
            filePart: nextPartIndex,
            fileTotalParts,
            bytes: Buffer.from(bytes),
        }))
        if (!result) throw new Error(`Failed to upload generated chunk ${chunkIndex + 1} part ${nextPartIndex + 1}.`)
        nextPartIndex += 1
        partBufferLength = 0
    }

    const finalizeChunk = async () => {
        if (!nextPartIndex) return
        const uploadedChunk = new Api.InputFileBig({
            id: chunkFileId,
            parts: nextPartIndex,
            name: `pending-${uploadToken}.chunk${chunkIndex + 1}`,
        })
        const message = await client.sendFile("me", { file: uploadedChunk })
        uploadedChunkMessageIds.push(message.id)
        chunkIndex += 1
        chunkBytesWritten = 0
        chunkFileId = createUploadFileId()
        nextPartIndex = 0
    }

    const appendEncryptedBytes = async (bytes: Uint8Array) => {
        let offset = 0
        while (offset < bytes.length) {
            const remainingChunkSpace = config.chunkSize - chunkBytesWritten
            const bytesToCopy = Math.min(
                bytes.length - offset,
                UPLOAD_PART_SIZE - partBufferLength,
                remainingChunkSpace,
            )
            if (bytesToCopy <= 0) throw new Error("Generated upload reached an invalid chunk boundary.")

            partBuffer.set(bytes.subarray(offset, offset + bytesToCopy), partBufferLength)
            offset += bytesToCopy
            partBufferLength += bytesToCopy
            chunkBytesWritten += bytesToCopy

            const partFull = partBufferLength === UPLOAD_PART_SIZE
            const chunkFull = chunkBytesWritten === config.chunkSize
            if (chunkFull) {
                await uploadPart(nextPartIndex + 1)
                await finalizeChunk()
            } else if (partFull) {
                await uploadPart(-1)
            }
        }
    }

    const encryptBufferedPlaintext = async (length: number) => {
        const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
            { name: "AES-CTR", counter: encryptionCounter, length: 64 },
            aesKey,
            encryptionBuffer.subarray(0, length),
        ))
        encryptionCounter = Encryption.incrementCounter64By(encryptionCounter, Math.ceil(length / 16))
        encryptionBufferLength = 0
        await appendEncryptedBytes(encrypted)
    }

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue

            let valueOffset = 0
            while (valueOffset < value.length) {
                const bytesToCopy = Math.min(
                    value.length - valueOffset,
                    encryptionBuffer.length - encryptionBufferLength,
                )
                encryptionBuffer.set(value.subarray(valueOffset, valueOffset + bytesToCopy), encryptionBufferLength)
                encryptionBufferLength += bytesToCopy
                valueOffset += bytesToCopy
                if (encryptionBufferLength === encryptionBuffer.length) {
                    await encryptBufferedPlaintext(encryptionBuffer.length)
                }
            }
        }

        if (encryptionBufferLength) await encryptBufferedPlaintext(encryptionBufferLength)
        if (partBufferLength) await uploadPart(nextPartIndex + 1)
        await finalizeChunk()
        if (!uploadedChunkMessageIds.length) throw new Error("The generated upload produced no Telegram chunks.")

        const ufid = await ufidAccumulator.digest()
        const duplicate = await lookupFileCardByUfid(client, ufid, { peer: "me" })
        if (duplicate) {
            await deleteUploadedChunks()
            throw new Error(`A file with the generated UFID ${ufid} already exists.`)
        }

        const fileCardData = createFileCardData({
            name: options.name,
            ufid,
            size: plaintextBytes,
            uploadComplete: true,
            chunks: uploadedChunkMessageIds,
            IV: iv,
            parentFolderId: options.parentFolderId?.trim() || TGLFS_ROOT_PARENT_ID,
        })
        const fileCardMessage = await client.sendMessage("me", {
            message: serializeFileCardMessage(fileCardData),
        })

        options.onProgress?.({ plaintextBytes })
        return {
            msgId: fileCardMessage.id,
            date: fileCardMessage.date,
            data: fileCardData,
        }
    } catch (error) {
        try { await reader.cancel(error) } catch {}
        await deleteUploadedChunks()
        throw error
    } finally {
        try { reader.releaseLock() } catch {}
    }
}
