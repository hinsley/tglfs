import { FILE_CARD_TYPE, normalizeFileCardV1Data } from "./protocol/file-card-v1.js"
import type { NormalizedFileCardV1Data } from "./protocol/file-card-v1.js"
import {
    normalizeFileCardV2Data,
} from "./protocol/file-card-v2.js"
import type { FileCardV2Data, FileCardV2Input } from "./protocol/file-card-v2.js"
import {
    createFileCardV3Data,
    FILE_CARD_V3_VERSION,
    normalizeFileCardV3Data,
} from "./protocol/file-card-v3.js"
import type { FileCardV3Data, FileCardV3Input } from "./protocol/file-card-v3.js"
import {
    createFileCardV4Data,
    FILE_CARD_V4_VERSION,
    normalizeFileCardV4Data,
} from "./protocol/file-card-v4.js"
import type { FileCardV4Data, FileCardV4Input } from "./protocol/file-card-v4.js"

export type FileCardData = NormalizedFileCardV1Data | FileCardV2Data | FileCardV3Data | FileCardV4Data
export type FileCardInput = FileCardData | FileCardV3Input | FileCardV2Input | FileCardV4Input
export type { FileCardV4Data, FileCardV4Input, ArchiveUpgradeSource } from "./protocol/file-card-v4.js"
export { createFileCardV4Data } from "./protocol/file-card-v4.js"

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

export const FILE_CARD_PREFIX = FILE_CARD_TYPE
export const FILE_CARD_CURRENT_VERSION = FILE_CARD_V3_VERSION
export const FILE_CARD_ARCHIVE_VERSION = FILE_CARD_V4_VERSION

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
    return normalizeFileCardV1Data(value) !== null || normalizeFileCardV2Data(value) !== null || normalizeFileCardV3Data(value) !== null || normalizeFileCardV4Data(value) !== null
}

export function createFileCardData(data: FileCardInput): FileCardData {
    if ("version" in data && data.version === FILE_CARD_V4_VERSION) return createFileCardV4Data(data)
    if ("version" in data && data.version !== undefined && ![1, 2, 3].includes(data.version)) {
        throw new Error("Unsupported file-card protocol version.")
    }
    return createFileCardV3Data(data)
}

export function parseFileCardMessage(message: string): FileCardData | null {
    if (!message.startsWith(FILE_CARD_PREFIX)) {
        return null
    }

    try {
        const payload = JSON.parse(message.substring(message.indexOf("{")))
        return normalizeFileCardV4Data(payload) ?? normalizeFileCardV3Data(payload) ?? normalizeFileCardV2Data(payload) ?? normalizeFileCardV1Data(payload)
    } catch {
        return null
    }
}

export function serializeFileCardMessage(data: FileCardInput) {
    let payload: object
    const version = "version" in data ? data.version : undefined
    if (version === 1) {
        const { type: _type, version: _version, ...stored } = data as NormalizedFileCardV1Data
        if (_type !== FILE_CARD_TYPE || !normalizeFileCardV1Data(stored)) throw new Error("Malformed file-card protocol version 1.")
        payload = stored
    } else if (version === 2 || version === 3 || version === 4) {
        const normalized = version === 4 ? normalizeFileCardV4Data(data) :
            version === 3 ? normalizeFileCardV3Data(data) : normalizeFileCardV2Data(data)
        if (!normalized) throw new Error(`Malformed file-card protocol version ${version}.`)
        payload = normalized
    } else if (version === undefined) {
        payload = createFileCardV3Data(data)
    } else {
        throw new Error("Unsupported file-card protocol version.")
    }
    return `${FILE_CARD_PREFIX}\n${JSON.stringify(payload)}`
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

export function buildFileCardParentSearchQuery(parentFolderId: string, query = "") {
    return buildFileCardSearchQuery(`"parentFolderId":"${parentFolderId.trim()}" ${query.trim()}`.trim())
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
