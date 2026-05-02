import { openAsBlob } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"

import type { TelegramClient } from "telegram/client/TelegramClient.js"

import { downloadFileCard } from "./download.js"
import { CliError, EXIT_CODES } from "./errors.js"
import { getGramJs } from "./gramjs.js"
import { getFileCardByUfid } from "./protocol.js"
import {
    buildSyncManifestSearchQuery,
    createEmptySyncManifest,
    extractSyncManifestRecords,
    serializeSyncManifestMessage,
} from "./sync-manifest.js"
import type { SyncManifest, SyncManifestEntry, SyncManifestRecord } from "./sync-manifest.js"
import { scanSyncFolder } from "./sync-scan.js"
import type { LocalSyncFile } from "./sync-scan.js"
import { loadSyncLedger, resolveLedgerRoot, saveSyncLedger } from "./sync-store.js"
import type { SyncLedgerRoot } from "./sync-store.js"
import { computeUfidFromStream } from "./ufid.js"
import { DuplicateUfidError, uploadCurrentFormatSource } from "./shared/upload.js"
import type { UploadSource } from "./shared/upload.js"

type ApiLike = {
    messages: {
        EditMessage: new (args: any) => any
    }
}

type SyncClient = {
    getMessages(peer: string, options: unknown): Promise<any[]>
    sendMessage(peer: string, options: { message: string }): Promise<any>
    invoke(request: any): Promise<any>
}

type UploadFile = (file: LocalSyncFile) => Promise<{ ufid: string; size: number }>
type DownloadFile = (ufid: string, outputPath: string) => Promise<void>

export type SyncDiff = {
    added: LocalSyncFile[]
    modified: LocalSyncFile[]
    unchanged: LocalSyncFile[]
    deleted: SyncManifestEntry[]
}

export type SyncPushResult = {
    rootId: string
    rootName: string
    manifestMsgId: number
    added: number
    modified: number
    unchanged: number
    deleted: number
    uploaded: Array<{ path: string; ufid: string }>
}

export type SyncPullResult = {
    rootId: string
    rootName: string
    destination: string
    downloaded: Array<{ path: string; ufid: string; outputPath: string }>
    skipped: Array<{ path: string; reason: string }>
    conflicts: Array<{ path: string; conflictPath: string }>
}

export type SyncStatusResult = {
    rootId: string
    rootName: string
    folderPath: string
    manifestMsgId?: number
    added: number
    modified: number
    unchanged: number
    deleted: number
}

export type SyncListResult = {
    roots: SyncLedgerRoot[]
}

function nowIso() {
    return new Date().toISOString()
}

function hashManifest(manifest: SyncManifest) {
    return createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
}

function createEntryId(rootId: string, path: string) {
    return createHash("sha256").update(`${rootId}\0${path}`).digest("hex")
}

function sameFile(entry: SyncManifestEntry | undefined, file: LocalSyncFile) {
    return entry !== undefined && !entry.deleted && entry.size === file.size && entry.mtimeMs === file.mtimeMs
}

export function diffSyncFiles(files: LocalSyncFile[], manifest: SyncManifest): SyncDiff {
    const localByPath = new Map(files.map((file) => [file.path, file]))
    const added: LocalSyncFile[] = []
    const modified: LocalSyncFile[] = []
    const unchanged: LocalSyncFile[] = []
    const deleted: SyncManifestEntry[] = []

    for (const file of files) {
        const entry = manifest.entries[file.path]
        if (!entry || entry.deleted) {
            added.push(file)
        } else if (sameFile(entry, file)) {
            unchanged.push(file)
        } else {
            modified.push(file)
        }
    }

    for (const entry of Object.values(manifest.entries)) {
        if (!entry.deleted && !localByPath.has(entry.path)) {
            deleted.push(entry)
        }
    }

    return { added, modified, unchanged, deleted }
}

export async function findSyncManifest(client: SyncClient, rootId: string): Promise<SyncManifestRecord | null> {
    const messages = await client.getMessages("me", {
        search: buildSyncManifestSearchQuery(rootId),
        limit: 10,
        waitTime: 0,
    } as any)
    return extractSyncManifestRecords(messages).find((record) => record.data.rootId === rootId) ?? null
}

export async function writeSyncManifest(
    client: SyncClient,
    options: {
        Api: ApiLike
        manifest: SyncManifest
        existing?: SyncManifestRecord | null
    },
): Promise<SyncManifestRecord> {
    const message = serializeSyncManifestMessage(options.manifest)
    if (!options.existing) {
        const result = await client.sendMessage("me", { message })
        return {
            msgId: result.id,
            date: result.date,
            peerId: result.peerId,
            data: options.manifest,
        }
    }

    await client.invoke(
        new options.Api.messages.EditMessage({
            peer: options.existing.peerId ?? "me",
            id: options.existing.msgId,
            message,
        }),
    )
    return {
        ...options.existing,
        data: options.manifest,
    }
}

