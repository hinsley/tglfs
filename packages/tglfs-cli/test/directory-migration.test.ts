import assert from "node:assert/strict"
import test from "node:test"

import { TGLFS_ROOT_PARENT_ID } from "../src/shared/constants.js"
import { planDirectoryParentMigration } from "../src/shared/directory-migration.js"
import type { TglfsFolderManifestRecord, TglfsFolderRecord } from "../src/folders.js"

const now = "2026-05-13T12:00:00.000Z"

function folderRecord(folderId: string, name: string, parentFolderId?: string): TglfsFolderRecord {
    return {
        msgId: Number(folderId.replace(/\D/g, "")) || 1,
        date: 1,
        data: {
            type: "tglfs:folder",
            version: 2,
            folderId,
            parentFolderId,
            rootId: folderId === "folder-root" ? folderId : "folder-root",
            name,
            path: folderId === "folder-root" ? "" : name,
            createdAt: now,
            updatedAt: now,
            deleted: false,
        },
    }
}

test("directory parent migration plans nested folder and file parent refs", () => {
    const folders = [
        folderRecord("folder-root", "Docs"),
        folderRecord("folder-child", "Projects"),
    ]
    const manifests: TglfsFolderManifestRecord[] = [
        {
            msgId: 10,
            date: 1,
            data: {
                type: "tglfs:folder-entries",
                version: 2,
                folderId: "folder-root",
                path: "",
                createdAt: now,
                updatedAt: now,
                entries: {
                    Projects: {
                        entryId: "entry-projects",
                        name: "Projects",
                        path: "Projects",
                        kind: "folder",
                        folderId: "folder-child",
                        deleted: false,
                        updatedAt: now,
                    },
                    "remote.txt": {
                        entryId: "entry-remote",
                        name: "remote.txt",
                        path: "remote.txt",
                        kind: "file",
                        ufid: "ufid-remote",
                        size: 42,
                        mtimeMs: 1,
                        mode: 0o644,
                        deleted: false,
                        updatedAt: now,
                    },
                },
            },
        },
        {
            msgId: 11,
            date: 1,
            data: {
                type: "tglfs:folder-entries",
                version: 2,
                folderId: "folder-child",
                path: "Projects",
                createdAt: now,
                updatedAt: now,
                entries: {
                    "plan.md": {
                        entryId: "entry-plan",
                        name: "plan.md",
                        path: "Projects/plan.md",
                        kind: "file",
                        ufid: "ufid-plan",
                        size: 10,
                        mtimeMs: 1,
                        mode: 0o644,
                        deleted: false,
                        updatedAt: now,
                    },
                },
            },
        },
    ]
    const files = [
        {
            msgId: 20,
            date: 1,
            data: { type: "tglfs:file" as const, version: 2 as const, name: "loose.txt", ufid: "ufid-loose", size: 1, uploadComplete: true, chunks: [1], IV: "iv" },
        },
        {
            msgId: 21,
            date: 1,
            data: { type: "tglfs:file" as const, version: 2 as const, name: "remote.txt", ufid: "ufid-remote", size: 42, uploadComplete: true, chunks: [2], IV: "iv" },
        },
        {
            msgId: 22,
            date: 1,
            data: { type: "tglfs:file" as const, version: 2 as const, name: "plan.md", ufid: "ufid-plan", size: 10, uploadComplete: true, chunks: [3], IV: "iv" },
        },
    ]

    const plan = planDirectoryParentMigration(folders, manifests, files)

    assert.deepEqual(
        plan.folderUpdates.map((update) => [update.record.data.folderId, update.parentFolderId]),
        [
            ["folder-root", TGLFS_ROOT_PARENT_ID],
            ["folder-child", "folder-root"],
        ],
    )
    assert.deepEqual(
        plan.fileUpdates.map((update) => [update.record.data.ufid, update.parentFolderId]),
        [
            ["ufid-loose", TGLFS_ROOT_PARENT_ID],
            ["ufid-remote", "folder-root"],
            ["ufid-plan", "folder-child"],
        ],
    )
})

test("directory parent migration skips ambiguous duplicate parent refs", () => {
    const folders = [folderRecord("folder-a", "A"), folderRecord("folder-b", "B")]
    const manifests: TglfsFolderManifestRecord[] = folders.map((folder, index) => ({
        msgId: 30 + index,
        date: 1,
        data: {
            type: "tglfs:folder-entries",
            version: 2,
            folderId: folder.data.folderId,
            path: "",
            createdAt: now,
            updatedAt: now,
            entries: {
                "same.txt": {
                    entryId: `entry-${index}`,
                    name: "same.txt",
                    path: "same.txt",
                    kind: "file",
                    ufid: "ufid-same",
                    size: 1,
                    mtimeMs: 1,
                    mode: 0o644,
                    deleted: false,
                    updatedAt: now,
                },
            },
        },
    }))
    const files = [
        {
            msgId: 40,
            date: 1,
            data: { type: "tglfs:file" as const, version: 2 as const, name: "same.txt", ufid: "ufid-same", size: 1, uploadComplete: true, chunks: [1], IV: "iv" },
        },
    ]

    const plan = planDirectoryParentMigration(folders, manifests, files)

    assert.deepEqual(plan.fileParentConflicts, ["ufid-same"])
    assert.deepEqual(plan.fileUpdates, [])
})

test("directory parent migration ignores and repairs self-parent folder refs", () => {
    const folders = [
        folderRecord("folder-root", "Docs", "folder-root"),
        folderRecord("folder-child", "Projects"),
    ]
    const manifests: TglfsFolderManifestRecord[] = [
        {
            msgId: 50,
            date: 1,
            data: {
                type: "tglfs:folder-entries",
                version: 2,
                folderId: "folder-root",
                path: "",
                createdAt: now,
                updatedAt: now,
                entries: {
                    Docs: {
                        entryId: "entry-self",
                        name: "Docs",
                        path: "",
                        kind: "folder",
                        folderId: "folder-root",
                        deleted: false,
                        updatedAt: now,
                    },
                    Projects: {
                        entryId: "entry-projects",
                        name: "Projects",
                        path: "Projects",
                        kind: "folder",
                        folderId: "folder-child",
                        deleted: false,
                        updatedAt: now,
                    },
                },
            },
        },
    ]

    const plan = planDirectoryParentMigration(folders, manifests, [])

    assert.deepEqual(
        plan.folderUpdates.map((update) => [update.record.data.folderId, update.parentFolderId]),
        [
            ["folder-root", TGLFS_ROOT_PARENT_ID],
            ["folder-child", "folder-root"],
        ],
    )
})
