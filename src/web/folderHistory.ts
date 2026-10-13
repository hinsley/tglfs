// Folder "time machine": reconstructs the best honest approximation of what a folder (or the root
// "All files" view) contained at an earlier point in time, using only what TGLFS already stores.
//
// Pure and DOM-free so it can be unit tested from Node. It never throws on malformed input: records
// that fail the existing protocol validators are skipped (fail closed) and counted in `skipped`.
//
// What survives in Telegram (see AGENTS.md and the folder mutation code in browser.ts):
// - Folder records keep `createdAt`; `updatedAt` is bumped by every rename, move and entries write.
//   Deleting a folder edits its record to `deleted: true` with `updatedAt` = deletion time and the
//   record message stays in Telegram, so folder deletions are known precisely.
// - When a folder's text-only record is upgraded to an attachment-backed v2 record, the old message is
//   marked `deleted: true` too ("superseded"). It is recognised because a newer message (higher msgId)
//   exists for the same folderId; it proves the folder was in the old parent at that time.
// - File cards are Telegram messages: their message date is the upload time. Renames and moves edit the
//   card in place, so old names and old parents are lost. Deleting a file deletes the card and its chunks.
// - Folder entries (manifests) are compacted before every write, so tombstones (`deleted: true`) only
//   survive in records written before compaction existed (legacy v1 manifest messages). Uploads do not
//   write entries; browser moves do (with `mtimeMs` = move time, which later edits never change).
//   File deletes do not touch entries, so an entry can outlive its file card.
import {
    normalizeTglfsFolder,
    normalizeTglfsFolderManifest,
    parseTglfsFolderEntriesJson,
    parseTglfsFolderManifestMessage,
    parseTglfsFolderMessage,
    type TglfsFolder,
    type TglfsFolderManifest,
    type TglfsFolderManifestEntry,
} from "../../packages/tglfs-cli/src/folders"
import { isFileCardData, parseFileCardMessage } from "../../packages/tglfs-cli/src/shared/file-cards"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"

/* --------------------------------------------------------------- Inputs */

/** A Telegram message carrying a serialized record. `date` is the Telegram message date in seconds. */
export type HistoryMessageInput = {
    msgId: number
    date: number
    text?: string
    data?: unknown
}

export type HistoryManifestInput = {
    /** Serialized `tglfs:folder-manifest` message text, or the plain JSON of a `tglfs:folder-entries` attachment. */
    text?: string
    /** An already-parsed manifest object (validated again here). */
    data?: unknown
    msgId?: number
}

export type FolderHistoryInput = {
    /** The folder whose history is reconstructed, or null for the root "All files" view. */
    folderId: string | null
    /** The folder's own record (for its creation time). */
    folder?: HistoryMessageInput | null
    /** Folder record messages: children of this folder in any state, plus every message found for referenced folder ids. */
    folderRecords?: HistoryMessageInput[]
    /** File card messages: cards whose parent is this folder, plus cards looked up by UFID for manifest entries. */
    fileCards?: HistoryMessageInput[]
    /** Folder entries for this folder: the current attachment/manifest and any older legacy manifest messages. */
    manifests?: HistoryManifestInput[]
    /** Reference "now" in epoch milliseconds. */
    now?: number
}

/* -------------------------------------------------------------- Outputs */

export type HistoryItemStatus = "live" | "deleted" | "moved-out" | "gone"
export type HistoryArrival = "created" | "uploaded" | "moved-in" | "returned" | "unknown"

export type HistoryItem = {
    key: string
    kind: "file" | "folder"
    name: string
    /** Other names seen for the same item in folder entries (the item was renamed at an unknown time). */
    formerNames: string[]
    ufid?: string
    folderId?: string
    size?: number
    uploadComplete?: boolean
    /** Message id of the live file card (files) or of the canonical folder record (folders). */
    msgId?: number
    status: HistoryItemStatus
    arrival: HistoryArrival
    /** Whether `presentFrom` is the exact arrival time (false: it is only the latest possible arrival time). */
    arrivalExact: boolean
    /** Certainly not in this folder before this time (ms), when known. */
    absentBefore: number | null
    /** Certainly in this folder from this time (ms) until removal, when known. */
    presentFrom: number | null
    /** Exact removal time (ms), when known. */
    removedAt: number | null
    /** For items that are gone but whose removal time is unknown: the last time they were known to be here. */
    lastSeenAt: number | null
    /** A later change of an entry that could be a rename or a move (ms). */
    changedAt: number | null
    /** Whether the underlying data (file card and chunks, or folder record) still exists in Telegram. */
    contentsStored: boolean
    /** For moved-out items: the folder id they live in now (TGLFS_ROOT_PARENT_ID for the root). */
    movedToFolderId?: string
    /** Deleted folders that can be undeleted with the existing write paths. */
    restorable: boolean
    restoreBlockedReason?: string
    /** Human-readable caveats about this item's history. */
    notes: string[]
}

