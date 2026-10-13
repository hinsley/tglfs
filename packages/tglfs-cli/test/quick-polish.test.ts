import assert from "node:assert/strict"
import test from "node:test"

import { fuzzyMatch, highlightSegments, rankFuzzy } from "../../../src/web/fuzzyMatch.ts"
import {
    createStorageAccumulator,
    finalizeStorageSummary,
    formatShare,
    formatStorageBytes,
    formatStorageHeadline,
    parseCachedStorageSummary,
    storageKindForName,
    storageSegments,
} from "../../../src/web/storageStats.ts"
import {
    describePastedUpload,
    extensionForMimeType,
    formatPasteTimestamp,
    isPlaceholderClipboardName,
    namePastedFiles,
} from "../../../src/web/pastedFiles.ts"
import {
    parseRecentItems,
    pushRecentItem,
    serializeRecentItems,
    type RecentItem,
} from "../../../src/web/recentItems.ts"
import { createLocationResolver, defaultSearchScope, formatLocation } from "../../../src/web/searchScope.ts"
import { shortcutGroups } from "../../../src/web/shortcutsSheet.ts"

/* ------------------------------------------------------------- Fuzzy */

test("fuzzy match rejects candidates missing a query character in order", () => {
    assert.equal(fuzzyMatch("xyz", "plan.md"), null)
    assert.equal(fuzzyMatch("nalp", "plan.md"), null)
    assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, indices: [] })
})

test("fuzzy match ranks exact > prefix > word-start substring > inner substring > scattered", () => {
    const exact = fuzzyMatch("plan", "plan")!.score
    const prefix = fuzzyMatch("plan", "plan.md")!.score
    const wordStart = fuzzyMatch("plan", "Project plan.md")!.score
    const inner = fuzzyMatch("plan", "airplane.md")!.score
    const scattered = fuzzyMatch("plan", "pictures of a lantern.jpg")!.score
    assert.ok(exact > prefix, `${exact} > ${prefix}`)
    assert.ok(prefix > wordStart, `${prefix} > ${wordStart}`)
    assert.ok(wordStart > inner, `${wordStart} > ${inner}`)
    assert.ok(inner > scattered, `${inner} > ${scattered}`)
})

test("fuzzy match prefers word starts for scattered matches and reports indices", () => {
    const match = fuzzyMatch("qr", "Quarterly report.pdf")!
    assert.deepEqual(match.indices, [0, 10])
    const acronym = fuzzyMatch("hm", "Home movie.mp4")!
    const buried = fuzzyMatch("hm", "rhythm.mp3")!
    assert.ok(acronym.score > buried.score)
})

test("fuzzy match is case-insensitive and treats each query word independently", () => {
    const match = fuzzyMatch("REPORT q", "Quarterly report.pdf")
    assert.ok(match)
    assert.deepEqual(match.indices, [0, 10, 11, 12, 13, 14, 15])
    assert.equal(fuzzyMatch("report zz", "Quarterly report.pdf"), null)
})

test("rankFuzzy orders by score, keeps input order on ties, and uses keywords as a weaker fallback", () => {
    const items = [
        { label: "Switch to dark mode", keywords: ["theme"] },
        { label: "Upload files", keywords: ["add files"] },
        { label: "Theme", keywords: [] },
    ]
    const ranked = rankFuzzy("theme", items, (item) => [item.label, ...item.keywords])
    assert.deepEqual(ranked.map((entry) => entry.item.label), ["Theme", "Switch to dark mode"])
    // Keyword-only matches carry no label highlight.
    assert.deepEqual(ranked[1].match.indices, [])
    assert.deepEqual(ranked[0].match.indices, [0, 1, 2, 3, 4])

    const ties = rankFuzzy("", items, (item) => item.label)
    assert.deepEqual(ties.map((entry) => entry.item.label), items.map((item) => item.label))
    assert.equal(rankFuzzy("files", items, (item) => item.label, { limit: 1 }).length, 1)
})

test("highlightSegments groups consecutive matched characters", () => {
    assert.deepEqual(highlightSegments("plan.md", [0, 1, 2, 3]), [
        { text: "plan", match: true },
        { text: ".md", match: false },
    ])
    assert.deepEqual(highlightSegments("abc", []), [{ text: "abc", match: false }])
})

