import { Buffer } from "buffer"

import { UfidAccumulator } from "../ufid.js"

export const ARCHIVE_CONTENT_TYPE = "tglfs:archive-content" as const
export const ARCHIVE_CONTENT_VERSION = 1 as const
export const ARCHIVE_INDEX_TYPE = "tglfs:archive-index" as const
export const ARCHIVE_INDEX_VERSION = 1 as const
export const ARCHIVE_BLOCK_SIZE = 1024 * 1024
export const ARCHIVE_MAX_BLOCK_SIZE = 4 * 1024 * 1024
export const ARCHIVE_MAX_INDEX_SIZE = 32 * 1024 * 1024
const MAX_EXTENSION_SIZE = 1024 * 1024
const MAX_ENTRIES = 100000
const INDEX_NONCE = 0xffffffff
const PASSWORD_ITERATIONS = 600000

export type ArchiveStorageDescriptor = {
    type: typeof ARCHIVE_CONTENT_TYPE
    version: typeof ARCHIVE_CONTENT_VERSION
    archiveId: string
    salt: string
    noncePrefix: string
    blockSize: number
    indexOffset: number
    indexLength: number
    storedSize: number
}

export type ArchiveMember = {
    id: string
    path: string
    kind: "file" | "directory" | "symlink" | "hardlink"
    headerOffset: number
    dataOffset: number
    size: number
    modifiedTime?: number
    linkTarget?: string
}

export type ArchiveBlock = {
    offset: number
    length: number
    storedOffset: number
    storedLength: number
}

export type ArchiveIndex = {
    type: typeof ARCHIVE_INDEX_TYPE
    version: typeof ARCHIVE_INDEX_VERSION
    archiveId: string
    size: number
    ufid: string
    entries: ArchiveMember[]
    blocks: ArchiveBlock[]
}

export type ArchiveEncodeOptions = {
    password: string
    signal?: AbortSignal
    blockSize?: number
    onProgress?: (bytes: number) => void
}

export type ArchiveReadRange = (offset: number, length: number) => Promise<Uint8Array>

export type ArchiveReader = {
    index: ArchiveIndex
    readRange: ArchiveReadRange
    entryStream(entryId: string): ReadableStream<Uint8Array>
    stream(): ReadableStream<Uint8Array>
}

function isInteger(value: unknown, minimum = 0): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

function decodeBase64(value: string, size: number): Uint8Array {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"))
    if (bytes.length !== size || Buffer.from(bytes).toString("base64") !== value) {
        throw new Error("The archive encryption metadata is malformed.")
    }
    return bytes
}

export function isArchiveStorageDescriptor(value: unknown): value is ArchiveStorageDescriptor {
    if (!value || typeof value !== "object") return false
    const item = value as Partial<ArchiveStorageDescriptor>
    if (
        item.type !== ARCHIVE_CONTENT_TYPE || item.version !== ARCHIVE_CONTENT_VERSION ||
        typeof item.archiveId !== "string" || !/^[0-9a-f]{32}$/.test(item.archiveId) ||
        typeof item.salt !== "string" || typeof item.noncePrefix !== "string" ||
        !isInteger(item.blockSize, 512) || item.blockSize > ARCHIVE_MAX_BLOCK_SIZE || item.blockSize % 512 !== 0 ||
        !isInteger(item.indexOffset, 1) || !isInteger(item.indexLength, 17) ||
        item.indexLength > ARCHIVE_MAX_INDEX_SIZE + 1024 * 1024 || !isInteger(item.storedSize, 1) ||
        item.indexOffset + item.indexLength !== item.storedSize
    ) return false
    try {
        decodeBase64(item.salt, 16)
        decodeBase64(item.noncePrefix, 8)
        return true
    } catch {
        return false
    }
}

function checkAbort(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Archive operation cancelled.")
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const material = await globalThis.crypto.subtle.importKey(
        "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"],
    )
    return globalThis.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    )
}

function nonce(prefix: Uint8Array, ordinal: number): Uint8Array {
    const iv = new Uint8Array(12)
    iv.set(prefix)
    new DataView(iv.buffer).setUint32(8, ordinal, false)
    return iv
}