export type HistoryChangeType = "created" | "added" | "removed" | "changed"

export type HistoryChange = {
    type: HistoryChangeType
    itemKey: string | null
    name: string
    kind: "file" | "folder"
    /** e.g. "uploaded", "created", "moved here", "deleted", "moved out", "renamed or moved". */
    detail: string
    /** True when the time is an upper bound rather than the exact moment. */
    approximate: boolean
}

export type HistoryPoint = {
    at: number
    isNow: boolean
    changes: HistoryChange[]
}

export type FolderHistory = {
    folderId: string | null
    now: number
    createdAt: number | null
    items: HistoryItem[]
    points: HistoryPoint[]
    /** Records that failed validation and were ignored. */
    skipped: number
    warnings: string[]
}

export type HistoryItemState = "present" | "uncertain" | "absent"

export type HistoryAnnotation =
    | "deleted-later"
    | "moved-out-later"
    | "removed-unknown"
    | "arrival-unknown"
    | "contents-gone"
    | "renamed"

export type HistorySnapshotItem = {
    item: HistoryItem
    state: Exclude<HistoryItemState, "absent">
    annotations: HistoryAnnotation[]
}

/* ------------------------------------------------------------- Helpers */

const SKEW_MS = 1000

const KNOWN_FOLDER_RECORD_KEYS = new Set([
    "type",
    "version",
    "folderId",
    "parentFolderId",
    "rootId",
    "name",
    "path",
    "createdAt",
    "updatedAt",
    "deleted",
    "entriesRevision",
    "entriesHash",
    "entriesFileName",
])

function isoToMs(value: unknown): number | null {
    if (typeof value !== "string") return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

function secondsToMs(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null
}

function finiteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

function validMsgId(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value)
}

/**
 * True when a serialized folder record contains only fields this client understands. Editing a record
 * with unknown fields would drop them (the normalizer does not preserve them), so callers must refuse.
 */
export function folderRecordTextHasOnlyKnownFields(text: unknown): boolean {
    if (typeof text !== "string") return false
    const start = text.indexOf("{")
    if (start === -1) return false
    try {
        const parsed = JSON.parse(text.substring(start))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
        return Object.keys(parsed).every((key) => KNOWN_FOLDER_RECORD_KEYS.has(key))
    } catch {
        return false
    }
}

type ParsedFolderRecord = { msgId: number; date: number; data: TglfsFolder; text?: string }
type ParsedFileCard = {
    msgId: number
    dateMs: number | null
    name: string
    ufid: string
    size: number
    parentFolderId?: string
    uploadComplete: boolean
}
type ManifestEntryObservation = { entry: TglfsFolderManifestEntry; manifestUpdatedAt: number | null; order: number }

function parseFolderRecordInput(input: HistoryMessageInput): ParsedFolderRecord | null {
    if (!input || typeof input !== "object" || !validMsgId(input.msgId)) return null
    let data: TglfsFolder | null = null
    if (typeof input.text === "string") data = parseTglfsFolderMessage(input.text)
    else if (input.data !== undefined) data = normalizeTglfsFolder(input.data)
    if (!data) return null
    return { msgId: input.msgId, date: finiteNumber(input.date) ?? 0, data, text: input.text }
}

