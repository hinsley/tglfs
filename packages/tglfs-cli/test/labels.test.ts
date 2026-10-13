import assert from "node:assert/strict"
import { test } from "node:test"

import {
    LABELS_BACKUP_SUFFIX,
    LABELS_DOCUMENT_TYPE,
    LABELS_DOCUMENT_VERSION,
    applyTagChanges,
    createLabelStore,
    createLabelsDocument,
    createTag,
    deleteTag,
    forgetItems,
    getItem,
    isStarred,
    itemTagIds,
    keysWithTag,
    labelItemKey,
    labelsStorageKey,
    listTags,
    mergeImportedLabels,
    normalizeTagName,
    parseLabelsDocument,
    recolorTag,
    renameTag,
    serializeLabelsDocument,
    setStarred,
    starredKeys,
    updateNameHints,
    type LabelStorage,
    type LabelsDocument,
} from "../../../src/web/labels.ts"

const NOW = "2026-10-13T12:00:00.000Z"
const LATER = "2026-10-13T12:05:00.000Z"

function memoryStorage(initial: Record<string, string> = {}): LabelStorage & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial))
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value)
        },
        removeItem: (key) => {
            data.delete(key)
        },
    }
}

/** A real v1 document as written by this client (fixture). */
const V1_FIXTURE = JSON.stringify({
    type: "tglfs:local-labels",
    version: 1,
    accountKey: "user:42",
    updatedAt: "2026-10-01T08:00:00.000Z",
    tags: {
        "tag-travel": { name: "Travel", color: "blue", createdAt: "2026-10-01T08:00:00.000Z" },
        "tag-work": { name: "Work", color: "green", createdAt: "2026-10-01T08:00:00.000Z" },
    },
    items: {
        "file:ufid-lisbon": {
            kind: "file",
            id: "ufid-lisbon",
            starred: true,
            starredAt: "2026-10-01T08:00:00.000Z",
            tags: ["tag-travel"],
            name: "Lisbon.jpg",
            updatedAt: "2026-10-01T08:00:00.000Z",
        },
        "folder:folder-projects": {
            kind: "folder",
            id: "folder-projects",
            tags: ["tag-work", "tag-travel"],
            name: "Projects",
            updatedAt: "2026-10-01T08:00:00.000Z",
        },
    },
})

function okDoc(text: string, accountKey?: string): LabelsDocument {
    const parsed = parseLabelsDocument(text, accountKey)
    assert.equal(parsed.status, "ok")
    return (parsed as { status: "ok"; doc: LabelsDocument }).doc
}

test("v1 fixture parses with stars, tags and counts", () => {
    const doc = okDoc(V1_FIXTURE, "user:42")
    assert.deepEqual(starredKeys(doc), ["file:ufid-lisbon"])
    assert.deepEqual(itemTagIds(doc, "folder:folder-projects"), ["tag-work", "tag-travel"])
    assert.deepEqual(
        listTags(doc).map((tag) => [tag.name, tag.color, tag.count]),
        [["Travel", "blue", 2], ["Work", "green", 1]],
    )
    assert.deepEqual(keysWithTag(doc, "tag-travel").sort(), ["file:ufid-lisbon", "folder:folder-projects"])
})

test("serialize then parse round-trips a document built through mutations", () => {
    let doc = createLabelsDocument("user:7", NOW)
    doc = setStarred(doc, [{ key: labelItemKey("file", "u1"), name: "a.txt" }, { key: "folder:f1", name: "Docs" }], true, NOW)
    const created = createTag(doc, "  #Road   trip ", { now: NOW, id: "t1" })
    assert.ok(created)
    assert.equal(created.created, true)
    doc = applyTagChanges(created.doc, [{ key: "file:u1" }], { add: [created.id] }, NOW)

    const reparsed = okDoc(serializeLabelsDocument(doc), "user:7")
    assert.deepEqual(reparsed, doc)
    assert.equal(reparsed.type, LABELS_DOCUMENT_TYPE)
    assert.equal(reparsed.version, LABELS_DOCUMENT_VERSION)
    assert.equal(listTags(reparsed)[0].name, "Road trip")
    assert.ok(isStarred(reparsed, "folder:f1"))
    assert.deepEqual(itemTagIds(reparsed, "file:u1"), ["t1"])
    assert.equal(getItem(reparsed, "file:u1")?.name, "a.txt")
})

