import assert from "node:assert/strict"
import test from "node:test"

import {
    createTglfsFolder,
    createTglfsFolderManifest,
    serializeTglfsFolderEntriesJson,
    serializeTglfsFolderMessage,
} from "../src/folders.js"
import { serializeFileCardMessage } from "../src/shared/file-cards.js"

const history = await import("../../../src/web/folderHistory.ts")
const { buildFolderHistory, folderSnapshotAt, historyItemStateAt, historyPointIndexAt, diffSnapshots, folderRecordTextHasOnlyKnownFields } = history

const sec = (iso: string) => Date.parse(iso) / 1000
const ms = (iso: string) => Date.parse(iso)
const NOW = ms("2026-06-01T00:00:00.000Z")

// Folder v2 record exactly as the browser writes it (attachment-backed).
const CLIENT_FOLDER_V2 =
    'tglfs:folder\n{"type":"tglfs:folder","version":2,"folderId":"folder-client","parentFolderId":"tglfs-root","rootId":"folder-client","name":"Client Work","path":"","createdAt":"2026-04-20T09:15:00.000Z","updatedAt":"2026-05-08T12:00:00.000Z","deleted":false,"entriesRevision":7,"entriesHash":"sha256:00","entriesFileName":"tglfs-folder-folder-client-entries-r7.json"}'

// Child folder v2 record (live, renamed later: the parent entry was rewritten on 5 May).
const DRAFTS_V2 =
    'tglfs:folder\n{"type":"tglfs:folder","version":2,"folderId":"folder-drafts","parentFolderId":"folder-client","rootId":"folder-client","name":"Drafts","path":"Drafts","createdAt":"2026-04-21T14:05:00.000Z","updatedAt":"2026-05-05T09:00:00.000Z","deleted":false}'

// Deleted child folder, folder protocol v1 text record (tombstoned in place by tombstoneFolderTree).
const OLD_EXPORTS_V1_DELETED =
    'tglfs:folder\n{"type":"tglfs:folder","version":1,"folderId":"folder-old-exports","parentFolderId":"folder-client","rootId":"folder-client","name":"Old exports","path":"Old exports","createdAt":"2026-04-22T08:00:00.000Z","updatedAt":"2026-05-04T12:00:00.000Z","deleted":true}'

// A superseded text-only record (marked deleted when its v2 replacement was written) and that replacement,
// which has since been moved to another folder.
const SCANS_SUPERSEDED =
    'tglfs:folder\n{"type":"tglfs:folder","version":1,"folderId":"folder-scans","parentFolderId":"folder-client","rootId":"folder-client","name":"Scans","path":"Scans","createdAt":"2026-04-21T07:00:00.000Z","updatedAt":"2026-04-28T10:00:00.000Z","deleted":true}'
const SCANS_CURRENT =
    'tglfs:folder\n{"type":"tglfs:folder","version":2,"folderId":"folder-scans","parentFolderId":"folder-archive","rootId":"folder-archive","name":"Scans","path":"Scans","createdAt":"2026-04-21T07:00:00.000Z","updatedAt":"2026-05-01T10:00:00.000Z","deleted":false,"entriesRevision":1,"entriesHash":"sha256:01","entriesFileName":"tglfs-folder-folder-scans-entries-r1.json"}'

// A deleted folder whose record carries a field this client does not understand.
const WEIRD_DELETED =
    'tglfs:folder\n{"type":"tglfs:folder","version":2,"folderId":"folder-weird","parentFolderId":"folder-client","rootId":"folder-client","name":"Weird","path":"Weird","createdAt":"2026-04-24T08:00:00.000Z","updatedAt":"2026-04-30T08:00:00.000Z","deleted":true,"color":"red"}'

