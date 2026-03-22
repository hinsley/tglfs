import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { TelegramClient } from "telegram/client/TelegramClient.js"

import { decodeIv, deriveAESKeyFromPassword, ENCRYPTION_CHUNK_SIZE, incrementCounter64By } from "./crypto.js"
import { CliError, EXIT_CODES } from "./errors.js"
import { getGramJs } from "./gramjs.js"
import type { FileCardData } from "./types.js"
import { UfidAccumulator } from "./ufid.js"

const DOWNLOAD_PART_SIZE = 1024 * 1024

type DownloadResult = {
    outputPath: string
    bytesWritten: number
    name: string
    ufid: string
}

function normalizeDownloadError(error: unknown): CliError {
    if (error instanceof CliError) {
        return error
    }
    if (error instanceof TypeError) {
        return new CliError(
            "decryption_failed",
            "Incorrect decryption password or corrupted compressed data.",
            EXIT_CODES.DECRYPTION_FAILED,
        )
    }
    if (error instanceof Error && error.name === "OperationError") {
        return new CliError(
            "decryption_failed",
            "Incorrect decryption password or corrupted encrypted data.",
            EXIT_CODES.DECRYPTION_FAILED,
        )
    }
    if (error instanceof Error) {
        return new CliError("download_failed", error.message, EXIT_CODES.GENERAL_ERROR)
    }
    return new CliError("download_failed", String(error), EXIT_CODES.GENERAL_ERROR)
}

async function* iterateEncryptedFile(client: TelegramClient, data: FileCardData): AsyncGenerator<Uint8Array> {
    const { Api, getFileInfo } = getGramJs()
    const chunkMessages = await client.getMessages("me", { ids: data.chunks } as any)
    const chunkMap = new Map<number, any>()
    for (const message of chunkMessages) {
        chunkMap.set(message.id, message)
    }

    for (const chunkId of data.chunks) {
        const chunkMessage = chunkMap.get(chunkId)
        const chunkSize = chunkMessage?.media?.document?.size
        if (!chunkMessage || typeof chunkSize !== "number") {
            throw new CliError(
                "invalid_file_card",
                "One or more Telegram chunk messages are missing or malformed.",
                EXIT_CODES.INVALID_FILE_CARD,
            )
        }

        let offset = 0
        while (offset < chunkSize) {
            const part = await client.invoke(
                new Api.upload.GetFile({
                    location: getFileInfo(chunkMessage.media).location,
                    offset,
                    limit: DOWNLOAD_PART_SIZE,
                    precise: false,
                    cdnSupported: false,
                } as any),
            )
            const bytes = (part as any).bytes as Uint8Array
            offset += bytes.length
            yield bytes
        }
    }
}

async function consumeDecompressedStream(
    readable: ReadableStream<Uint8Array>,
    filePath: string,
): Promise<{ bytesWritten: number; computedUfid: string }> {
    const handle = await open(filePath, "w")
    const reader = readable.getReader()
    const ufid = new UfidAccumulator()
    let bytesWritten = 0

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            if (!value || value.length === 0) {
                continue
            }
            await handle.write(value)
            bytesWritten += value.length
            await ufid.update(value)
        }

        return {
            bytesWritten,
            computedUfid: await ufid.digest(),
        }
    } finally {
        await handle.close()
    }
}

export function defaultOutputPath(fileName: string) {
    return resolve(process.cwd(), fileName.split(/[\\/]/).pop() ?? fileName)
}

export async function ensureOutputDirectory(filePath: string) {
    await mkdir(dirname(filePath), { recursive: true })
}

export async function restoreFileFromEncryptedParts(
    data: FileCardData,
    password: string,
    outputPath: string,
    encryptedParts: AsyncIterable<Uint8Array>,
    overwrite = false,
): Promise<DownloadResult> {
    await ensureOutputDirectory(outputPath)
    const tempPath = join(dirname(outputPath), `.${data.ufid}.part`)

    const { salt, counter } = decodeIv(data.IV)
    const aesKey = await deriveAESKeyFromPassword(password, salt)
    let decryptionCounter = counter
    let bufferBytes = 0
    const decryptionBuffer = new Uint8Array(ENCRYPTION_CHUNK_SIZE)

    const decompressionStream = new DecompressionStream("gzip")
    const writer = decompressionStream.writable.getWriter()
    const consumePromise = consumeDecompressedStream(decompressionStream.readable, tempPath)

    try {
        for await (const part of encryptedParts) {
            let partOffset = 0
            while (partOffset < part.length) {
                const bytesToCopy = Math.min(part.length - partOffset, decryptionBuffer.length - bufferBytes)
                decryptionBuffer.set(part.subarray(partOffset, partOffset + bytesToCopy), bufferBytes)
                bufferBytes += bytesToCopy
                partOffset += bytesToCopy

                if (bufferBytes === decryptionBuffer.length) {
                    const decrypted = new Uint8Array(
                        await globalThis.crypto.subtle.decrypt(
                            { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                            aesKey,
                            decryptionBuffer,
                        ),
                    )
                    decryptionCounter = incrementCounter64By(decryptionCounter, Math.ceil(decryptionBuffer.length / 16))
                    bufferBytes = 0
                    await writer.write(decrypted)
                }
            }
        }

        if (bufferBytes > 0) {
            const decrypted = new Uint8Array(
                await globalThis.crypto.subtle.decrypt(
                    { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                    aesKey,
                    decryptionBuffer.subarray(0, bufferBytes),
                ),
            )
            decryptionCounter = incrementCounter64By(decryptionCounter, Math.ceil(bufferBytes / 16))
            await writer.write(decrypted)
        }

        await writer.close()
        const { bytesWritten, computedUfid } = await consumePromise
        if (computedUfid !== data.ufid) {
            throw new CliError(
                "ufid_mismatch",
                "The downloaded file did not match the expected UFID.",
                EXIT_CODES.UFID_MISMATCH,
            )
        }

        if (overwrite) {
            await rm(outputPath, { force: true })
        }
        await rename(tempPath, outputPath)

        return {
            outputPath,
            bytesWritten,
            name: data.name,
            ufid: data.ufid,
        }
    } catch (error) {
        try {
            await writer.abort(error)
        } catch {}
        try {
            await consumePromise
        } catch {}
        await rm(tempPath, { force: true }).catch(() => {})
        throw normalizeDownloadError(error)
    }
}

export async function downloadFileCard(
    client: TelegramClient,
    data: FileCardData,
    password: string,
    outputPath: string,
    overwrite = false,
): Promise<DownloadResult> {
    return restoreFileFromEncryptedParts(data, password, outputPath, iterateEncryptedFile(client, data), overwrite)
}
