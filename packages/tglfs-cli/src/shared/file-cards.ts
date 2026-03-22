export type FileCardData = {
    name: string
    ufid: string
    size: number
    uploadComplete: boolean
    chunks: number[]
    IV: string
}

export type FileCardRecord = {
    msgId: number
    date: number
    data: FileCardData
}

export type FileCardMessageLike = {
    id: number
    date: number
    message?: string | null
}

export const FILE_CARD_SEARCH_SORT_VALUES = [
    "date_desc",
    "date_asc",
    "name_asc",
    "name_desc",
    "size_desc",
    "size_asc",
] as const

export type FileCardSearchSort = (typeof FILE_CARD_SEARCH_SORT_VALUES)[number]

export function isFileCardData(value: unknown): value is FileCardData {
    if (!value || typeof value !== "object") {
        return false
    }

    const candidate = value as Partial<FileCardData>
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

export function parseFileCardMessage(message: string): FileCardData | null {
    if (!message.startsWith("tglfs:file")) {
        return null
    }

    try {
        const payload = JSON.parse(message.substring(message.indexOf("{")))
        return isFileCardData(payload) ? payload : null
    } catch {
        return null
    }
}

export function extractFileCardRecord(message: FileCardMessageLike): FileCardRecord | null {
    if (typeof message.message !== "string") {
        return null
    }

    const data = parseFileCardMessage(message.message)
    if (!data) {
        return null
    }

    return {
        msgId: message.id,
        date: message.date,
        data,
    }
}

export function extractFileCardRecords(messages: Iterable<FileCardMessageLike>) {
    const results: FileCardRecord[] = []
    for (const message of messages) {
        const record = extractFileCardRecord(message)
        if (record) {
            results.push(record)
        }
    }
    return results
}

export function buildFileCardSearchQuery(query = "") {
    return `tglfs:file ${query.trim()}`.trim()
}

export function buildFileCardUfidLookupQuery(ufid: string) {
    return `tglfs:file "ufid":"${ufid.trim()}"`
}

export function sortFileCardRecords(records: FileCardRecord[], sort: FileCardSearchSort) {
    records.sort((a, b) => {
        switch (sort) {
            case "date_desc":
                return b.date - a.date
            case "date_asc":
                return a.date - b.date
            case "name_asc":
                return a.data.name.localeCompare(b.data.name)
            case "name_desc":
                return b.data.name.localeCompare(a.data.name)
            case "size_desc":
                return b.data.size - a.data.size
            case "size_asc":
                return a.data.size - b.data.size
        }
    })
}

export function formatFileCardSize(size: number): string {
    if (size <= 0 || !Number.isFinite(size)) {
        return "0 B"
    }

    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    const unitIndex = Math.floor(Math.log(size) / Math.log(1024))
    const value = size / Math.pow(1024, unitIndex)
    return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`
}

export function formatFileCardDate(epochSec: number): string {
    const date = new Date(epochSec * 1000)
    const pad = (value: number) => (value < 10 ? `0${value}` : String(value))

    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    ].join(" ")
}
