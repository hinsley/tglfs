export const TGLFS_FOLDER_TYPE = "tglfs:folder" as const
export const TGLFS_FOLDER_VERSION = 1 as const
export const TGLFS_FOLDER_MANIFEST_TYPE = "tglfs:folder-manifest" as const
export const TGLFS_FOLDER_MANIFEST_VERSION = 1 as const

export type TglfsFolder = {
    type: typeof TGLFS_FOLDER_TYPE
    version: typeof TGLFS_FOLDER_VERSION
    folderId: string
    parentFolderId?: string
    rootId?: string
    name: string
    path: string
    createdAt: string
    updatedAt: string
    deleted: boolean
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
    type: typeof TGLFS_FOLDER_MANIFEST_TYPE
    version: typeof TGLFS_FOLDER_MANIFEST_VERSION
    folderId: string
    rootId?: string
    path: string
    createdAt: string
    updatedAt: string
    entries: Record<string, TglfsFolderManifestEntry>
}

export type TglfsFolderRecord = {
    msgId: number
    date: number
    peerId?: unknown
    data: TglfsFolder
}

export type TglfsFolderManifestRecord = {
    msgId: number
    date: number
    peerId?: unknown
    data: TglfsFolderManifest
}

export type TelegramRecordMessageLike = {
    id: number
    date: number
    peerId?: unknown
    message?: string | null
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
        candidate.version !== TGLFS_FOLDER_VERSION ||
        !isNonEmptyString(candidate.folderId) ||
        !isOptionalString(candidate.parentFolderId) ||
        !isOptionalString(candidate.rootId) ||
        typeof candidate.name !== "string" ||
        typeof candidate.path !== "string" ||
        !isIsoDate(candidate.createdAt) ||
        !isIsoDate(candidate.updatedAt) ||
        typeof candidate.deleted !== "boolean"
    ) {
        return null
    }
    return {
        type: TGLFS_FOLDER_TYPE,
        version: TGLFS_FOLDER_VERSION,
        folderId: candidate.folderId,
        parentFolderId: candidate.parentFolderId,
        rootId: candidate.rootId,
        name: candidate.name,
        path: candidate.path,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        deleted: candidate.deleted,
    }
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
    if (
        candidate.type !== TGLFS_FOLDER_MANIFEST_TYPE ||
        candidate.version !== TGLFS_FOLDER_MANIFEST_VERSION ||
        !isNonEmptyString(candidate.folderId) ||
        !isOptionalString(candidate.rootId) ||
        typeof candidate.path !== "string" ||
        !isIsoDate(candidate.createdAt) ||
        !isIsoDate(candidate.updatedAt) ||
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

    return {
        type: TGLFS_FOLDER_MANIFEST_TYPE,
        version: TGLFS_FOLDER_MANIFEST_VERSION,
        folderId: candidate.folderId,
        rootId: candidate.rootId,
        path: candidate.path,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        entries,
    }
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

export function serializeTglfsFolderMessage(folder: TglfsFolder) {
    return `${TGLFS_FOLDER_TYPE}\n${JSON.stringify(folder)}`
}

export function serializeTglfsFolderManifestMessage(manifest: TglfsFolderManifest) {
    return `${TGLFS_FOLDER_MANIFEST_TYPE}\n${JSON.stringify(manifest)}`
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
    return data ? { msgId: message.id, date: message.date, peerId: message.peerId, data } : null
}

export function extractTglfsFolderManifestRecord(message: TelegramRecordMessageLike): TglfsFolderManifestRecord | null {
    if (typeof message.message !== "string") {
        return null
    }
    const data = parseTglfsFolderManifestMessage(message.message)
    return data ? { msgId: message.id, date: message.date, peerId: message.peerId, data } : null
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
        type: TGLFS_FOLDER_MANIFEST_TYPE,
        version: TGLFS_FOLDER_MANIFEST_VERSION,
        folderId: options.folderId,
        rootId: options.rootId,
        path: options.path,
        createdAt: now,
        updatedAt: now,
        entries: options.entries ?? {},
    }
}