function blockAad(archiveId: string, blockSize: number, ordinal: number, length: number) {
    return new TextEncoder().encode(JSON.stringify([ARCHIVE_CONTENT_TYPE, ARCHIVE_CONTENT_VERSION, archiveId, blockSize, "block", ordinal, length]))
}

function indexAad(storage: ArchiveStorageDescriptor) {
    return new TextEncoder().encode(JSON.stringify([
        ARCHIVE_CONTENT_TYPE, ARCHIVE_CONTENT_VERSION, storage.archiveId, storage.salt,
        storage.noncePrefix, storage.blockSize, "index", storage.indexOffset, storage.indexLength, storage.storedSize,
    ]))
}

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value?.length) continue
            size += value.length
            if (size > limit) throw new Error("The archive data exceeds its permitted size.")
            chunks.push(value)
        }
    } catch (error) {
        await reader.cancel(error).catch(() => {})
        throw error
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
    }
    return bytes
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
    return collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), bytes.length + 1024 * 1024)
}

async function gunzip(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
    return collect(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), limit)
}

const textDecoder = new TextDecoder("utf-8", { fatal: true })

function tarString(bytes: Uint8Array): string {
    const end = bytes.indexOf(0)
    return textDecoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

function tarNumber(bytes: Uint8Array): number {
    if ((bytes[0] & 0x80) !== 0) {
        if ((bytes[0] & 0x40) !== 0) throw new Error("Negative tar sizes are unsupported.")
        let result = BigInt(bytes[0] & 0x7f)
        for (const byte of bytes.subarray(1)) result = result * 256n + BigInt(byte)
        if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("A tar number is too large.")
        return Number(result)
    }
    const value = tarString(bytes).trim()
    if (!value) return 0
    if (!/^[0-7]+$/.test(value)) throw new Error("A tar number is malformed.")
    const result = Number.parseInt(value, 8)
    if (!isInteger(result)) throw new Error("A tar number is too large.")
    return result
}

function safePath(path: string): string {
    if (!path || path.includes("\0") || path.startsWith("/") || path.includes("\\") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) {
        throw new Error("The tar contains an unsafe member path.")
    }
    return path
}

function paxFields(bytes: Uint8Array): Record<string, string> {
    const fields: Record<string, string> = Object.create(null)
    let offset = 0
    while (offset < bytes.length) {
        let space = offset
        while (space < bytes.length && bytes[space] !== 32) space += 1
        const rawLength = textDecoder.decode(bytes.subarray(offset, space))
        if (!/^[1-9][0-9]*$/.test(rawLength)) throw new Error("The PAX header is malformed.")
        const length = Number(rawLength)
        if (!isInteger(length, 1) || offset + length > bytes.length || offset + length <= space + 1 || bytes[offset + length - 1] !== 10) {
            throw new Error("The PAX header is truncated.")
        }
        const item = textDecoder.decode(bytes.subarray(space + 1, offset + length - 1))
        const equals = item.indexOf("=")
        if (equals < 1) throw new Error("The PAX header is malformed.")
        const key = item.slice(0, equals)
        if (key.includes("sparse") || key === "SCHILY.filetype") throw new Error("Sparse and special tar entries are unsupported.")
        if (["path", "linkpath", "size", "mtime"].includes(key)) fields[key] = item.slice(equals + 1)
        offset += length
    }
    return fields
}

class TarIndexBuilder {
    readonly entries: ArchiveMember[] = []
    indexSize = 0
    private header = new Uint8Array(512)
    private headerLength = 0
    private remaining = 0
    private extension: { kind: string; bytes: Uint8Array; length: number; size: number } | null = null
    private nextFields: Record<string, string> = Object.create(null)
    private globalFields: Record<string, string> = Object.create(null)
    private offset = 0
    private zeros = 0

    append(bytes: Uint8Array) {
        let cursor = 0
        while (cursor < bytes.length) {
            if (this.remaining > 0) {
                const count = Math.min(this.remaining, bytes.length - cursor)
                if (this.extension && this.extension.length < this.extension.size) {
                    const copied = Math.min(count, this.extension.size - this.extension.length)
                    this.extension.bytes.set(bytes.subarray(cursor, cursor + copied), this.extension.length)
                    this.extension.length += copied
                }
                cursor += count
                this.offset += count
                this.remaining -= count
                if (this.remaining === 0 && this.extension) this.finishExtension()
                continue
            }
            const count = Math.min(512 - this.headerLength, bytes.length - cursor)
            this.header.set(bytes.subarray(cursor, cursor + count), this.headerLength)
            this.headerLength += count
            this.offset += count
            cursor += count
            if (this.headerLength === 512) {
                this.parseHeader()
                this.headerLength = 0
            }
        }
    }

    private finishExtension() {
        const extension = this.extension!
        if (extension.kind === "x") this.nextFields = { ...this.nextFields, ...paxFields(extension.bytes) }
        else if (extension.kind === "g") this.globalFields = { ...this.globalFields, ...paxFields(extension.bytes) }
        else if (extension.kind === "L") this.nextFields.path = tarString(extension.bytes)
        else this.nextFields.linkpath = tarString(extension.bytes)
        this.extension = null
    }

    private parseHeader() {
        const header = this.header
        if (header.every((byte) => byte === 0)) {
            this.zeros += 1
            return
        }
        if (this.zeros > 0) throw new Error("The tar contains data after its end marker.")
        const expectedChecksum = tarNumber(header.subarray(148, 156))
        const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
        if (expectedChecksum !== actualChecksum) throw new Error("The tar header checksum is invalid.")
        const rawSize = tarNumber(header.subarray(124, 136))
        const kind = header[156] === 0 ? "0" : String.fromCharCode(header[156])
        if (["x", "g", "L", "K"].includes(kind)) {
            if (rawSize > MAX_EXTENSION_SIZE) throw new Error("The tar extension header is too large.")
            this.extension = { kind, bytes: new Uint8Array(rawSize), length: 0, size: rawSize }
            this.remaining = Math.ceil(rawSize / 512) * 512
            if (this.remaining === 0) this.finishExtension()
            return
        }
        if (!["0", "5", "1", "2"].includes(kind)) throw new Error("The tar contains an unsupported entry type.")
        const fields = { ...this.globalFields, ...this.nextFields }
        this.nextFields = Object.create(null)
        const prefix = tarString(header.subarray(257, 263)) === "ustar" ? tarString(header.subarray(345, 500)) : ""
        const path = safePath(fields.path ?? `${prefix ? `${prefix}/` : ""}${tarString(header.subarray(0, 100))}`)
        let size = rawSize
        if (fields.size !== undefined) {
            if (!/^[0-9]+$/.test(fields.size) || !isInteger(Number(fields.size))) throw new Error("The PAX size is invalid.")
            size = Number(fields.size)
        }
        if (kind !== "0" && size !== 0) throw new Error("A non-file tar member contains unsupported data.")
        if (this.entries.length >= MAX_ENTRIES) throw new Error("The archive contains too many members to index.")
        const modifiedTime = fields.mtime === undefined ? tarNumber(header.subarray(136, 148)) : Number(fields.mtime)
        if (!Number.isFinite(modifiedTime)) throw new Error("The PAX modification time is invalid.")
        this.entries.push({
            id: String(this.entries.length), path,
            kind: kind === "5" ? "directory" : kind === "1" ? "hardlink" : kind === "2" ? "symlink" : "file",
            headerOffset: this.offset - 512, dataOffset: this.offset, size, modifiedTime,
            ...(["1", "2"].includes(kind) ? { linkTarget: fields.linkpath ?? tarString(header.subarray(157, 257)) } : {}),
        })
        this.indexSize += new TextEncoder().encode(JSON.stringify(this.entries[this.entries.length - 1])).length + 1
        if (this.indexSize > ARCHIVE_MAX_INDEX_SIZE) throw new Error("The archive member index is too large.")
        this.remaining = Math.ceil(size / 512) * 512
        if (!Number.isSafeInteger(this.offset + this.remaining)) throw new Error("The tar archive is too large.")
    }

    finish() {
        if (this.headerLength !== 0 || this.remaining !== 0 || this.zeros < 2 || this.extension || Object.keys(this.nextFields).length > 0) {
            throw new Error("The tar archive is truncated or has no complete end marker.")
        }
    }
}

export async function encodeArchiveStream(
    source: ReadableStream<Uint8Array>, options: ArchiveEncodeOptions,
    write: (bytes: Uint8Array) => Promise<void>,
): Promise<{ storage: ArchiveStorageDescriptor; ufid: string; size: number; index: ArchiveIndex }> {
    const blockSize = options.blockSize ?? ARCHIVE_BLOCK_SIZE
    if (!isInteger(blockSize, 512) || blockSize > ARCHIVE_MAX_BLOCK_SIZE || blockSize % 512 !== 0) throw new Error("The archive block size is invalid.")
    checkAbort(options.signal)
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const prefix = globalThis.crypto.getRandomValues(new Uint8Array(8))
    const archiveId = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString("hex")
    const key = await deriveKey(options.password, salt)
    const ufidAccumulator = new UfidAccumulator()
    const tar = new TarIndexBuilder()
    const blocks: ArchiveBlock[] = []
    const buffer = new Uint8Array(blockSize)
    let length = 0
    let size = 0
    let storedSize = 0
    let indexEstimate = 256
    const flush = async () => {
        if (!length) return
        checkAbort(options.signal)
        if (blocks.length >= INDEX_NONCE) throw new Error("The archive contains too many blocks.")
        const bytes = buffer.subarray(0, length)
        const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce(prefix, blocks.length), additionalData: blockAad(archiveId, blockSize, blocks.length, length), tagLength: 128 },
            key, await gzip(bytes),
        ))
        await write(encrypted)
        blocks.push({ offset: size - length, length, storedOffset: storedSize, storedLength: encrypted.length })
        indexEstimate += 128
        if (indexEstimate > ARCHIVE_MAX_INDEX_SIZE) throw new Error("The archive index is too large.")
        storedSize += encrypted.length
        length = 0
    }
    const reader = source.getReader()
    const abort = () => { void reader.cancel(new Error("Archive operation cancelled.")).catch(() => {}) }
    options.signal?.addEventListener("abort", abort, { once: true })
    try {
        while (true) {
            checkAbort(options.signal)
            const { value, done } = await reader.read()
            checkAbort(options.signal)
            if (done) break
            if (!value?.length) continue
            let offset = 0
            while (offset < value.length) {
                checkAbort(options.signal)
                const count = Math.min(blockSize - length, value.length - offset)
                const part = value.subarray(offset, offset + count)
                tar.append(part)
                if (indexEstimate + tar.indexSize > ARCHIVE_MAX_INDEX_SIZE) throw new Error("The archive index is too large.")
                await ufidAccumulator.update(part)
                buffer.set(part, length)
                length += count
                size += count
                offset += count
                if (!Number.isSafeInteger(size)) throw new Error("The archive is too large.")
                options.onProgress?.(size)
                if (length === blockSize) await flush()
            }
        }
        tar.finish()
        await flush()
        const ufid = await ufidAccumulator.digest()
        const index: ArchiveIndex = { type: ARCHIVE_INDEX_TYPE, version: ARCHIVE_INDEX_VERSION, archiveId, size, ufid, entries: tar.entries, blocks }
        const rawIndex = new TextEncoder().encode(JSON.stringify(index))
        if (rawIndex.length > ARCHIVE_MAX_INDEX_SIZE) throw new Error("The archive index is too large.")
        const compressedIndex = await gzip(rawIndex)
        const storage: ArchiveStorageDescriptor = {
            type: ARCHIVE_CONTENT_TYPE, version: ARCHIVE_CONTENT_VERSION, archiveId,
            salt: Buffer.from(salt).toString("base64"), noncePrefix: Buffer.from(prefix).toString("base64"), blockSize,
            indexOffset: storedSize, indexLength: compressedIndex.length + 16, storedSize: storedSize + compressedIndex.length + 16,
        }
        const encryptedIndex = new Uint8Array(await globalThis.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce(prefix, INDEX_NONCE), additionalData: indexAad(storage), tagLength: 128 }, key, compressedIndex,
        ))
        checkAbort(options.signal)
        await write(encryptedIndex)
        return { storage, ufid, size, index }
    } catch (error) {
        await reader.cancel(error).catch(() => {})
        throw error
    } finally {
        options.signal?.removeEventListener("abort", abort)
        reader.releaseLock()
    }
}

