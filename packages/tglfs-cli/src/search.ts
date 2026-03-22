import type { TelegramClient } from "telegram/client/TelegramClient.js"

import {
    FILE_CARD_SEARCH_SORT_VALUES,
    formatFileCardDate,
    formatFileCardSize,
    sortFileCardRecords,
} from "./shared/file-cards.js"
import type { FileCardRecord, FileCardSearchSort } from "./shared/file-cards.js"
import { listFileCards } from "./shared/telegram-files.js"

export { FILE_CARD_SEARCH_SORT_VALUES } from "./shared/file-cards.js"
export type { FileCardSearchSort } from "./shared/file-cards.js"

export type SearchFileCardsOptions = {
    peer?: string
    query?: string
    limit?: number
    offsetId?: number
    sort?: FileCardSearchSort
}

export type SearchFileCardsResult = {
    peer: string
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
    const peer = options.peer?.trim() || "me"
    const query = options.query?.trim() ?? ""
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
    const sort = options.sort ?? FILE_CARD_SEARCH_SORT_VALUES[0]
    const offsetId = options.offsetId

    const rawResults = await listFileCards(client as any, {
        peer,
        query,
        limit,
        offsetId,
    })
    const results = rawResults.slice()
    sortFileCardRecords(results, sort)

    return {
        peer,
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
    const peer = result.peer ?? "me"
    if (result.results.length === 0) {
        const location = peer === "me" ? "Saved Messages" : peer
        return result.query === ""
            ? peer === "me"
                ? "No TGLFS files found."
                : `No TGLFS files found in ${location}.`
            : `No TGLFS files found for query ${shellQuote(result.query)} in ${location}.`
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
        if (peer !== "me") {
            parts.push("--peer", shellQuote(peer))
        }
        parts.push("--limit", String(result.limit), "--offset-id", String(result.nextOffsetId))
        if (result.sort !== FILE_CARD_SEARCH_SORT_VALUES[0]) {
            parts.push("--sort", result.sort)
        }
        lines.push(`Next page: ${parts.join(" ")}`)
    }

    return lines.join("\n")
}