async function defaultUploadFile(client: TelegramClient, chunkSize: number, password: string, file: LocalSyncFile) {
    const { Api } = getGramJs()
    const blob = await openAsBlob(file.absolutePath)
    const source: UploadSource = {
        name: basename(file.path),
        size: file.size,
        stream() {
            return blob.stream() as ReadableStream<Uint8Array>
        },
    }
    try {
        const record = await uploadCurrentFormatSource(client, {
            Api,
            chunkSize,
            password,
            source,
        })
        return {
            ufid: record.data.ufid,
            size: record.data.size,
        }
    } catch (error) {
        if (error instanceof DuplicateUfidError) {
            return {
                ufid: error.ufid,
                size: file.size,
            }
        }
        throw error
    }
}

async function defaultDownloadFile(client: TelegramClient, password: string, ufid: string, outputPath: string) {
    const record = await getFileCardByUfid(client, ufid)
    await downloadFileCard(client, record.data, password, outputPath, false)
}

export async function initSyncRoot(
    client: SyncClient,
    options: {
        Api: ApiLike
        folderPath: string
        rootName: string
    },
) {
    const absolutePath = resolve(options.folderPath)
    const rootName = options.rootName.trim()
    if (rootName === "") {
        throw new CliError("invalid_sync_root", "Sync root name must not be empty.", EXIT_CODES.GENERAL_ERROR)
    }
    const stats = await stat(absolutePath)
    if (!stats.isDirectory()) {
        throw new CliError("invalid_sync_root", `Sync path must be a directory: ${absolutePath}.`, EXIT_CODES.GENERAL_ERROR)
    }

    const ledger = await loadSyncLedger()
    const existing = Object.values(ledger.roots).find((root) => resolve(root.folderPath) === absolutePath)
    if (existing) {
        return {
            root: existing,
            created: false,
        }
    }

    const rootId = randomUUID()
    const manifest = createEmptySyncManifest({ rootId, rootName })
    const record = await writeSyncManifest(client, { Api: options.Api, manifest })
    const root: SyncLedgerRoot = {
        rootId,
        rootName,
        folderPath: absolutePath,
        manifestMsgId: record.msgId,
        lastManifestHash: hashManifest(manifest),
        lastSyncedFiles: {},
    }
    ledger.roots[rootId] = root
    await saveSyncLedger(ledger)
    return {
        root,
        created: true,
    }
}

function upsertManifestEntry(
    manifest: SyncManifest,
    file: LocalSyncFile,
    upload: { ufid: string; size: number },
    timestamp: string,
) {
    manifest.entries[file.path] = {
        entryId: manifest.entries[file.path]?.entryId ?? createEntryId(manifest.rootId, file.path),
        path: file.path,
        ufid: upload.ufid,
        size: upload.size,
        mtimeMs: file.mtimeMs,
        mode: file.mode,
        deleted: false,
        updatedAt: timestamp,
    }
}

function updateRootFromManifest(root: SyncLedgerRoot, record: SyncManifestRecord) {
    root.manifestMsgId = record.msgId
    root.lastManifestHash = hashManifest(record.data)
    root.lastSyncedFiles = Object.fromEntries(
        Object.values(record.data.entries).map((entry) => [
            entry.path,
            {
                ufid: entry.ufid,
                size: entry.size,
                mtimeMs: entry.mtimeMs,
                deleted: entry.deleted,
            },
        ]),
    )
}

export async function pushSyncRoot(
    client: SyncClient,
    options: {
        Api: ApiLike
        root: SyncLedgerRoot
        password: string
        chunkSize: number
        uploadFile?: UploadFile
    },
): Promise<SyncPushResult> {
    const existing = await findSyncManifest(client, options.root.rootId)
    const manifest = existing?.data ?? createEmptySyncManifest({ rootId: options.root.rootId, rootName: options.root.rootName })
    const files = await scanSyncFolder(options.root.folderPath)
    const diff = diffSyncFiles(files, manifest)
    const uploadFile =
        options.uploadFile ?? ((file: LocalSyncFile) => defaultUploadFile(client as TelegramClient, options.chunkSize, options.password, file))
    const timestamp = nowIso()
    const uploaded: Array<{ path: string; ufid: string }> = []

    for (const file of [...diff.added, ...diff.modified]) {
        const upload = await uploadFile(file)
        upsertManifestEntry(manifest, file, upload, timestamp)
        uploaded.push({ path: file.path, ufid: upload.ufid })
    }

    for (const entry of diff.deleted) {
        manifest.entries[entry.path] = {
            ...entry,
            deleted: true,
            updatedAt: timestamp,
        }
    }

    manifest.updatedAt = timestamp
    const record = await writeSyncManifest(client, {
        Api: options.Api,
        manifest,
        existing: existing ?? (options.root.manifestMsgId ? { msgId: options.root.manifestMsgId, date: 0, data: manifest } : null),
    })

    const ledger = await loadSyncLedger()
    const root = ledger.roots[options.root.rootId] ?? options.root
    updateRootFromManifest(root, record)
    ledger.roots[root.rootId] = root
    await saveSyncLedger(ledger)

    return {
        rootId: root.rootId,
        rootName: root.rootName,
        manifestMsgId: record.msgId,
        added: diff.added.length,
        modified: diff.modified.length,
        unchanged: diff.unchanged.length,
        deleted: diff.deleted.length,
        uploaded,
    }
}