/* ----------------------------------------------------------- Storage */

const card = (msgId: number, name: string, size: number, extra: { ufid?: string; uploadComplete?: boolean } = {}) => ({
    msgId,
    data: { name, size, ufid: extra.ufid ?? `ufid-${msgId}`, uploadComplete: extra.uploadComplete ?? true },
})

test("storage kinds follow the file-kind icons, folding code and unknown types into other", () => {
    assert.equal(storageKindForName("IMG_0001.HEIC"), "image")
    assert.equal(storageKindForName("clip.mkv"), "video")
    assert.equal(storageKindForName("song.flac"), "audio")
    assert.equal(storageKindForName("Quarterly report.pdf"), "doc")
    assert.equal(storageKindForName("backup.tar.gz"), "archive")
    assert.equal(storageKindForName("main.ts"), "other")
    assert.equal(storageKindForName("README"), "other")
})

test("storage accumulator counts every card, sizes only complete uploads, and dedupes UFIDs", () => {
    const accumulator = createStorageAccumulator()
    accumulator.add([
        card(1, "a.jpg", 100),
        card(2, "b.mp4", 1000),
        card(3, "partial.zip", 5000, { uploadComplete: false }),
    ])
    accumulator.add([card(4, "a copy.jpg", 100, { ufid: "ufid-1" }), card(5, "notes.txt", 10)])
    const totals = accumulator.totals()
    assert.equal(accumulator.scanned, 5)
    assert.equal(totals.files, 4)
    assert.equal(totals.bytes, 1110)
    assert.deepEqual(totals.byKind.image, { files: 1, bytes: 100 })
    assert.deepEqual(totals.byKind.archive, { files: 1, bytes: 0 })
    assert.deepEqual(totals.byKind.doc, { files: 1, bytes: 10 })
})

test("finalized summaries are exact when the scan finished and extrapolated when it stopped early", () => {
    const accumulator = createStorageAccumulator()
    accumulator.add([card(1, "a.jpg", 300), card(2, "b.mp4", 700)])
    const exact = finalizeStorageSummary(accumulator.totals(), { exhausted: true, serverCount: 2, now: 1000 })
    assert.equal(exact.approximate, false)
    assert.equal(exact.bytes, 1000)
    assert.equal(exact.files, 2)
    assert.equal(exact.computedAt, 1000)

    const estimated = finalizeStorageSummary(accumulator.totals(), { exhausted: false, serverCount: 10, now: 1000 })
    assert.equal(estimated.approximate, true)
    assert.equal(estimated.files, 10)
    assert.equal(estimated.bytes, 5000)
    assert.equal(estimated.byKind.video.bytes, 3500)

    const unknownTotal = finalizeStorageSummary(accumulator.totals(), { exhausted: false, serverCount: null })
    assert.equal(unknownTotal.approximate, true)
    assert.equal(unknownTotal.bytes, 1000)
})

test("storage segments keep display order, skip empty kinds and add up to the whole", () => {
    const accumulator = createStorageAccumulator()
    accumulator.add([card(1, "song.mp3", 250), card(2, "a.png", 500), card(3, "x.bin", 250), card(4, "empty.pdf", 0)])
    const summary = finalizeStorageSummary(accumulator.totals(), { exhausted: true })
    const segments = storageSegments(summary)
    assert.deepEqual(segments.map((segment) => segment.kind), ["image", "audio", "other"])
    assert.equal(segments.reduce((sum, segment) => sum + segment.fraction, 0), 1)
    assert.deepEqual(storageSegments({ bytes: 0, byKind: summary.byKind }), [])
})

