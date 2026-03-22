import type { TelegramClient } from "telegram/client/TelegramClient.js"

import type { DownloadMode } from "./download.js"
import {
    coerceTelegramDocumentSize,
    inspectFileFromEncryptedParts,
    iterateEncryptedFile,
} from "./download.js"
import { CliError, EXIT_CODES } from "./errors.js"
import { getGramJs } from "./gramjs.js"
import { validateDownloadableFileCard } from "./protocol.js"
import type { FileCardData, FileCardRecord } from "./types.js"
import {
    deleteFileCardMessages,
    lookupFileCardByUfid,
    renameFileCardMessage,
    transferFileCard,
    unsendFileCard,
} from "./shared/telegram-files.js"

export type ChunkInspection = {
    msgId: number
    status: "ok" | "missing" | "not_document" | "invalid_size"
    size?: number
    className?: string
}

export type FileInspectionResult = {
    peer: string
    msgId: number
    date: number
    data: FileCardData
    chunks: ChunkInspection[]
    format: DownloadMode | "unknown"
    probe?:
        | {
              mode: DownloadMode
              bytesWritten: number
              computedUfid: string
          }
        | undefined
    probeError?: string
}

export type FileModeProbe = NonNullable<FileInspectionResult["probe"]>

export type FileModeDetectionResult = {
    probe?: FileModeProbe
    lastError?: string
}

function normalizePeer(peer: string | undefined, fallback = "me") {
    const normalized = peer?.trim() ?? fallback
    if (normalized === "") {
        throw new CliError("invalid_input", "Peer must not be empty.", EXIT_CODES.GENERAL_ERROR)
    }
    return normalized
}

export async function resolveFileCardRecord(client: TelegramClient, ufid: string, peer = "me") {
    const normalizedPeer = normalizePeer(peer)
    const record = await lookupFileCardByUfid(client as any, ufid.trim(), { peer: normalizedPeer })
    if (!record) {
        throw new CliError(
            "file_not_found",
            `No TGLFS file card was found for UFID ${ufid.trim()} in ${normalizedPeer === "me" ? "Saved Messages" : normalizedPeer}.`,
            EXIT_CODES.FILE_NOT_FOUND,
        )
    }
    return record
}

export async function renameFile(client: TelegramClient, ufid: string, newName: string) {
    const record = await resolveFileCardRecord(client, ufid, "me")
    const trimmedName = newName.trim()
    if (trimmedName === "") {
        throw new CliError("invalid_input", "New file name must not be empty.", EXIT_CODES.GENERAL_ERROR)
    }

    const { Api } = getGramJs()
    const updated = { ...record.data, name: trimmedName }
    await renameFileCardMessage(client as any, {
        Api: Api as any,
        peer: "me",
        msgId: record.msgId,
        peerId: "me",
        data: record.data,
        newName: trimmedName,
    })
    return {
        before: record,
        after: {
            ...record,
            data: updated,
        },
    }
}

export async function deleteFiles(client: TelegramClient, ufids: string[]) {
    const { Api } = getGramJs()
    const deleted: FileCardRecord[] = []
    for (const ufid of ufids) {
        const record = await resolveFileCardRecord(client, ufid, "me")
        await deleteFileCardMessages(client as any, {
            Api: Api as any,
            msgId: record.msgId,
            data: record.data,
        })
        deleted.push(record)
    }
    return deleted
}

export async function sendFiles(client: TelegramClient, ufids: string[], recipient: string) {
    const normalizedRecipient = normalizePeer(recipient, "")
    const { Api } = getGramJs()
    const sent: Array<{ source: FileCardRecord; recipient: string; data: FileCardData }> = []
    for (const ufid of ufids) {
        const record = await resolveFileCardRecord(client, ufid, "me")
        validateDownloadableFileCard(record.data)
        const result = await transferFileCard(client as any, {
            Api: Api as any,
            record,
            sourcePeer: "me",
            targetPeer: normalizedRecipient,
            silent: true,
        })
        sent.push({
            source: record,
            recipient: normalizedRecipient,
            data: result.data,
        })
    }
    return sent
}

