import * as Encryption from "./encryption"
import { getGramJs } from "../gramjs"
import type { FileCardData } from "../../packages/tglfs-cli/src/shared/file-cards"

const DOWNLOAD_PART_SIZE = 1024 * 1024
let Api!: typeof import("telegram")["Api"]
let getFileInfo!: typeof import("telegram/Utils")["getFileInfo"]
const gramJsReady = getGramJs().then((modules) => {
    Api = modules.Api
    getFileInfo = modules.getFileInfo
})

export type DownloadedSource = {
    file: File
    cleanup: () => Promise<void>
}

type DownloadSink = {
    write: (chunk: Uint8Array) => Promise<void>
    close: () => Promise<File>
    abort: (reason?: unknown) => Promise<void>
    cleanup: () => Promise<void>
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function normalizedError(error: unknown): Error {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === "DataError")) {
        return new Error("The source decryption password is incorrect, or the stored file is corrupted.")
    }
    return error instanceof Error ? error : new Error(String(error))
}

function documentSize(message: any): number {
    const size = Number(message?.media?.document?.size)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("A source chunk is missing its Telegram document data.")
    return size
}

async function memorySink(outputName: string): Promise<DownloadSink> {
    const chunks: Uint8Array[] = []
    return {
        async write(chunk) { chunks.push(chunk.slice()) },
        async close() { return new File(chunks, outputName, { type: "video/mp4", lastModified: Date.now() }) },
        async abort() { chunks.length = 0 },
        async cleanup() { chunks.length = 0 },
    }
}

async function createSink(outputName: string): Promise<DownloadSink> {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<any> }
    if (typeof storage?.getDirectory !== "function") return memorySink(outputName)

    let root: any
    let temporaryName = ""
    try {
        root = await storage.getDirectory()
        temporaryName = `.tglfs-preview-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}.mp4`
        const handle = await root.getFileHandle(temporaryName, { create: true })
        const writable = await handle.createWritable()
        let closed = false
        let removed = false
        const cleanup = async () => {
            if (removed) return
            removed = true
            try { await root.removeEntry(temporaryName) }
            catch (error: any) {
                if (error?.name !== "NotFoundError") console.warn("Unable to remove temporary MP4 conversion file", error)
            }
        }
        return {
            async write(chunk) { await writable.write(chunk) },
            async close() {
                if (!closed) {
                    await writable.close()
                    closed = true
                }
                const stored = await handle.getFile()
                return new File([stored], outputName, { type: "video/mp4", lastModified: Date.now() })
            },
            async abort(reason) {
                if (!closed) {
                    try { await writable.abort(reason) } catch {}
                    closed = true
                }
                await cleanup()
            },
            cleanup,
        }
    } catch (error) {
        if (root && temporaryName) {
            try { await root.removeEntry(temporaryName) } catch {}
        }
        console.warn("OPFS staging unavailable; using memory for MP4 conversion", error)
        return memorySink(outputName)
    }
}

export async function downloadFileCardToTemporaryFile(
    client: any,
    data: FileCardData,
    password: string,
    outputName: string,
    onProgress?: (percentage: number) => void,
): Promise<DownloadedSource> {
    await gramJsReady
    if (typeof DecompressionStream === "undefined") throw new Error("This browser does not support streaming gzip decompression.")
    if (!data.uploadComplete) throw new Error("The source upload is incomplete.")
    if (!data.chunks.length) throw new Error("The source file card has no uploaded chunks.")

    const fetched = await client.getMessages("me", { ids: data.chunks })
    const byId = new Map<number, any>(fetched.map((message: any) => [Number(message.id), message]))
    const messages = data.chunks.map((id) => byId.get(id))
    if (messages.some((message) => !message)) throw new Error("One or more source chunks could not be loaded from Telegram.")

    const iv = base64ToBytes(data.IV)
    if (iv.length !== 32) throw new Error("The source file card contains invalid encryption metadata.")
    const key = await Encryption.deriveAESKeyFromPassword(password, iv.subarray(0, 16))
    let counter = iv.slice(16)
    const encryptedBlock = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)
    let encryptedLength = 0

    const decompression = new DecompressionStream("gzip")
    const writer = decompression.writable.getWriter()
    const reader = decompression.readable.getReader()
    const sink = await createSink(outputName)
    let plaintextBytes = 0
    let readError: unknown = null

    const readPromise = (async () => {
        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (!value?.length) continue
                await sink.write(value)
                plaintextBytes += value.length
                onProgress?.(data.size ? Math.min(100, Math.round(plaintextBytes / data.size * 100)) : 100)
            }
        } catch (error) {
            readError = error
            try { await writer.abort(error) } catch {}
        }
    })()

    const decryptFullBlock = async () => {
        const plaintext = new Uint8Array(await crypto.subtle.decrypt(
            { name: "AES-CTR", counter, length: 64 }, key, encryptedBlock,
        ))
        counter = Encryption.incrementCounter64By(counter, Math.ceil(encryptedBlock.length / 16))
        encryptedLength = 0
        await writer.write(plaintext)
    }

    let writeError: unknown = null
    try {
        for (const message of messages) {
            const size = documentSize(message)
            for (let downloaded = 0; downloaded < size;) {
                const part = await client.invoke(new Api.upload.GetFile({
                    location: getFileInfo(message.media).location,
                    offset: downloaded,
                    limit: DOWNLOAD_PART_SIZE,
                    precise: false,
                    cdnSupported: false,
                }))
                const bytes = (part as any).bytes as Uint8Array
                if (!bytes?.length) throw new Error("Telegram returned an empty source-file part before the chunk was complete.")
                downloaded += bytes.length
                for (let offset = 0; offset < bytes.length;) {
                    const count = Math.min(bytes.length - offset, encryptedBlock.length - encryptedLength)
                    encryptedBlock.set(bytes.subarray(offset, offset + count), encryptedLength)
                    encryptedLength += count
                    offset += count
                    if (encryptedLength === encryptedBlock.length) await decryptFullBlock()
                }
            }
        }
        if (encryptedLength) {
            const plaintext = new Uint8Array(await crypto.subtle.decrypt(
                { name: "AES-CTR", counter, length: 64 }, key, encryptedBlock.subarray(0, encryptedLength),
            ))
            counter = Encryption.incrementCounter64By(counter, Math.ceil(encryptedLength / 16))
            await writer.write(plaintext)
        }
        await writer.close()
    } catch (error) {
        writeError = error
        try { await writer.abort(error) } catch {}
    } finally {
        await readPromise
    }

    if (readError || writeError) {
        await sink.abort(readError ?? writeError)
        throw normalizedError(readError ?? writeError)
    }
    if (plaintextBytes !== data.size) {
        await sink.abort()
        throw new Error(`The downloaded source size was ${plaintextBytes} bytes; the file card expected ${data.size} bytes.`)
    }
    try {
        return { file: await sink.close(), cleanup: sink.cleanup }
    } catch (error) {
        await sink.abort(error)
        throw error
    }
}
