import {
    FILE_CARD_V1_TYPE,
    FILE_CARD_V1_VERSION,
    isFileCardV1Data,
    normalizeFileCardV1Data,
    serializeFileCardV1Data,
} from "./protocol/file-card-v1.js"
import type { FileCardV1Data, FileCardV1Input } from "./protocol/file-card-v1.js"

export type FileCardData = FileCardV1Data
export type FileCardInput = FileCardV1Input

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

export const FILE_CARD_PREFIX = FILE_CARD_V1_TYPE
export const FILE_CARD_CURRENT_VERSION = FILE_CARD_V1_VERSION

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
    return isFileCardV1Data(value)
}

export function createFileCardData(data: FileCardInput): FileCardData {
    const normalized = normalizeFileCardV1Data(data)
    if (!normalized) {
        throw new Error("Unsupported file-card data.")
    }
    return normalized
}

export function parseFileCardMessage(message: string): FileCardData | null {
    if (!message.startsWith(FILE_CARD_PREFIX)) {
        return null
    }

    try {
        const payload = JSON.parse(message.substring(message.indexOf("{")))
        return normalizeFileCardV1Data(payload)
    } catch {
        return null
    }
}

export function serializeFileCardMessage(data: FileCardInput) {
    return `${FILE_CARD_PREFIX}\n${serializeFileCardV1Data(data)}`
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
    return `${FILE_CARD_PREFIX} ${query.trim()}`.trim()
}

export function buildFileCardUfidLookupQuery(ufid: string) {
    return `${FILE_CARD_PREFIX} "ufid":"${ufid.trim()}"`
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
