import type { TelegramClient } from "telegram/client/TelegramClient.js"

import {
    buildFileCardSearchQuery,
    extractFileCardRecords,
    FILE_CARD_SEARCH_SORT_VALUES,
    formatFileCardDate,
    formatFileCardSize,
    sortFileCardRecords,
} from "./shared/file-cards.js"
import type { FileCardRecord, FileCardSearchSort } from "./shared/file-cards.js"

export { FILE_CARD_SEARCH_SORT_VALUES } from "./shared/file-cards.js"
export type { FileCardSearchSort } from "./shared/file-cards.js"

export type SearchFileCardsOptions = {
    query?: string
    limit?: number
    offsetId?: number
    sort?: FileCardSearchSort
}

export type SearchFileCardsResult = {
    query: string
    sort: FileCardSearchSort
    limit: number
    offsetId?: number
    nextOffsetId?: number
    hasMore: boolean
    results: FileCardRecord[]
}

const DEFAULT_SEARCH_LIMIT = 50

function shellQuote(value: string) {
    if (value === "") {
        return "''"
    }
    return `'${value.replace(/'/g, `'\\''`)}'`
}

function padCell(value: string, width: number) {
    return value.padEnd(width, " ")
}

export async function searchFileCards(client: TelegramClient, options: SearchFileCardsOptions = {}): Promise<SearchFileCardsResult> {
    const query = options.query?.trim() ?? ""
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
    const sort = options.sort ?? FILE_CARD_SEARCH_SORT_VALUES[0]
    const offsetId = options.offsetId

    const messages = await client.getMessages("me", {
        search: buildFileCardSearchQuery(query),
        limit,
        addOffset: 0,
        minId: 0,
        maxId: offsetId ?? 0,
        waitTime: 0,
    } as any)

    const rawResults = extractFileCardRecords(messages)
    const results = rawResults.slice()
    sortFileCardRecords(results, sort)

    return {
        query,
        sort,
        limit,
        offsetId,
        nextOffsetId: rawResults.length === limit ? rawResults.at(-1)?.msgId : undefined,
        hasMore: rawResults.length === limit,
        results,
    }
}

export function formatSearchResultsTable(result: SearchFileCardsResult) {
    if (result.results.length === 0) {
        return result.query === ""
            ? "No TGLFS files found."
            : `No TGLFS files found for query ${shellQuote(result.query)}.`
    }

    const headers = ["Name", "Size", "Date", "UFID", "Status"]
    const rows = result.results.map((record) => [
        record.data.name,
        formatFileCardSize(record.data.size),
        formatFileCardDate(record.date),
        record.data.ufid,
        record.data.uploadComplete ? "Complete" : "Incomplete",
    ])

    const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)))
    const lines = [
        headers.map((header, index) => padCell(header, widths[index])).join("  "),
        widths.map((width) => "-".repeat(width)).join("  "),
        ...rows.map((row) => row.map((cell, index) => padCell(cell, widths[index])).join("  ")),
        "",
        `Showing ${result.results.length} result(s).`,
    ]

    if (result.hasMore && result.nextOffsetId !== undefined) {
        const parts = ["tglfs", "search"]
        if (result.query !== "") {
            parts.push(shellQuote(result.query))
        }
        parts.push("--limit", String(result.limit), "--offset-id", String(result.nextOffsetId))
        if (result.sort !== FILE_CARD_SEARCH_SORT_VALUES[0]) {
            parts.push("--sort", result.sort)
        }
        lines.push(`Next page: ${parts.join(" ")}`)
    }

    return lines.join("\n")
}
