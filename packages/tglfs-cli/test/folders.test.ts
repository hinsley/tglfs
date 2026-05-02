import assert from "node:assert/strict"
import test from "node:test"

import {
    createTglfsFolder,
    createTglfsFolderManifest,
    parseTglfsFolderManifestMessage,
    parseTglfsFolderMessage,
    serializeTglfsFolderManifestMessage,
    serializeTglfsFolderMessage,
} from "../src/folders.js"

test("folder v1 messages parse successfully", () => {
    const folder = createTglfsFolder({
        folderId: "folder-1",
        rootId: "root-1",
        name: "Documents",
        path: "",
        now: "2026-05-02T12:00:00.000Z",
    })

    assert.deepEqual(parseTglfsFolderMessage(serializeTglfsFolderMessage(folder)), folder)
})

test("folder manifest v1 messages parse file and folder entries", () => {
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

    assert.deepEqual(parseTglfsFolderManifestMessage(serializeTglfsFolderManifestMessage(manifest)), manifest)
})

test("folder parsers refuse malformed and future-version records", () => {
    assert.equal(parseTglfsFolderMessage("tglfs:folder\n{}"), null)
    assert.equal(
        parseTglfsFolderMessage(
            'tglfs:folder\n{"type":"tglfs:folder","version":2,"folderId":"folder-1","name":"Documents","path":"","createdAt":"2026-05-02T12:00:00.000Z","updatedAt":"2026-05-02T12:00:00.000Z","deleted":false}',
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
