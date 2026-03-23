import type { TelegramClient } from "telegram"

import { CliError, EXIT_CODES } from "./errors.js"
import {
    parseFileCardMessage,
} from "./shared/file-cards.js"
import { lookupFileCardByUfid } from "./shared/telegram-files.js"
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

export async function getFileCardByUfid(client: TelegramClient, ufid: string, peer = "me"): Promise<FileCardRecord> {
    const trimmed = ufid.trim()
    if (trimmed === "") {
        throw new CliError("invalid_ufid", "UFID must not be empty.", EXIT_CODES.GENERAL_ERROR)
    }

    const match = await lookupFileCardByUfid(client as any, trimmed, { peer })
    if (!match) {
        throw new CliError(
            "file_not_found",
            `No TGLFS file card was found for UFID ${trimmed} in ${peer === "me" ? "Saved Messages" : peer}.`,
            EXIT_CODES.FILE_NOT_FOUND,
        )
    }

    validateDownloadableFileCard(match.data)
    return match
}
