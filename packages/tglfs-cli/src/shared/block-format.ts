import { Buffer } from "buffer"
import { UfidAccumulator } from "../ufid.js"
import type { ArchiveMember, ArchiveReader } from "./archive-format.js"

export const BLOCK_SIZE = 16 * 1024 * 1024
export const MAX_METADATA_SIZE = 32 * 1024 * 1024
export type BlockContent = {
    type: "tglfs:block-content"
    version: 1
    id: string
    salt: string
    blockSize: number
    archive: boolean
}
export type Sealed = { iv: string; ciphertext: string }
export type MediaIndex = {
    type: "tglfs:media-index"
    version: 1
    container: "mp4" | "webm"
    duration: number
    initializationLength: number
    segments: { time: number; offset: number; length: number; keyframe: boolean }[]
}
export type BlockPlan = {
    type: "tglfs:upload-plan"
    version: 1
    id: string
    fingerprint: string
    name: string
    size: number
    ufid: string
    hashes: string[]
    mediaIndex?: MediaIndex
    directory?: { type: "tglfs:tar-directory"; version: 1; entries: ArchiveMember[] }
}
export type BlockManifest = {
    type: "tglfs:block-manifest"
    version: 1
    plan: BlockPlan
    blocks: { iv: string; length: number }[]
}
export type BlockMap = { type: "tglfs:block-map"; version: 1; id: string; messages: number[]; payload: Sealed }
export const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
export function unbase64(value: string, length?: number): Uint8Array {
    if (typeof value !== "string") throw new Error("Invalid encryption metadata.")
    const bytes = Uint8Array.from(Buffer.from(value, "base64"))
    if (base64(bytes) !== value || (length !== undefined && bytes.length !== length))
        throw new Error("Invalid encryption metadata.")
    return bytes
}
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
export const randomBytes = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size))
export async function hashBytes(bytes: Uint8Array): Promise<string> {
    return Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", bytes)).toString("hex")
}
export async function finishUfid(ufid: UfidAccumulator, size: number): Promise<string> {
    return size === 0 ? hashBytes(new Uint8Array()) : ufid.digest()
}
export function isBlockContent(value: unknown): value is BlockContent {
    const c = value as BlockContent
    try {
        return (
            !!c &&
            c.type === "tglfs:block-content" &&
            c.version === 1 &&
            /^[a-f0-9]{32}$/.test(c.id) &&
            typeof c.archive === "boolean" &&
            Number.isSafeInteger(c.blockSize) &&
            c.blockSize >= 65536 &&
            c.blockSize <= BLOCK_SIZE &&
            c.blockSize % 65536 === 0 &&
            unbase64(c.salt, 16).length === 16
        )
    } catch {
        return false
    }
}
export async function blockKey(password: string, content: BlockContent): Promise<CryptoKey> {
    const material = await globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
    )
    return globalThis.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: unbase64(content.salt, 16), iterations: 600000, hash: "SHA-256" },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    )
}
function aad(content: BlockContent, purpose: string) {
    return jsonBytes([
        content.type,
        content.version,
        content.id,
        content.salt,
        content.blockSize,
        content.archive,
        purpose,
    ])
}
export async function seal(bytes: Uint8Array, key: CryptoKey, content: BlockContent, purpose: string): Promise<Sealed> {
    const iv = randomBytes(12)
    const ciphertext = await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(content, purpose) },
        key,
        bytes,
    )
    return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) }
}
export async function unseal(
    value: Sealed,
    key: CryptoKey,
    content: BlockContent,
    purpose: string,
): Promise<Uint8Array> {
    try {
        return new Uint8Array(
            await globalThis.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: unbase64(value.iv, 12), additionalData: aad(content, purpose) },
                key,
                unbase64(value.ciphertext),
            ),
        )
    } catch {
        throw new Error("Incorrect password or corrupted transfer data.")
    }
}
export async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.length
            if (size > limit) throw new Error("Transfer data exceeds its permitted size.")
            chunks.push(value)
        }
    } finally {
        await reader.cancel().catch(() => {})
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
export const gzipBlock = (bytes: Uint8Array) =>
    collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), bytes.length + 1024 * 1024)
export const gunzipBlock = (bytes: Uint8Array, limit: number) =>
    collect(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), limit)
