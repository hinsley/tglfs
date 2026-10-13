// "Recent" items for the command palette: the last few folders and files the user opened. This is a local,
// per-browser UI convenience (localStorage), never written to Telegram. The stored JSON carries a version and
// anything unrecognised is ignored rather than rewritten.

export const RECENT_ITEMS_STORAGE_KEY = "tglfs.palette.recent"
export const RECENT_ITEMS_LIMIT = 8

export type RecentFolder = { kind: "folder"; folderId: string; name: string; at: number }
export type RecentFile = { kind: "file"; msgId: number; ufid: string; name: string; parentFolderId: string; at: number }
export type RecentItem = RecentFolder | RecentFile

export function recentItemKey(item: RecentItem) {
    return item.kind === "folder" ? `folder:${item.folderId}` : `file:${item.ufid}`
}

/** Moves `item` to the front (dropping an older copy of the same folder/file) and caps the list. */
export function pushRecentItem(items: readonly RecentItem[], item: RecentItem, limit = RECENT_ITEMS_LIMIT): RecentItem[] {
    const key = recentItemKey(item)
    return [item, ...items.filter((existing) => recentItemKey(existing) !== key)].slice(0, limit)
}

export function removeRecentItem(items: readonly RecentItem[], key: string): RecentItem[] {
    return items.filter((existing) => recentItemKey(existing) !== key)
}

function isRecentItem(value: any): value is RecentItem {
    if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.at !== "number") return false
    if (value.kind === "folder") return typeof value.folderId === "string" && value.folderId.length > 0
    if (value.kind === "file") {
        return Number.isInteger(value.msgId) && typeof value.ufid === "string" && value.ufid.length > 0 &&
            typeof value.parentFolderId === "string"
    }
    return false
}

export function parseRecentItems(raw: string | null): RecentItem[] {
    if (!raw) return []
    try {
        const value = JSON.parse(raw)
        if (!value || value.v !== 1 || !Array.isArray(value.items)) return []
        return value.items.filter(isRecentItem).slice(0, RECENT_ITEMS_LIMIT)
    } catch {
        return []
    }
}

export function serializeRecentItems(items: readonly RecentItem[]) {
    return JSON.stringify({ v: 1, items: items.slice(0, RECENT_ITEMS_LIMIT) })
}

export function loadRecentItems(): RecentItem[] {
    try {
        return parseRecentItems(localStorage.getItem(RECENT_ITEMS_STORAGE_KEY))
    } catch {
        return []
    }
}

function saveRecentItems(items: readonly RecentItem[]) {
    try {
        localStorage.setItem(RECENT_ITEMS_STORAGE_KEY, serializeRecentItems(items))
    } catch {
        // Best-effort convenience.
    }
}

export function rememberRecentItem(item: RecentItem) {
    saveRecentItems(pushRecentItem(loadRecentItems(), item))
}

export function forgetRecentItem(key: string) {
    saveRecentItems(removeRecentItem(loadRecentItems(), key))
}

export function clearRecentItems() {
    try {
        localStorage.removeItem(RECENT_ITEMS_STORAGE_KEY)
    } catch {}
}