function validateIndex(value: unknown, storage: ArchiveStorageDescriptor): ArchiveIndex {
    if (!value || typeof value !== "object") throw new Error("The archive index is malformed.")
    const index = value as ArchiveIndex
    if (index.type !== ARCHIVE_INDEX_TYPE || index.version !== ARCHIVE_INDEX_VERSION) throw new Error("The archive index version is unsupported.")
    if (index.archiveId !== storage.archiveId || !isInteger(index.size, 1024) || typeof index.ufid !== "string" || !/^[0-9a-f]{64}$/.test(index.ufid) || !Array.isArray(index.blocks) || !Array.isArray(index.entries) || index.entries.length > MAX_ENTRIES || index.blocks.length >= INDEX_NONCE) {
        throw new Error("The archive index metadata is malformed.")
    }
    let offset = 0
    let storedOffset = 0
    for (let ordinal = 0; ordinal < index.blocks.length; ordinal += 1) {
        const block = index.blocks[ordinal]
        if (!block || block.offset !== offset || block.storedOffset !== storedOffset || !isInteger(block.length, 1) || block.length > storage.blockSize || (ordinal < index.blocks.length - 1 && block.length !== storage.blockSize) || !isInteger(block.storedLength, 17) || block.storedLength > storage.blockSize + 1024 * 1024) {
            throw new Error("The archive block map is malformed.")
        }
        offset += block.length
        storedOffset += block.storedLength
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(storedOffset)) throw new Error("The archive block map is too large.")
    }
    if (offset !== index.size || storedOffset !== storage.indexOffset) throw new Error("The archive block map does not match its stored content.")
    let previousHeader = -1
    for (let ordinal = 0; ordinal < index.entries.length; ordinal += 1) {
        const entry = index.entries[ordinal]
        if (!entry || entry.id !== String(ordinal) || typeof entry.path !== "string" || !["file", "directory", "symlink", "hardlink"].includes(entry.kind) || !isInteger(entry.headerOffset) || entry.headerOffset % 512 !== 0 || entry.headerOffset <= previousHeader || entry.dataOffset !== entry.headerOffset + 512 || !isInteger(entry.size) || !Number.isSafeInteger(entry.dataOffset + entry.size) || entry.dataOffset + entry.size > index.size || (entry.kind !== "file" && entry.size !== 0) || (entry.modifiedTime !== undefined && (typeof entry.modifiedTime !== "number" || !Number.isFinite(entry.modifiedTime))) || (entry.linkTarget !== undefined && typeof entry.linkTarget !== "string")) {
            throw new Error("The archive member index is malformed.")
        }
        safePath(entry.path)
        previousHeader = entry.headerOffset
    }
    return index
}