// Unknown future folder protocol version: must be ignored (fail closed).
const FUTURE_FOLDER =
    'tglfs:folder\n{"type":"tglfs:folder","version":3,"folderId":"folder-future","parentFolderId":"folder-client","name":"Future","path":"Future","createdAt":"2026-04-24T08:00:00.000Z","updatedAt":"2026-04-24T08:00:00.000Z","deleted":false}'

// Legacy v1 manifest written before compaction existed, so it still carries tombstones.
const CLIENT_MANIFEST_V1 = `tglfs:folder-manifest\n${JSON.stringify({
    type: "tglfs:folder-manifest",
    version: 1,
    folderId: "folder-client",
    rootId: "folder-client",
    path: "",
    createdAt: "2026-04-20T09:15:00.000Z",
    updatedAt: "2026-05-06T18:00:00.000Z",
    entries: {
        Drafts: { entryId: "e-drafts", name: "Drafts", path: "Drafts", kind: "folder", folderId: "folder-drafts", deleted: false, updatedAt: "2026-05-05T09:00:00.000Z" },
        "Invoice March.pdf": { entryId: "e-invoice", name: "Invoice March.pdf", path: "Invoice March.pdf", kind: "file", ufid: "ufid-invoice", size: 5000, mtimeMs: ms("2026-04-25T16:40:00.000Z"), mode: 420, deleted: false, updatedAt: "2026-04-25T16:40:00.000Z" },
        "Moodboard.jpg": { entryId: "e-mood", name: "Moodboard.jpg", path: "Moodboard.jpg", kind: "file", ufid: "ufid-mood", size: 800000, mtimeMs: ms("2026-04-22T11:00:00.000Z"), mode: 420, deleted: true, updatedAt: "2026-05-03T10:12:00.000Z" },
        "Contract draft.docx": { entryId: "e-contract", name: "Contract draft.docx", path: "Contract draft.docx", kind: "file", ufid: "ufid-contract", size: 32000, mtimeMs: ms("2026-04-23T09:30:00.000Z"), mode: 420, deleted: true, updatedAt: "2026-05-06T18:00:00.000Z" },
        "Notes.txt": { entryId: "e-notes", name: "Notes.txt", path: "Notes.txt", kind: "file", ufid: "ufid-notes", size: 900, mtimeMs: ms("2026-04-26T08:00:00.000Z"), mode: 420, deleted: false, updatedAt: "2026-04-26T08:00:00.000Z" },
        "Old exports": { entryId: "e-old", name: "Old exports", path: "Old exports", kind: "folder", folderId: "folder-old-exports", deleted: true, updatedAt: "2026-05-04T12:00:00.000Z" },
    },
})}`

const card = (name: string, ufid: string, parentFolderId: string, extra: Record<string, unknown> = {}) =>
    serializeFileCardMessage({ name, ufid, size: 1000, uploadComplete: true, chunks: [1], IV: "aXY=", parentFolderId, ...extra } as any)