function parseFileCardInput(input: HistoryMessageInput): ParsedFileCard | null {
    if (!input || typeof input !== "object" || !validMsgId(input.msgId)) return null
    let data: unknown = null
    if (typeof input.text === "string") data = parseFileCardMessage(input.text)
    else if (input.data !== undefined && isFileCardData(input.data)) data = input.data
    if (!data || typeof data !== "object") return null
    const candidate = data as { name?: unknown; ufid?: unknown; size?: unknown; parentFolderId?: unknown; uploadComplete?: unknown }
    if (typeof candidate.name !== "string" || typeof candidate.ufid !== "string" || candidate.ufid === "") return null
    return {
        msgId: input.msgId,
        dateMs: secondsToMs(input.date),
        name: candidate.name,
        ufid: candidate.ufid,
        size: finiteNumber(candidate.size) ?? 0,
        parentFolderId: typeof candidate.parentFolderId === "string" ? candidate.parentFolderId : undefined,
        uploadComplete: candidate.uploadComplete !== false,
    }
}

function parseManifestInput(input: HistoryManifestInput): TglfsFolderManifest | null {
    if (!input || typeof input !== "object") return null
    if (typeof input.text === "string") {
        const text = input.text.trimStart()
        return text.startsWith("{") ? parseTglfsFolderEntriesJson(text) : parseTglfsFolderManifestMessage(text)
    }
    if (input.data !== undefined) return normalizeTglfsFolderManifest(input.data)
    return null
}

/** Picks the most informative observation: live entries over tombstones, then the most recent write. */
function preferredObservation(observations: ManifestEntryObservation[]) {
    return [...observations].sort((a, b) => {
        if (a.entry.deleted !== b.entry.deleted) return a.entry.deleted ? 1 : -1
        return a.order - b.order
    })[0]
}

/** The most recent tombstone strictly between `after` and `before`: proof of an earlier stint in this folder. */
function latestTombstoneBefore(observations: ManifestEntryObservation[], before: number | null, after: number | null) {
    if (before === null) return null
    return observations
        .filter((observation) => observation.entry.deleted)
        .map((observation) => ({ entry: observation.entry, at: isoToMs(observation.entry.updatedAt) }))
        .filter((candidate): candidate is { entry: TglfsFolderManifestEntry; at: number } =>
            candidate.at !== null && candidate.at < before - SKEW_MS && (after === null || candidate.at > after + SKEW_MS))
        .sort((a, b) => b.at - a.at)[0] ?? null
}

/** The time a file entry arrived, from the move-time `mtimeMs` the browser writes, when it is plausible. */
function plausibleMoveTime(entry: TglfsFolderManifestEntry, cardDateMs: number | null, upperBound: number | null) {
    const mtime = finiteNumber(entry.mtimeMs)
    if (mtime === null || cardDateMs === null) return null
    if (mtime < cardDateMs - SKEW_MS) return null
    if (upperBound !== null && mtime > upperBound + SKEW_MS) return null
    return mtime
}

function emptyHistory(folderId: string | null, now: number, warning: string): FolderHistory {
    return {
        folderId,
        now,
        createdAt: null,
        items: [],
        points: [{ at: now, isNow: true, changes: [] }],
        skipped: 0,
        warnings: [warning],
    }
}

/* -------------------------------------------------------- Reconstruction */

