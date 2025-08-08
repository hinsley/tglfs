/**
 * Utilities for (un)chunking files and processing before uploading and after
 * downloading.
 * @module fileProcessing
 */

import * as Encryption from "./encryption"

export const ENCRYPTION_CHUNK_SIZE = 32 * 1024 * 1024 // 32 MB.

export async function prepChunk(
    file: File,
    ufid: string,
    password: string,
    chunkSize: number,
    chunkIndex: number,
): Promise<[Uint8Array, Uint8Array]> {
    // TODO: Implement upload resumption.
    const chunkStart = chunkIndex * chunkSize
    const fileStream = file.slice(chunkStart).stream()
    const compressedStream = fileStream.pipeThrough(new CompressionStream("gzip"))
    const salt = window.crypto.getRandomValues(new Uint8Array(16))
    const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt)
    const initialCounter = window.crypto.getRandomValues(new Uint8Array(16))
    const encryptionCounter = new Uint8Array(initialCounter)

    const rootDir = await navigator.storage.getDirectory()
    const chunkFileName = `${ufid}.chunk${chunkIndex + 1}`
    let chunkFileHandle
    let chunkFileStream
    let chunkFileWriter
    let bytesWritten = 0

    try {
        // Remove chunk file if it exists.
        await rootDir.removeEntry(chunkFileName)
    } catch (e: any) {
        if (e.name !== "NotFoundError") {
            throw e
        }
        // Pass; the chunk file doesn't exist.
    }

    chunkFileHandle = await rootDir.getFileHandle(chunkFileName, { create: true })
    chunkFileStream = await chunkFileHandle.createWritable()
    chunkFileWriter = chunkFileStream.getWriter()

    const reader = compressedStream.getReader()
    let done, value

    while ((({ done, value } = await reader.read()), !done && bytesWritten < chunkSize)) {
        const remainingSpace = chunkSize - bytesWritten
        const chunkToWrite = (value ?? new Uint8Array()).slice(0, remainingSpace)

        // TODO: Consider moving to Encryption module.
        const encryptedChunk = await window.crypto.subtle.encrypt(
            {
                name: "AES-CTR",
                counter: encryptionCounter,
                length: 64, // Bit length of the counter block.
            },
            aesKey,
            chunkToWrite,
        )

        await chunkFileWriter.write(new Uint8Array(encryptedChunk))
        bytesWritten += chunkToWrite.length
    }

    await chunkFileWriter.close()

    return [salt, initialCounter]
}

export async function decryptAndDecompressFile(fileName: string, key: Uint8Array, nonce: Uint8Array) {
    const rootDir = await navigator.storage.getDirectory()
    const file = await rootDir.getFileHandle(fileName, { create: false })
    const fileStream = await file.getFile()
}

export async function UFID(file: File): Promise<string> {
    const UFIDChunkSize = 64 * 1024 // 64 KB.
    let UFIDArray = new Uint8Array([])
    let i
    for (i = 0; i < file.size; i += UFIDChunkSize) {
        const chunk = new Uint8Array(UFIDArray.length + UFIDChunkSize)
        chunk.set(UFIDArray, 0)
        const data = file.slice(i, i + UFIDChunkSize)
        const dataArrayBuffer = await data.arrayBuffer()
        const dataArray = new Uint8Array(dataArrayBuffer)
        chunk.set(dataArray, UFIDArray.length)
        const UFIDBuffer = await window.crypto.subtle.digest("SHA-256", chunk)
        UFIDArray = new Uint8Array(UFIDBuffer)
    }
    // Convert UFID to a hexadecimal string.
    const UFIDString = Array.from(UFIDArray)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    return UFIDString
}

export async function UFIDFromStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const UFIDChunkSize = 64 * 1024 // 64 KiB.
    const reader = stream.getReader()
    let rolling = new Uint8Array(0)
    let pending = new Uint8Array(0)
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        // Append to pending.
        const combined = new Uint8Array(pending.length + value.length)
        combined.set(pending, 0)
        combined.set(value, pending.length)
        let offset = 0
        while (offset + UFIDChunkSize <= combined.length) {
            const piece = combined.subarray(offset, offset + UFIDChunkSize)
            const toHash = new Uint8Array(rolling.length + UFIDChunkSize)
            toHash.set(rolling, 0)
            toHash.set(piece, rolling.length)
            const digest = await window.crypto.subtle.digest("SHA-256", toHash.buffer)
            rolling = new Uint8Array(digest)
            offset += UFIDChunkSize
        }
        pending = combined.subarray(offset)
    }
    if (pending.length > 0) {
        const padded = new Uint8Array(UFIDChunkSize)
        padded.set(pending, 0)
        const toHash = new Uint8Array(rolling.length + UFIDChunkSize)
        toHash.set(rolling, 0)
        toHash.set(padded, rolling.length)
        const digest = await window.crypto.subtle.digest("SHA-256", toHash.buffer)
        rolling = new Uint8Array(digest)
        pending = new Uint8Array(0)
    }
    return Array.from(rolling)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
}