function clientInput() {
    return {
        folderId: "folder-client",
        now: NOW,
        folder: { msgId: 100, date: sec("2026-04-20T09:15:00.000Z"), text: CLIENT_FOLDER_V2 },
        folderRecords: [
            { msgId: 210, date: sec("2026-04-21T14:05:00.000Z"), text: DRAFTS_V2 },
            { msgId: 220, date: sec("2026-04-22T08:00:00.000Z"), text: OLD_EXPORTS_V1_DELETED },
            { msgId: 300, date: sec("2026-04-21T07:00:00.000Z"), text: SCANS_SUPERSEDED },
            { msgId: 410, date: sec("2026-04-28T10:00:00.000Z"), text: SCANS_CURRENT },
            { msgId: 230, date: sec("2026-04-24T08:00:00.000Z"), text: WEIRD_DELETED },
            { msgId: 240, date: sec("2026-04-24T08:00:00.000Z"), text: FUTURE_FOLDER },
        ],
        fileCards: [
            // Uploaded directly (no folder entry): the message date is the upload time.
            { msgId: 501, date: sec("2026-04-20T09:20:00.000Z"), text: card("Brief.pdf", "ufid-brief", "folder-client") },
            // Uploaded in March, moved here on 25 April.
            { msgId: 502, date: sec("2026-03-31T10:00:00.000Z"), text: card("Invoice March.pdf", "ufid-invoice", "folder-client") },
            // Renamed after it was moved here; the entry still has the old name.
            { msgId: 503, date: sec("2026-04-26T08:00:00.000Z"), text: card("Meeting notes.txt", "ufid-notes", "folder-client") },
            // Uploaded later.
            { msgId: 504, date: sec("2026-05-08T12:00:00.000Z"), text: card("Final deliverable.zip", "ufid-final", "folder-client") },
            // Moved out to the archive folder (found by UFID lookup).
            { msgId: 505, date: sec("2026-04-23T09:00:00.000Z"), text: card("Contract draft.docx", "ufid-contract", "folder-archive") },
            // Orphaned card inside the deleted folder: not part of this folder.
            { msgId: 506, date: sec("2026-04-22T09:00:00.000Z"), text: card("export-01.csv", "ufid-export", "folder-old-exports") },
            // Malformed card: ignored.
            { msgId: 507, date: sec("2026-04-22T09:00:00.000Z"), text: 'tglfs:file\n{"name":"broken"' },
        ],
        manifests: [{ text: CLIENT_MANIFEST_V1, msgId: 700 }],
    }
}

function namesAt(result: ReturnType<typeof buildFolderHistory>, iso: string) {
    const snapshot = folderSnapshotAt(result, ms(iso))
    return {
        present: snapshot.filter((entry) => entry.state === "present").map((entry) => entry.item.name).sort(),
        uncertain: snapshot.filter((entry) => entry.state === "uncertain").map((entry) => entry.item.name).sort(),
        byName: new Map(snapshot.map((entry) => [entry.item.name, entry])),
    }
}

test("folder history: listing shortly after the folder was created", () => {
    const result = buildFolderHistory(clientInput())
    const at = namesAt(result, "2026-04-20T10:00:00.000Z")
    assert.deepEqual(at.present, ["Brief.pdf"])
    // A tombstoned entry whose card is gone has no recorded arrival time: shown as uncertain, never as fact.
    assert.deepEqual(at.uncertain, ["Moodboard.jpg"])
    assert.deepEqual(at.byName.get("Moodboard.jpg")?.annotations.sort(), ["arrival-unknown", "contents-gone", "deleted-later"])
})

test("folder history: listing in the middle of the history with tombstones, moves and renames", () => {
    const result = buildFolderHistory(clientInput())
    const at = namesAt(result, "2026-04-27T12:00:00.000Z")
    assert.deepEqual(at.present, [
        "Brief.pdf",
        "Contract draft.docx",
        "Drafts",
        "Invoice March.pdf",
        "Meeting notes.txt",
        "Old exports",
        "Weird",
    ])
    assert.deepEqual(at.uncertain, ["Moodboard.jpg", "Scans"])
    assert.deepEqual(at.byName.get("Old exports")?.annotations, ["deleted-later"])
    assert.deepEqual(at.byName.get("Contract draft.docx")?.annotations, ["moved-out-later"])
    assert.deepEqual(at.byName.get("Meeting notes.txt")?.annotations, ["renamed"])
    assert.deepEqual(at.byName.get("Meeting notes.txt")?.item.formerNames, ["Notes.txt"])
    assert.deepEqual(at.byName.get("Scans")?.annotations, ["removed-unknown", "arrival-unknown"])
    // The future-version folder record and the malformed file card are ignored, not guessed at.
    assert.equal(at.byName.has("Future"), false)
    assert.ok(result.skipped >= 2)
})

