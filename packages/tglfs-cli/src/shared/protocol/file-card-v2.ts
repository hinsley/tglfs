import { FILE_CARD_TYPE } from "./file-card-v1.js"
import type { FileCardV1StoredData } from "./file-card-v1.js"

export const FILE_CARD_V2_VERSION = 2 as const

export type FileCardV2Data = FileCardV1StoredData & {
    type: typeof FILE_CARD_TYPE
    version: typeof FILE_CARD_V2_VERSION
}

export type FileCardV2Input = FileCardV2Data | FileCardV1StoredData

type FileCardV2Candidate = FileCardV2Data

function hasFileCardV2Shape(value: unknown): value is FileCardV2Candidate {
    if (!value || typeof value !== "object") {
        return false
    }

    const candidate = value as Partial<FileCardV2Data>
    return (
        candidate.type === FILE_CARD_TYPE &&
        candidate.version === FILE_CARD_V2_VERSION &&
        typeof candidate.name === "string" &&
        typeof candidate.ufid === "string" &&
        typeof candidate.size === "number" &&
        typeof candidate.uploadComplete === "boolean" &&
        Array.isArray(candidate.chunks) &&
        candidate.chunks.every((chunk) => typeof chunk === "number") &&
        typeof candidate.IV === "string"
    )
}

export function normalizeFileCardV2Data(value: unknown): FileCardV2Data | null {
    if (!hasFileCardV2Shape(value)) {
        return null
    }

    return {
        type: FILE_CARD_TYPE,
        version: FILE_CARD_V2_VERSION,
        name: value.name,
        ufid: value.ufid,
        size: value.size,
        uploadComplete: value.uploadComplete,
        chunks: value.chunks.slice(),
        IV: value.IV,
    }
}

export function createFileCardV2Data(data: FileCardV2Input): FileCardV2Data {
    return {
        type: FILE_CARD_TYPE,
        version: FILE_CARD_V2_VERSION,
        name: data.name,
        ufid: data.ufid,
        size: data.size,
        uploadComplete: data.uploadComplete,
        chunks: data.chunks.slice(),
        IV: data.IV,
    }
}

export function serializeFileCardV2Data(data: FileCardV2Input): string {
    return JSON.stringify(createFileCardV2Data(data))
}
