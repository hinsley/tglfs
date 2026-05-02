export const FILE_CARD_V1_TYPE = "tglfs:file" as const
export const FILE_CARD_V1_VERSION = 1 as const

export type FileCardV1Data = {
    type: typeof FILE_CARD_V1_TYPE
    version: typeof FILE_CARD_V1_VERSION
    name: string
    ufid: string
    size: number
    uploadComplete: boolean
    chunks: number[]
    IV: string
}

export type LegacyFileCardV1Data = Omit<FileCardV1Data, "type" | "version">

export type FileCardV1Input = FileCardV1Data | LegacyFileCardV1Data

type FileCardV1Candidate = Partial<FileCardV1Data>

function hasFileCardV1Shape(value: unknown): value is FileCardV1Candidate {
    if (!value || typeof value !== "object") {
        return false
    }

    const candidate = value as Partial<FileCardV1Data>
    return (
        typeof candidate.name === "string" &&
        typeof candidate.ufid === "string" &&
        typeof candidate.size === "number" &&
        typeof candidate.uploadComplete === "boolean" &&
        Array.isArray(candidate.chunks) &&
        candidate.chunks.every((chunk) => typeof chunk === "number") &&
        typeof candidate.IV === "string"
    )
}

export function isFileCardV1Data(value: unknown): value is FileCardV1Data {
    if (!hasFileCardV1Shape(value)) {
        return false
    }
    const legacyV1 = value.type === undefined && value.version === undefined
    const explicitV1 = value.type === FILE_CARD_V1_TYPE && value.version === FILE_CARD_V1_VERSION

    return (
        legacyV1 ||
        explicitV1
    )
}

export function normalizeFileCardV1Data(value: unknown): FileCardV1Data | null {
    if (!isFileCardV1Data(value)) {
        return null
    }

    return {
        type: FILE_CARD_V1_TYPE,
        version: FILE_CARD_V1_VERSION,
        name: value.name,
        ufid: value.ufid,
        size: value.size,
        uploadComplete: value.uploadComplete,
        chunks: value.chunks.slice(),
        IV: value.IV,
    }
}

export function serializeFileCardV1Data(data: FileCardV1Input): string {
    return JSON.stringify({
        type: FILE_CARD_V1_TYPE,
        version: FILE_CARD_V1_VERSION,
        name: data.name,
        ufid: data.ufid,
        size: data.size,
        uploadComplete: data.uploadComplete,
        chunks: data.chunks,
        IV: data.IV,
    })
}