test("folder history: entries moved in are absent before their move time", () => {
    const result = buildFolderHistory(clientInput())
    const invoice = result.items.find((item) => item.name === "Invoice March.pdf")!
    assert.equal(invoice.arrival, "moved-in")
    assert.equal(invoice.arrivalExact, true)
    assert.equal(invoice.presentFrom, ms("2026-04-25T16:40:00.000Z"))
    // The browser writes the move time into mtimeMs, so the arrival is exact: absent just before it.
    assert.equal(historyItemStateAt(invoice, ms("2026-04-25T16:39:00.000Z"), NOW), "absent")
    assert.equal(historyItemStateAt(invoice, ms("2026-03-30T00:00:00.000Z"), NOW), "absent")
    assert.equal(historyItemStateAt(invoice, ms("2026-04-25T16:40:00.000Z"), NOW), "present")
})

test("folder history: listing after the deletions and at now", () => {
    const result = buildFolderHistory(clientInput())
    const at = namesAt(result, "2026-05-07T00:00:00.000Z")
    assert.deepEqual(at.present, ["Brief.pdf", "Drafts", "Invoice March.pdf", "Meeting notes.txt"])
    assert.deepEqual(at.uncertain, ["Scans"])
    const now = folderSnapshotAt(result, NOW)
    assert.deepEqual(now.map((entry) => entry.item.name).sort(), [
        "Brief.pdf",
        "Drafts",
        "Final deliverable.zip",
        "Invoice March.pdf",
        "Meeting notes.txt",
    ])
    assert.ok(now.every((entry) => entry.state === "present"))
})

test("folder history: deleted folders are restorable only when their record is fully understood", () => {
    const result = buildFolderHistory(clientInput())
    const oldExports = result.items.find((item) => item.folderId === "folder-old-exports")!
    assert.equal(oldExports.status, "deleted")
    assert.equal(oldExports.removedAt, ms("2026-05-04T12:00:00.000Z"))
    assert.equal(oldExports.contentsStored, true)
    assert.equal(oldExports.restorable, true)
    assert.equal(oldExports.msgId, 220)

    const weird = result.items.find((item) => item.folderId === "folder-weird")!
    assert.equal(weird.status, "deleted")
    assert.equal(weird.restorable, false)
    assert.match(weird.restoreBlockedReason ?? "", /does not understand/)

    const moodboard = result.items.find((item) => item.ufid === "ufid-mood")!
    assert.equal(moodboard.status, "gone")
    assert.equal(moodboard.contentsStored, false)
    assert.equal(moodboard.restorable, false)

    const contract = result.items.find((item) => item.ufid === "ufid-contract")!
    assert.equal(contract.status, "moved-out")
    assert.equal(contract.movedToFolderId, "folder-archive")
    assert.equal(contract.contentsStored, true)
})

test("folder history: superseded folder records are not mistaken for deletions", () => {
    const result = buildFolderHistory(clientInput())
    const scans = result.items.find((item) => item.folderId === "folder-scans")!
    assert.equal(scans.status, "moved-out")
    assert.equal(scans.movedToFolderId, "folder-archive")
    assert.equal(scans.removedAt, null)
    assert.equal(scans.lastSeenAt, ms("2026-04-28T10:00:00.000Z"))
    assert.equal(scans.restorable, false)
})

