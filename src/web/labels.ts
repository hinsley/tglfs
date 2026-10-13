// Stars and tags ("labels") stored locally on this device, one versioned document per Telegram account.
//
// This module is pure (no DOM, no Telegram) so Node tests can import it. The browser passes in a Storage-like
// object (localStorage); tests pass an in-memory one.
//
// Durable local format (AGENTS.md treats persisted local state as a protocol surface):
//
//   localStorage["tglfs.labels:<accountKey>"] = JSON of
//   {
//     "type": "tglfs:local-labels",
//     "version": 1,
//     "accountKey": "<accountKey>",
//     "updatedAt": "<ISO time>",
//     "tags":  { "<tagId>": { "name": "Travel", "color": "blue", "createdAt": "<ISO>" } },
//     "items": { "file:<ufid>" | "folder:<folderId>": {
//                  "kind": "file" | "folder", "id": "<ufid|folderId>",
//                  "starred": true, "starredAt": "<ISO>", "tags": ["<tagId>"],
//                  "name": "<last known display name>", "updatedAt": "<ISO>" } }
//   }
//
// Rules:
// - Files are identified by UFID and folders by folderId, so labels follow renames and moves.
// - Readers ignore malformed tags/items but keep them verbatim when writing; unknown fields on the document,
//   tags and items are preserved on every write.
// - A document with a newer `version` (or for a different account) is never interpreted or overwritten: the
//   store becomes read-only ("unsupported") and reports empty labels.
// - A document that is not valid JSON / not a labels document is copied to "<key>.malformed-backup" before a
//   fresh document is started, so nothing is lost silently.

export const LABELS_DOCUMENT_TYPE = "tglfs:local-labels"
export const LABELS_DOCUMENT_VERSION = 1
export const LABELS_STORAGE_PREFIX = "tglfs.labels:"
export const LABELS_BACKUP_SUFFIX = ".malformed-backup"
export const MAX_TAG_NAME_LENGTH = 48

/** Palette names, in the order new tags are auto-assigned. Rendered through CSS tokens so both themes work. */
export const TAG_COLORS = ["blue", "green", "amber", "purple", "pink", "teal", "orange", "red", "gray"] as const
export type TagColor = (typeof TAG_COLORS)[number]

export type LabelItemKind = "file" | "folder"

export type LabelTag = {
    name: string
    color: string
    createdAt?: string
    [field: string]: unknown
}

export type LabelItem = {
    kind: LabelItemKind
    id: string
    starred?: boolean
    starredAt?: string
    tags?: string[]
    name?: string
    updatedAt?: string
    [field: string]: unknown
}

export type LabelsDocument = {
    type: typeof LABELS_DOCUMENT_TYPE
    version: number
    accountKey: string
    updatedAt?: string
    tags: Record<string, unknown>
    items: Record<string, unknown>
    [field: string]: unknown
}

export type ParseLabelsResult =
    | { status: "empty" }
    | { status: "ok"; doc: LabelsDocument }
    | { status: "unsupported"; reason: "future-version" | "other-account"; version?: unknown }
    | { status: "malformed"; reason: string }

export type LabelStorage = {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem?: (key: string) => void
}

/* ------------------------------------------------------------- Helpers */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

export function labelItemKey(kind: LabelItemKind, id: string) {
    return `${kind}:${id}`
}

export function parseLabelItemKey(key: string): { kind: LabelItemKind; id: string } | null {
    const match = /^(file|folder):(.+)$/.exec(key)
    return match ? { kind: match[1] as LabelItemKind, id: match[2] } : null
}

export function labelsStorageKey(accountKey: string) {
    return `${LABELS_STORAGE_PREFIX}${accountKey}`
}

export function isKnownTagColor(color: unknown): color is TagColor {
    return typeof color === "string" && (TAG_COLORS as readonly string[]).includes(color)
}

