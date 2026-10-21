import { UfidAccumulator } from "../ufid.js"
import {
    base64,
    BLOCK_SIZE,
    blockKey,
    finishUfid,
    gzipBlock,
    hashBytes,
    jsonBytes,
    MAX_METADATA_SIZE,
    randomBytes,
    seal,
    unbase64,
} from "./block-format.js"
import type { BlockContent, BlockManifest, BlockMap, BlockPlan } from "./block-format.js"
import { sendTransferDocument } from "./block-transfer.js"
import type { ArchiveTransferClient, ArchiveTransferOptions } from "./archive-transfer.js"
import { createFileCardV5Data } from "./protocol/file-card-v5.js"
import type { FileCardV5Data } from "./protocol/file-card-v5.js"
import { serializeFileCardMessage } from "./file-cards.js"
import type { FileCardRecord } from "./file-cards.js"
import { MediaStreamIndexer } from "./media-index.js"

export type MediaSource = {
    type: "tglfs:media-source"
    version: 1
    messageId: number
    fileVersion: number
    ufid: string
}
export type MediaUploadOptions = ArchiveTransferOptions & {
    name: string
    stream: ReadableStream<Uint8Array>
    password: string
    container: "mp4" | "webm"
    duration?: number
    parentFolderId?: string
    source?: MediaSource
    expectedUfid?: string
    expectedSize?: number
    blockSize?: number
    onBytes?: (bytes: number) => void
}

/** Upload each generated media block once and publish its encrypted seek index after the stream succeeds. */
export async function uploadSeekableMedia(
    client: ArchiveTransferClient,
    options: MediaUploadOptions,
): Promise<FileCardRecord & { data: FileCardV5Data }> {
    const content: BlockContent = {
        type: "tglfs:block-content",
        version: 1,
        id: Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join(""),
        salt: base64(randomBytes(16)),
        blockSize: options.blockSize ?? BLOCK_SIZE,
        archive: false,
    }
    if (
        !options.name.trim() ||
        !Number.isSafeInteger(content.blockSize) ||
        content.blockSize < 65536 ||
        content.blockSize > BLOCK_SIZE ||
        content.blockSize % 65536
    )
        throw new Error("Invalid seekable media upload options.")
    const key = await blockKey(options.password, content)
    const hashes: string[] = []
    const messages: number[] = []
    const blocks: BlockManifest["blocks"] = []
    const accumulator = new UfidAccumulator()
    const indexer = new MediaStreamIndexer(options.container)
    const reader = options.stream.getReader()
    const buffer = new Uint8Array(content.blockSize)
    let buffered = 0,
        size = 0,
        publishing = false
    const uploadBlock = async () => {
        options.signal?.throwIfAborted()
        const bytes = buffer.subarray(0, buffered)
        const index = hashes.length
        const hash = await hashBytes(bytes)
        const encoded = await seal(await gzipBlock(bytes), key, content, `block:${index}:${bytes.length}:${hash}`)
        const stored = unbase64(encoded.ciphertext)
        const message = await sendTransferDocument(client, options, stored, `${content.id}.media-block-${index}`)
        messages.push(message.id)
        hashes.push(hash)
        blocks.push({ iv: encoded.iv, length: stored.length })
        buffered = 0
        if (hashes.length * 200 > MAX_METADATA_SIZE / 2)
            throw new Error("The media has too many blocks for this client.")
    }
    try {
        while (true) {
            options.signal?.throwIfAborted()
            const { value, done } = await reader.read()
            if (done) break
            if (!value?.length) continue
            size += value.length
            if (!Number.isSafeInteger(size) || (options.expectedSize !== undefined && size > options.expectedSize))
                throw new Error("The media exceeded its expected size.")
            indexer.append(value)
            await accumulator.update(value)
            let offset = 0
            while (offset < value.length) {
                const n = Math.min(value.length - offset, buffer.length - buffered)
                buffer.set(value.subarray(offset, offset + n), buffered)
                buffered += n
                offset += n
                if (buffered === buffer.length) await uploadBlock()
            }
            options.onBytes?.(size)
        }
        options.signal?.throwIfAborted()
        const mediaIndex = indexer.finish(options.duration)
        const ufid = await finishUfid(accumulator, size)
        if (
            (options.expectedSize !== undefined && size !== options.expectedSize) ||
            (options.expectedUfid !== undefined && ufid !== options.expectedUfid)
        )
            throw new Error("The source media failed its size or UFID verification. Its original copy was preserved.")
        if (buffered) await uploadBlock()
        const plan: BlockPlan = {
            type: "tglfs:upload-plan",
            version: 1,
            id: content.id,
            fingerprint: "generated-media",
            name: options.name,
            size,
            ufid,
            hashes,
            mediaIndex,
        }
        const map: BlockMap = {
            type: "tglfs:block-map",
            version: 1,
            id: content.id,
            messages,
            payload: await seal(
                jsonBytes({ type: "tglfs:block-manifest", version: 1, plan, blocks } satisfies BlockManifest),
                key,
                content,
                "manifest",
            ),
        }
        const bytes = jsonBytes(map)
        if (bytes.length > MAX_METADATA_SIZE) throw new Error("The media seek index exceeds its permitted size.")
        const manifest = await sendTransferDocument(client, options, bytes, `${content.id}.media-map`)
        messages.push(manifest.id)
        const data = createFileCardV5Data({
            name: options.name,
            ufid,
            size,
            uploadComplete: true,
            chunks: [manifest.id],
            IV: "",
            parentFolderId: options.parentFolderId,
            content,
            mediaPreview: {
                type: "tglfs:media-preview",
                version: 1,
                container: options.container,
                seeking: "byte-range",
                ...(options.source ? { source: options.source } : {}),
            },
        })
        options.signal?.throwIfAborted()
        publishing = true
        const sent = await client.sendMessage(options.peer || "me", { message: serializeFileCardMessage(data) })
        return { msgId: sent.id, date: sent.date, data }
    } catch (error) {
        await reader.cancel(error).catch(() => {})
        if (!publishing && messages.length && options.Api.messages?.DeleteMessages) {
            try {
                for (let i = 0; i < messages.length; i += 100)
                    await client.invoke(new options.Api.messages.DeleteMessages({ id: messages.slice(i, i + 100) }))
            } catch {
                throw new Error(
                    `${error instanceof Error ? error.message : String(error)} Unpublished media chunks could not be removed: ${messages.join(", ")}.`,
                    { cause: error },
                )
            }
        }
        throw error
    } finally {
        reader.releaseLock()
    }
}
