export const TGLFS_FOLDER_TYPE = "tglfs:folder" as const
export const TGLFS_FOLDER_PROTOCOL_VERSION = 2 as const
export const TGLFS_FOLDER_VERSION = TGLFS_FOLDER_PROTOCOL_VERSION
export const TGLFS_FOLDER_MANIFEST_TYPE = "tglfs:folder-manifest" as const
export const TGLFS_FOLDER_ENTRIES_TYPE = "tglfs:folder-entries" as const
export const TGLFS_FOLDER_MANIFEST_VERSION = 1 as const
export const TGLFS_FOLDER_ENTRIES_MIME_TYPE = "application/json" as const

export type TglfsFolderProtocolVersion = 1 | typeof TGLFS_FOLDER_PROTOCOL_VERSION

export type TglfsFolder = {
    type: typeof TGLFS_FOLDER_TYPE
    version: TglfsFolderProtocolVersion
    folderId: string
    parentFolderId?: string
    rootId?: string
    name: string
    path: string
    createdAt: string
    updatedAt: string
    deleted: boolean
    entriesRevision?: number
    entriesHash?: string
    entriesFileName?: string
}

export type TglfsFolderManifestEntry = {
    entryId: string
    name: string
    path: string
    kind: "file" | "folder"
    ufid?: string
    folderId?: string
    size?: number
    mtimeMs?: number
    mode?: number
    deleted: boolean
    updatedAt: string
}

export type TglfsFolderManifest = {
    type: typeof TGLFS_FOLDER_MANIFEST_TYPE | typeof TGLFS_FOLDER_ENTRIES_TYPE
    version: TglfsFolderProtocolVersion
    folderId: string
    rootId?: string
    path: string
    createdAt: string
    updatedAt: string
    revision?: number
    entries: Record<string, TglfsFolderManifestEntry>
}

export type TglfsFolderRecord = {
    msgId: number
    date: number
    peerId?: unknown
    data: TglfsFolder
    raw?: TelegramRecordMessageLike
}

export type TglfsFolderManifestRecord = {
    msgId: number
    date: number
    peerId?: unknown
    data: TglfsFolderManifest
    raw?: TelegramRecordMessageLike
}

export type TelegramRecordMessageLike = {
    id: number
    date: number
    peerId?: unknown
    message?: string | null
    media?: unknown
}

function isIsoDate(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== ""
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === "string"
}

function isOptionalInteger(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === "number" && Number.isInteger(value))
}

function isSupportedFolderVersion(value: unknown): value is TglfsFolderProtocolVersion {
    return value === 1 || value === TGLFS_FOLDER_PROTOCOL_VERSION
}

export function buildFolderSearchQuery(folderId?: string) {
    const trimmed = folderId?.trim()
    return trimmed ? `${TGLFS_FOLDER_TYPE} "folderId":"${trimmed}"` : TGLFS_FOLDER_TYPE
}

export function buildFolderManifestSearchQuery(folderId?: string) {
    const trimmed = folderId?.trim()
    return trimmed ? `${TGLFS_FOLDER_MANIFEST_TYPE} "folderId":"${trimmed}"` : TGLFS_FOLDER_MANIFEST_TYPE
}

export function normalizeTglfsFolder(value: unknown): TglfsFolder | null {
    if (!value || typeof value !== "object") {
        return null
    }
    const candidate = value as Partial<TglfsFolder>
    if (
        candidate.type !== TGLFS_FOLDER_TYPE ||
        !isSupportedFolderVersion(candidate.version) ||
        !isNonEmptyString(candidate.folderId) ||
        !isOptionalString(candidate.parentFolderId) ||
        !isOptionalString(candidate.rootId) ||
        typeof candidate.name !== "string" ||
        typeof candidate.path !== "string" ||
        !isIsoDate(candidate.createdAt) ||
        !isIsoDate(candidate.updatedAt) ||
        typeof candidate.deleted !== "boolean" ||
        !isOptionalInteger(candidate.entriesRevision) ||
        !isOptionalString(candidate.entriesHash) ||
        !isOptionalString(candidate.entriesFileName)
    ) {
        return null
    }
    const folder: TglfsFolder = {
        type: TGLFS_FOLDER_TYPE,
        version: candidate.version,
        folderId: candidate.folderId,
        parentFolderId: candidate.parentFolderId,
        rootId: candidate.rootId,
        name: candidate.name,
        path: candidate.path,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        deleted: candidate.deleted,
    }
    if (candidate.entriesRevision !== undefined) folder.entriesRevision = candidate.entriesRevision
    if (candidate.entriesHash !== undefined) folder.entriesHash = candidate.entriesHash
    if (candidate.entriesFileName !== undefined) folder.entriesFileName = candidate.entriesFileName
    return folder
}