export function parseJson(bytes: Uint8Array): any {
    if (bytes.length > MAX_METADATA_SIZE) throw new Error("Transfer metadata exceeds its permitted size.")
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}
export function validatePlan(value: unknown, content: BlockContent): BlockPlan {
    const p = value as BlockPlan
    if (
        !p ||
        p.type !== "tglfs:upload-plan" ||
        p.version !== 1 ||
        p.id !== content.id ||
        typeof p.name !== "string" ||
        !p.name.trim() ||
        !Number.isSafeInteger(p.size) ||
        p.size < 0 ||
        !/^[a-f0-9]{64}$/.test(p.ufid) ||
        typeof p.fingerprint !== "string" ||
        !Array.isArray(p.hashes) ||
        p.hashes.length !== Math.ceil(p.size / content.blockSize) ||
        !p.hashes.every((h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))
    )
        throw new Error("Unsupported or malformed upload plan.")
    if (content.archive) {
        if (
            !p.directory ||
            p.directory.type !== "tglfs:tar-directory" ||
            p.directory.version !== 1 ||
            !Array.isArray(p.directory.entries) ||
            p.directory.entries.length > 100000
        )
            throw new Error("Unsupported archive directory.")
        const ids = new Set<string>()
        for (const e of p.directory.entries) {
            if (
                !e ||
                typeof e.id !== "string" ||
                ids.has(e.id) ||
                typeof e.path !== "string" ||
                !e.path ||
                e.path.includes("\\") ||
                e.path.includes("\0") ||
                e.path.startsWith("/") ||
                /^[a-z]:/i.test(e.path) ||
                e.path.split("/").includes("..") ||
                !["file", "directory", "symlink", "hardlink"].includes(e.kind) ||
                !Number.isSafeInteger(e.headerOffset) ||
                e.headerOffset < 0 ||
                !Number.isSafeInteger(e.dataOffset) ||
                e.dataOffset < 0 ||
                !Number.isSafeInteger(e.size) ||
                e.size < 0 ||
                e.dataOffset + e.size > p.size
            )
                throw new Error("Malformed archive directory entry.")
            ids.add(e.id)
        }
    } else if (p.directory !== undefined) throw new Error("Unexpected archive directory.")
    if (p.mediaIndex !== undefined) {
        const m = p.mediaIndex
        if (
            !m ||
            m.type !== "tglfs:media-index" ||
            m.version !== 1 ||
            !["mp4", "webm"].includes(m.container) ||
            !Number.isFinite(m.duration) ||
            m.duration <= 0 ||
            !Number.isSafeInteger(m.initializationLength) ||
            m.initializationLength < 1 ||
            m.initializationLength > p.size ||
            !Array.isArray(m.segments) ||
            m.segments.length < 1 ||
            m.segments.length > 100000
        )
            throw new Error("Unsupported media index.")
        let time = -1
        let end = m.initializationLength
        for (const segment of m.segments) {
            if (
                !Number.isFinite(segment.time) ||
                segment.time < 0 ||
                segment.time < time ||
                segment.time > m.duration ||
                !Number.isSafeInteger(segment.offset) ||
                segment.offset < end ||
                !Number.isSafeInteger(segment.length) ||
                segment.length < 1 ||
                segment.offset + segment.length > p.size ||
                typeof segment.keyframe !== "boolean"
            )
                throw new Error("Malformed media index segment.")
            time = segment.time
            end = segment.offset + segment.length
        }
    }
    return p
}
export function validateBlockMap(value: unknown, content: BlockContent): BlockMap {
    const m = value as BlockMap
    if (
        !m ||
        m.type !== "tglfs:block-map" ||
        m.version !== 1 ||
        m.id !== content.id ||
        !Array.isArray(m.messages) ||
        m.messages.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(m.messages).size !== m.messages.length ||
        !m.payload
    )
        throw new Error("Unsupported or malformed block map.")
    unbase64(m.payload.iv, 12)
    unbase64(m.payload.ciphertext)
    return m
}
export type BlockReader = {
    plan: BlockPlan
    content: BlockContent
    readBlock(index: number): Promise<Uint8Array>
    readRange(offset: number, length: number): Promise<Uint8Array>
    stream(): ReadableStream<Uint8Array>
}
export function asArchiveReader(reader: BlockReader): ArchiveReader {
    if (!reader.plan.directory) throw new Error("This file is not an indexed archive.")
    return {
        index: {
            type: "tglfs:archive-index",
            version: 1,
            archiveId: reader.content.id,
            size: reader.plan.size,
            ufid: reader.plan.ufid,
            entries: reader.plan.directory.entries,
            blocks: [],
        },
        readRange: reader.readRange,
        stream: reader.stream,
        entryStream(entryId) {
            const e = reader.plan.directory!.entries.find((e) => e.id === entryId)
            if (!e || e.kind !== "file") throw new Error("This archive entry cannot be downloaded.")
            let offset = 0
            return new ReadableStream(
                {
                    async pull(controller) {
                        try {
                            if (offset === e.size) {
                                controller.close()
                                return
                            }
                            const bytes = await reader.readRange(
                                e.dataOffset + offset,
                                Math.min(256 * 1024, e.size - offset),
                            )
                            offset += bytes.length
                            controller.enqueue(bytes)
                        } catch (error) {
                            controller.error(error)
                        }
                    },
                },
                { highWaterMark: 0 },
            )
        },
    }
}

export function asFileReader(reader: BlockReader, name: string): ArchiveReader {
    return asArchiveReader({
        ...reader,
        plan: {
            ...reader.plan,
            directory: {
                type: "tglfs:tar-directory",
                version: 1,
                entries: [
                    { id: "file", path: name, kind: "file", headerOffset: 0, dataOffset: 0, size: reader.plan.size },
                ],
            },
        },
    })
}
export function isBrowsableArchive(data: { version?: number; content?: BlockContent }): boolean {
    return data.version === 4 || (data.version === 5 && data.content?.archive === true)
}