test("folder history: timeline points carry added, removed and changed events in order", () => {
    const result = buildFolderHistory(clientInput())
    assert.equal(result.createdAt, ms("2026-04-20T09:15:00.000Z"))
    const first = result.points[0]
    assert.equal(first.at, ms("2026-04-20T09:15:00.000Z"))
    assert.equal(first.changes[0].type, "created")
    const last = result.points[result.points.length - 1]
    assert.equal(last.isNow, true)
    assert.equal(last.at, NOW)
    const times = result.points.map((point) => point.at)
    assert.deepEqual(times, [...times].sort((a, b) => a - b))

    const deletion = result.points.find((point) => point.at === ms("2026-05-04T12:00:00.000Z"))!
    assert.deepEqual(deletion.changes.map((change) => [change.type, change.name, change.detail]), [["removed", "Old exports", "deleted"]])
    const rename = result.points.find((point) => point.at === ms("2026-05-05T09:00:00.000Z"))!
    assert.deepEqual(rename.changes.map((change) => [change.type, change.name]), [["changed", "Drafts"]])
    const move = result.points.find((point) => point.at === ms("2026-04-25T16:40:00.000Z"))!
    assert.deepEqual(move.changes.map((change) => [change.type, change.name, change.detail, change.approximate]), [["added", "Invoice March.pdf", "moved here", false]])

    assert.equal(historyPointIndexAt(result, ms("2026-05-04T13:00:00.000Z")), result.points.indexOf(deletion))
    const diff = diffSnapshots(result, ms("2026-04-27T12:00:00.000Z"), ms("2026-05-07T00:00:00.000Z"))
    assert.deepEqual(diff.added, [])
    assert.deepEqual(diff.removed.sort(), ["entry-file:ufid-contract", "folder:folder-old-exports", "folder:folder-weird"])
})

test("folder history: v2 entries attachments merge with older legacy manifest snapshots", () => {
    const folder = createTglfsFolder({ folderId: "folder-a", parentFolderId: "tglfs-root", rootId: "folder-a", name: "A", path: "", now: "2026-04-01T00:00:00.000Z" })
    const current = createTglfsFolderManifest({
        folderId: "folder-a",
        rootId: "folder-a",
        path: "",
        now: "2026-05-01T00:00:00.000Z",
        entries: {
            "b.txt": { entryId: "e-b", name: "b.txt", path: "b.txt", kind: "file", ufid: "ufid-b", size: 1, mtimeMs: ms("2026-04-10T00:00:00.000Z"), mode: 420, deleted: false, updatedAt: "2026-05-01T00:00:00.000Z" },
        },
    })
    current.revision = 3
    const legacy = `tglfs:folder-manifest\n${JSON.stringify({
        type: "tglfs:folder-manifest",
        version: 1,
        folderId: "folder-a",
        path: "",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
        entries: {
            "a.txt": { entryId: "e-a", name: "a.txt", path: "a.txt", kind: "file", ufid: "ufid-b", size: 1, mtimeMs: ms("2026-04-10T00:00:00.000Z"), mode: 420, deleted: false, updatedAt: "2026-04-10T00:00:00.000Z" },
        },
    })}`
    const result = buildFolderHistory({
        folderId: "folder-a",
        now: NOW,
        folder: { msgId: 1, date: sec("2026-04-01T00:00:00.000Z"), text: serializeTglfsFolderMessage(folder) },
        fileCards: [{ msgId: 2, date: sec("2026-04-02T00:00:00.000Z"), text: card("b.txt", "ufid-b", "folder-a") }],
        manifests: [{ text: serializeTglfsFolderEntriesJson(current) }, { text: legacy, msgId: 9 }],
    })
    assert.equal(result.items.length, 1)
    const item = result.items[0]
    assert.equal(item.name, "b.txt")
    assert.deepEqual(item.formerNames, ["a.txt"])
    assert.equal(item.arrival, "moved-in")
    assert.equal(item.presentFrom, ms("2026-04-10T00:00:00.000Z"))
    assert.equal(item.changedAt, ms("2026-05-01T00:00:00.000Z"))
})

