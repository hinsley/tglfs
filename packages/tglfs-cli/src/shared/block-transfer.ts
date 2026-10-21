import { UfidAccumulator } from "../ufid.js"
import { TarIndexBuilder } from "./archive-format.js"
import { createTelegramArchiveRangeReader } from "./archive-transfer.js"
import type { ArchiveTransferClient, ArchiveTransferOptions } from "./archive-transfer.js"
import {
    base64,
    BLOCK_SIZE,
    blockKey,
    collect,
    finishUfid,
    gzipBlock,
    gunzipBlock,
    hashBytes,
    jsonBytes,
    MAX_METADATA_SIZE,
    parseJson,
    randomBytes,
    seal,
    unbase64,
    unseal,
    validateBlockMap,
    validatePlan,
} from "./block-format.js"
import type { BlockContent, BlockMap, BlockManifest, BlockPlan, BlockReader, Sealed } from "./block-format.js"
import { parseFileCardMessage, serializeFileCardMessage } from "./file-cards.js"
import type { FileCardRecord } from "./file-cards.js"
import { createFileCardV5Data, normalizeFileCardV5Data } from "./protocol/file-card-v5.js"
import type { FileCardV5Data } from "./protocol/file-card-v5.js"
import { TGLFS_ROOT_PARENT_ID, UPLOAD_PART_SIZE } from "./constants.js"

export type SeekableSource = {
    name: string
    size: number
    fingerprint: string
    archive: boolean
    slice(start: number, end: number): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}