export async function receiveFiles(client: TelegramClient, source: string, ufids: string[]) {
    const normalizedSource = normalizePeer(source, "")
    const { Api } = getGramJs()
    const received: Array<{ source: string; original: FileCardRecord; data: FileCardData }> = []
    for (const ufid of ufids) {
        const record = await resolveFileCardRecord(client, ufid, normalizedSource)
        validateDownloadableFileCard(record.data)
        const result = await transferFileCard(client as any, {
            Api: Api as any,
            record,
            sourcePeer: normalizedSource,
            targetPeer: "me",
        })
        received.push({
            source: normalizedSource,
            original: record,
            data: result.data,
        })
    }
    return received
}

export async function unsendFiles(client: TelegramClient, source: string, ufids: string[]) {
    const normalizedSource = normalizePeer(source, "")
    const { Api } = getGramJs()
    const unsent: FileCardRecord[] = []
    for (const ufid of ufids) {
        const record = await resolveFileCardRecord(client, ufid, normalizedSource)
        await unsendFileCard(client as any, {
            Api: Api as any,
            record,
            peer: normalizedSource,
        })
        unsent.push(record)
    }
    return unsent
}

async function inspectChunkMessages(client: TelegramClient, peer: string, data: FileCardData): Promise<ChunkInspection[]> {
    const messages = await client.getMessages(peer, { ids: data.chunks, waitTime: 0 } as any)
    const byId = new Map<number, any>()
    for (const message of messages) {
        if (typeof message?.id === "number") {
            byId.set(message.id, message)
        }
    }

    return data.chunks.map((chunkId) => {
        const message = byId.get(chunkId)
        if (!message) {
            return { msgId: chunkId, status: "missing" }
        }
        if (!message?.media?.document) {
            return {
                msgId: chunkId,
                status: "not_document",
                className: message.className,
            }
        }

        const size = coerceTelegramDocumentSize(message.media.document.size)
        if (size === null) {
            return {
                msgId: chunkId,
                status: "invalid_size",
                className: message.className,
            }
        }

        return {
            msgId: chunkId,
            status: "ok",
            size,
            className: message.className,
        }
    })
}

export async function detectFileMode(
    expected: { size: number; ufid: string },
    inspectMode: (mode: DownloadMode) => Promise<{ bytesWritten: number; computedUfid: string }>,
): Promise<FileModeDetectionResult> {
    let lastError: string | undefined

    for (const mode of ["current", "legacy"] satisfies DownloadMode[]) {
        try {
            const result = await inspectMode(mode)
            if (result.bytesWritten === expected.size && result.computedUfid === expected.ufid) {
                return {
                    probe: {
                        mode,
                        bytesWritten: result.bytesWritten,
                        computedUfid: result.computedUfid,
                    },
                }
            }
            lastError = `The ${mode} probe did not match the expected UFID.`
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
        }
    }

    return { lastError }
}

async function probeFileMode(
    client: TelegramClient,
    peer: string,
    data: FileCardData,
    password: string,
): Promise<FileModeDetectionResult> {
    return detectFileMode({ size: data.size, ufid: data.ufid }, (mode) =>
        inspectFileFromEncryptedParts(data, password, iterateEncryptedFile(client, data, peer), mode),
    )
}

export async function inspectFileCard(
    client: TelegramClient,
    ufid: string,
    options: {
        peer?: string
        password?: string
    } = {},
): Promise<FileInspectionResult> {
    const peer = normalizePeer(options.peer)
    const record = await resolveFileCardRecord(client, ufid, peer)
    const chunks = await inspectChunkMessages(client, peer, record.data)
    const everyChunkReadable = chunks.every((chunk) => chunk.status === "ok")

    let probe: FileInspectionResult["probe"]
    let probeError: string | undefined
    if (everyChunkReadable) {
        try {
            const detection = await probeFileMode(client, peer, record.data, options.password ?? "")
            probe = detection.probe
            if (!probe) {
                probeError =
                    detection.lastError ??
                    (options.password === undefined
                        ? "Format probe could not distinguish current vs legacy with an empty password."
                        : "Format probe failed with the supplied password.")
            }
        } catch (error) {
            probeError = error instanceof Error ? error.message : String(error)
        }
    } else {
        probeError = "One or more Telegram chunk messages are missing or malformed."
    }

    return {
        peer,
        msgId: record.msgId,
        date: record.date,
        data: record.data,
        chunks,
        format: probe?.mode ?? "unknown",
        probe,
        probeError,
    }
}
