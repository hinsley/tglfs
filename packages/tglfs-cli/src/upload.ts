import { openAsBlob } from "node:fs"
import { stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

import type { TelegramClient } from "telegram/client/TelegramClient.js"

import { CliError, EXIT_CODES } from "./errors.js"
import { getGramJs } from "./gramjs.js"
import { computeTarSize, createTarStream, defaultArchiveName } from "./shared/archive.js"
import type { ArchiveEntry } from "./shared/archive.js"
import { DuplicateUfidError } from "./shared/upload.js"
import type { UploadProgress } from "./shared/upload.js"
import { uploadResumableFile } from "./shared/block-transfer.js"
import type { SeekableSource } from "./shared/block-transfer.js"
import { hashBytes, jsonBytes } from "./shared/block-format.js"

type LocalArchiveEntry = ArchiveEntry & {
    path: string
}

export type UploadPathsResult = {
    name: string
    ufid: string
    size: number
    msgId: number
    date: number
    chunks: number[]
    sourcePaths: string[]
    archived: boolean
}

async function resolveLocalArchiveEntry(inputPath: string): Promise<LocalArchiveEntry> {
    const absolutePath = resolve(inputPath)
    let stats
    try {
        stats = await stat(absolutePath)
    } catch (error) {
        throw new CliError(
            "invalid_input",
            `Upload path does not exist: ${absolutePath}.`,
            EXIT_CODES.GENERAL_ERROR,
            { path: absolutePath, cause: error instanceof Error ? error.message : String(error) },
        )
    }

    if (!stats.isFile()) {
        throw new CliError(
            "invalid_input",
            `Upload path must be a file: ${absolutePath}.`,
            EXIT_CODES.GENERAL_ERROR,
            { path: absolutePath },
        )
    }

    const blob = await openAsBlob(absolutePath)

    return {
        path: absolutePath,
        name: basename(absolutePath),
        size: stats.size,
        lastModified: Math.floor(stats.mtimeMs) || 1000,
        range(start, end) { return blob.slice(start, end).stream() as ReadableStream<Uint8Array> },
        stream() {
            return blob.stream() as ReadableStream<Uint8Array>
        },
    }
}

async function resolveUploadSource(paths: string[]): Promise<{
    source: SeekableSource
    sourcePaths: string[]
    archived: boolean
}> {
    if (paths.length === 0) {
        throw new CliError("invalid_input", "At least one file path is required.", EXIT_CODES.GENERAL_ERROR)
    }

    const entries = await Promise.all(paths.map((path) => resolveLocalArchiveEntry(path)))
    if (entries.length === 1) {
        const [entry] = entries
        return {
            source: {
                name: entry.name,
                size: entry.size,
                archive: /\.tar$/i.test(entry.name),
                fingerprint: await hashBytes(jsonBytes([[entry.name, entry.size, entry.lastModified]])),
                slice(start, end) { return entry.range!(start, end) },
            },
            sourcePaths: [entry.path],
            archived: false,
        }
    }

    return {
        source: {
            name: defaultArchiveName(),
            size: computeTarSize(entries),
            archive: true,
            fingerprint: await hashBytes(jsonBytes(entries.map(e => [e.name, e.size, e.lastModified]))),
            slice(start, end) { return createTarStream(entries, start, end) },
        },
        sourcePaths: entries.map((entry) => entry.path),
        archived: true,
    }
}

function normalizeUploadError(error: unknown): CliError {
    if (error instanceof CliError) {
        return error
    }
    if (error instanceof DuplicateUfidError) {
        return new CliError(
            "duplicate_ufid",
            `A file with UFID ${error.ufid} already exists in Saved Messages.`,
            EXIT_CODES.GENERAL_ERROR,
            { ufid: error.ufid },
        )
    }
    if (error instanceof Error) {
        return new CliError("upload_failed", error.message, EXIT_CODES.GENERAL_ERROR)
    }
    return new CliError("upload_failed", String(error), EXIT_CODES.GENERAL_ERROR)
}

export async function uploadPaths(
    client: TelegramClient,
    options: {
        paths: string[]
        chunkSize: number
        password: string
        resumeId?: string
        onUfidProgress?: (progress: UploadProgress) => void
        onUploadProgress?: (progress: UploadProgress) => void
    },
): Promise<UploadPathsResult> {
    const { Api, getFileInfo } = getGramJs()
    const resolved = await resolveUploadSource(options.paths)

    try {
        const record = await uploadResumableFile(client as any, {
            Api, getFileInfo, password: options.password, source: resolved.source, resumeId: options.resumeId,
            onProgress(progress) {
                const report = progress.phase === "reading" ? options.onUfidProgress : options.onUploadProgress
                report?.({ bytesProcessed: progress.bytesProcessed, totalBytes: progress.totalBytes })
            },
        })

        return {
            name: record.data.name,
            ufid: record.data.ufid,
            size: record.data.size,
            msgId: record.msgId,
            date: record.date,
            chunks: record.data.chunks,
            sourcePaths: resolved.sourcePaths,
            archived: resolved.archived,
        }
    } catch (error) {
        throw normalizeUploadError(error)
    }
}