test("malformed documents are reported, not interpreted", () => {
    assert.deepEqual(parseLabelsDocument(null), { status: "empty" })
    assert.equal(parseLabelsDocument("{not json").status, "malformed")
    assert.equal(parseLabelsDocument("[]").status, "malformed")
    assert.equal(parseLabelsDocument(JSON.stringify({ type: "tglfs:file", version: 1, accountKey: "a" })).status, "malformed")
    assert.equal(parseLabelsDocument(JSON.stringify({ type: LABELS_DOCUMENT_TYPE, version: "1", accountKey: "a" })).status, "malformed")
    assert.equal(parseLabelsDocument(JSON.stringify({ type: LABELS_DOCUMENT_TYPE, version: 0, accountKey: "a" })).status, "malformed")
    assert.equal(parseLabelsDocument(JSON.stringify({ type: LABELS_DOCUMENT_TYPE, version: 1 })).status, "malformed")
    assert.equal(parseLabelsDocument(JSON.stringify({ type: LABELS_DOCUMENT_TYPE, version: 1, accountKey: "a", items: [] })).status, "malformed")
})

test("malformed tags and items are ignored for reading but preserved verbatim on write", () => {
    const text = JSON.stringify({
        type: LABELS_DOCUMENT_TYPE,
        version: 1,
        accountKey: "a",
        tags: { good: { name: "Good", color: "red" }, bad: { name: 5 }, blank: { name: "   ", color: "red" } },
        items: {
            "file:ok": { kind: "file", id: "ok", starred: true, tags: ["good", "bad", "nope"] },
            "file:mismatch": { kind: "folder", id: "mismatch", starred: true },
            "weird-key": { kind: "file", id: "x", starred: true },
            "file:badstar": { kind: "file", id: "badstar", starred: "yes" },
        },
    })
    const doc = okDoc(text, "a")
    assert.deepEqual(starredKeys(doc), ["file:ok"])
    assert.deepEqual(itemTagIds(doc, "file:ok"), ["good"])
    assert.deepEqual(listTags(doc).map((tag) => tag.id), ["good"])

    const next = setStarred(doc, [{ key: "folder:new" }], true, NOW)
    const written = JSON.parse(serializeLabelsDocument(next))
    assert.deepEqual(written.tags.bad, { name: 5 })
    assert.deepEqual(written.items["weird-key"], { kind: "file", id: "x", starred: true })
    assert.deepEqual(written.items["file:badstar"], { kind: "file", id: "badstar", starred: "yes" })
    assert.equal(written.items["folder:new"].starred, true)
})

test("unknown future versions are refused and never overwritten", () => {
    const future = JSON.stringify({ type: LABELS_DOCUMENT_TYPE, version: 2, accountKey: "user:1", stars: ["x"], items: {} })
    assert.deepEqual(parseLabelsDocument(future), { status: "unsupported", reason: "future-version", version: 2 })

    const storage = memoryStorage({ [labelsStorageKey("user:1")]: future })
    const store = createLabelStore({ storage, accountKey: "user:1", now: () => NOW })
    assert.equal(store.status(), "unsupported")
    assert.match(store.takeNotice() ?? "", /newer version/)
    assert.deepEqual(starredKeys(store.doc()), [])
    assert.equal(store.update((doc, now) => setStarred(doc, [{ key: "file:a" }], true, now)), false)
    assert.equal(storage.data.get(labelsStorageKey("user:1")), future)
    // Export hands back the stored document untouched so nothing is lost.
    assert.equal(store.exportText(), future)

    const merged = mergeImportedLabels(createLabelsDocument("user:1"), future, { now: NOW, newId: () => "t" })
    assert.deepEqual(merged, { ok: false, error: "future-version" })
})

test("unknown fields on the document, tags and items survive edits", () => {
    const text = JSON.stringify({
        type: LABELS_DOCUMENT_TYPE,
        version: 1,
        accountKey: "a",
        futureTopLevel: { keep: true },
        tags: { t1: { name: "Keep", color: "teal", emoji: "🌴" } },
        items: { "file:u": { kind: "file", id: "u", starred: true, tags: ["t1"], pinnedAt: 123 } },
    })
    let doc = okDoc(text, "a")
    doc = setStarred(doc, [{ key: "file:u" }], false, NOW)
    doc = applyTagChanges(doc, [{ key: "file:u" }], { remove: ["t1"] }, NOW)
    const renamed = renameTag(doc, "t1", "Kept", NOW)
    assert.ok(renamed.ok)
    doc = recolorTag(renamed.doc, "t1", "pink", NOW)

    const written = JSON.parse(serializeLabelsDocument(doc))
    assert.deepEqual(written.futureTopLevel, { keep: true })
    assert.equal(written.tags.t1.emoji, "🌴")
    assert.equal(written.tags.t1.name, "Kept")
    assert.equal(written.tags.t1.color, "pink")
    // The item has no labels left but carries an unknown field, so it is kept rather than dropped.
    assert.equal(written.items["file:u"].pinnedAt, 123)
    assert.equal(written.items["file:u"].starred, undefined)
    assert.equal(written.items["file:u"].tags, undefined)
})

