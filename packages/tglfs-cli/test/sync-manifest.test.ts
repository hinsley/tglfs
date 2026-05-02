import assert from "node:assert/strict"
import test from "node:test"

import {
    createEmptySyncManifest,
    parseSyncManifestMessage,
    serializeSyncManifestMessage,
} from "../src/sync-manifest.js"
import { normalizeRelativeSyncPath } from "../src/sync-scan.js"

test("sync manifest v1 messages parse successfully", () => {
    const manifest = createEmptySyncManifest({
        rootId: "root-1",
        rootName: "Documents",
        now: "2026-05-02T12:00:00.000Z",
    })
    manifest.entries["notes/a.txt"] = {
        entryId: "entry-1",
        path: "notes/a.txt",
        ufid: "ufid-1",
        size: 12,
        mtimeMs: 1700000000000,
        mode: 0o644,
        deleted: false,
        updatedAt: "2026-05-02T12:01:00.000Z",
    }

    assert.deepEqual(parseSyncManifestMessage(serializeSyncManifestMessage(manifest)), manifest)
})

test("sync manifest parser refuses malformed and future-version records", () => {
    assert.equal(parseSyncManifestMessage("tglfs:sync-manifest\n{}"), null)
    assert.equal(
        parseSyncManifestMessage(
            'tglfs:sync-manifest\n{"type":"tglfs:sync-manifest","version":2,"rootId":"root","rootName":"Docs","createdAt":"2026-05-02T12:00:00.000Z","updatedAt":"2026-05-02T12:00:00.000Z","entries":{}}',
        ),
        null,
    )
    assert.equal(
        parseSyncManifestMessage(
            'tglfs:sync-manifest\n{"type":"tglfs:sync-manifest","version":1,"rootId":"root","rootName":"Docs","createdAt":"2026-05-02T12:00:00.000Z","updatedAt":"2026-05-02T12:00:00.000Z","entries":{"a.txt":{"entryId":"e","path":"b.txt","ufid":"u","size":1,"mtimeMs":1,"mode":420,"deleted":false,"updatedAt":"2026-05-02T12:00:00.000Z"}}}',
        ),
        null,
    )
})

test("sync path normalization rejects paths escaping the root", () => {
    assert.equal(normalizeRelativeSyncPath("/tmp/root", "/tmp/root/nested/file.txt"), "nested/file.txt")
    assert.throws(() => normalizeRelativeSyncPath("/tmp/root", "/tmp/other/file.txt"))
})