test("storage formatting reads naturally", () => {
    assert.equal(formatStorageBytes(0), "0 B")
    assert.equal(formatStorageBytes(512), "512 B")
    assert.equal(formatStorageBytes(1536), "1.5 KiB")
    assert.equal(formatStorageBytes(1.2 * 1024 ** 4), "1.2 TiB")
    assert.equal(formatStorageBytes(250 * 1024 ** 3), "250 GiB")
    assert.deepEqual(formatStorageHeadline({ bytes: 1.2 * 1024 ** 4, files: 3402, approximate: false }), {
        size: "1.2 TiB stored",
        files: "3,402 files",
    })
    assert.equal(formatStorageHeadline({ bytes: 2048, files: 1, approximate: true }).size, "≈ 2 KiB stored")
    assert.equal(formatStorageHeadline({ bytes: 2048, files: 1, approximate: true }).files, "1 file")
    assert.equal(formatShare(0.004), "<1%")
    assert.equal(formatShare(0.456), "46%")
})

test("cached storage summaries are only reused when fresh, versioned and well-formed", () => {
    const accumulator = createStorageAccumulator()
    accumulator.add([card(1, "a.jpg", 300)])
    const summary = finalizeStorageSummary(accumulator.totals(), { exhausted: true, now: 10_000 })
    const raw = JSON.stringify(summary)
    assert.deepEqual(parseCachedStorageSummary(raw, 10_500, 1000), summary)
    assert.equal(parseCachedStorageSummary(raw, 20_000, 1000), null, "stale")
    assert.equal(parseCachedStorageSummary(JSON.stringify({ ...summary, v: 2 }), 10_500, 1000), null, "unknown version")
    assert.equal(parseCachedStorageSummary(JSON.stringify({ ...summary, byKind: {} }), 10_500, 1000), null, "malformed")
    assert.equal(parseCachedStorageSummary("{not json", 10_500, 1000), null)
    assert.equal(parseCachedStorageSummary(null, 10_500, 1000), null)
})

/* ------------------------------------------------------------- Paste */

test("clipboard placeholder names are recognised, real file names are not", () => {
    assert.equal(isPlaceholderClipboardName("image.png", "image/png"), true)
    assert.equal(isPlaceholderClipboardName("Image.JPEG", "image/jpeg"), true)
    assert.equal(isPlaceholderClipboardName("", "application/pdf"), true)
    assert.equal(isPlaceholderClipboardName("holiday.png", "image/png"), false)
    assert.equal(isPlaceholderClipboardName("image.png", "application/octet-stream"), false)
})

test("pasted images get a timestamped name with an extension from their type", () => {
    const now = new Date(2026, 9, 13, 14, 5, 59)
    assert.equal(formatPasteTimestamp(now), "2026-10-13 14.05")
    assert.deepEqual(
        namePastedFiles([{ name: "image.png", type: "image/png" }], now),
        ["Pasted image 2026-10-13 14.05.png"],
    )
    assert.deepEqual(
        namePastedFiles([{ name: "", type: "image/jpeg" }, { name: "", type: "" }], now),
        ["Pasted image 2026-10-13 14.05.jpg", "Pasted file 2026-10-13 14.05"],
    )
    assert.equal(extensionForMimeType("image/svg+xml"), "svg")
    assert.equal(extensionForMimeType("image/x-weird-format-name"), "")
    assert.equal(extensionForMimeType("text/plain; charset=utf-8"), "txt")
})

test("pasted file names stay unique within a paste and real names are kept", () => {
    const now = new Date(2026, 9, 13, 9, 0)
    assert.deepEqual(
        namePastedFiles([
            { name: "image.png", type: "image/png" },
            { name: "image.png", type: "image/png" },
            { name: "report.pdf", type: "application/pdf" },
            { name: "Report.pdf", type: "application/pdf" },
            { name: "image.png", type: "image/png" },
        ], now),
        [
            "Pasted image 2026-10-13 09.00.png",
            "Pasted image 2026-10-13 09.00 (2).png",
            "report.pdf",
            "Report (2).pdf",
            "Pasted image 2026-10-13 09.00 (3).png",
        ],
    )
    assert.equal(describePastedUpload(1), "Uploading pasted file…")
    assert.equal(describePastedUpload(2), "Uploading 2 pasted files…")
})

/* ------------------------------------------------------------ Recents */