test("items without labels or unknown fields are dropped", () => {
    let doc = setStarred(createLabelsDocument("a"), [{ key: "file:u" }], true, NOW)
    doc = setStarred(doc, [{ key: "file:u" }], false, LATER)
    assert.equal(doc.items["file:u"], undefined)
})

test("starring twice keeps the original starredAt", () => {
    let doc = setStarred(createLabelsDocument("a"), [{ key: "file:u" }], true, NOW)
    doc = setStarred(doc, [{ key: "file:u" }], true, LATER)
    assert.equal(getItem(doc, "file:u")?.starredAt, NOW)
})

test("tag names are normalized and unique case-insensitively", () => {
    assert.equal(normalizeTagName("  #Travel  plans "), "Travel plans")
    assert.equal(normalizeTagName(""), null)
    assert.equal(normalizeTagName("a\u0001b"), null)
    assert.equal(normalizeTagName("x".repeat(49)), null)
    let doc = createLabelsDocument("a")
    const first = createTag(doc, "Travel", { now: NOW, id: "t1" })!
    doc = first.doc
    const again = createTag(doc, "travel", { now: NOW, id: "t2" })!
    assert.equal(again.created, false)
    assert.equal(again.id, "t1")
    const other = createTag(doc, "Work", { now: NOW, id: "t2" })!
    doc = other.doc
    assert.deepEqual(renameTag(doc, "t2", "TRAVEL", NOW), { ok: false, error: "duplicate" })
    assert.deepEqual(renameTag(doc, "t2", "  ", NOW), { ok: false, error: "invalid" })
    assert.ok(renameTag(doc, "t1", "travel", NOW).ok, "changing only the case of its own name is allowed")
})

test("new tags get distinct palette colours until the palette is used up", () => {
    let doc = createLabelsDocument("a")
    const colors: string[] = []
    for (let index = 0; index < 4; index++) {
        const created = createTag(doc, `Tag ${index}`, { now: NOW, id: `t${index}` })!
        doc = created.doc
        colors.push(listTags(doc).find((tag) => tag.id === created.id)!.color)
    }
    assert.equal(new Set(colors).size, 4)
})

test("deleting a tag removes it from every item", () => {
    let doc = okDoc(V1_FIXTURE, "user:42")
    doc = deleteTag(doc, "tag-travel", NOW)
    assert.equal(doc.tags["tag-travel"], undefined)
    assert.deepEqual(itemTagIds(doc, "folder:folder-projects"), ["tag-work"])
    assert.deepEqual(getItem(doc, "file:ufid-lisbon")?.tags, undefined)
    assert.ok(isStarred(doc, "file:ufid-lisbon"))
})

test("forgetting items removes all of their labels", () => {
    let doc = okDoc(V1_FIXTURE, "user:42")
    doc = forgetItems(doc, ["file:ufid-lisbon", "file:not-there"], NOW)
    assert.equal(getItem(doc, "file:ufid-lisbon"), null)
    assert.ok(getItem(doc, "folder:folder-projects"))
    assert.equal(forgetItems(doc, ["file:nothing"], NOW), doc)
})

test("name hints update only labelled items", () => {
    const doc = okDoc(V1_FIXTURE, "user:42")
    const next = updateNameHints(doc, new Map([["file:ufid-lisbon", "Lisbon sunset.jpg"], ["file:unknown", "x"]]))
    assert.equal(getItem(next, "file:ufid-lisbon")?.name, "Lisbon sunset.jpg")
    assert.equal(next.items["file:unknown"], undefined)
    assert.equal(updateNameHints(next, new Map([["file:ufid-lisbon", "Lisbon sunset.jpg"]])), next)
})

test("import merges stars and tags by name without removing anything", () => {
    let local = createLabelsDocument("user:42")
    const travel = createTag(local, "travel", { now: NOW, id: "local-travel", color: "red" })!
    local = setStarred(travel.doc, [{ key: "file:mine", name: "mine.txt" }], true, NOW)
    local = applyTagChanges(local, [{ key: "file:ufid-lisbon" }], { add: ["local-travel"] }, NOW)

    let counter = 0
    const result = mergeImportedLabels(local, V1_FIXTURE, { now: LATER, newId: () => `new-${counter++}` })
    assert.ok(result.ok)
    const merged = result.doc
    assert.deepEqual(result.summary, {
        starsAdded: 1,
        tagsCreated: 1,
        tagAssignmentsAdded: 2,
        itemsTouched: 2,
        skipped: 0,
        otherAccount: false,
    })
    // Existing "travel" tag is reused (local colour wins), "Work" is created.
    const tags = listTags(merged)
    assert.deepEqual(tags.map((tag) => [tag.name, tag.color]), [["travel", "red"], ["Work", "green"]])
    assert.ok(isStarred(merged, "file:mine"))
    assert.ok(isStarred(merged, "file:ufid-lisbon"))
    assert.deepEqual(itemTagIds(merged, "file:ufid-lisbon"), ["local-travel"])
    const workId = tags.find((tag) => tag.name === "Work")!.id
    assert.deepEqual(itemTagIds(merged, "folder:folder-projects").sort(), ["local-travel", workId].sort())
    assert.equal(getItem(merged, "folder:folder-projects")?.name, "Projects")

    const again = mergeImportedLabels(merged, V1_FIXTURE, { now: LATER, newId: () => `new-${counter++}` })
    assert.ok(again.ok)
    assert.equal(again.summary.starsAdded + again.summary.tagsCreated + again.summary.tagAssignmentsAdded, 0)
    assert.deepEqual(mergeImportedLabels(merged, "nope", { now: LATER, newId: () => "x" }), { ok: false, error: "malformed" })
})