/** Trims, collapses whitespace and drops a leading "#". Returns null for names that cannot be used. */
export function normalizeTagName(value: unknown): string | null {
    if (typeof value !== "string") return null
    const name = value.replace(/\s+/g, " ").trim().replace(/^#+\s*/, "").trim()
    if (!name || name.length > MAX_TAG_NAME_LENGTH) return null
    if (/[\u0000-\u001f\u007f]/.test(name)) return null
    return name
}

export function tagNameKey(name: string) {
    return name.toLocaleLowerCase()
}

/** Validates one stored tag. Returns null when it is unusable (it is then ignored but preserved). */
export function readTag(value: unknown): LabelTag | null {
    if (!isPlainObject(value)) return null
    const name = normalizeTagName(value.name)
    if (!name || name !== value.name) return null
    if (typeof value.color !== "string") return null
    return value as LabelTag
}

/** Validates one stored item against its key. Returns null when it is unusable (ignored but preserved). */
export function readItem(key: string, value: unknown): LabelItem | null {
    const parsedKey = parseLabelItemKey(key)
    if (!parsedKey || !isPlainObject(value)) return null
    if (value.kind !== parsedKey.kind || value.id !== parsedKey.id) return null
    if (value.starred !== undefined && typeof value.starred !== "boolean") return null
    if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) return null
    if (value.name !== undefined && typeof value.name !== "string") return null
    return value as LabelItem
}

export function createLabelsDocument(accountKey: string, now?: string): LabelsDocument {
    return {
        type: LABELS_DOCUMENT_TYPE,
        version: LABELS_DOCUMENT_VERSION,
        accountKey,
        ...(now ? { updatedAt: now } : {}),
        tags: {},
        items: {},
    }
}

/* ------------------------------------------------------- Parse/serialize */

/**
 * Parses a stored or imported labels document. `expectedAccountKey` (when given) must match the document's
 * account. Does not validate individual tags/items; accessors skip malformed ones.
 */
export function parseLabelsDocument(text: string | null | undefined, expectedAccountKey?: string): ParseLabelsResult {
    if (text === null || text === undefined || text === "") return { status: "empty" }
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        return { status: "malformed", reason: "not JSON" }
    }
    if (!isPlainObject(raw)) return { status: "malformed", reason: "not an object" }
    if (raw.type !== LABELS_DOCUMENT_TYPE) return { status: "malformed", reason: "wrong type" }
    const version = raw.version
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        return { status: "malformed", reason: "bad version" }
    }
    if (version > LABELS_DOCUMENT_VERSION) return { status: "unsupported", reason: "future-version", version }
    if (typeof raw.accountKey !== "string" || raw.accountKey === "") return { status: "malformed", reason: "missing accountKey" }
    if (expectedAccountKey !== undefined && raw.accountKey !== expectedAccountKey) {
        return { status: "unsupported", reason: "other-account" }
    }
    if (raw.tags !== undefined && !isPlainObject(raw.tags)) return { status: "malformed", reason: "tags is not an object" }
    if (raw.items !== undefined && !isPlainObject(raw.items)) return { status: "malformed", reason: "items is not an object" }
    const doc: LabelsDocument = {
        ...raw,
        type: LABELS_DOCUMENT_TYPE,
        version,
        accountKey: raw.accountKey,
        tags: { ...((raw.tags as Record<string, unknown> | undefined) ?? {}) },
        items: { ...((raw.items as Record<string, unknown> | undefined) ?? {}) },
    }
    return { status: "ok", doc }
}

export function serializeLabelsDocument(doc: LabelsDocument, pretty = false) {
    return pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc)
}

/* ------------------------------------------------------------- Queries */

export type TagSummary = { id: string; name: string; color: TagColor; count: number }

export function tagColorOf(tag: LabelTag, id: string): TagColor {
    if (isKnownTagColor(tag.color)) return tag.color
    // Unknown colour names (e.g. from a newer client) are preserved on disk but rendered with a stable fallback.
    let hash = 0
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return TAG_COLORS[hash % TAG_COLORS.length]
}