type Session = { type: "tglfs:upload-session"; version: 1; content: BlockContent; size: number; parentFolderId: string }
type Checkpoint = { type: "tglfs:upload-block"; version: 1; id: string; index: number; payload: Sealed }
type BlockReceipt = { type: "tglfs:block-receipt"; version: 1; hash: string; iv: string; length: number }
function check(options: ArchiveTransferOptions) {
    if (options.signal?.aborted)
        throw new DOMException("Transfer cancelled. Select the same files and password to resume.", "AbortError")
}
async function search(client: ArchiveTransferClient, peer: string, query: string): Promise<any[]> {
    const result: any[] = []
    let maxId = 0
    for (let page = 0; page < 10000; page++) {
        const messages = await client.getMessages(peer, { search: query, limit: 100, maxId, waitTime: 0 })
        if (!messages.length) return result
        result.push(...messages)
        const next = Math.min(...messages.map((m) => m.id))
        if (messages.length < 100) return result
        if (next === maxId) throw new Error("Telegram did not advance the transfer search.")
        maxId = next
    }
    throw new Error("Too many transfer records to scan safely.")
}
function caption(message: any): any {
    try {
        return JSON.parse(message.message)
    } catch {
        return null
    }
}
export async function sendTransferDocument(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions,
    bytes: Uint8Array,
    name: string,
    message = "",
): Promise<any> {
    check(options)
    const words = globalThis.crypto.getRandomValues(new Uint32Array(2))
    const id = (BigInt(words[0] & 0x001fffff) << 32n) | BigInt(words[1])
    const parts = Math.ceil(bytes.length / UPLOAD_PART_SIZE)
    if (!parts) throw new Error("Cannot upload an empty transfer document.")
    for (let i = 0; i < parts; i++) {
        check(options)
        const ok = await client.invoke(
            new options.Api.upload.SaveBigFilePart({
                fileId: id,
                filePart: i,
                fileTotalParts: parts,
                bytes: bytes.subarray(i * UPLOAD_PART_SIZE, (i + 1) * UPLOAD_PART_SIZE),
            }),
        )
        if (!ok) throw new Error("Telegram refused an upload part.")
    }
    check(options)
    const sent = await client.sendFile(options.peer || "me", {
        file: new options.Api.InputFileBig({ id, parts, name }),
        caption: message,
        forceDocument: true,
    } as any)
    if (!Number.isSafeInteger(sent?.id) || sent.id <= 0)
        throw new Error("Telegram did not acknowledge the transfer document.")
    return sent
}
export async function readTransferDocument(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions,
    id: number,
    maximum: number,
): Promise<Uint8Array> {
    const remote = await createTelegramArchiveRangeReader(client, [id], options)
    if (remote.size > maximum) throw new Error("The transfer document exceeds its permitted size.")
    return remote.readRange(0, remote.size)
}
async function preparePlan(
    source: SeekableSource,
    content: BlockContent,
    options: ArchiveTransferOptions,
): Promise<BlockPlan> {
    const ufid = new UfidAccumulator()
    const hashes: string[] = []
    const tar = source.archive ? new TarIndexBuilder() : null
    for (let offset = 0; offset < source.size; offset += content.blockSize) {
        check(options)
        const length = Math.min(content.blockSize, source.size - offset)
        const bytes = await collect(await source.slice(offset, offset + length), length)
        if (bytes.length !== length) throw new Error("The upload source changed size.")
        await ufid.update(bytes)
        hashes.push(await hashBytes(bytes))
        tar?.append(bytes)
        options.onProgress?.({ phase: "reading", bytesProcessed: offset + length, totalBytes: source.size })
        if (hashes.length * 100 + (tar?.indexSize ?? 0) > MAX_METADATA_SIZE / 2)
            throw new Error("This transfer has too much metadata for this client.")
    }
    tar?.finish()
    return {
        type: "tglfs:upload-plan",
        version: 1,
        id: content.id,
        fingerprint: source.fingerprint,
        name: source.name,
        size: source.size,
        ufid: await finishUfid(ufid, source.size),
        hashes,
        ...(tar ? { directory: { type: "tglfs:tar-directory", version: 1, entries: tar.entries } } : {}),
    }
}
export async function uploadResumableFile(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions & {
        source: SeekableSource
        password: string
        parentFolderId?: string
        resumeId?: string
        blockSize?: number
    },
): Promise<FileCardRecord> {
    check(options)
    if (
        !Number.isSafeInteger(options.source.size) ||
        options.source.size < 0 ||
        typeof options.source.name !== "string" ||
        !options.source.name.trim() ||
        typeof options.source.fingerprint !== "string" ||
        !options.source.fingerprint
    )
        throw new Error("Invalid resumable upload source.")
    const peer = options.peer || "me"
    const parentFolderId = options.parentFolderId || TGLFS_ROOT_PARENT_ID
    const source = options.source
    let content: BlockContent | undefined
    let plan: BlockPlan | undefined
    let key: CryptoKey | undefined
    const sessions = await search(
        client,
        peer,
        options.resumeId ? `tglfs:upload-session ${options.resumeId}` : "tglfs:upload-session",
    )
    for (const message of sessions) {
        const session = caption(message) as Session
        if (!session || session.type !== "tglfs:upload-session") continue
        if (session.version !== 1) {
            if (options.resumeId) throw new Error("Unsupported upload-session version.")
            continue
        }
        if (
            session.size !== source.size ||
            session.parentFolderId !== parentFolderId ||
            session.content?.archive !== source.archive ||
            (options.resumeId && session.content.id !== options.resumeId)
        )
            continue
        // A matching plan is authenticated before any completed block is reused.
        try {
            const { isBlockContent } = await import("./block-format.js")
            if (!isBlockContent(session.content)) throw new Error("Malformed upload-session content.")
            const candidateKey = await blockKey(options.password, session.content)
            const sealed = parseJson(await readTransferDocument(client, options, message.id, MAX_METADATA_SIZE))
            const candidate = validatePlan(
                parseJson(await unseal(sealed, candidateKey, session.content, "plan")),
                session.content,
            )
            if (candidate.size !== source.size || candidate.fingerprint !== source.fingerprint) {
                if (options.resumeId) throw new Error("The selected source does not match this upload session.")
                continue
            }
            content = session.content
            plan = candidate
            key = candidateKey
            break
        } catch (error) {
            if (options.resumeId) throw error
        }
    }
    if (options.resumeId && !plan)
        throw new Error("No matching resumable upload was found. Select the original files and password.")
    if (!plan) {
        content = {
            type: "tglfs:block-content",
            version: 1,
            id: Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join(""),
            salt: base64(randomBytes(16)),
            blockSize: options.blockSize ?? BLOCK_SIZE,
            archive: source.archive,
        }
        const { isBlockContent } = await import("./block-format.js")
        if (!isBlockContent(content)) throw new Error("Unsupported transfer block size.")
        plan = await preparePlan(source, content, options)
        key = await blockKey(options.password, content)
        const duplicates = await search(client, peer, `tglfs:file ${plan.ufid}`)
        for (const message of duplicates) {
            const data = parseFileCardMessage(message.message || "")
            if (data?.ufid === plan.ufid && data.uploadComplete)
                throw new Error("A file with identical contents is already stored (duplicate UFID).")
        }
        await sendTransferDocument(
            client,
            options,
            jsonBytes(await seal(jsonBytes(plan), key, content, "plan")),
            `${content.id}.upload-plan`,
            JSON.stringify({
                type: "tglfs:upload-session",
                version: 1,
                content,
                size: source.size,
                parentFolderId,
            } satisfies Session),
        )
    }
    const c = content!
    const p = plan
    const k = key!
    try {
        const complete = await search(client, peer, `tglfs:file ${c.id}`)
        for (const message of complete) {
            const data = parseFileCardMessage(message.message || "")
            if (data?.version === 5 && data.content.id === c.id) {
                if (
                    data.ufid !== p.ufid ||
                    data.size !== p.size ||
                    data.content.salt !== c.salt ||
                    data.content.blockSize !== c.blockSize ||
                    data.content.archive !== c.archive
                )
                    throw new Error("A completed file conflicts with this upload session. Both records were preserved.")
                return { msgId: message.id, date: message.date, data }
            }
        }
        const receipts = new Map<number, { id: number; receipt: BlockReceipt }>()
        for (const message of await search(client, peer, `tglfs:upload-block ${c.id}`)) {
            check(options)
            const cp = caption(message) as Checkpoint
            if (!cp || cp.type !== "tglfs:upload-block" || cp.id !== c.id) continue
            if (cp.version !== 1 || !Number.isSafeInteger(cp.index) || cp.index < 0 || cp.index >= p.hashes.length)
                throw new Error("Unsupported or malformed upload checkpoint.")
            const receipt = parseJson(await unseal(cp.payload, k, c, `receipt:${cp.index}`)) as BlockReceipt
            if (
                receipt.type !== "tglfs:block-receipt" ||
                receipt.version !== 1 ||
                receipt.hash !== p.hashes[cp.index] ||
                !Number.isSafeInteger(receipt.length) ||
                receipt.length < 17 ||
                receipt.length > c.blockSize + 1024 * 1024 ||
                Number(message.media?.document?.size) !== receipt.length
            )
                throw new Error("The upload checkpoint does not match its document.")
            unbase64(receipt.iv, 12)
            const prior = receipts.get(cp.index)
            if (!prior || message.id < prior.id) receipts.set(cp.index, { id: message.id, receipt })
        }
        const messages: number[] = []
        const blocks: BlockManifest["blocks"] = []
        for (let index = 0; index < p.hashes.length; index++) {
            check(options)
            let found = receipts.get(index)
            const start = index * c.blockSize
            const length = Math.min(c.blockSize, source.size - start)
            if (!found) {
                const bytes = await collect(await source.slice(start, start + length), length)
                if (bytes.length !== length || (await hashBytes(bytes)) !== p.hashes[index])
                    throw new Error("The source changed after this upload began. The interrupted upload was preserved.")
                const encoded = await seal(await gzipBlock(bytes), k, c, `block:${index}:${length}:${p.hashes[index]}`)
                const stored = unbase64(encoded.ciphertext)
                const receipt: BlockReceipt = {
                    type: "tglfs:block-receipt",
                    version: 1,
                    hash: p.hashes[index],
                    iv: encoded.iv,
                    length: stored.length,
                }
                const cp: Checkpoint = {
                    type: "tglfs:upload-block",
                    version: 1,
                    id: c.id,
                    index,
                    payload: await seal(jsonBytes(receipt), k, c, `receipt:${index}`),
                }
                const message = await sendTransferDocument(
                    client,
                    options,
                    stored,
                    `${c.id}.block-${index}`,
                    JSON.stringify(cp),
                )
                found = { id: message.id, receipt }
            }
            messages.push(found.id)
            blocks.push({ iv: found.receipt.iv, length: found.receipt.length })
            options.onProgress?.({ phase: "uploading", bytesProcessed: start + length, totalBytes: source.size })
        }
        const map: BlockMap = {
            type: "tglfs:block-map",
            version: 1,
            id: c.id,
            messages,
            payload: await seal(
                jsonBytes({ type: "tglfs:block-manifest", version: 1, plan: p, blocks } satisfies BlockManifest),
                k,
                c,
                "manifest",
            ),
        }
        const mapBytes = jsonBytes(map)
        if (mapBytes.length > MAX_METADATA_SIZE) throw new Error("The transfer manifest exceeds its permitted size.")
        const mapMessage = await sendTransferDocument(client, options, mapBytes, `${c.id}.block-map`)
        const data = createFileCardV5Data({
            name: p.name,
            size: p.size,
            ufid: p.ufid,
            uploadComplete: true,
            chunks: [mapMessage.id],
            IV: "",
            content: c,
            parentFolderId,
        })
        check(options)
        const message = await client.sendMessage(peer, { message: serializeFileCardMessage(data) })
        return { msgId: message.id, date: message.date, data }
    } catch (error) {
        throw new Error(
            `${error instanceof Error ? error.message : String(error)} Resume by selecting the same files and password. Transfer ID: ${c.id}.`,
            { cause: error },
        )
    }
}
export async function openBlockFile(
    client: ArchiveTransferClient,
    options: ArchiveTransferOptions & { data: FileCardV5Data; password: string },
): Promise<BlockReader> {
    const { data } = options
    if (!normalizeFileCardV5Data(data)) throw new Error("Unsupported or malformed resumable file card.")
    const content = data.content
    const map = validateBlockMap(
        parseJson(await readTransferDocument(client, options, data.chunks[0], MAX_METADATA_SIZE)),
        content,
    )
    const key = await blockKey(options.password, content)
    const manifest = parseJson(await unseal(map.payload, key, content, "manifest")) as BlockManifest
    if (manifest.type !== "tglfs:block-manifest" || manifest.version !== 1)
        throw new Error("Unsupported block-manifest version.")
    const plan = validatePlan(manifest.plan, content)
    if (
        plan.size !== data.size ||
        plan.ufid !== data.ufid ||
        map.messages.length !== plan.hashes.length ||
        !Array.isArray(manifest.blocks) ||
        manifest.blocks.length !== plan.hashes.length
    )
        throw new Error("The authenticated transfer manifest does not match its file card.")
    for (const b of manifest.blocks) {
        if (!Number.isSafeInteger(b.length) || b.length < 17 || b.length > content.blockSize + 1024 * 1024)
            throw new Error("Invalid block length.")
        unbase64(b.iv, 12)
    }
    if (data.mediaPreview && (!plan.mediaIndex || plan.mediaIndex.container !== data.mediaPreview.container))
        throw new Error("The media preview descriptor does not match its authenticated index.")
    let cached: { index: number; bytes: Uint8Array } | undefined
    const loadBlock = async (index: number) => {
        check(options)
        if (!Number.isSafeInteger(index) || index < 0 || index >= map.messages.length)
            throw new Error("Invalid block index.")
        if (cached?.index === index) return cached.bytes
        const b = manifest.blocks[index]
        const length = Math.min(content.blockSize, data.size - index * content.blockSize)
        const stored = await readTransferDocument(client, options, map.messages[index], b.length)
        if (stored.length !== b.length) throw new Error("The encrypted block has the wrong size.")
        const compressed = await unseal(
            { iv: b.iv, ciphertext: base64(stored) },
            key,
            content,
            `block:${index}:${length}:${plan.hashes[index]}`,
        )
        const bytes = await gunzipBlock(compressed, length)
        if (bytes.length !== length || (await hashBytes(bytes)) !== plan.hashes[index])
            throw new Error("The downloaded block failed its integrity check.")
        cached = { index, bytes }
        return bytes
    }
    let pendingBlock: Promise<unknown> = Promise.resolve()
    const internalReadBlock = (index: number): Promise<Uint8Array> => {
        const next = pendingBlock.then(() => loadBlock(index))
        pendingBlock = next.catch(() => {})
        return next
    }
    const readBlock = async (index: number) => (await internalReadBlock(index)).slice()
    const readRange = async (offset: number, length: number) => {
        if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            length > content.blockSize ||
            offset + length > data.size
        )
            throw new Error("Invalid file range.")
        const output = new Uint8Array(length)
        let written = 0
        while (written < length) {
            const position = offset + written
            const index = Math.floor(position / content.blockSize)
            const bytes = await internalReadBlock(index)
            const from = position % content.blockSize
            const count = Math.min(length - written, bytes.length - from)
            output.set(bytes.subarray(from, from + count), written)
            written += count
        }
        return output
    }
    return {
        plan,
        content,
        readBlock,
        readRange,
        stream() {
            let index = 0
            const ufid = new UfidAccumulator()
            return new ReadableStream(
                {
                    async pull(controller) {
                        try {
                            if (index === plan.hashes.length) {
                                if ((await finishUfid(ufid, data.size)) !== data.ufid)
                                    throw new Error("The file failed its UFID verification.")
                                controller.close()
                                return
                            }
                            const bytes = await readBlock(index++)
                            await ufid.update(bytes)
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