test("import from another account is allowed and flagged", () => {
    const result = mergeImportedLabels(createLabelsDocument("user:99"), V1_FIXTURE, { now: NOW, newId: () => "t" })
    assert.ok(result.ok)
    assert.equal(result.summary.otherAccount, true)
})

test("stores are isolated per account", () => {
    const storage = memoryStorage()
    const alice = createLabelStore({ storage, accountKey: "user:1", now: () => NOW })
    const bob = createLabelStore({ storage, accountKey: "user:2", now: () => NOW })
    assert.ok(alice.update((doc, now) => setStarred(doc, [{ key: "file:shared-ufid" }], true, now)))
    assert.ok(isStarred(alice.doc(), "file:shared-ufid"))
    assert.equal(isStarred(bob.doc(), "file:shared-ufid"), false)
    bob.reload()
    assert.equal(isStarred(bob.doc(), "file:shared-ufid"), false)
    assert.deepEqual([...storage.data.keys()].sort(), [labelsStorageKey("user:1")])
    const stored = JSON.parse(storage.data.get(labelsStorageKey("user:1"))!)
    assert.equal(stored.accountKey, "user:1")

    // A document filed under the wrong account key is refused rather than adopted.
    storage.data.set(labelsStorageKey("user:3"), storage.data.get(labelsStorageKey("user:1"))!)
    const carol = createLabelStore({ storage, accountKey: "user:3", now: () => NOW })
    assert.equal(carol.status(), "unsupported")
    assert.deepEqual(starredKeys(carol.doc()), [])
})

test("the store re-reads storage before writing so other tabs' changes are kept", () => {
    const storage = memoryStorage()
    const tabA = createLabelStore({ storage, accountKey: "u", now: () => NOW })
    const tabB = createLabelStore({ storage, accountKey: "u", now: () => NOW })
    tabA.update((doc, now) => setStarred(doc, [{ key: "file:a" }], true, now))
    tabB.update((doc, now) => setStarred(doc, [{ key: "file:b" }], true, now))
    tabA.reload()
    assert.deepEqual(starredKeys(tabA.doc()).sort(), ["file:a", "file:b"])
})

test("a malformed stored document is backed up before starting fresh", () => {
    const key = labelsStorageKey("u")
    const storage = memoryStorage({ [key]: "{definitely not json" })
    const store = createLabelStore({ storage, accountKey: "u", now: () => NOW })
    assert.equal(store.status(), "ok")
    assert.match(store.takeNotice() ?? "", /backup/)
    assert.equal(storage.data.get(`${key}${LABELS_BACKUP_SUFFIX}`), "{definitely not json")
    assert.equal(parseLabelsDocument(storage.data.get(key)!, "u").status, "ok")
    // Loading again neither backs up twice nor reports anything.
    const again = createLabelStore({ storage, accountKey: "u", now: () => NOW })
    assert.equal(again.takeNotice(), null)
    assert.equal([...storage.data.keys()].filter((name) => name.includes(LABELS_BACKUP_SUFFIX)).length, 1)
})

test("store notifies subscribers and works without storage", () => {
    const store = createLabelStore({ storage: null, accountKey: "u", now: () => NOW })
    let calls = 0
    const unsubscribe = store.subscribe(() => calls++)
    assert.ok(store.update((doc, now) => setStarred(doc, [{ key: "folder:f" }], true, now)))
    assert.equal(calls, 1)
    assert.ok(isStarred(store.doc(), "folder:f"))
    unsubscribe()
    store.update((doc, now) => setStarred(doc, [{ key: "folder:g" }], true, now))
    assert.equal(calls, 1)
    const exported = JSON.parse(store.exportText())
    assert.equal(exported.type, LABELS_DOCUMENT_TYPE)
    assert.equal(exported.exportedAt, NOW)
})
