import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { createEmptySyncManifest, serializeSyncManifestMessage } from "../src/sync-manifest.js"
import { diffSyncFiles, pullSyncRoot, pushSyncRoot } from "../src/sync.js"
import { scanSyncFolder } from "../src/sync-scan.js"
import { loadSyncLedger } from "../src/sync-store.js"

const FakeApi = {
    messages: {
        EditMessage: class EditMessage {
            constructor(readonly args: any) {}
        },
    },
}

async function withTempLedger<T>(work: (dir: string) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), "tglfs-sync-test-"))
    const previous = process.env.TGLFS_SYNC_LEDGER_FILE
    process.env.TGLFS_SYNC_LEDGER_FILE = join(dir, "ledger.json")
    try {
        return await work(dir)
    } finally {
        if (previous === undefined) {
            delete process.env.TGLFS_SYNC_LEDGER_FILE
        } else {
            process.env.TGLFS_SYNC_LEDGER_FILE = previous
        }
    }
}

test("diffSyncFiles classifies added, modified, unchanged, and deleted files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tglfs-diff-test-"))
    await mkdir(join(dir, "nested"))
    await writeFile(join(dir, "new.txt"), "new")
    await writeFile(join(dir, "modified.txt"), "modified")
    await writeFile(join(dir, "same.txt"), "same")
    await writeFile(join(dir, "nested", "child.txt"), "child")

    const files = await scanSyncFolder(dir)
    const same = files.find((file) => file.path === "same.txt")
    assert.ok(same)
    const manifest = createEmptySyncManifest({ rootId: "root-1", rootName: "Docs" })
    manifest.entries["same.txt"] = {
        entryId: "same",
        path: "same.txt",
        ufid: "same-ufid",
        size: same.size,
        mtimeMs: same.mtimeMs,
        mode: same.mode,
        deleted: false,
        updatedAt: manifest.createdAt,
    }
    manifest.entries["modified.txt"] = {
        entryId: "modified",
        path: "modified.txt",
        ufid: "old-ufid",
        size: 1,
        mtimeMs: 1,
        mode: 0o644,
        deleted: false,
        updatedAt: manifest.createdAt,
    }
    manifest.entries["deleted.txt"] = {
        entryId: "deleted",
        path: "deleted.txt",
        ufid: "deleted-ufid",
        size: 1,
        mtimeMs: 1,
        mode: 0o644,
        deleted: false,
        updatedAt: manifest.createdAt,
    }

    const diff = diffSyncFiles(files, manifest)
    assert.deepEqual(diff.added.map((file) => file.path), ["nested/child.txt", "new.txt"])
    assert.deepEqual(diff.modified.map((file) => file.path), ["modified.txt"])
    assert.deepEqual(diff.unchanged.map((file) => file.path), ["same.txt"])
    assert.deepEqual(diff.deleted.map((entry) => entry.path), ["deleted.txt"])
})

test("pushSyncRoot uploads blobs before publishing the manifest", async () => {
    await withTempLedger(async (dir) => {
        await writeFile(join(dir, "new.txt"), "new")
        await writeFile(join(dir, "same.txt"), "same")
        const files = await scanSyncFolder(dir)
        const same = files.find((file) => file.path === "same.txt")
        assert.ok(same)

        const manifest = createEmptySyncManifest({ rootId: "root-1", rootName: "Docs" })
        manifest.entries["same.txt"] = {
            entryId: "same",
            path: "same.txt",
            ufid: "same-ufid",
            size: same.size,
            mtimeMs: same.mtimeMs,
            mode: same.mode,
            deleted: false,
            updatedAt: manifest.createdAt,
        }
        manifest.entries["gone.txt"] = {
            entryId: "gone",
            path: "gone.txt",
            ufid: "gone-ufid",
            size: 4,
            mtimeMs: 4,
            mode: 0o644,
            deleted: false,
            updatedAt: manifest.createdAt,
        }

        const events: string[] = []
        const client = {
            async getMessages() {
                return [{ id: 44, date: 1, peerId: "me-peer", message: serializeSyncManifestMessage(manifest) }]
            },
            async sendMessage() {
                throw new Error("unexpected send")
            },
            async invoke(request: any) {
                events.push(`manifest:${request.args.id}`)
                return true
            },
        } as any

        const result = await pushSyncRoot(client, {
            Api: FakeApi as any,
            root: {
                rootId: "root-1",
                rootName: "Docs",
                folderPath: dir,
                manifestMsgId: 44,
                lastSyncedFiles: {},
            },
            password: "",
            chunkSize: 2 * 1024 * 1024,
            async uploadFile(file) {
                events.push(`upload:${file.path}`)
                return { ufid: `ufid-${file.path}`, size: file.size }
            },
        })

        assert.deepEqual(events, ["upload:new.txt", "manifest:44"])
        assert.equal(result.added, 1)
        assert.equal(result.deleted, 1)
        assert.equal(result.uploaded[0]?.ufid, "ufid-new.txt")
    })
})

test("pullSyncRoot recreates files and preserves divergent local files as conflicts", async () => {
    await withTempLedger(async (dir) => {
        const destination = join(dir, "restore")
        await mkdir(join(destination, "nested"), { recursive: true })
        await writeFile(join(destination, "nested", "a.txt"), "local")

        const manifest = createEmptySyncManifest({ rootId: "root-1", rootName: "Docs" })
        manifest.entries["nested/a.txt"] = {
            entryId: "a",
            path: "nested/a.txt",
            ufid: "remote-a",
            size: 6,
            mtimeMs: 1,
            mode: 0o644,
            deleted: false,
            updatedAt: manifest.createdAt,
        }
        manifest.entries["nested/b.txt"] = {
            entryId: "b",
            path: "nested/b.txt",
            ufid: "remote-b",
            size: 6,
            mtimeMs: 1,
            mode: 0o644,
            deleted: false,
            updatedAt: manifest.createdAt,
        }

        const client = {
            async getMessages() {
                return [{ id: 44, date: 1, peerId: "me-peer", message: serializeSyncManifestMessage(manifest) }]
            },
        } as any

        const result = await pullSyncRoot(client, {
            rootId: "root-1",
            destination,
            password: "",
            now: "2026-05-02T12:34:56.000Z",
            async downloadFile(ufid, outputPath) {
                await writeFile(outputPath, ufid === "remote-a" ? "remote" : "other!")
            },
        })

        assert.equal(result.downloaded.length, 2)
        assert.equal(result.conflicts.length, 1)
        assert.match(result.conflicts[0]?.conflictPath ?? "", /nested\/a \(TGLFS conflict 20260502 123456\)\.txt$/)
        assert.equal(await readFile(join(destination, "nested", "a.txt"), "utf8"), "local")
        assert.equal(await readFile(result.conflicts[0]!.conflictPath, "utf8"), "remote")
        assert.equal(await readFile(join(destination, "nested", "b.txt"), "utf8"), "other!")
        const ledger = await loadSyncLedger()
        assert.equal(ledger.roots["root-1"]?.folderPath, destination)
        assert.equal(ledger.roots["root-1"]?.lastSyncedFiles["nested/a.txt"], undefined)
        assert.equal(ledger.roots["root-1"]?.lastSyncedFiles["nested/b.txt"]?.ufid, "remote-b")
    })
})