function conflictPathFor(outputPath: string, timestamp: string) {
    const ext = extname(outputPath)
    const base = ext ? outputPath.slice(0, -ext.length) : outputPath
    const stamp = timestamp.replace(/[-:]/g, "").replace("T", " ").slice(0, 15)
    return `${base} (TGLFS conflict ${stamp})${ext}`
}

async function existingFileMatches(path: string, entry: SyncManifestEntry) {
    try {
        const stats = await stat(path)
        if (!stats.isFile() || stats.size !== entry.size) {
            return false
        }
        const blob = await openAsBlob(path)
        const ufid = await computeUfidFromStream(blob.stream() as ReadableStream<Uint8Array>, undefined, stats.size)
        return ufid === entry.ufid
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return null
        }
        throw error
    }
}

export async function pullSyncRoot(
    client: SyncClient,
    options: {
        rootId: string
        destination: string
        password: string
        downloadFile?: DownloadFile
        now?: string
    },
): Promise<SyncPullResult> {
    const record = await findSyncManifest(client, options.rootId)
    if (!record) {
        throw new CliError("sync_manifest_not_found", `No sync manifest found for root ${options.rootId}.`, EXIT_CODES.FILE_NOT_FOUND)
    }

    const destination = resolve(options.destination)
    await mkdir(destination, { recursive: true })
    const download =
        options.downloadFile ?? ((ufid: string, outputPath: string) => defaultDownloadFile(client as TelegramClient, options.password, ufid, outputPath))
    const timestamp = options.now ?? nowIso()
    const downloaded: SyncPullResult["downloaded"] = []
    const skipped: SyncPullResult["skipped"] = []
    const conflicts: SyncPullResult["conflicts"] = []
    const conflictedPaths = new Set<string>()

    for (const entry of Object.values(record.data.entries).sort((a, b) => a.path.localeCompare(b.path))) {
        if (entry.deleted) {
            skipped.push({ path: entry.path, reason: "deleted" })
            continue
        }
        const outputPath = join(destination, entry.path)
        const match = await existingFileMatches(outputPath, entry)
        let targetPath = outputPath
        if (match === true) {
            skipped.push({ path: entry.path, reason: "unchanged" })
            continue
        }
        if (match === false) {
            targetPath = conflictPathFor(outputPath, timestamp)
            conflicts.push({ path: entry.path, conflictPath: targetPath })
            conflictedPaths.add(entry.path)
        }
        await mkdir(dirname(targetPath), { recursive: true })
        await download(entry.ufid, targetPath)
        downloaded.push({ path: entry.path, ufid: entry.ufid, outputPath: targetPath })
    }

    const ledger = await loadSyncLedger()
    const syncedEntries = Object.values(record.data.entries).filter((entry) => !conflictedPaths.has(entry.path))
    ledger.roots[record.data.rootId] = {
        rootId: record.data.rootId,
        rootName: record.data.rootName,
        folderPath: destination,
        manifestMsgId: record.msgId,
        lastManifestHash: hashManifest(record.data),
        lastSyncedFiles: Object.fromEntries(
            syncedEntries.map((entry) => [
                entry.path,
                {
                    ufid: entry.ufid,
                    size: entry.size,
                    mtimeMs: entry.mtimeMs,
                    deleted: entry.deleted,
                },
            ]),
        ),
    }
    await saveSyncLedger(ledger)

    return {
        rootId: record.data.rootId,
        rootName: record.data.rootName,
        destination,
        downloaded,
        skipped,
        conflicts,
    }
}

export async function statusSyncRoot(client: SyncClient, root: SyncLedgerRoot): Promise<SyncStatusResult> {
    const record = await findSyncManifest(client, root.rootId)
    const manifest = record?.data ?? createEmptySyncManifest({ rootId: root.rootId, rootName: root.rootName })
    const files = await scanSyncFolder(root.folderPath)
    const diff = diffSyncFiles(files, manifest)
    return {
        rootId: root.rootId,
        rootName: root.rootName,
        folderPath: root.folderPath,
        manifestMsgId: record?.msgId ?? root.manifestMsgId,
        added: diff.added.length,
        modified: diff.modified.length,
        unchanged: diff.unchanged.length,
        deleted: diff.deleted.length,
    }
}

export async function listSyncRoots(): Promise<SyncListResult> {
    const ledger = await loadSyncLedger()
    return {
        roots: Object.values(ledger.roots).sort((a, b) => a.rootName.localeCompare(b.rootName)),
    }
}

export async function resolveSyncRootOrThrow(folderOrRootId: string) {
    const ledger = await loadSyncLedger()
    const root = resolveLedgerRoot(ledger, folderOrRootId)
    if (!root) {
        throw new CliError(
            "sync_root_not_found",
            `No sync root found for ${folderOrRootId}. Run tglfs sync init first.`,
            EXIT_CODES.FILE_NOT_FOUND,
        )
    }
    return root
}
