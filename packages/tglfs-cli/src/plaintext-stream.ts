import type { TelegramClient } from "telegram/client/TelegramClient.js"

import {
    decodeIv,
    deriveAESKeyFromPassword,
    ENCRYPTION_CHUNK_SIZE,
    incrementCounter,
    incrementCounter64By,
} from "./crypto.js"
import { iterateEncryptedFile, type DownloadMode, type DownloadProgress } from "./download.js"
import { CliError, EXIT_CODES } from "./errors.js"
import type { FileCardData } from "./types.js"
import { UfidAccumulator } from "./ufid.js"

function normalizeError(error: unknown): Error {
    if (error instanceof CliError) return error
    if (error instanceof TypeError || (error instanceof Error && error.name === "OperationError")) {
        return new CliError(
            "decryption_failed",
            "Incorrect decryption password or corrupted encrypted/compressed data.",
            EXIT_CODES.DECRYPTION_FAILED,
        )
    }
    return error instanceof Error ? error : new Error(String(error))
}

/** Download -> AES-CTR decrypt -> gzip decompress -> size/UFID verification. */
export async function createVerifiedFileCardPlaintextStream(
    client: TelegramClient,
    data: FileCardData,
    password: string,
    mode: DownloadMode = "current",
    onProgress?: (progress: DownloadProgress) => void,
): Promise<ReadableStream<Uint8Array>> {
    const { salt, counter } = decodeIv(data.IV)
    const key = await deriveAESKeyFromPassword(password, salt)
    let nextCounter = counter
    const encryptedBlock = new Uint8Array(ENCRYPTION_CHUNK_SIZE)
    let encryptedLength = 0

    const decompression = new DecompressionStream("gzip")
    const writer = decompression.writable.getWriter()
    const accumulator = new UfidAccumulator()
    let plaintextBytes = 0
    const validated = decompression.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
            if (!chunk.byteLength) return
            plaintextBytes += chunk.byteLength
            await accumulator.update(chunk)
            onProgress?.({ bytesWritten: plaintextBytes, totalBytes: data.size })
            controller.enqueue(chunk)
        },
        async flush() {
            if (plaintextBytes !== data.size) {
                throw new CliError(
                    "size_mismatch",
                    `The source produced ${plaintextBytes} bytes; the file card expected ${data.size}.`,
                    EXIT_CODES.UFID_MISMATCH,
                )
            }
            const computedUfid = await accumulator.digest()
            if (computedUfid !== data.ufid) {
                throw new CliError(
                    "ufid_mismatch",
                    "The source did not match its expected UFID.",
                    EXIT_CODES.UFID_MISMATCH,
                    { expectedUfid: data.ufid, computedUfid },
                )
            }
            onProgress?.({ bytesWritten: plaintextBytes, totalBytes: data.size })
        },
    }))

    const decryptBuffered = async (length: number) => {
        const decrypted = new Uint8Array(await globalThis.crypto.subtle.decrypt(
            { name: "AES-CTR", counter: nextCounter, length: 64 },
            key,
            encryptedBlock.subarray(0, length),
        ))
        nextCounter = mode === "legacy"
            ? incrementCounter(nextCounter)
            : incrementCounter64By(nextCounter, Math.ceil(length / 16))
        encryptedLength = 0
        await writer.write(decrypted)
    }

    void (async () => {
        try {
            for await (const part of iterateEncryptedFile(client, data)) {
                let offset = 0
                while (offset < part.length) {
                    const count = Math.min(part.length - offset, encryptedBlock.length - encryptedLength)
                    encryptedBlock.set(part.subarray(offset, offset + count), encryptedLength)
                    encryptedLength += count
                    offset += count
                    if (encryptedLength === encryptedBlock.length) await decryptBuffered(encryptedBlock.length)
                }
            }
            if (encryptedLength) await decryptBuffered(encryptedLength)
            await writer.close()
        } catch (error) {
            try { await writer.abort(normalizeError(error)) } catch {}
        }
    })()

    return validated
}
