export const SYNC_MANIFEST_TYPE = "tglfs:sync-manifest" as const
export const SYNC_MANIFEST_V1_VERSION = 1 as const
export const SYNC_MANIFEST_VERSION = 2 as const

export type SyncManifestEntry = {
    entryId: string
    path: string
    ufid: string
    size: number
    mtimeMs: number
    mode: number
    deleted: boolean
    updatedAt: string
}

export type SyncManifestV1 = {
    type: typeof SYNC_MANIFEST_TYPE
    version: typeof SYNC_MANIFEST_V1_VERSION
    rootId: string
    rootName: string
    createdAt: string
    updatedAt: string
    entries: Record<string, SyncManifestEntry>
}

export type SyncManifestV2 = Omit<SyncManifestV1, "version"> & {
    version: typeof SYNC_MANIFEST_VERSION
    folderId: string
}

export type SyncManifest = SyncManifestV1 | SyncManifestV2

export type SyncManifestRecord = {
    msgId: number
    date: number
    peerId?: unknown
    data: SyncManifest
}

export type SyncManifestMessageLike = {
    id: number
    date: number
    peerId?: unknown
    message?: string | null
}

export function buildSyncManifestSearchQuery(rootId?: string) {
    const trimmed = rootId?.trim()
    return trimmed ? `${SYNC_MANIFEST_TYPE} "rootId":"${trimmed}"` : SYNC_MANIFEST_TYPE
}

function isIsoDate(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function isManifestEntry(value: unknown): value is SyncManifestEntry {
    if (!value || typeof value !== "object") {
        return false
    }
    const candidate = value as Partial<SyncManifestEntry>
    return (
        typeof candidate.entryId === "string" &&
        typeof candidate.path === "string" &&
        typeof candidate.ufid === "string" &&
        typeof candidate.size === "number" &&
        Number.isFinite(candidate.size) &&
        candidate.size >= 0 &&
        typeof candidate.mtimeMs === "number" &&
        Number.isFinite(candidate.mtimeMs) &&
        typeof candidate.mode === "number" &&
        Number.isInteger(candidate.mode) &&
        typeof candidate.deleted === "boolean" &&
        isIsoDate(candidate.updatedAt)
    )
}

export function normalizeSyncManifest(value: unknown): SyncManifest | null {
    if (!value || typeof value !== "object") {
        return null
    }

    const candidate = value as Partial<SyncManifestV1> & { folderId?: unknown }
    if (
        candidate.type !== SYNC_MANIFEST_TYPE ||
        (candidate.version !== SYNC_MANIFEST_V1_VERSION && candidate.version !== SYNC_MANIFEST_VERSION) ||
        typeof candidate.rootId !== "string" ||
        candidate.rootId.trim() === "" ||
        typeof candidate.rootName !== "string" ||
        candidate.rootName.trim() === "" ||
        !isIsoDate(candidate.createdAt) ||
        !isIsoDate(candidate.updatedAt) ||
        !candidate.entries ||
        typeof candidate.entries !== "object" ||
        Array.isArray(candidate.entries)
    ) {
        return null
    }

    const entries: Record<string, SyncManifestEntry> = {}
    for (const [path, entry] of Object.entries(candidate.entries)) {
        if (!isManifestEntry(entry) || entry.path !== path) {
            return null
        }
        entries[path] = {
            entryId: entry.entryId,
            path: entry.path,
            ufid: entry.ufid,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            mode: entry.mode,
            deleted: entry.deleted,
            updatedAt: entry.updatedAt,
        }
    }

    if (candidate.version === SYNC_MANIFEST_V1_VERSION) {
        return {
            type: SYNC_MANIFEST_TYPE,
            version: SYNC_MANIFEST_V1_VERSION,
            rootId: candidate.rootId,
            rootName: candidate.rootName,
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
            entries,
        }
    }
    if (typeof candidate.folderId !== "string" || candidate.folderId.trim() === "") {
        return null
    }
    return {
        type: SYNC_MANIFEST_TYPE,
        version: SYNC_MANIFEST_VERSION,
        rootId: candidate.rootId,
        rootName: candidate.rootName,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        folderId: candidate.folderId,
        entries,
    }
}

export function parseSyncManifestMessage(message: string): SyncManifest | null {
    if (!message.startsWith(SYNC_MANIFEST_TYPE)) {
        return null
    }
    try {
        return normalizeSyncManifest(JSON.parse(message.substring(message.indexOf("{"))))
    } catch {
        return null
    }
}

export function serializeSyncManifestMessage(manifest: SyncManifest) {
    return `${SYNC_MANIFEST_TYPE}\n${JSON.stringify(manifest)}`
}

export function extractSyncManifestRecord(message: SyncManifestMessageLike): SyncManifestRecord | null {
    if (typeof message.message !== "string") {
        return null
    }
    const data = parseSyncManifestMessage(message.message)
    if (!data) {
        return null
    }
    return {
        msgId: message.id,
        date: message.date,
        peerId: message.peerId,
        data,
    }
}

export function extractSyncManifestRecords(messages: Iterable<SyncManifestMessageLike>) {
    const records: SyncManifestRecord[] = []
    for (const message of messages) {
        const record = extractSyncManifestRecord(message)
        if (record) {
            records.push(record)
        }
    }
    return records
}

export function createEmptySyncManifest(options: { rootId: string; rootName: string; folderId?: string; now?: string }): SyncManifest {
    const now = options.now ?? new Date().toISOString()
    const base: SyncManifestV1 = {
        type: SYNC_MANIFEST_TYPE,
        version: SYNC_MANIFEST_V1_VERSION,
        rootId: options.rootId,
        rootName: options.rootName,
        createdAt: now,
        updatedAt: now,
        entries: {},
    }
    if (!options.folderId) {
        return base
    }
    return {
        ...base,
        version: SYNC_MANIFEST_VERSION,
        folderId: options.folderId,
    }
}

export function getSyncManifestFolderId(manifest: SyncManifest) {
    return manifest.version === SYNC_MANIFEST_VERSION ? manifest.folderId : undefined
}