export function listTags(doc: LabelsDocument): TagSummary[] {
    const counts = new Map<string, number>()
    for (const [key, value] of Object.entries(doc.items)) {
        const item = readItem(key, value)
        for (const tagId of new Set(item?.tags ?? [])) counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
    }
    const tags: TagSummary[] = []
    for (const [id, value] of Object.entries(doc.tags)) {
        const tag = readTag(value)
        if (!tag) continue
        tags.push({ id, name: tag.name, color: tagColorOf(tag, id), count: counts.get(id) ?? 0 })
    }
    return tags.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
}

export function getItem(doc: LabelsDocument, key: string): LabelItem | null {
    return readItem(key, doc.items[key])
}

export function isStarred(doc: LabelsDocument, key: string) {
    return getItem(doc, key)?.starred === true
}

/** Tag ids of an item that refer to existing, valid tags. */
export function itemTagIds(doc: LabelsDocument, key: string): string[] {
    const tags = getItem(doc, key)?.tags ?? []
    return [...new Set(tags)].filter((id) => !!readTag(doc.tags[id]))
}

export function starredKeys(doc: LabelsDocument): string[] {
    return Object.keys(doc.items).filter((key) => isStarred(doc, key))
}

export function keysWithTag(doc: LabelsDocument, tagId: string): string[] {
    return Object.keys(doc.items).filter((key) => itemTagIds(doc, key).includes(tagId))
}

export function findTagByName(doc: LabelsDocument, name: string): string | null {
    const normalized = normalizeTagName(name)
    if (!normalized) return null
    const wanted = tagNameKey(normalized)
    for (const [id, value] of Object.entries(doc.tags)) {
        const tag = readTag(value)
        if (tag && tagNameKey(tag.name) === wanted) return id
    }
    return null
}

export function nextTagColor(doc: LabelsDocument): TagColor {
    const used = new Map<string, number>()
    for (const value of Object.values(doc.tags)) {
        const tag = readTag(value)
        if (tag) used.set(tag.color, (used.get(tag.color) ?? 0) + 1)
    }
    let best: TagColor = TAG_COLORS[0]
    let bestCount = Infinity
    for (const color of TAG_COLORS) {
        const count = used.get(color) ?? 0
        if (count < bestCount) {
            best = color
            bestCount = count
        }
    }
    return best
}

/* ----------------------------------------------------------- Mutations */
// Every mutation returns a new document (inputs are not modified) and preserves unknown fields.

export type ItemRef = { key: string; name?: string }

type MutationContext = { now: string }

function withItem(doc: LabelsDocument, ref: ItemRef, ctx: MutationContext, change: (item: LabelItem) => LabelItem): LabelsDocument {
    const parsedKey = parseLabelItemKey(ref.key)
    if (!parsedKey) return doc
    const existing = getItem(doc, ref.key)
    const base: LabelItem = existing ? { ...existing } : { kind: parsedKey.kind, id: parsedKey.id }
    if (ref.name) base.name = ref.name
    const next = change(base)
    next.updatedAt = ctx.now
    const items = { ...doc.items }
    if (isEmptyItem(next)) {
        delete items[ref.key]
    } else {
        items[ref.key] = next
    }
    return { ...doc, items, updatedAt: ctx.now }
}

const KNOWN_ITEM_FIELDS = new Set(["kind", "id", "starred", "starredAt", "tags", "name", "updatedAt"])

/** An item with no star, no tags and no unknown fields carries no information and is dropped. */
function isEmptyItem(item: LabelItem) {
    if (item.starred) return false
    if (item.tags && item.tags.length > 0) return false
    return Object.keys(item).every((field) => KNOWN_ITEM_FIELDS.has(field))
}

function stripEmptyFields(item: LabelItem): LabelItem {
    const next = { ...item }
    if (!next.starred) {
        delete next.starred
        delete next.starredAt
    }
    if (next.tags && next.tags.length === 0) delete next.tags
    return next
}