function isFolderManifestEntry(value: unknown): value is TglfsFolderManifestEntry {
    if (!value || typeof value !== "object") {
        return false
    }
    const candidate = value as Partial<TglfsFolderManifestEntry>
    const common =
        isNonEmptyString(candidate.entryId) &&
        isNonEmptyString(candidate.name) &&
        typeof candidate.path === "string" &&
        (candidate.kind === "file" || candidate.kind === "folder") &&
        typeof candidate.deleted === "boolean" &&
        isIsoDate(candidate.updatedAt)
    if (!common) {
        return false
    }
    if (candidate.kind === "file") {
        return (
            isNonEmptyString(candidate.ufid) &&
            typeof candidate.size === "number" &&
            Number.isFinite(candidate.size) &&
            candidate.size >= 0 &&
            typeof candidate.mtimeMs === "number" &&
            Number.isFinite(candidate.mtimeMs) &&
            typeof candidate.mode === "number" &&
            Number.isInteger(candidate.mode)
        )
    }
    return isNonEmptyString(candidate.folderId)
}

export function normalizeTglfsFolderManifest(value: unknown): TglfsFolderManifest | null {
    if (!value || typeof value !== "object") {
        return null
    }
    const candidate = value as Partial<TglfsFolderManifest>
    const isV1Manifest = candidate.type === TGLFS_FOLDER_MANIFEST_TYPE && candidate.version === TGLFS_FOLDER_MANIFEST_VERSION
    const isV2Entries = candidate.type === TGLFS_FOLDER_ENTRIES_TYPE && candidate.version === TGLFS_FOLDER_PROTOCOL_VERSION
    const type = isV1Manifest ? TGLFS_FOLDER_MANIFEST_TYPE : isV2Entries ? TGLFS_FOLDER_ENTRIES_TYPE : undefined
    const version = isV1Manifest ? TGLFS_FOLDER_MANIFEST_VERSION : isV2Entries ? TGLFS_FOLDER_PROTOCOL_VERSION : undefined
    if (
        !type ||
        !version ||
        !isNonEmptyString(candidate.folderId) ||
        !isOptionalString(candidate.rootId) ||
        typeof candidate.path !== "string" ||
        !isIsoDate(candidate.createdAt) ||
        !isIsoDate(candidate.updatedAt) ||
        !isOptionalInteger(candidate.revision) ||
        !candidate.entries ||
        typeof candidate.entries !== "object" ||
        Array.isArray(candidate.entries)
    ) {
        return null
    }

    const entries: Record<string, TglfsFolderManifestEntry> = {}
    for (const [name, entry] of Object.entries(candidate.entries)) {
        if (!isFolderManifestEntry(entry) || entry.name !== name) {
            return null
        }
        entries[name] = { ...entry }
    }

    const manifest: TglfsFolderManifest = {
        type,
        version,
        folderId: candidate.folderId,
        rootId: candidate.rootId,
        path: candidate.path,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        entries,
    }
    if (candidate.revision !== undefined) manifest.revision = candidate.revision
    return manifest
}

export function parseTglfsFolderMessage(message: string): TglfsFolder | null {
    if (!message.startsWith(TGLFS_FOLDER_TYPE)) {
        return null
    }
    try {
        return normalizeTglfsFolder(JSON.parse(message.substring(message.indexOf("{"))))
    } catch {
        return null
    }
}

export function parseTglfsFolderManifestMessage(message: string): TglfsFolderManifest | null {
    if (!message.startsWith(TGLFS_FOLDER_MANIFEST_TYPE)) {
        return null
    }
    try {
        return normalizeTglfsFolderManifest(JSON.parse(message.substring(message.indexOf("{"))))
    } catch {
        return null
    }
}

export function parseTglfsFolderEntriesJson(json: string): TglfsFolderManifest | null {
    try {
        return normalizeTglfsFolderManifest(JSON.parse(json))
    } catch {
        return null
    }
}

export function serializeTglfsFolderMessage(folder: TglfsFolder) {
    return `${TGLFS_FOLDER_TYPE}\n${JSON.stringify(folder)}`
}

export function serializeTglfsFolderManifestMessage(manifest: TglfsFolderManifest) {
    return `${manifest.type}\n${JSON.stringify(manifest)}`
}

