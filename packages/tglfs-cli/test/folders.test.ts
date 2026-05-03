import assert from "node:assert/strict"
import test from "node:test"

import {
    compactTglfsFolderManifest,
    createTglfsFolder,
    createTglfsFolderManifest,
    parseTglfsFolderEntriesJson,
    parseTglfsFolderManifestMessage,
    parseTglfsFolderMessage,
    serializeTglfsFolderEntriesJson,
    serializeTglfsFolderManifestMessage,
    serializeTglfsFolderMessage,
} from "../src/folders.js"

test("folder v2 messages parse successfully", () => {
    const folder = createTglfsFolder({
        folderId: "folder-1",
        rootId: "root-1",
        name: "Documents",
        path: "",
        now: "2026-05-02T12:00:00.000Z",
    })

    assert.deepEqual(parseTglfsFolderMessage(serializeTglfsFolderMessage(folder)), folder)
})

test("folder entries v2 json uses the global folder protocol version", () => {
    const manifest = createTglfsFolderManifest({
        folderId: "folder-1",
        rootId: "root-1",
        path: "",
        now: "2026-05-02T12:00:00.000Z",
        entries: {
            Notes: {
                entryId: "entry-folder",
                name: "Notes",
                path: "Notes",
                kind: "folder",
                folderId: "folder-2",
                deleted: false,
                updatedAt: "2026-05-02T12:00:00.000Z",
            },
            "a.txt": {
                entryId: "entry-file",
                name: "a.txt",
                path: "a.txt",
                kind: "file",
                ufid: "ufid-a",
                size: 1,
                mtimeMs: 2,
                mode: 0o644,
                deleted: false,
                updatedAt: "2026-05-02T12:00:00.000Z",
            },
        },
    })

    assert.equal(manifest.version, 2)
    assert.deepEqual(parseTglfsFolderEntriesJson(serializeTglfsFolderEntriesJson(manifest)), manifest)
})

test("folder manifest v1 messages still parse file and folder entries", () => {
    const manifest = {
        type: "tglfs:folder-manifest" as const,
        version: 1 as const,
        folderId: "folder-1",
        rootId: "root-1",
        path: "",
        createdAt: "2026-05-02T12:00:00.000Z",
        updatedAt: "2026-05-02T12:00:00.000Z",
        entries: {
            Notes: {
                entryId: "entry-folder",
                name: "Notes",
                path: "Notes",
                kind: "folder" as const,
                folderId: "folder-2",
                deleted: false,
                updatedAt: "2026-05-02T12:00:00.000Z",
            },
            "a.txt": {
                entryId: "entry-file",
                name: "a.txt",
                path: "a.txt",
                kind: "file" as const,
                ufid: "ufid-a",
                size: 1,
                mtimeMs: 2,
                mode: 0o644,
                deleted: false,
                updatedAt: "2026-05-02T12:00:00.000Z",
            },
        },
    }

    assert.deepEqual(parseTglfsFolderManifestMessage(serializeTglfsFolderManifestMessage(manifest)), manifest)
})

test("folder manifest compaction drops deleted entries before storage writes", () => {
    const manifest = createTglfsFolderManifest({
        folderId: "folder-1",
        rootId: "root-1",
        path: "",
        now: "2026-05-02T12:00:00.000Z",
        entries: {
            "active.txt": {
                entryId: "entry-active",
                name: "active.txt",
                path: "active.txt",
                kind: "file",
                ufid: "ufid-active",
                size: 1,
                mtimeMs: 2,
                mode: 0o644,
                deleted: false,
                updatedAt: "2026-05-02T12:00:00.000Z",
            },
            "old.txt": {
                entryId: "entry-deleted",
                name: "old.txt",
                path: "old.txt",
                kind: "file",
                ufid: "ufid-old",
                size: 1,
                mtimeMs: 2,
                mode: 0o644,
                deleted: true,
                updatedAt: "2026-05-02T12:00:00.000Z",
            },
        },
    })

    const compacted = compactTglfsFolderManifest(manifest)

    assert.deepEqual(Object.keys(compacted.entries), ["active.txt"])
    assert.equal(Object.keys(manifest.entries).length, 2)
})

test("folder parsers refuse malformed and future-version records", () => {
    assert.equal(parseTglfsFolderMessage("tglfs:folder\n{}"), null)
    assert.equal(
        parseTglfsFolderMessage(
            'tglfs:folder\n{"type":"tglfs:folder","version":3,"folderId":"folder-1","name":"Documents","path":"","createdAt":"2026-05-02T12:00:00.000Z","updatedAt":"2026-05-02T12:00:00.000Z","deleted":false}',
        ),
        null,
    )
    assert.equal(
        parseTglfsFolderManifestMessage(
            'tglfs:folder-manifest\n{"type":"tglfs:folder-manifest","version":2,"folderId":"folder-1","path":"","createdAt":"2026-05-02T12:00:00.000Z","updatedAt":"2026-05-02T12:00:00.000Z","entries":{}}',
        ),
        null,
    )
    assert.equal(
        parseTglfsFolderManifestMessage(
            'tglfs:folder-manifest\n{"type":"tglfs:folder-manifest","version":1,"folderId":"folder-1","path":"","createdAt":"2026-05-02T12:00:00.000Z","updatedAt":"2026-05-02T12:00:00.000Z","entries":{"a.txt":{"entryId":"entry","name":"b.txt","path":"a.txt","kind":"file","ufid":"u","size":1,"mtimeMs":1,"mode":420,"deleted":false,"updatedAt":"2026-05-02T12:00:00.000Z"}}}',
        ),
        null,
    )
})