export function setStarred(doc: LabelsDocument, refs: ItemRef[], starred: boolean, now: string): LabelsDocument {
    let next = doc
    for (const ref of refs) {
        next = withItem(next, ref, { now }, (item) => {
            if (starred) {
                return { ...item, starred: true, starredAt: item.starred ? item.starredAt ?? now : now }
            }
            return stripEmptyFields({ ...item, starred: false })
        })
    }
    return next
}

export function applyTagChanges(
    doc: LabelsDocument,
    refs: ItemRef[],
    changes: { add?: string[]; remove?: string[] },
    now: string,
): LabelsDocument {
    const add = (changes.add ?? []).filter((id) => !!readTag(doc.tags[id]))
    const remove = new Set(changes.remove ?? [])
    let next = doc
    for (const ref of refs) {
        next = withItem(next, ref, { now }, (item) => {
            const tags = (item.tags ?? []).filter((id) => !remove.has(id))
            for (const id of add) if (!tags.includes(id)) tags.push(id)
            return stripEmptyFields({ ...item, tags })
        })
    }
    return next
}

export type CreateTagResult = { doc: LabelsDocument; id: string; created: boolean }

export function createTag(
    doc: LabelsDocument,
    name: string,
    options: { now: string; id: string; color?: string },
): CreateTagResult | null {
    const normalized = normalizeTagName(name)
    if (!normalized) return null
    const existing = findTagByName(doc, normalized)
    if (existing) return { doc, id: existing, created: false }
    let id = options.id
    while (doc.tags[id] !== undefined) id = `${options.id}-${Math.random().toString(36).slice(2, 6)}`
    const color = options.color && isKnownTagColor(options.color) ? options.color : nextTagColor(doc)
    return {
        doc: { ...doc, tags: { ...doc.tags, [id]: { name: normalized, color, createdAt: options.now } }, updatedAt: options.now },
        id,
        created: true,
    }
}

export type RenameTagResult = { ok: true; doc: LabelsDocument } | { ok: false; error: "invalid" | "duplicate" | "missing" }

export function renameTag(doc: LabelsDocument, id: string, name: string, now: string): RenameTagResult {
    const tag = readTag(doc.tags[id])
    if (!tag) return { ok: false, error: "missing" }
    const normalized = normalizeTagName(name)
    if (!normalized) return { ok: false, error: "invalid" }
    const clash = findTagByName(doc, normalized)
    if (clash && clash !== id) return { ok: false, error: "duplicate" }
    return { ok: true, doc: { ...doc, tags: { ...doc.tags, [id]: { ...tag, name: normalized } }, updatedAt: now } }
}

export function recolorTag(doc: LabelsDocument, id: string, color: string, now: string): LabelsDocument {
    const tag = readTag(doc.tags[id])
    if (!tag || !isKnownTagColor(color)) return doc
    return { ...doc, tags: { ...doc.tags, [id]: { ...tag, color } }, updatedAt: now }
}

/** Deletes a tag and removes it from every item that had it. */
export function deleteTag(doc: LabelsDocument, id: string, now: string): LabelsDocument {
    if (doc.tags[id] === undefined) return doc
    const tags = { ...doc.tags }
    delete tags[id]
    let next: LabelsDocument = { ...doc, tags, updatedAt: now }
    const affected = Object.keys(doc.items).filter((key) => (getItem(doc, key)?.tags ?? []).includes(id))
    next = applyTagChanges(next, affected.map((key) => ({ key })), { remove: [id] }, now)
    return next
}

/** Removes every label of the given items (e.g. after they were deleted for good). */
export function forgetItems(doc: LabelsDocument, keys: string[], now: string): LabelsDocument {
    const items = { ...doc.items }
    let changed = false
    for (const key of keys) {
        if (items[key] === undefined) continue
        delete items[key]
        changed = true
    }
    return changed ? { ...doc, items, updatedAt: now } : doc
}