export function serializeTglfsFolderEntriesJson(manifest: TglfsFolderManifest) {
    const entries: Record<string, TglfsFolderManifestEntry> = {}
    for (const [name, entry] of Object.entries(manifest.entries).sort(([a], [b]) => a.localeCompare(b))) {
        const orderedEntry: TglfsFolderManifestEntry = {
            entryId: entry.entryId,
            name: entry.name,
            path: entry.path,
            kind: entry.kind,
            deleted: entry.deleted,
            updatedAt: entry.updatedAt,
        }
        if (entry.kind === "file") {
            orderedEntry.ufid = entry.ufid
            orderedEntry.size = entry.size
            orderedEntry.mtimeMs = entry.mtimeMs
            orderedEntry.mode = entry.mode
        } else {
            orderedEntry.folderId = entry.folderId
        }
        entries[name] = orderedEntry
    }
    const payload: TglfsFolderManifest = {
        type: TGLFS_FOLDER_ENTRIES_TYPE,
        version: TGLFS_FOLDER_PROTOCOL_VERSION,
        folderId: manifest.folderId,
        path: manifest.path,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        entries,
    }
    if (manifest.rootId !== undefined) payload.rootId = manifest.rootId
    if (manifest.revision !== undefined) payload.revision = manifest.revision
    return JSON.stringify(payload)
}

function bytesToHex(bytes: Uint8Array) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function hashTglfsFolderEntries(manifest: TglfsFolderManifest) {
    const bytes = new TextEncoder().encode(serializeTglfsFolderEntriesJson(manifest))
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    return `sha256:${bytesToHex(new Uint8Array(digest))}`
}

export function createTglfsFolderEntriesFileName(folderId: string, revision: number) {
    const safeFolderId = folderId.replace(/[^A-Za-z0-9_.-]/g, "_")
    return `tglfs-folder-${safeFolderId}-entries-r${revision}.json`
}

export function toTglfsFolderEntriesManifest(manifest: TglfsFolderManifest, revision?: number): TglfsFolderManifest {
    return {
        ...manifest,
        type: TGLFS_FOLDER_ENTRIES_TYPE,
        version: TGLFS_FOLDER_PROTOCOL_VERSION,
        revision: revision ?? manifest.revision ?? 0,
    }
}

export function toLegacyTglfsFolderManifest(manifest: TglfsFolderManifest): TglfsFolderManifest {
    const legacy = {
        ...manifest,
        type: TGLFS_FOLDER_MANIFEST_TYPE,
        version: TGLFS_FOLDER_MANIFEST_VERSION,
    }
    delete legacy.revision
    return legacy
}

export function compactTglfsFolderManifest(manifest: TglfsFolderManifest): TglfsFolderManifest {
    const entries: Record<string, TglfsFolderManifestEntry> = {}
    for (const [name, entry] of Object.entries(manifest.entries)) {
        if (!entry.deleted) {
            entries[name] = entry
        }
    }
    return { ...manifest, entries }
}

export function extractTglfsFolderRecord(message: TelegramRecordMessageLike): TglfsFolderRecord | null {
    if (typeof message.message !== "string") {
        return null
    }
    const data = parseTglfsFolderMessage(message.message)
    return data ? { msgId: message.id, date: message.date, peerId: message.peerId, data, raw: message } : null
}

export function extractTglfsFolderManifestRecord(message: TelegramRecordMessageLike): TglfsFolderManifestRecord | null {
    if (typeof message.message !== "string") {
        return null
    }
    const data = parseTglfsFolderManifestMessage(message.message)
    return data ? { msgId: message.id, date: message.date, peerId: message.peerId, data, raw: message } : null
}

export function createTglfsFolder(options: {
    folderId: string
    parentFolderId?: string
    rootId?: string
    name: string
    path: string
    now?: string
}): TglfsFolder {
    const now = options.now ?? new Date().toISOString()
    return {
        type: TGLFS_FOLDER_TYPE,
        version: TGLFS_FOLDER_VERSION,
        folderId: options.folderId,
        parentFolderId: options.parentFolderId,
        rootId: options.rootId,
        name: options.name,
        path: options.path,
        createdAt: now,
        updatedAt: now,
        deleted: false,
    }
}

export function createTglfsFolderManifest(options: {
    folderId: string
    rootId?: string
    path: string
    now?: string
    entries?: Record<string, TglfsFolderManifestEntry>
}): TglfsFolderManifest {
    const now = options.now ?? new Date().toISOString()
    return {
        type: TGLFS_FOLDER_ENTRIES_TYPE,
        version: TGLFS_FOLDER_PROTOCOL_VERSION,
        folderId: options.folderId,
        rootId: options.rootId,
        path: options.path,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        entries: options.entries ?? {},
    }
}