test("folder history: an old tombstone plus a newer entry keeps the earlier stint and the gap", () => {
    // After the browser moves a file back (or restores a folder), the current v2 entries hold the new
    // arrival while the older legacy manifest still holds the tombstone of the first departure.
    const current = createTglfsFolderManifest({
        folderId: "folder-client",
        rootId: "folder-client",
        path: "",
        now: "2026-05-20T10:00:00.000Z",
        entries: {
            "Contract draft.docx": { entryId: "e-contract-2", name: "Contract draft.docx", path: "Contract draft.docx", kind: "file", ufid: "ufid-contract", size: 32000, mtimeMs: ms("2026-05-20T10:00:00.000Z"), mode: 420, deleted: false, updatedAt: "2026-05-20T10:00:00.000Z" },
            "Old exports": { entryId: "e-old-2", name: "Old exports", path: "Old exports", kind: "folder", folderId: "folder-old-exports", deleted: false, updatedAt: "2026-05-20T10:00:00.000Z" },
        },
    })
    current.revision = 8
    const restoredOldExports = OLD_EXPORTS_V1_DELETED.replace('"deleted":true', '"deleted":false').replace("2026-05-04T12:00:00.000Z", "2026-05-20T10:00:00.000Z")
    const result = buildFolderHistory({
        folderId: "folder-client",
        now: NOW,
        folder: { msgId: 100, date: sec("2026-04-20T09:15:00.000Z"), text: CLIENT_FOLDER_V2 },
        folderRecords: [{ msgId: 220, date: sec("2026-04-22T08:00:00.000Z"), text: restoredOldExports }],
        fileCards: [{ msgId: 505, date: sec("2026-04-23T09:00:00.000Z"), text: card("Contract draft.docx", "ufid-contract", "folder-client") }],
        manifests: [{ text: serializeTglfsFolderEntriesJson(current) }, { text: CLIENT_MANIFEST_V1, msgId: 700 }],
    })
    const state = (key: string, iso: string) => {
        const item = result.items.find((candidate) => candidate.key === key)!
        return historyItemStateAt(item, ms(iso), NOW)
    }
    // File: here 23 Apr 09:30 → 6 May 18:00, away, back 20 May.
    assert.equal(state("file:505:earlier", "2026-04-27T00:00:00.000Z"), "present")
    assert.equal(state("file:505", "2026-04-27T00:00:00.000Z"), "absent")
    assert.equal(state("file:505:earlier", "2026-05-10T00:00:00.000Z"), "absent")
    assert.equal(state("file:505", "2026-05-10T00:00:00.000Z"), "absent")
    assert.equal(state("file:505", "2026-05-21T00:00:00.000Z"), "present")
    // Folder: here since 22 Apr, deleted 4 May, back by 20 May (exact return time unknown: uncertain gap).
    assert.equal(state("folder:folder-old-exports:earlier", "2026-04-27T00:00:00.000Z"), "present")
    assert.equal(state("folder:folder-old-exports", "2026-04-27T00:00:00.000Z"), "absent")
    assert.equal(state("folder:folder-old-exports:earlier", "2026-05-10T00:00:00.000Z"), "absent")
    assert.equal(state("folder:folder-old-exports", "2026-05-10T00:00:00.000Z"), "uncertain")
    assert.equal(state("folder:folder-old-exports", "2026-05-21T00:00:00.000Z"), "present")
    const back = result.points.find((point) => point.at === ms("2026-05-20T10:00:00.000Z"))!
    assert.deepEqual(back.changes.map((change) => [change.name, change.detail]).sort(), [
        ["Contract draft.docx", "moved here"],
        ["Old exports", "restored or moved back"],
    ])
})

