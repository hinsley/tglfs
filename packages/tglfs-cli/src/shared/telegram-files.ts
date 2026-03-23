import { BATCH_DELAY_MS, BATCH_LIMIT } from "./constants.js"
import {
    buildFileCardSearchQuery,
    buildFileCardUfidLookupQuery,
    extractFileCardRecords,
    serializeFileCardMessage,
} from "./file-cards.js"
import type { FileCardData, FileCardRecord } from "./file-cards.js"

type ApiLike = {
    messages: {
        EditMessage: new (args: any) => any
        DeleteMessages: new (args: any) => any
        ForwardMessages: new (args: any) => any
    }
}

type TelegramFileClient = {
    getMessages(peer: string, options: unknown): Promise<any[]>
    invoke(request: any): Promise<any>
    sendMessage(peer: string, options: { message: string }): Promise<any>
}

type ListFileCardsOptions = {
    peer?: string
    query?: string
    limit?: number
    offsetId?: number
}

type LookupFileCardByUfidOptions = {
    peer?: string
    limit?: number
}

type WriteFileCardOptions = {
    Api: ApiLike
    peer?: string
    msgId?: number
    peerId?: unknown
    data: FileCardData
}

type DeleteFileCardOptions = {
    Api: ApiLike
    msgId: number
    data: FileCardData
}

type ForwardChunkMessagesOptions = {
    Api: ApiLike
    fromPeer?: string
    toPeer: string
    chunkIds: number[]
    silent?: boolean
    batchLimit?: number
    batchDelayMs?: number
    onChunkForwarded?: (progress: { completed: number; total: number; sourceChunkId: number; targetChunkId: number }) => void
}

type TransferFileCardOptions = {
    Api: ApiLike
    record: FileCardRecord
    sourcePeer?: string
    targetPeer: string
    silent?: boolean
    batchLimit?: number
    batchDelayMs?: number
    onChunkForwarded?: ForwardChunkMessagesOptions["onChunkForwarded"]
}

type UnsendFileCardOptions = {
    Api: ApiLike
    record: FileCardRecord
    peer?: string
    batchLimit?: number
    batchDelayMs?: number
}

function resolvePeer(peer?: string) {
    return peer?.trim() ? peer.trim() : "me"
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractForwardedMessageId(result: any) {
    const updateWithId = result?.updates?.find?.((update: any) => typeof update?.id === "number")
    const id = updateWithId?.id ?? result?.updates?.[0]?.id
    return typeof id === "number" ? id : null
}

export async function listFileCards(
    client: TelegramFileClient,
    options: ListFileCardsOptions = {},
): Promise<FileCardRecord[]> {
    const peer = resolvePeer(options.peer)
    const messages = await client.getMessages(peer, {
        search: buildFileCardSearchQuery(options.query),
        limit: options.limit ?? 50,
        addOffset: 0,
        minId: 0,
        maxId: options.offsetId ?? 0,
        waitTime: 0,
    } as any)

    return extractFileCardRecords(messages)
}

export async function lookupFileCardByUfid(
    client: TelegramFileClient,
    ufid: string,
    options: LookupFileCardByUfidOptions = {},
): Promise<FileCardRecord | null> {
    const trimmed = ufid.trim()
    if (trimmed === "") {
        return null
    }

    const peer = resolvePeer(options.peer)
    const messages = await client.getMessages(peer, {
        search: buildFileCardUfidLookupQuery(trimmed),
        limit: options.limit ?? 10,
        waitTime: 0,
    } as any)

    return extractFileCardRecords(messages).find((record) => record.data.ufid === trimmed) ?? null
}

export async function writeFileCardMessage(client: TelegramFileClient, options: WriteFileCardOptions) {
    const peer = resolvePeer(options.peer)
    const message = serializeFileCardMessage(options.data)

    if (options.msgId === undefined) {
        return client.sendMessage(peer, { message })
    }

    return client.invoke(
        new options.Api.messages.EditMessage({
            peer: options.peerId ?? peer,
            id: options.msgId,
            message,
        }),
    )
}

export async function renameFileCardMessage(
    client: TelegramFileClient,
    options: WriteFileCardOptions & { newName: string },
) {
    return writeFileCardMessage(client, {
        ...options,
        data: {
            ...options.data,
            name: options.newName,
        },
    })
}

export async function deleteFileCardMessages(client: TelegramFileClient, options: DeleteFileCardOptions) {
    return client.invoke(
        new options.Api.messages.DeleteMessages({
            id: [...options.data.chunks, options.msgId],
        }),
    )
}

export async function forwardChunkMessages(
    client: TelegramFileClient,
    options: ForwardChunkMessagesOptions,
): Promise<number[]> {
    const sourcePeer = resolvePeer(options.fromPeer)
    const batchLimit = options.batchLimit ?? BATCH_LIMIT
    const batchDelayMs = options.batchDelayMs ?? BATCH_DELAY_MS
    const targetChunkIds: number[] = []

    for (let index = 0; index < options.chunkIds.length; index += 1) {
        const sourceChunkId = options.chunkIds[index]
        const result = await client.invoke(
            new options.Api.messages.ForwardMessages({
                fromPeer: sourcePeer,
                toPeer: options.toPeer,
                id: [sourceChunkId],
                silent: options.silent ?? false,
            }),
        )

        const targetChunkId = extractForwardedMessageId(result)
        if (targetChunkId === null) {
            throw new Error(`Unable to determine forwarded Telegram message id for chunk ${sourceChunkId}.`)
        }

        targetChunkIds.push(targetChunkId)
        options.onChunkForwarded?.({
            completed: targetChunkIds.length,
            total: options.chunkIds.length,
            sourceChunkId,
            targetChunkId,
        })

        const completed = index + 1
        if (completed % batchLimit === 0 && completed < options.chunkIds.length) {
            await sleep(batchDelayMs)
        }
    }

    return targetChunkIds
}

export async function transferFileCard(
    client: TelegramFileClient & { sendMessage(peer: string, options: { message: string }): Promise<any> },
    options: TransferFileCardOptions,
): Promise<FileCardRecord> {
    const updatedChunks = await forwardChunkMessages(client, {
        Api: options.Api,
        fromPeer: options.sourcePeer,
        toPeer: options.targetPeer,
        chunkIds: options.record.data.chunks,
        silent: options.silent,
        batchLimit: options.batchLimit,
        batchDelayMs: options.batchDelayMs,
        onChunkForwarded: options.onChunkForwarded,
    })

    const updatedData: FileCardData = {
        ...options.record.data,
        chunks: updatedChunks,
    }
    const message = await client.sendMessage(resolvePeer(options.targetPeer), {
        message: serializeFileCardMessage(updatedData),
    })

    return {
        msgId: message.id,
        date: message.date,
        data: updatedData,
    }
}

export async function unsendFileCard(client: TelegramFileClient, options: UnsendFileCardOptions) {
    const peer = resolvePeer(options.peer)
    const batchLimit = options.batchLimit ?? BATCH_LIMIT
    const batchDelayMs = options.batchDelayMs ?? BATCH_DELAY_MS

    for (let index = 0; index < options.record.data.chunks.length; index += batchLimit) {
        const batch = options.record.data.chunks.slice(index, index + batchLimit)
        await client.invoke(
            new options.Api.messages.DeleteMessages({
                id: batch,
            }),
        )
        if (index + batch.length < options.record.data.chunks.length) {
            await sleep(batchDelayMs)
        }
    }

    return client.invoke(
        new options.Api.messages.DeleteMessages({
            id: [options.record.msgId],
        }),
    )
}