export function buildFolderHistory(input: FolderHistoryInput): FolderHistory {
    const now = finiteNumber(input?.now) ?? Date.now()
    const folderId = typeof input?.folderId === "string" && input.folderId.trim() !== "" ? input.folderId : null
    try {
        return buildFolderHistoryUnsafe(input, folderId, now)
    } catch (error) {
        return emptyHistory(folderId, now, `History could not be reconstructed: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function buildFolderHistoryUnsafe(input: FolderHistoryInput, folderId: string | null, now: number): FolderHistory {
    const scopeId = folderId ?? TGLFS_ROOT_PARENT_ID
    const warnings: string[] = []
    let skipped = 0

    const ownRecord = input.folder ? parseFolderRecordInput(input.folder) : null
    if (input.folder && !ownRecord) skipped++
    const folderCreatedAt = folderId && ownRecord?.data.folderId === folderId ? isoToMs(ownRecord.data.createdAt) : null

    // Folder records grouped by folder id; the highest message id is the canonical (current) record.
    const folderGroups = new Map<string, ParsedFolderRecord[]>()
    for (const raw of Array.isArray(input.folderRecords) ? input.folderRecords : []) {
        const record = parseFolderRecordInput(raw)
        if (!record) {
            skipped++
            continue
        }
        if (record.data.folderId === folderId) continue
        const group = folderGroups.get(record.data.folderId) ?? []
        if (!group.some((existing) => existing.msgId === record.msgId)) group.push(record)
        folderGroups.set(record.data.folderId, group)
    }

    const cards: ParsedFileCard[] = []
    for (const raw of Array.isArray(input.fileCards) ? input.fileCards : []) {
        const card = parseFileCardInput(raw)
        if (!card) {
            skipped++
            continue
        }
        if (!cards.some((existing) => existing.msgId === card.msgId)) cards.push(card)
    }
    const liveCards = cards.filter((card) => card.parentFolderId === scopeId)
    const cardsByUfid = new Map<string, ParsedFileCard[]>()
    for (const card of cards) {
        const list = cardsByUfid.get(card.ufid) ?? []
        list.push(card)
        cardsByUfid.set(card.ufid, list)
    }

    // Folder entries: the root has none. Manifests for other folders are ignored.
    const manifests: Array<{ manifest: TglfsFolderManifest; updatedAt: number | null }> = []
    if (folderId) {
        for (const raw of Array.isArray(input.manifests) ? input.manifests : []) {
            const manifest = parseManifestInput(raw)
            if (!manifest) {
                skipped++
                warnings.push("Some folder entries could not be read and were ignored.")
                continue
            }
            if (manifest.folderId !== folderId) continue
            manifests.push({ manifest, updatedAt: isoToMs(manifest.updatedAt) })
        }
    }
    // Most recent write first; `order` breaks ties in favour of the input order (current manifest first).
    const orderedManifests = manifests
        .map((value, index) => ({ ...value, index }))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.index - b.index)
    const fileObservations = new Map<string, ManifestEntryObservation[]>()
    const folderObservations = new Map<string, ManifestEntryObservation[]>()
    orderedManifests.forEach(({ manifest, updatedAt }, order) => {
        for (const entry of Object.values(manifest.entries)) {
            const map = entry.kind === "file" ? fileObservations : folderObservations
            const id = entry.kind === "file" ? entry.ufid : entry.folderId
            if (!id) continue
            const list = map.get(id) ?? []
            list.push({ entry, manifestUpdatedAt: updatedAt, order })
            map.set(id, list)
        }
    })

    const items: HistoryItem[] = []

    /* Files currently in this folder */
    const liveUfids = new Set<string>()
    for (const card of liveCards) {
        liveUfids.add(card.ufid)
        const observations = fileObservations.get(card.ufid) ?? []
        const preferred = observations.length ? preferredObservation(observations) : null
        const formerNames = [...new Set(observations.map((observation) => observation.entry.name))]
            .filter((name) => name !== card.name)
        const item: HistoryItem = {
            key: `file:${card.msgId}`,
            kind: "file",
            name: card.name,
            formerNames,
            ufid: card.ufid,
            size: card.size,
            uploadComplete: card.uploadComplete,
            msgId: card.msgId,
            status: "live",
            arrival: "uploaded",
            arrivalExact: true,
            absentBefore: card.dateMs,
            presentFrom: card.dateMs,
            removedAt: null,
            lastSeenAt: null,
            changedAt: null,
            contentsStored: true,
            restorable: false,
            notes: [],
        }
        if (preferred && !preferred.entry.deleted) {
            // An entry for an uploaded file means it was moved (or synced) here after the upload.
            const entryUpdatedAt = isoToMs(preferred.entry.updatedAt)
            const moveTime = plausibleMoveTime(preferred.entry, card.dateMs, entryUpdatedAt)
            item.arrival = "moved-in"
            if (moveTime !== null) {
                item.presentFrom = Math.max(moveTime, card.dateMs ?? moveTime)
            } else if (entryUpdatedAt !== null) {
                item.presentFrom = Math.max(entryUpdatedAt, card.dateMs ?? entryUpdatedAt)
                item.arrivalExact = item.presentFrom === card.dateMs
                item.notes.push("Moved here at an unknown time before this point.")
            }
            if (entryUpdatedAt !== null && item.presentFrom !== null && entryUpdatedAt > item.presentFrom + SKEW_MS) {
                item.changedAt = entryUpdatedAt
            }
        }
        if (item.presentFrom !== null && item.absentBefore !== null && item.presentFrom - item.absentBefore <= SKEW_MS) {
            item.presentFrom = item.absentBefore
        }
        if (formerNames.length) item.notes.push(`Renamed at an unknown time; earlier name: ${formerNames.join(", ")}.`)
        if (item.absentBefore === null) {
            item.arrival = "unknown"
            item.arrivalExact = false
            item.notes.push("Upload time unknown.")
        }
        items.push(item)

        // A tombstone older than the current arrival means the file was here before, left, and came back.
        const earlier = item.arrival === "moved-in" ? latestTombstoneBefore(observations, item.presentFrom, item.absentBefore) : null
        if (earlier) {
            const earlierFrom = plausibleMoveTime(earlier.entry, card.dateMs, earlier.at)
            items.push({
                ...item,
                key: `${item.key}:earlier`,
                formerNames: earlier.entry.name !== card.name ? [earlier.entry.name] : [],
                status: "moved-out",
                arrivalExact: earlierFrom !== null,
                presentFrom: earlierFrom,
                removedAt: earlier.at,
                changedAt: null,
                notes: ["Moved out, and later moved back here."],
            })
            item.absentBefore = earlier.at
            item.notes.push("Was here earlier too, then moved out and back.")
        }
    }

    /* Files referenced by folder entries but no longer here */
    for (const [ufid, observations] of fileObservations) {
        if (liveUfids.has(ufid)) continue
        const preferred = preferredObservation(observations)
        const entry = preferred.entry
        const elsewhere = (cardsByUfid.get(ufid) ?? []).sort((a, b) => b.msgId - a.msgId)[0] ?? null
        const tombstoneAt = entry.deleted ? isoToMs(entry.updatedAt) : null
        const formerNames = [...new Set(observations.map((observation) => observation.entry.name))]
        const name = elsewhere?.name ?? entry.name
        const item: HistoryItem = {
            key: `entry-file:${ufid}`,
            kind: "file",
            name,
            formerNames: formerNames.filter((candidate) => candidate !== name),
            ufid,
            size: elsewhere?.size ?? finiteNumber(entry.size) ?? 0,
            msgId: elsewhere?.msgId,
            status: elsewhere ? "moved-out" : "gone",
            arrival: "unknown",
            arrivalExact: false,
            absentBefore: elsewhere?.dateMs ?? folderCreatedAt,
            presentFrom: null,
            removedAt: tombstoneAt,
            lastSeenAt: null,
            changedAt: null,
            contentsStored: !!elsewhere,
            movedToFolderId: elsewhere?.parentFolderId,
            restorable: false,
            notes: [],
        }
        const moveTime = elsewhere ? plausibleMoveTime(entry, elsewhere.dateMs, tombstoneAt ?? isoToMs(entry.updatedAt)) : null
        if (moveTime !== null) {
            item.arrival = "moved-in"
            item.arrivalExact = true
            item.presentFrom = moveTime
        }
        if (tombstoneAt === null) {
            // No tombstone: it left at an unknown time (file deletes and some moves never touch entries).
            item.lastSeenAt = item.presentFrom
            item.notes.push(elsewhere ? "Moved out at an unknown time." : "Deleted at an unknown time.")
        } else if (!elsewhere) {
            item.notes.push("Removed from this folder at this time; its file card no longer exists.")
        }
        if (!elsewhere) item.notes.push("Contents no longer stored in Telegram.")
        if (item.presentFrom === null) item.notes.push("When it arrived in this folder is not recorded.")
        items.push(item)
    }

    /* Folders */
    const folderIds = new Set<string>([...folderGroups.keys(), ...folderObservations.keys()])
    for (const childId of folderIds) {
        if (childId === folderId) continue
        const group = (folderGroups.get(childId) ?? []).sort((a, b) => b.msgId - a.msgId)
        const canonical = group[0] ?? null
        const hereVersions = group.filter((record) => record.data.parentFolderId === scopeId)
        const observations = folderObservations.get(childId) ?? []
        const preferred = observations.length ? preferredObservation(observations) : null
        if (!canonical && !preferred) continue
        if (canonical && hereVersions.length === 0 && !preferred) continue

        const names = new Set<string>([
            ...group.map((record) => record.data.name),
            ...observations.map((observation) => observation.entry.name),
        ])
        const name = canonical?.data.name ?? preferred?.entry.name ?? childId
        names.delete(name)
        const createdAt = canonical ? isoToMs(canonical.data.createdAt) : null
        const item: HistoryItem = {
            key: `folder:${childId}`,
            kind: "folder",
            name,
            formerNames: [...names],
            folderId: childId,
            msgId: canonical?.msgId,
            status: "live",
            arrival: "created",
            arrivalExact: createdAt !== null,
            absentBefore: createdAt,
            presentFrom: createdAt,
            removedAt: null,
            lastSeenAt: null,
            changedAt: null,
            contentsStored: !!canonical,
            restorable: false,
            notes: [],
        }

        if (!canonical) {
            item.status = "gone"
            item.arrival = "unknown"
            item.arrivalExact = false
            item.absentBefore = folderCreatedAt
            item.presentFrom = null
            item.removedAt = preferred?.entry.deleted ? isoToMs(preferred.entry.updatedAt) : null
            item.notes.push("Its folder record could not be found.")
        } else if (canonical.data.parentFolderId === scopeId) {
            if (canonical.data.deleted) {
                item.status = "deleted"
                const deletedAt = isoToMs(canonical.data.updatedAt)
                item.removedAt = deletedAt !== null && (createdAt === null || deletedAt >= createdAt) ? deletedAt : null
                if (item.removedAt === null) item.notes.push("Deletion time unknown.")
                if (!folderRecordTextHasOnlyKnownFields(canonical.text)) {
                    item.restoreBlockedReason = "This folder record has fields this version of TGLFS does not understand."
                } else {
                    item.restorable = true
                }
            } else if (preferred && !preferred.entry.deleted) {
                const entryUpdatedAt = isoToMs(preferred.entry.updatedAt)
                if (entryUpdatedAt !== null && createdAt !== null && entryUpdatedAt > createdAt + SKEW_MS) {
                    item.changedAt = entryUpdatedAt
                }
                // A tombstone between creation and the current entry: it was removed once and came back.
                const earlier = latestTombstoneBefore(observations, entryUpdatedAt, createdAt)
                if (earlier && entryUpdatedAt !== null) {
                    items.push({
                        ...item,
                        key: `${item.key}:earlier`,
                        formerNames: earlier.entry.name !== name ? [earlier.entry.name] : [],
                        status: "deleted",
                        removedAt: earlier.at,
                        changedAt: null,
                        restorable: false,
                        notes: ["Removed, and later restored or moved back here."],
                    })
                    item.absentBefore = earlier.at
                    item.presentFrom = entryUpdatedAt
                    item.arrival = "returned"
                    item.arrivalExact = false
                    item.changedAt = null
                    item.notes.push("Came back by this time (restored or moved back).")
                }
            }
            if (item.status === "live" || item.status === "deleted") {
                item.notes.push("Assumed to have been created in this folder: folder moves are not recorded.")
            }
        } else {
            // It lives (or was deleted) somewhere else now.
            item.status = canonical.data.deleted ? "gone" : "moved-out"
            item.movedToFolderId = canonical.data.parentFolderId
            item.arrival = "unknown"
            item.arrivalExact = false
            item.presentFrom = null
            const tombstoneAt = preferred?.entry.deleted ? isoToMs(preferred.entry.updatedAt) : null
            item.removedAt = tombstoneAt
            const seenHere = hereVersions
                .map((record) => isoToMs(record.data.updatedAt))
                .filter((value): value is number => value !== null)
            const lastSeen = seenHere.length ? Math.max(...seenHere) : null
            if (tombstoneAt === null) {
                item.lastSeenAt = lastSeen
                item.notes.push(canonical.data.deleted ? "Moved out and later deleted; when is not recorded." : "Moved out at an unknown time.")
            }
            if (canonical.data.deleted) {
                item.contentsStored = true
                item.notes.push("Deleted from its newer location.")
            }
        }
        items.push(item)
    }

    /* Timeline */
    const changes: Array<{ at: number; change: HistoryChange }> = []
    if (folderCreatedAt !== null) {
        changes.push({
            at: Math.min(folderCreatedAt, now),
            change: { type: "created", itemKey: null, name: ownRecord?.data.name ?? "Folder", kind: "folder", detail: "folder created", approximate: false },
        })
    }
    for (const item of items) {
        if (item.presentFrom !== null) {
            const detail = item.arrival === "uploaded"
                ? "uploaded"
                : item.arrival === "created"
                    ? "created"
                    : item.arrival === "moved-in" ? "moved here" : item.arrival === "returned" ? "restored or moved back" : "appeared"
            changes.push({
                at: Math.min(item.presentFrom, now),
                change: { type: "added", itemKey: item.key, name: item.name, kind: item.kind, detail, approximate: !item.arrivalExact },
            })
        }
        if (item.removedAt !== null) {
            const detail = item.status === "deleted" || item.status === "gone" ? "deleted" : "moved out"
            changes.push({
                at: Math.min(item.removedAt, now),
                change: { type: "removed", itemKey: item.key, name: item.name, kind: item.kind, detail, approximate: false },
            })
        }
        if (item.changedAt !== null && (item.removedAt === null || item.changedAt < item.removedAt)) {
            changes.push({
                at: Math.min(item.changedAt, now),
                change: { type: "changed", itemKey: item.key, name: item.name, kind: item.kind, detail: "renamed or moved", approximate: false },
            })
        }
    }
    const byTime = new Map<number, HistoryChange[]>()
    for (const { at, change } of changes) {
        const list = byTime.get(at) ?? []
        list.push(change)
        byTime.set(at, list)
    }
    const order: Record<HistoryChangeType, number> = { created: 0, added: 1, changed: 2, removed: 3 }
    const points: HistoryPoint[] = [...byTime.entries()]
        .filter(([at]) => at < now)
        .sort(([a], [b]) => a - b)
        .map(([at, list]) => ({ at, isNow: false, changes: list.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name)) }))
    points.push({ at: now, isNow: true, changes: byTime.get(now) ?? [] })

    return { folderId, now, createdAt: folderCreatedAt, items, points, skipped, warnings: [...new Set(warnings)] }
}

/* ------------------------------------------------------------- Queries */

/** Whether an item was in the folder at time `at` (ms), as far as the stored data can tell. */
export function historyItemStateAt(item: HistoryItem, at: number, now: number): HistoryItemState {
    if (at >= now) return item.status === "live" ? "present" : "absent"
    if (item.removedAt !== null && at >= item.removedAt) return "absent"
    if (item.absentBefore !== null && at < item.absentBefore) return "absent"
    if (item.arrivalExact && item.presentFrom !== null && at < item.presentFrom) return "absent"
    const removalUnknown = item.status !== "live" && item.removedAt === null
    if (item.presentFrom !== null && at >= item.presentFrom) return removalUnknown ? "uncertain" : "present"
    return "uncertain"
}

/** The folder listing at time `at`: present items plus items whose presence cannot be decided, annotated. */
export function folderSnapshotAt(history: FolderHistory, at: number): HistorySnapshotItem[] {
    const result: HistorySnapshotItem[] = []
    for (const item of history.items) {
        const state = historyItemStateAt(item, at, history.now)
        if (state === "absent") continue
        const annotations: HistoryAnnotation[] = []
        if (item.removedAt !== null && at < item.removedAt) {
            annotations.push(item.status === "moved-out" ? "moved-out-later" : "deleted-later")
        } else if (item.status !== "live" && at < history.now) {
            annotations.push("removed-unknown")
        }
        if (state === "uncertain" && (item.presentFrom === null || at < item.presentFrom)) annotations.push("arrival-unknown")
        if (!item.contentsStored) annotations.push("contents-gone")
        if (item.formerNames.length) annotations.push("renamed")
        result.push({ item, state, annotations })
    }
    return result
}

/** Index of the timeline point that describes the folder at time `at` (the last point at or before it). */
export function historyPointIndexAt(history: FolderHistory, at: number): number {
    let index = 0
    for (const [candidate, point] of history.points.entries()) {
        if (point.at <= at) index = candidate
    }
    return index
}

/** Counts of what changed between two times, for "+ added / − removed" summaries. */
export function diffSnapshots(history: FolderHistory, from: number, to: number) {
    const before = new Set(folderSnapshotAt(history, from).filter((entry) => entry.state === "present").map((entry) => entry.item.key))
    const after = new Set(folderSnapshotAt(history, to).filter((entry) => entry.state === "present").map((entry) => entry.item.key))
    return {
        added: [...after].filter((key) => !before.has(key)),
        removed: [...before].filter((key) => !after.has(key)),
    }
}
