export const FILE_CARD_TYPE = "tglfs:file" as const
export const FILE_CARD_V1_VERSION = 1 as const

export type FileCardV1StoredData = {
    name: string
    ufid: string
    size: number
    uploadComplete: boolean
    chunks: number[]
    IV: string
}

export type NormalizedFileCardV1Data = FileCardV1StoredData & {
    type: typeof FILE_CARD_TYPE
    version: typeof FILE_CARD_V1_VERSION
}

type FileCardV1Candidate = FileCardV1StoredData & {
    type?: unknown
    version?: unknown
}

function hasFileCardV1Shape(value: unknown): value is FileCardV1Candidate {
    if (!value || typeof value !== "object") {
        return false
    }

    const candidate = value as FileCardV1Candidate
    return (
        candidate.type === undefined &&
        candidate.version === undefined &&
        typeof candidate.name === "string" &&
        typeof candidate.ufid === "string" &&
        typeof candidate.size === "number" &&
        typeof candidate.uploadComplete === "boolean" &&
        Array.isArray(candidate.chunks) &&
        candidate.chunks.every((chunk) => typeof chunk === "number") &&
        typeof candidate.IV === "string"
    )
}

export function normalizeFileCardV1Data(value: unknown): NormalizedFileCardV1Data | null {
    if (!hasFileCardV1Shape(value)) {
        return null
    }

    return {
        type: FILE_CARD_TYPE,
        version: FILE_CARD_V1_VERSION,
        name: value.name,
        ufid: value.ufid,
        size: value.size,
        uploadComplete: value.uploadComplete,
        chunks: value.chunks.slice(),
        IV: value.IV,
    }
}
