import { TGLFS_ROOT_PARENT_ID } from "./constants.js"
import { FILE_CARD_CURRENT_VERSION } from "./file-cards.js"
import type { FileCardRecord } from "./file-cards.js"
import type { TglfsFolderManifestRecord, TglfsFolderRecord } from "../folders.js"

export type DirectoryParentMigrationPlan = {
    folderUpdates: Array<{ record: TglfsFolderRecord; parentFolderId: string }>
    fileUpdates: Array<{ record: FileCardRecord; parentFolderId: string }>
    folderParentConflicts: string[]
    fileParentConflicts: string[]
}

function fileParentFolderId(record: FileCardRecord) {
    return "parentFolderId" in record.data ? record.data.parentFolderId : undefined
}

function recordParent(parentMap: Map<string, string>, conflictSet: Set<string>, childId: string, parentId: string) {
    const existing = parentMap.get(childId)
    if (existing && existing !== parentId) {
        conflictSet.add(childId)
        return
    }
    parentMap.set(childId, parentId)
}

export function planDirectoryParentMigration(
    folderRecords: TglfsFolderRecord[],
    manifestRecords: TglfsFolderManifestRecord[],
    fileRecords: FileCardRecord[],
): DirectoryParentMigrationPlan {
    const folderParents = new Map<string, string>()
    const fileParents = new Map<string, string>()
    const folderParentConflicts = new Set<string>()
    const fileParentConflicts = new Set<string>()

    for (const manifestRecord of manifestRecords) {
        const parentFolderId = manifestRecord.data.folderId
        for (const entry of Object.values(manifestRecord.data.entries)) {
            if (entry.deleted) continue
            if (entry.kind === "folder" && entry.folderId) {
                recordParent(folderParents, folderParentConflicts, entry.folderId, parentFolderId)
            }
            if (entry.kind === "file" && entry.ufid) {
                recordParent(fileParents, fileParentConflicts, entry.ufid, parentFolderId)
            }
        }
    }

    const folderUpdates: DirectoryParentMigrationPlan["folderUpdates"] = []
    for (const record of folderRecords) {
        if (folderParentConflicts.has(record.data.folderId)) continue
        const desiredParent = folderParents.get(record.data.folderId) || record.data.parentFolderId || TGLFS_ROOT_PARENT_ID
        if (record.data.parentFolderId !== desiredParent) {
            folderUpdates.push({ record, parentFolderId: desiredParent })
        }
    }

    const fileUpdates: DirectoryParentMigrationPlan["fileUpdates"] = []
    for (const record of fileRecords) {
        if (fileParentConflicts.has(record.data.ufid)) continue
        const desiredParent = fileParents.get(record.data.ufid) || fileParentFolderId(record) || TGLFS_ROOT_PARENT_ID
        if (fileParentFolderId(record) !== desiredParent || record.data.version !== FILE_CARD_CURRENT_VERSION) {
            fileUpdates.push({ record, parentFolderId: desiredParent })
        }
    }

    return {
        folderUpdates,
        fileUpdates,
        folderParentConflicts: [...folderParentConflicts].sort(),
        fileParentConflicts: [...fileParentConflicts].sort(),
    }
}