/** Records the latest known display names (used to label items that later go missing). */
export function updateNameHints(doc: LabelsDocument, hints: Map<string, string>): LabelsDocument {
    let items: Record<string, unknown> | null = null
    for (const [key, name] of hints) {
        const item = getItem(doc, key)
        if (!item || !name || item.name === name) continue
        items ??= { ...doc.items }
        items[key] = { ...item, name }
    }
    return items ? { ...doc, items } : doc
}

/* -------------------------------------------------------------- Import */

export type ImportSummary = {
    starsAdded: number
    tagsCreated: number
    tagAssignmentsAdded: number
    itemsTouched: number
    skipped: number
    otherAccount: boolean
}

export type ImportResult =
    | { ok: true; doc: LabelsDocument; summary: ImportSummary }
    | { ok: false; error: "malformed" | "future-version" }

/**
 * Merges an exported labels document into `doc`. Stars are unioned, tags are matched by name (case-insensitive)
 * and unioned per item; existing tag colours win. Nothing is removed.
 */
export function mergeImportedLabels(
    doc: LabelsDocument,
    text: string,
    options: { now: string; newId: () => string },
): ImportResult {
    const parsed = parseLabelsDocument(text)
    if (parsed.status === "unsupported") return { ok: false, error: "future-version" }
    if (parsed.status !== "ok") return { ok: false, error: "malformed" }
    const incoming = parsed.doc
    const summary: ImportSummary = {
        starsAdded: 0,
        tagsCreated: 0,
        tagAssignmentsAdded: 0,
        itemsTouched: 0,
        skipped: 0,
        otherAccount: incoming.accountKey !== doc.accountKey,
    }
    let next = doc
    const tagIdMap = new Map<string, string>()
    for (const [incomingId, value] of Object.entries(incoming.tags)) {
        const tag = readTag(value)
        if (!tag) {
            summary.skipped++
            continue
        }
        const created = createTag(next, tag.name, { now: options.now, id: options.newId(), color: tag.color })
        if (!created) {
            summary.skipped++
            continue
        }
        if (created.created) summary.tagsCreated++
        next = created.doc
        tagIdMap.set(incomingId, created.id)
    }
    for (const [key, value] of Object.entries(incoming.items)) {
        const item = readItem(key, value)
        if (!item) {
            summary.skipped++
            continue
        }
        const before = next
        const ref: ItemRef = { key, name: getItem(next, key)?.name ? undefined : item.name }
        if (item.starred && !isStarred(next, key)) {
            next = setStarred(next, [ref], true, options.now)
            summary.starsAdded++
        }
        const mapped = (item.tags ?? []).map((id) => tagIdMap.get(id)).filter((id): id is string => !!id)
        const current = new Set(itemTagIds(next, key))
        const missing = [...new Set(mapped)].filter((id) => !current.has(id))
        if (missing.length > 0) {
            next = applyTagChanges(next, [ref], { add: missing }, options.now)
            summary.tagAssignmentsAdded += missing.length
        }
        if (next !== before) summary.itemsTouched++
    }
    return { ok: true, doc: next, summary }
}

/* --------------------------------------------------------------- Store */

export type LabelStoreStatus = "ok" | "unsupported"

export type LabelStore = {
    readonly accountKey: string
    readonly storageKey: string
    status: () => LabelStoreStatus
    /** A one-time human-readable notice about recovered or refused data (null when there is none). */
    takeNotice: () => string | null
    /** The current document. Empty (but valid) while the store is unsupported. */
    doc: () => LabelsDocument
    /** Re-reads storage (e.g. after another tab changed it). Returns true when the document changed. */
    reload: () => boolean
    /** Read-modify-write against the latest stored document. Returns false when the store is read-only. */
    update: (mutate: (doc: LabelsDocument, now: string) => LabelsDocument) => boolean
    /** The raw stored text for export (the stored document even when this client cannot interpret it). */
    exportText: () => string
    subscribe: (listener: () => void) => () => void
}

