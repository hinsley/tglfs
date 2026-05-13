import { TGLFS_ROOT_PARENT_ID } from "../constants.js"
import { FILE_CARD_TYPE } from "./file-card-v1.js"
import type { FileCardV1StoredData } from "./file-card-v1.js"

export const FILE_CARD_V3_VERSION = 3 as const

export type FileCardV3Data = FileCardV1StoredData & {
    type: typeof FILE_CARD_TYPE
    version: typeof FILE_CARD_V3_VERSION
    parentFolderId: string
}

export type FileCardV3Input = FileCardV1StoredData & {
    parentFolderId?: string
}

type FileCardV3Candidate = FileCardV3Data

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== ""
}

function hasFileCardV3Shape(value: unknown): value is FileCardV3Candidate {
    if (!value || typeof value !== "object") {
        return false
    }

    const candidate = value as Partial<FileCardV3Data>
    return (
        candidate.type === FILE_CARD_TYPE &&
        candidate.version === FILE_CARD_V3_VERSION &&
        typeof candidate.name === "string" &&
        typeof candidate.ufid === "string" &&
        typeof candidate.size === "number" &&
        typeof candidate.uploadComplete === "boolean" &&
        Array.isArray(candidate.chunks) &&
        candidate.chunks.every((chunk) => typeof chunk === "number") &&
        typeof candidate.IV === "string" &&
        isNonEmptyString(candidate.parentFolderId)
    )
}

export function normalizeFileCardV3Data(value: unknown): FileCardV3Data | null {
    if (!hasFileCardV3Shape(value)) {
        return null
    }

    return {
        type: FILE_CARD_TYPE,
        version: FILE_CARD_V3_VERSION,
        name: value.name,
        ufid: value.ufid,
        size: value.size,
        uploadComplete: value.uploadComplete,
        chunks: value.chunks.slice(),
        IV: value.IV,
        parentFolderId: value.parentFolderId,
    }
}

export function createFileCardV3Data(data: FileCardV3Input): FileCardV3Data {
    return {
        type: FILE_CARD_TYPE,
        version: FILE_CARD_V3_VERSION,
        name: data.name,
        ufid: data.ufid,
        size: data.size,
        uploadComplete: data.uploadComplete,
        chunks: data.chunks.slice(),
        IV: data.IV,
        parentFolderId: data.parentFolderId?.trim() || TGLFS_ROOT_PARENT_ID,
    }
}

export function serializeFileCardV3Data(data: FileCardV3Input): string {
    return JSON.stringify(createFileCardV3Data(data))
}
