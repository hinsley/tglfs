import type { TelegramClient } from "telegram"

import { CliError, EXIT_CODES } from "./errors.js"
import {
    buildFileCardUfidLookupQuery,
    parseFileCardMessage,
} from "./shared/file-cards.js"
import type { FileCardData, FileCardRecord } from "./types.js"

export { parseFileCardMessage } from "./shared/file-cards.js"

export function validateDownloadableFileCard(data: FileCardData) {
    if (!data.uploadComplete) {
        throw new CliError(
            "invalid_file_card",
            "The requested file is not marked as fully uploaded.",
            EXIT_CODES.INVALID_FILE_CARD,
        )
    }

    if (data.ufid.trim() === "" || data.name.trim() === "" || data.IV.trim() === "") {
        throw new CliError(
            "invalid_file_card",
            "The requested file card is missing required metadata.",
            EXIT_CODES.INVALID_FILE_CARD,
        )
    }

    if (data.size < 0 || !Number.isFinite(data.size) || data.chunks.length === 0) {
        throw new CliError(
            "invalid_file_card",
            "The requested file card is malformed or unsupported.",
            EXIT_CODES.INVALID_FILE_CARD,
        )
    }
}

export async function getFileCardByUfid(client: TelegramClient, ufid: string): Promise<FileCardRecord> {
    const trimmed = ufid.trim()
    if (trimmed === "") {
        throw new CliError("invalid_ufid", "UFID must not be empty.", EXIT_CODES.GENERAL_ERROR)
    }

    const messages = await client.getMessages("me", {
        search: buildFileCardUfidLookupQuery(trimmed),
        limit: 10,
        waitTime: 0,
    })

    const match = messages.find((message) => typeof message.message === "string" && parseFileCardMessage(message.message))
    if (!match || typeof match.message !== "string") {
        throw new CliError(
            "file_not_found",
            `No TGLFS file card was found for UFID ${trimmed}.`,
            EXIT_CODES.FILE_NOT_FOUND,
        )
    }

    const data = parseFileCardMessage(match.message)
    if (!data) {
        throw new CliError(
            "invalid_file_card",
            `The file card for UFID ${trimmed} is unreadable.`,
            EXIT_CODES.INVALID_FILE_CARD,
        )
    }

    validateDownloadableFileCard(data)
    return {
        msgId: match.id,
        date: match.date,
        data,
    }
}