export async function openArchive(
    storage: ArchiveStorageDescriptor, password: string, readStoredRange: ArchiveReadRange,
    options: { signal?: AbortSignal } = {},
): Promise<ArchiveReader> {
    if (!isArchiveStorageDescriptor(storage)) throw new Error("The archive content version or metadata is unsupported.")
    checkAbort(options.signal)
    const prefix = decodeBase64(storage.noncePrefix, 8)
    const key = await deriveKey(password, decodeBase64(storage.salt, 16))
    const exactRead = async (offset: number, length: number) => {
        checkAbort(options.signal)
        const bytes = await readStoredRange(offset, length)
        checkAbort(options.signal)
        if (bytes.length !== length) throw new Error("The archive content is incomplete.")
        return bytes
    }
    const decrypt = async (bytes: Uint8Array, ordinal: number, aad: Uint8Array) => {
        try {
            return new Uint8Array(await globalThis.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: nonce(prefix, ordinal), additionalData: aad, tagLength: 128 }, key, bytes,
            ))
        } catch {
            throw new Error("Incorrect archive password or damaged encrypted archive data.")
        }
    }
    const encryptedIndex = await exactRead(storage.indexOffset, storage.indexLength)
    const indexBytes = await gunzip(await decrypt(encryptedIndex, INDEX_NONCE, indexAad(storage)), ARCHIVE_MAX_INDEX_SIZE)
    const index = validateIndex(JSON.parse(textDecoder.decode(indexBytes)), storage)
    const blockCache = new Map<number, Uint8Array>()
    const pendingBlocks = new Map<number, Promise<Uint8Array>>()
    let pendingTail: Promise<unknown> = Promise.resolve()
    const readBlock = (ordinal: number): Promise<Uint8Array> => {
        checkAbort(options.signal)
        const cached = blockCache.get(ordinal)
        if (cached) {
            blockCache.delete(ordinal)
            blockCache.set(ordinal, cached)
            return Promise.resolve(cached)
        }
        const pending = pendingBlocks.get(ordinal)
        if (pending) return pending
        if (pendingBlocks.size >= 32) return Promise.reject(new Error("Too many archive blocks were requested at once."))
        const operation = pendingTail.then(async () => {
            const block = index.blocks[ordinal]
            const bytes = await decrypt(await exactRead(block.storedOffset, block.storedLength), ordinal, blockAad(storage.archiveId, storage.blockSize, ordinal, block.length))
            const plaintext = await gunzip(bytes, block.length)
            if (plaintext.length !== block.length) throw new Error("The archive block length is incorrect.")
            blockCache.set(ordinal, plaintext)
            while (blockCache.size > 2) blockCache.delete(blockCache.keys().next().value!)
            return plaintext
        })
        const completed = operation.then(
            (bytes) => { pendingBlocks.delete(ordinal); return bytes },
            (error) => { pendingBlocks.delete(ordinal); throw error },
        )
        pendingBlocks.set(ordinal, completed)
        pendingTail = completed.catch(() => {})
        return completed
    }
    const readRange: ArchiveReadRange = async (offset, length) => {
        checkAbort(options.signal)
        if (!isInteger(offset) || !isInteger(length) || !Number.isSafeInteger(offset + length) || offset + length > index.size) throw new Error("The archive read range is invalid.")
        const result = new Uint8Array(length)
        let written = 0
        while (written < length) {
            checkAbort(options.signal)
            const position = offset + written
            const ordinal = Math.floor(position / storage.blockSize)
            const block = index.blocks[ordinal]
            const plaintext = await readBlock(ordinal)
            checkAbort(options.signal)
            const start = position - block.offset
            const count = Math.min(length - written, plaintext.length - start)
            result.set(plaintext.subarray(start, start + count), written)
            written += count
        }
        return result
    }
    const streamRange = (start: number, size: number, verify = false) => {
        let position = start
        let remaining = size
        let cancelled = false
        const accumulator = verify ? new UfidAccumulator() : null
        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    checkAbort(options.signal)
                    if (cancelled) return
                    if (remaining === 0) {
                        if (accumulator && await accumulator.digest() !== index.ufid) throw new Error("The reconstructed archive UFID does not match its index.")
                        controller.close()
                        return
                    }
                    const count = Math.min(remaining, storage.blockSize - position % storage.blockSize)
                    const bytes = await readRange(position, count)
                    if (cancelled) return
                    await accumulator?.update(bytes)
                    position += count
                    remaining -= count
                    controller.enqueue(bytes)
                } catch (error) {
                    controller.error(error)
                }
            },
            cancel() { cancelled = true },
        }, { highWaterMark: 0 })
    }
    return {
        index, readRange,
        entryStream(entryId) {
            const entry = index.entries.find((item) => item.id === entryId)
            if (!entry || entry.kind !== "file") throw new Error("Only regular archive files can be read.")
            return streamRange(entry.dataOffset, entry.size)
        },
        stream() { return streamRange(0, index.size, true) },
    }
}