test("recent items move to the front, dedupe by identity and cap the list", () => {
    let items: RecentItem[] = []
    for (let i = 0; i < 10; i++) {
        items = pushRecentItem(items, { kind: "folder", folderId: `f${i}`, name: `Folder ${i}`, at: i })
    }
    assert.equal(items.length, 8)
    assert.equal(items[0].kind === "folder" && items[0].folderId, "f9")
    items = pushRecentItem(items, { kind: "folder", folderId: "f5", name: "Renamed", at: 99 })
    assert.equal(items.length, 8)
    assert.deepEqual(items[0], { kind: "folder", folderId: "f5", name: "Renamed", at: 99 })
    assert.equal(items.filter((item) => item.kind === "folder" && item.folderId === "f5").length, 1)

    const file: RecentItem = { kind: "file", msgId: 7, ufid: "u7", name: "a.txt", parentFolderId: "root", at: 1 }
    const moved: RecentItem = { ...file, msgId: 8, parentFolderId: "f1", at: 2 }
    assert.deepEqual(pushRecentItem([file], moved), [moved], "same UFID is the same file")
})

test("recent items round-trip and ignore unknown versions or malformed entries", () => {
    const items: RecentItem[] = [
        { kind: "folder", folderId: "f1", name: "Docs", at: 1 },
        { kind: "file", msgId: 3, ufid: "u3", name: "a.txt", parentFolderId: "f1", at: 2 },
    ]
    assert.deepEqual(parseRecentItems(serializeRecentItems(items)), items)
    assert.deepEqual(parseRecentItems(JSON.stringify({ v: 2, items })), [])
    assert.deepEqual(parseRecentItems(JSON.stringify({ v: 1, items: [...items, { kind: "file", name: "x" }, null] })), items)
    assert.deepEqual(parseRecentItems("nope"), [])
    assert.deepEqual(parseRecentItems(null), [])
})

/* --------------------------------------------------- Search & shortcuts */

test("search scope defaults to everywhere at the root and to the folder inside one", () => {
    assert.equal(defaultSearchScope(true), "everywhere")
    assert.equal(defaultSearchScope(false), "folder")
})

test("locations read as folder trails and shorten deep paths", () => {
    assert.equal(formatLocation([]), "All files")
    assert.equal(formatLocation(["Synced Docs", "Projects"]), "Synced Docs › Projects")
    assert.equal(formatLocation(["Photos", "2024", "Trips", "Lisbon"]), "Photos › … › Trips › Lisbon")
})

test("location resolver walks parents once, prefers known folders, and survives cycles", async () => {
    const folders: Record<string, { folderId: string; name: string; parentFolderId?: string }> = {
        a: { folderId: "a", name: "A", parentFolderId: "tglfs-root" },
        b: { folderId: "b", name: "B", parentFolderId: "a" },
        c: { folderId: "c", name: "C", parentFolderId: "b" },
        x: { folderId: "x", name: "X", parentFolderId: "y" },
        y: { folderId: "y", name: "Y", parentFolderId: "x" },
    }
    const fetched: string[] = []
    const resolver = createLocationResolver({
        known: (id) => (id === "b" ? (folders.b as any) : undefined),
        fetch: async (id) => {
            fetched.push(id)
            return (folders[id] as any) ?? null
        },
    })
    assert.equal(resolver.cached("c"), undefined)
    assert.deepEqual(await resolver.trail("c"), ["A", "B", "C"])
    assert.deepEqual(await resolver.trail("c"), ["A", "B", "C"])
    assert.deepEqual(fetched.sort(), ["a", "c"])
    assert.deepEqual(resolver.cached("c"), ["A", "B", "C"])
    assert.deepEqual(resolver.cached("tglfs-root"), [])
    assert.equal(await resolver.trail("missing"), null)
    const cyclic = await resolver.trail("x")
    assert.ok(Array.isArray(cyclic) && cyclic.length <= 33)
})

test("the shortcut sheet lists the palette and paste shortcuts with platform modifiers", () => {
    const flatten = (apple: boolean) => shortcutGroups(apple).flatMap((group) => group.items)
    const palette = flatten(true).find((item) => item.label === "Command palette")
    assert.deepEqual(palette?.keys, [["⌘", "K"]])
    const paste = flatten(false).find((item) => item.label === "Paste files to upload")
    assert.deepEqual(paste?.keys, [["Ctrl", "V"]])
    assert.ok(flatten(false).some((item) => item.label === "Search" && item.keys[0][0] === "/"))
})
