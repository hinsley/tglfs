// Pure aggregation for the sidebar storage summary (no DOM, no Telegram): safe to import from Node tests.
import { fileKindForName } from "./icons"

export type StorageKind = "image" | "video" | "audio" | "doc" | "archive" | "other"

export const STORAGE_KINDS: ReadonlyArray<{ kind: StorageKind; label: string }> = [
    { kind: "image", label: "Images" },
    { kind: "video", label: "Videos" },
    { kind: "audio", label: "Audio" },
    { kind: "doc", label: "Documents" },
    { kind: "archive", label: "Archives" },
    { kind: "other", label: "Other" },
]

export function storageKindForName(name: string): StorageKind {
    const kind = fileKindForName(name)
    return kind === "image" || kind === "video" || kind === "audio" || kind === "doc" || kind === "archive" ? kind : "other"
}

export type KindTotals = Record<StorageKind, { files: number; bytes: number }>

export type StorageCardLike = {
    msgId?: number
    data: { name: string; size: number; ufid?: string; uploadComplete?: boolean }
}

function emptyKindTotals(): KindTotals {
    return {
        image: { files: 0, bytes: 0 },
        video: { files: 0, bytes: 0 },
        audio: { files: 0, bytes: 0 },
        doc: { files: 0, bytes: 0 },
        archive: { files: 0, bytes: 0 },
        other: { files: 0, bytes: 0 },
    }
}

/**
 * Accumulates file cards page by page. Every card counts as a file; only completed uploads count towards
 * the stored size (an interrupted upload's declared size was never fully stored). Cards that share a UFID
 * (the same blob listed twice) are counted once.
 */
export function createStorageAccumulator() {
    const seen = new Set<string>()
    const byKind = emptyKindTotals()
    let files = 0
    let bytes = 0
    let scanned = 0
    return {
        add(records: readonly StorageCardLike[]) {
            for (const record of records) {
                scanned++
                const key = record.data.ufid ? `u:${record.data.ufid}` : record.msgId !== undefined ? `m:${record.msgId}` : null
                if (key) {
                    if (seen.has(key)) continue
                    seen.add(key)
                }
                files++
                const kind = storageKindForName(record.data.name || "")
                byKind[kind].files++
                const size = Number(record.data.size)
                if (record.data.uploadComplete === false || !Number.isFinite(size) || size <= 0) continue
                bytes += size
                byKind[kind].bytes += size
            }
        },
        /** Records seen so far, including duplicates. */
        get scanned() {
            return scanned
        },
        totals() {
            return {
                files,
                bytes,
                byKind: JSON.parse(JSON.stringify(byKind)) as KindTotals,
            }
        },
    }
}

export type StorageSummary = {
    v: 1
    computedAt: number
    files: number
    bytes: number
    byKind: KindTotals
    /** True when the scan stopped early and `bytes`/`byKind` were extrapolated from a sample. */
    approximate: boolean
}

/**
 * Turns accumulated totals into a summary. When the scan stopped before the end (`exhausted` false) and the
 * server reported a total card count, sizes are scaled up proportionally from the sample and marked
 * approximate.
 */
export function finalizeStorageSummary(
    totals: { files: number; bytes: number; byKind: KindTotals },
    options: { exhausted: boolean; serverCount?: number | null; now?: number },
): StorageSummary {
    const computedAt = options.now ?? Date.now()
    if (options.exhausted || !options.serverCount || options.serverCount <= totals.files || totals.files === 0) {
        return { v: 1, computedAt, files: totals.files, bytes: totals.bytes, byKind: totals.byKind, approximate: !options.exhausted }
    }
    const factor = options.serverCount / totals.files
    const byKind = emptyKindTotals()
    for (const { kind } of STORAGE_KINDS) {
        byKind[kind] = {
            files: Math.round(totals.byKind[kind].files * factor),
            bytes: Math.round(totals.byKind[kind].bytes * factor),
        }
    }
    return {
        v: 1,
        computedAt,
        files: options.serverCount,
        bytes: Math.round(totals.bytes * factor),
        byKind,
        approximate: true,
    }
}

export type StorageSegment = { kind: StorageKind; label: string; bytes: number; files: number; fraction: number }

/** Non-empty kinds in display order, with each kind's share of the stored bytes (fractions sum to 1). */
export function storageSegments(summary: Pick<StorageSummary, "bytes" | "byKind">): StorageSegment[] {
    if (summary.bytes <= 0) return []
    return STORAGE_KINDS
        .map(({ kind, label }) => ({
            kind,
            label,
            bytes: summary.byKind[kind].bytes,
            files: summary.byKind[kind].files,
            fraction: summary.byKind[kind].bytes / summary.bytes,
        }))
        .filter((segment) => segment.bytes > 0)
}

const SIZE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]

/** Same units as the file list (binary, KiB/MiB/GiB…), so totals line up with per-file sizes. */
export function formatStorageBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
    const unitIndex = Math.min(SIZE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    const value = bytes / Math.pow(1024, unitIndex)
    const digits = unitIndex === 0 || value >= 100 ? 0 : 1
    return `${value.toFixed(digits).replace(/\.0$/, "")} ${SIZE_UNITS[unitIndex]}`
}

export function formatFileCount(count: number) {
    return `${count.toLocaleString("en-US")} ${count === 1 ? "file" : "files"}`
}

/** Headline such as "1.2 GiB stored · 3,402 files" (prefixed with ≈ when approximate). */
export function formatStorageHeadline(summary: Pick<StorageSummary, "bytes" | "files" | "approximate">) {
    const size = `${summary.approximate ? "≈ " : ""}${formatStorageBytes(summary.bytes)}`
    return { size: `${size} stored`, files: formatFileCount(summary.files) }
}

export function formatShare(fraction: number) {
    if (fraction <= 0) return "0%"
    if (fraction < 0.01) return "<1%"
    return `${Math.round(fraction * 100)}%`
}

/** sessionStorage key for the cached summary (per tab; cleared on sign-out). */
export const STORAGE_SUMMARY_CACHE_KEY = "tglfs.storageSummary"

export function clearStorageSummaryCache() {
    try {
        sessionStorage.removeItem(STORAGE_SUMMARY_CACHE_KEY)
    } catch {}
}

/** Validates a cached summary (sessionStorage JSON). Returns null for anything stale, malformed or unknown. */
export function parseCachedStorageSummary(raw: string | null, now: number, maxAgeMs: number): StorageSummary | null {
    if (!raw) return null
    let value: any
    try {
        value = JSON.parse(raw)
    } catch {
        return null
    }
    if (!value || typeof value !== "object" || value.v !== 1) return null
    if (typeof value.computedAt !== "number" || now - value.computedAt > maxAgeMs || value.computedAt > now + 60_000) return null
    if (!Number.isFinite(value.files) || !Number.isFinite(value.bytes) || typeof value.approximate !== "boolean") return null
    if (!value.byKind || typeof value.byKind !== "object") return null
    for (const { kind } of STORAGE_KINDS) {
        const entry = value.byKind[kind]
        if (!entry || !Number.isFinite(entry.files) || !Number.isFinite(entry.bytes)) return null
    }
    return value as StorageSummary
}
