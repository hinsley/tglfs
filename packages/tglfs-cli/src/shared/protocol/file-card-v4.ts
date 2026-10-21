import { isArchiveStorageDescriptor } from "../archive-format.js"
import type { ArchiveStorageDescriptor } from "../archive-format.js"
import { TGLFS_ROOT_PARENT_ID } from "../constants.js"
import { FILE_CARD_TYPE } from "./file-card-v1.js"
import type { FileCardV1StoredData } from "./file-card-v1.js"

export const FILE_CARD_V4_VERSION = 4 as const
export const ARCHIVE_SOURCE_TYPE = "tglfs:archive-source" as const
export const ARCHIVE_SOURCE_VERSION = 1 as const

export type ArchiveUpgradeSource = {
    type: typeof ARCHIVE_SOURCE_TYPE
    version: typeof ARCHIVE_SOURCE_VERSION
    messageId: number
    fileVersion: number
    peer: string
    ufid: string
}

export type FileCardV4Data = FileCardV1StoredData & {
    type: typeof FILE_CARD_TYPE
    version: typeof FILE_CARD_V4_VERSION
    IV: ""
    parentFolderId: string
    archive: ArchiveStorageDescriptor
    upgradedFrom?: ArchiveUpgradeSource
}

export type FileCardV4Input = Omit<FileCardV4Data, "type" | "parentFolderId"> & {
    type?: typeof FILE_CARD_TYPE
    parentFolderId?: string
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== ""
}

function isArchiveUpgradeSource(value: unknown): value is ArchiveUpgradeSource {
    if (!value || typeof value !== "object") return false
    const source = value as Partial<ArchiveUpgradeSource>
    return source.type === ARCHIVE_SOURCE_TYPE &&
        source.version === ARCHIVE_SOURCE_VERSION &&
        isPositiveInteger(source.messageId) &&
        isPositiveInteger(source.fileVersion) &&
        isNonEmptyString(source.peer) &&
        isNonEmptyString(source.ufid)
}

export function normalizeFileCardV4Data(value: unknown): FileCardV4Data | null {
    if (!value || typeof value !== "object") return null
    const candidate = value as Partial<FileCardV4Data>
    if (
        candidate.type !== FILE_CARD_TYPE ||
        candidate.version !== FILE_CARD_V4_VERSION ||
        !isNonEmptyString(candidate.name) ||
        !isNonEmptyString(candidate.ufid) ||
        !Number.isSafeInteger(candidate.size) ||
        (candidate.size as number) < 0 ||
        typeof candidate.uploadComplete !== "boolean" ||
        !Array.isArray(candidate.chunks) ||
        candidate.chunks.length === 0 ||
        !candidate.chunks.every(isPositiveInteger) ||
        new Set(candidate.chunks).size !== candidate.chunks.length ||
        candidate.IV !== "" ||
        !isNonEmptyString(candidate.parentFolderId) ||
        !isArchiveStorageDescriptor(candidate.archive) ||
        (candidate.upgradedFrom !== undefined && !isArchiveUpgradeSource(candidate.upgradedFrom))
    ) return null

    return {
        ...candidate,
        type: FILE_CARD_TYPE,
        version: FILE_CARD_V4_VERSION,
        name: candidate.name,
        ufid: candidate.ufid,
        size: candidate.size as number,
        uploadComplete: candidate.uploadComplete,
        chunks: candidate.chunks.slice(),
        IV: "",
        parentFolderId: candidate.parentFolderId,
        archive: { ...candidate.archive },
        ...(candidate.upgradedFrom ? { upgradedFrom: { ...candidate.upgradedFrom } } : {}),
    }
}

export function createFileCardV4Data(data: Omit<FileCardV4Input, "version"> & { version?: typeof FILE_CARD_V4_VERSION }): FileCardV4Data {
    if ((data.version !== undefined && data.version !== FILE_CARD_V4_VERSION) ||
        (data.type !== undefined && data.type !== FILE_CARD_TYPE)) {
        throw new Error("Unsupported archive file-card protocol.")
    }
    const result = normalizeFileCardV4Data({
        ...data,
        type: FILE_CARD_TYPE,
        version: FILE_CARD_V4_VERSION,
        parentFolderId: data.parentFolderId?.trim() || TGLFS_ROOT_PARENT_ID,
    })
    if (!result) throw new Error("The archive file card is malformed or unsupported.")
    return result
}

export function serializeFileCardV4Data(data: Omit<FileCardV4Input, "version"> & { version?: typeof FILE_CARD_V4_VERSION }): string {
    return JSON.stringify(createFileCardV4Data(data))
}