test("folder history: root view uses folder records and file cards without a manifest", () => {
    const root = (name: string, folderId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
        `tglfs:folder\n${JSON.stringify({ type: "tglfs:folder", version: 2, folderId, parentFolderId: "tglfs-root", rootId: folderId, name, path: "", createdAt, updatedAt: createdAt, deleted: false, ...extra })}`
    const result = buildFolderHistory({
        folderId: null,
        now: NOW,
        folderRecords: [
            { msgId: 10, date: sec("2026-04-01T00:00:00.000Z"), text: root("Photos", "f-photos", "2026-04-01T00:00:00.000Z") },
            { msgId: 11, date: sec("2026-04-05T00:00:00.000Z"), text: root("Temp", "f-temp", "2026-04-05T00:00:00.000Z", { deleted: true, updatedAt: "2026-04-09T00:00:00.000Z" }) },
            // Children of other folders are ignored.
            { msgId: 12, date: sec("2026-04-05T00:00:00.000Z"), text: DRAFTS_V2 },
        ],
        fileCards: [
            { msgId: 20, date: sec("2026-04-03T00:00:00.000Z"), text: card("loose.txt", "ufid-loose", "tglfs-root") },
            // Unversioned v1 card without a parent: not shown at the root, same as the live browser.
            { msgId: 21, date: sec("2026-04-03T00:00:00.000Z"), text: 'tglfs:file\n{"name":"v1.txt","ufid":"u1","size":10,"uploadComplete":true,"chunks":[1],"IV":"iv"}' },
        ],
        manifests: [{ text: CLIENT_MANIFEST_V1 }],
    })
    assert.equal(result.createdAt, null)
    assert.deepEqual(namesAt(result, "2026-04-06T00:00:00.000Z").present, ["Photos", "Temp", "loose.txt"])
    assert.deepEqual(namesAt(result, "2026-04-10T00:00:00.000Z").present, ["Photos", "loose.txt"])
    assert.deepEqual(namesAt(result, "2026-04-02T00:00:00.000Z").present, ["Photos"])
    const temp = result.items.find((item) => item.name === "Temp")!
    assert.equal(temp.restorable, true)
})

test("folder history: malformed and unknown input never throws and fails closed", () => {
    const garbage: unknown[] = [
        null,
        undefined,
        42,
        "nope",
        {},
        { folderId: 7, folderRecords: "x", fileCards: {}, manifests: 3 },
        { folderId: "f", folderRecords: [null, 1, { msgId: "x" }, { msgId: 1, text: 5 }, { msgId: 2, text: "tglfs:folder\n{" }] },
        { folderId: "f", fileCards: [null, { msgId: 1, data: { name: 3 } }, { msgId: 2, text: "tglfs:file\nnot json" }] },
        {
            folderId: "f",
            manifests: [
                null,
                { text: "{" },
                { text: '{"type":"tglfs:folder-entries","version":3,"folderId":"f","path":"","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","entries":{}}' },
                { data: { type: "tglfs:folder-manifest", version: 1, folderId: "f", path: "", createdAt: "x", updatedAt: "y", entries: {} } },
                // One malformed entry rejects the whole manifest (fail closed), it is not partially trusted.
                { data: { type: "tglfs:folder-manifest", version: 1, folderId: "f", path: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", entries: { "a.txt": { entryId: "e", name: "a.txt", path: "a.txt", kind: "file", ufid: "u", deleted: false, updatedAt: "2026-01-01T00:00:00.000Z" } } } },
            ],
        },
    ]
    for (const input of garbage) {
        const result = buildFolderHistory(input as any)
        assert.ok(Array.isArray(result.items))
        assert.equal(result.items.length, 0)
        assert.ok(result.points.length >= 1)
        assert.equal(result.points[result.points.length - 1].isNow, true)
        assert.deepEqual(folderSnapshotAt(result, 0), [])
    }
    const manifestFailures = buildFolderHistory(garbage[8] as any)
    assert.equal(manifestFailures.skipped, 5)
    assert.ok(manifestFailures.warnings.length > 0)
})

test("folder record unknown-field check refuses records it cannot preserve", () => {
    assert.equal(folderRecordTextHasOnlyKnownFields(DRAFTS_V2), true)
    assert.equal(folderRecordTextHasOnlyKnownFields(CLIENT_FOLDER_V2), true)
    assert.equal(folderRecordTextHasOnlyKnownFields(WEIRD_DELETED), false)
    assert.equal(folderRecordTextHasOnlyKnownFields("tglfs:folder\n{"), false)
    assert.equal(folderRecordTextHasOnlyKnownFields("tglfs:folder\n[1,2]"), false)
    assert.equal(folderRecordTextHasOnlyKnownFields(undefined), false)
})