export function createLabelStore(options: {
    storage: LabelStorage | null
    accountKey: string
    now?: () => string
}): LabelStore {
    const storage = options.storage
    const storageKey = labelsStorageKey(options.accountKey)
    const now = options.now ?? (() => new Date().toISOString())
    const listeners = new Set<() => void>()
    let status: LabelStoreStatus = "ok"
    let notice: string | null = null
    let current = createLabelsDocument(options.accountKey)
    let lastRaw: string | null = null
    // Without working storage the labels still work for this page session.
    let memoryOnly = !storage

    const readRaw = (): string | null => {
        if (memoryOnly || !storage) return lastRaw
        try {
            return storage.getItem(storageKey)
        } catch {
            memoryOnly = true
            return lastRaw
        }
    }

    const writeRaw = (text: string) => {
        lastRaw = text
        if (memoryOnly || !storage) return
        try {
            storage.setItem(storageKey, text)
        } catch {
            memoryOnly = true
            notice = "Stars and tags can't be saved in this browser right now; changes last until you close the tab."
        }
    }

    const load = (raw: string | null): LabelsDocument => {
        const parsed = parseLabelsDocument(raw, options.accountKey)
        if (parsed.status === "ok") {
            status = "ok"
            return parsed.doc
        }
        if (parsed.status === "unsupported") {
            status = "unsupported"
            notice = parsed.reason === "future-version"
                ? "Stars and tags on this device were saved by a newer version of TGLFS. Update TGLFS to see or change them."
                : "Stars and tags stored for this account look like they belong to another account, so they were left untouched."
            return createLabelsDocument(options.accountKey)
        }
        status = "ok"
        const fresh = createLabelsDocument(options.accountKey)
        if (parsed.status === "malformed" && raw !== null && storage && !memoryOnly) {
            // Keep the unreadable data recoverable instead of silently overwriting it.
            try {
                const backupKey = `${storageKey}${LABELS_BACKUP_SUFFIX}`
                const existingBackup = storage.getItem(backupKey)
                storage.setItem(existingBackup === null ? backupKey : `${backupKey}-${Date.now()}`, raw)
                const freshText = serializeLabelsDocument(fresh)
                storage.setItem(storageKey, freshText)
                lastRaw = freshText
                notice = "Saved stars and tags on this device couldn't be read. A backup copy was kept; starting fresh."
            } catch {
                status = "unsupported"
                notice = "Saved stars and tags on this device couldn't be read, and no backup could be made, so they were left untouched."
            }
        }
        return fresh
    }

    const emit = () => {
        for (const listener of [...listeners]) {
            try {
                listener()
            } catch (error) {
                console.error(error)
            }
        }
    }

    lastRaw = readRaw()
    current = load(lastRaw)

    return {
        accountKey: options.accountKey,
        storageKey,
        status: () => status,
        takeNotice: () => {
            const value = notice
            notice = null
            return value
        },
        doc: () => current,
        reload: () => {
            const raw = readRaw()
            if (raw === lastRaw) return false
            lastRaw = raw
            current = load(raw)
            emit()
            return true
        },
        update: (mutate) => {
            const raw = readRaw()
            if (raw !== lastRaw) {
                lastRaw = raw
                current = load(raw)
            }
            if (status !== "ok") return false
            const timestamp = now()
            const next = mutate(current, timestamp)
            if (next === current) return true
            const stamped: LabelsDocument = { ...next, type: LABELS_DOCUMENT_TYPE, version: LABELS_DOCUMENT_VERSION, accountKey: options.accountKey }
            writeRaw(serializeLabelsDocument(stamped))
            current = stamped
            emit()
            return true
        },
        exportText: () => {
            const raw = readRaw()
            if (status !== "ok" && raw) return raw
            return serializeLabelsDocument({ ...current, exportedAt: now() }, true)
        },
        subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}
