/**
 * Telegram client methods.
 * @module Telegram
 */

// TODO: Add `tglfs:chunk` annotation to chunk files.

import type { Api as TelegramApi, TelegramClient } from "telegram"

import * as Config from "./config"
import { requestConfirm, requestText, showToast } from "./web/dialogs"
import { getGramJs } from "./gramjs"
import {
    buildFileCardSearchQuery,
    buildFileCardUfidLookupQuery,
    createFileCardData,
    FILE_CARD_PREFIX,
    extractFileCardRecords,
    formatFileCardDate,
    formatFileCardSize,
    parseFileCardMessage,
    serializeFileCardMessage,
} from "../packages/tglfs-cli/src/shared/file-cards"
import { TGLFS_ROOT_PARENT_ID } from "../packages/tglfs-cli/src/shared/constants"
import { planDirectoryParentMigration } from "../packages/tglfs-cli/src/shared/directory-migration"
import { extractTelegramFloodWaitSeconds } from "../packages/tglfs-cli/src/shared/telegram-rate-limit"
import {
    TELEGRAM_WEB_DC_ENDPOINTS,
    getTelegramWebDcEndpoint,
    getTelegramWebDcFallbackHosts,
    isTelegramWebDcConnectionError,
} from "../packages/tglfs-cli/src/shared/telegram-web-dc"
import {
    TGLFS_FOLDER_ENTRIES_MIME_TYPE,
    TGLFS_FOLDER_MANIFEST_TYPE,
    TGLFS_FOLDER_TYPE,
    buildFolderManifestSearchQuery,
    buildFolderParentSearchQuery,
    buildFolderSearchQuery,
    compactTglfsFolderManifest,
    createTglfsFolderEntriesFileName,
    serializeTglfsFolderManifestMessage,
    hashTglfsFolderEntries,
    parseTglfsFolderEntriesJson,
    serializeTglfsFolderEntriesJson,
    serializeTglfsFolderMessage,
    toTglfsFolderEntriesManifest,
    toLegacyTglfsFolderManifest,
    extractTglfsFolderManifestRecord,
    extractTglfsFolderRecord,
} from "../packages/tglfs-cli/src/folders"
import type { TglfsFolder, TglfsFolderManifest, TglfsFolderManifestRecord, TglfsFolderRecord } from "../packages/tglfs-cli/src/folders"
import type { FileCardRecord } from "../packages/tglfs-cli/src/shared/file-cards"
import {
    countFileCards as sharedCountFileCards,
    deleteFileCardMessages as sharedDeleteFileCardMessages,
    listFileCards as sharedListFileCards,
    lookupFileCardByUfid as sharedLookupFileCardByUfid,
    renameFileCardMessage as sharedRenameFileCardMessage,
    transferFileCard as sharedTransferFileCard,
} from "../packages/tglfs-cli/src/shared/telegram-files"
import * as Encryption from "./web/encryption"
import * as Transfers from "./web/transfers"
import * as FileProcessing from "./web/fileProcessing"
import * as Archive from "../packages/tglfs-cli/src/shared/archive"
import * as UploadResume from "../packages/tglfs-cli/src/shared/upload-resume"
import * as UploadPipeline from "../packages/tglfs-cli/src/shared/upload-pipeline"
import { FileCardData } from "./types/models"

let Api!: typeof import("telegram")["Api"]
let TelegramClientCtor!: typeof import("telegram")["TelegramClient"]
let StoreSession!: typeof import("telegram/sessions")["StoreSession"]
let PromisedWebSocketsCtor!: typeof import("telegram/extensions")["PromisedWebSockets"]
let getFileInfo!: typeof import("telegram/Utils")["getFileInfo"]

const gramJsReady = getGramJs().then((modules) => {
    Api = modules.Api
    TelegramClientCtor = modules.TelegramClient
    StoreSession = modules.StoreSession
    PromisedWebSocketsCtor = modules.PromisedWebSockets
    getFileInfo = modules.getFileInfo
})

// https://core.telegram.org/api/files
// DOWNLOAD_PART_SIZE must be divisible by 4 KiB (Telegram policy).
// DOWNLOAD_PART_SIZE must divide 1 MiB (Telegram policy).
// DOWNLOAD_PART_SIZE must divide `Config.chunkSize` (to be safe, 2 GiB). Subject to change.
// DOWNLOAD_PART_SIZE must divide `Encryption.ENCRYPTION_CHUNK_SIZE`. Subject to change.
const DOWNLOAD_PART_SIZE = 1024 * 1024 // 1 MiB.
// UPLOAD_PART_SIZE must be divisible by 1 KiB (Telegram policy).
// UPLOAD_PART_SIZE must divide 512 KiB (Telegram policy).
const UPLOAD_PART_SIZE = 512 * 1024 // 512 KiB.
const BATCH_LIMIT = 50 // How many messages to manipulate at a time with forwarding/deletion.
const BATCH_DELAY = 1000 // How many milliseconds to wait before processing the next batch (may prevent spam bans).
const DIRECTORY_MIGRATION_EDIT_DELAY_MS = 60_000
const DIRECTORY_MIGRATION_FLOOD_WAIT_PADDING_MS = 10_000
const DIRECTORY_MIGRATION_RECOVERY_EDIT_DELAY_MS = 120_000
const TELEGRAM_WEB_DC_START_TIMEOUT_MS = 10_000

// FileCardData is defined in src/types/models.ts.

function parseTelegramFileCardMessage(message: unknown): FileCardData {
    if (typeof message !== "string") {
        throw new Error("File card message is missing.")
    }
    const data = parseFileCardMessage(message)
    if (!data) {
        throw new Error("File card message is malformed or unsupported.")
    }
    return data
}

// TODO: Move this function to a more appropriate place.
function bytesToBase64(bytes: Uint8Array) {
    const binString = Array.from(bytes, (byte: number) => String.fromCodePoint(byte)).join("")
    return btoa(binString)
}

// TODO: Move this function to a more appropriate place.
function base64ToBytes(base64: string) {
    const binString = atob(base64)
    return Uint8Array.from(binString, (char: string) => {
        const code = char.codePointAt(0)
        if (code === undefined) {
            throw new Error("Invalid character in base64 string")
        }
        return code
    })
}

// TODO: Move this function to a more appropriate place.
function humanReadableSize(size: number): string {
    const i = Math.floor(Math.log(size) / Math.log(1024))
    const sizes = ["bytes", "KiB", "MiB", "GiB", "TiB"]
    return (size / Math.pow(1024, i)).toFixed(i == 0 ? 0 : 2) + " " + sizes[i]
}

function getFileExtension(name: string): string {
    const lastDot = name.lastIndexOf(".")
    if (lastDot < 0 || lastDot === name.length - 1) {
        return ""
    }
    return name.slice(lastDot + 1).toLowerCase()
}

function isPotentialStreamingRemuxCandidate(file: File): boolean {
    const extension = getFileExtension(file.name)
    const mimeType = file.type.toLowerCase()
    return (
        extension === "mp4" ||
        extension === "m4v" ||
        extension === "mov" ||
        extension === "qt" ||
        mimeType === "video/mp4" ||
        mimeType === "application/mp4" ||
        mimeType === "video/quicktime"
    )
}

type ServiceWorkerDownloadPump = {
    write: (chunk: Uint8Array) => Promise<void>
    close: () => Promise<void>
    abort: (reason?: unknown) => Promise<void>
}

function normalizeDownloadStreamError(error: unknown): Error {
    if (error instanceof TypeError) {
        return new Error("Incorrect decryption password.")
    }
    if (error instanceof Error) {
        return error
    }
    return new Error(String(error))
}

function createServiceWorkerDownloadPump(
    serviceWorkerRegistration: ServiceWorkerRegistration,
    fileName: string,
    byteCounterStream: TransformStream<Uint8Array, Uint8Array>,
): ServiceWorkerDownloadPump {
    serviceWorkerRegistration.active?.postMessage({
        type: "SET_FILE_NAME",
        fileName,
    })

    const decompressionStream = new DecompressionStream("gzip")
    const writer = decompressionStream.writable.getWriter()
    const reader = decompressionStream.readable.pipeThrough(byteCounterStream).getReader()
    const pumpPromise = (async () => {
        while (true) {
            const { value, done } = await reader.read()
            if (done) {
                break
            }
            if (!value || value.length === 0) {
                continue
            }
            const transferableChunk =
                value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice()
            serviceWorkerRegistration.active?.postMessage(
                {
                    type: "PROCESSED_DATA",
                    data: transferableChunk,
                },
                [transferableChunk.buffer],
            )
        }
    })()

    return {
        async write(chunk) {
            try {
                await writer.write(chunk)
            } catch (error) {
                throw normalizeDownloadStreamError(error)
            }
        },
        async close() {
            let writerError: unknown = null
            try {
                await writer.close()
            } catch (error) {
                writerError = error
            }

            let readerError: unknown = null
            try {
                await pumpPromise
            } catch (error) {
                readerError = error
            }

            if (writerError) {
                throw normalizeDownloadStreamError(writerError)
            }
            if (readerError) {
                throw normalizeDownloadStreamError(readerError)
            }
        },
        async abort(reason) {
            try {
                await writer.abort(reason)
            } catch {}
            try {
                await pumpPromise
            } catch {}
        },
    }
}

export async function fileDelete(client: TelegramClient, config: Config.Config) {
    await gramJsReady
    const fileUfid = prompt("Enter UFID of file to delete:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: buildFileCardUfidLookupQuery(fileUfid),
    })
    if (msgs.length === 0) {
        throw new Error("File not found.")
    }

    const fileCardData = parseTelegramFileCardMessage(msgs[0].message)

    const humanReadableFileSize = humanReadableSize(fileCardData.size)
    const date = new Date(msgs[0].date * 1000)
    const formattedDate = date
        .toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        })
        .replace(",", "") // Remove the comma between date and time.

    const fileInfo = `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`

    const confirmation = confirm(`Delete file?\n\n${fileInfo}`)
    if (!confirmation) {
        alert("Operation cancelled.")
        return
    }
    const result = await client.invoke(
        new Api.messages.DeleteMessages({
            id: [...fileCardData.chunks, msgs[0].id], // Delete chunk messages and file card message.
        }),
    )
    if (result) {
        alert(`File ${fileCardData.name} successfully deleted.`)
    } else {
        alert(`Failed to delete file ${fileCardData.name}.`)
    }
}

function formatFileCardInfo(fileCardData: FileCardData, epochSeconds: number) {
    const humanReadableFileSize = humanReadableSize(fileCardData.size)
    const date = new Date(epochSeconds * 1000)
    const formattedDate = date
        .toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        })
        .replace(",", "") // Remove the comma between date and time.

    return `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`
}

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000
const SERVICE_WORKER_UNAVAILABLE_MESSAGE =
    "Downloads need the TGLFS service worker, which isn't running. Reload the page and try again."

/** Waits for the download service worker, failing fast instead of blocking the transfer queue forever. */
async function waitForDownloadServiceWorker(signal: AbortSignal): Promise<ServiceWorkerRegistration> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        throw new Error(SERVICE_WORKER_UNAVAILABLE_MESSAGE)
    }
    const registration = await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        const cleanup = () => {
            globalThis.clearTimeout(timer)
            signal.removeEventListener("abort", onAbort)
        }
        const onAbort = () => {
            cleanup()
            reject(Transfers.abortError())
        }
        const timer = globalThis.setTimeout(() => {
            cleanup()
            reject(new Error(SERVICE_WORKER_UNAVAILABLE_MESSAGE))
        }, SERVICE_WORKER_READY_TIMEOUT_MS)
        signal.addEventListener("abort", onAbort, { once: true })
        navigator.serviceWorker.ready.then(
            (ready) => {
                cleanup()
                resolve(ready)
            },
            (error) => {
                cleanup()
                reject(error)
            },
        )
    })
    if (!registration.active || !navigator.serviceWorker.controller) {
        throw new Error(SERVICE_WORKER_UNAVAILABLE_MESSAGE)
    }
    return registration
}

/**
 * Streams a file card's chunks from Telegram, decrypts and decompresses them, and hands the plaintext to the
 * service worker download stream. Runs inside a transfer-queue slot (the service worker download stream is a
 * single global stream, so downloads must never overlap).
 *
 * `legacy` selects the old counter scheme (increment by 1 per 1 MiB block) and skips UFID verification.
 */
async function runServiceWorkerDownload(
    client: TelegramClient,
    fileCardData: FileCardData,
    password: string,
    transfer: Transfers.TransferHandle,
    options: { legacy: boolean },
) {
    await gramJsReady
    const legacy = options.legacy
    transfer.setPhase(null, { total: fileCardData.size })

    // Request chunk messages by their IDs in the file card.
    const chunkMsgs: TelegramApi.messages.Messages = await client.getMessages("me", { ids: fileCardData.chunks })
    transfer.throwIfCancelled()

    const IVBytes = base64ToBytes(fileCardData.IV)
    // TODO: DRY-ify the salt & counter byte size. Should be
    // module-level constants.
    const salt = IVBytes.subarray(0, 16)
    const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt)
    let decryptionCounter = IVBytes.slice(16)

    let aesBlockBytesWritten = 0
    const decryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)

    let bytesProcessed = 0
    // For streaming UFID verification.
    const UFIDChunkSize = 64 * 1024 // 64 KiB.
    let ufidRolling = new Uint8Array(0)
    let ufidPending = new Uint8Array(0)
    const byteCounterStream = new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
            bytesProcessed += chunk.length
            transfer.update({ bytes: bytesProcessed })
            if (!legacy) {
                // Accumulate data and process in fixed 64 KiB blocks.
                const combined = new Uint8Array(ufidPending.length + chunk.length)
                combined.set(ufidPending, 0)
                combined.set(chunk, ufidPending.length)
                let offset = 0
                while (offset + UFIDChunkSize <= combined.length) {
                    const piece = combined.subarray(offset, offset + UFIDChunkSize)
                    const toHash = new Uint8Array(ufidRolling.length + UFIDChunkSize)
                    toHash.set(ufidRolling, 0)
                    toHash.set(piece, ufidRolling.length)
                    const hash = await window.crypto.subtle.digest("SHA-256", toHash.buffer)
                    ufidRolling = new Uint8Array(hash)
                    offset += UFIDChunkSize
                }
                // Save remainder for finalization.
                ufidPending = combined.subarray(offset)
            }
            controller.enqueue(chunk)
        },
    })

    const advanceCounter = (bytesDecrypted: number) => {
        // Legacy behavior: increment the counter by 1 per 1 MiB block (and once for the trailing block set).
        decryptionCounter = legacy
            ? Encryption.incrementCounter(decryptionCounter)
            : Encryption.incrementCounter64By(decryptionCounter, Math.ceil(bytesDecrypted / 16))
    }

    async function downloadFile(serviceWorkerRegistration: ServiceWorkerRegistration) {
        const downloadPump = createServiceWorkerDownloadPump(
            serviceWorkerRegistration,
            fileCardData.name,
            byteCounterStream,
        )
        let streamError: unknown = null
        try {
            // Download each chunk.
            for (const chunkMsg of chunkMsgs) {
                let chunkBytesWritten = 0
                while (chunkBytesWritten < (chunkMsg as any).media.document.size) {
                    // Stop between parts when the user cancels.
                    transfer.throwIfCancelled()
                    // Download the next (up to) `DOWNLOAD_PART_SIZE` bytes of the chunk file.
                    const chunkPart = await client.invoke(
                        new Api.upload.GetFile({
                            location: getFileInfo((chunkMsg as any).media).location,
                            offset: chunkBytesWritten,
                            limit: DOWNLOAD_PART_SIZE,
                            precise: false,
                            cdnSupported: false,
                        }),
                    )
                    const partBytes = (chunkPart as any).bytes as Uint8Array
                    chunkBytesWritten += partBytes.length

                    // Write the chunk part to the decryption buffer.
                    decryptionBuffer.set(partBytes, aesBlockBytesWritten)
                    aesBlockBytesWritten += partBytes.length

                    // If the decryption buffer is full, decrypt.
                    if (aesBlockBytesWritten === decryptionBuffer.length) {
                        const decryptedData = new Uint8Array(
                            await window.crypto.subtle.decrypt(
                                {
                                    name: "AES-CTR",
                                    counter: decryptionCounter,
                                    length: 64, // Bit length of the counter block.
                                },
                                aesKey,
                                decryptionBuffer,
                            ),
                        )
                        // Advance counter by number of 16-byte blocks consumed in this call.
                        advanceCounter(decryptionBuffer.length)
                        aesBlockBytesWritten = 0

                        await downloadPump.write(decryptedData)
                    }
                }
            }

            // If there is any data left in the decryption buffer, process it.
            if (aesBlockBytesWritten > 0) {
                // Decrypt the remaining data.
                const decryptedData = new Uint8Array(
                    await window.crypto.subtle.decrypt(
                        {
                            name: "AES-CTR",
                            counter: decryptionCounter,
                            length: 64, // Bit length of the counter block.
                        },
                        aesKey,
                        decryptionBuffer.subarray(0, aesBlockBytesWritten),
                    ),
                )
                // Advance counter by exact number of 16-byte blocks from the trailing bytes.
                advanceCounter(aesBlockBytesWritten)

                await downloadPump.write(decryptedData)
            }

            await downloadPump.close()
        } catch (error) {
            streamError = error
            await downloadPump.abort(error)
        } finally {
            serviceWorkerRegistration.active?.postMessage({
                type: "DOWNLOAD_COMPLETE",
            })
        }

        if (streamError) {
            throw streamError
        }
        if (legacy) {
            return true
        }

        // Finalize UFID with zero-padded remainder, then verify.
        if (ufidPending.length > 0) {
            const padded = new Uint8Array(UFIDChunkSize)
            padded.set(ufidPending, 0)
            const toHash = new Uint8Array(ufidRolling.length + UFIDChunkSize)
            toHash.set(ufidRolling, 0)
            toHash.set(padded, ufidRolling.length)
            const hash = await window.crypto.subtle.digest("SHA-256", toHash.buffer)
            ufidRolling = new Uint8Array(hash)
            ufidPending = new Uint8Array(0)
        }
        const computedUfid = Array.from(ufidRolling)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
        return computedUfid === fileCardData.ufid
    }

    const serviceWorkerRegistration = await waitForDownloadServiceWorker(transfer.signal)

    const sanitizedUfid = encodeURIComponent(fileCardData.ufid)
    const response = await fetch("/download-file?ufid=" + sanitizedUfid)
    if (!response.ok) {
        throw new Error("Failed to start the download.")
    }

    const ufidVerified = await downloadFile(serviceWorkerRegistration)

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileCardData.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    if (ufidVerified) {
        transfer.complete({ ufid: fileCardData.ufid })
    } else {
        transfer.complete({
            ufid: fileCardData.ufid,
            tone: "warning",
            message: "Saved, but the UFID check failed — the file may be corrupted or the password was wrong",
        })
    }
}

/** Queues a file-card download. Ask for the password before calling this so the queue never waits on a dialog. */
function enqueueFileCardDownload(
    client: TelegramClient,
    fileCardData: FileCardData,
    password: string,
    options: { legacy?: boolean } = {},
) {
    void Transfers.enqueue(
        {
            direction: "download",
            name: fileCardData.name,
            size: fileCardData.size,
            meta: { ufid: fileCardData.ufid, legacy: !!options.legacy },
        },
        (transfer) => runServiceWorkerDownload(client, fileCardData, password, transfer, { legacy: !!options.legacy }),
    ).catch((error) => console.warn("Download failed:", error))
}

export async function fileDownload(client: TelegramClient, config: Config.Config) {
    await gramJsReady
    // TODO: Implement file validation via UFID comparison.
    const fileUfid = prompt("Enter UFID of file to download:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: buildFileCardUfidLookupQuery(fileUfid),
    })
    if (msgs.length === 0) {
        alert("File not found.")
        return
    }

    const fileCardData = parseTelegramFileCardMessage(msgs[0].message)
    // TODO: Verify that uploadComplete field is set to `true`.

    const fileInfo = formatFileCardInfo(fileCardData, msgs[0].date)

    const confirmation = confirm(`Download file?\n\n${fileInfo}`)
    if (!confirmation) {
        alert("Operation cancelled.")
        return
    }

    const password = prompt("(Optional) Decryption password:")
    if (password === null) {
        alert("Operation cancelled.")
        return
    }

    enqueueFileCardDownload(client, fileCardData, password)
}

// TODO: Remove the legacy download pipeline after all existing files have been ported to the new scheme.
export async function fileDownloadLegacy(client: TelegramClient, config: Config.Config) {
    await gramJsReady
    // TODO: Implement file validation via UFID comparison.
    const fileUfid = prompt("Enter UFID of file to download (legacy):")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: buildFileCardUfidLookupQuery(fileUfid),
    })
    if (msgs.length === 0) {
        alert("File not found.")
        return
    }

    const fileCardData = parseTelegramFileCardMessage(msgs[0].message)
    // TODO: Verify that uploadComplete field is set to `true`.

    const fileInfo = formatFileCardInfo(fileCardData, msgs[0].date)

    const confirmation = confirm(`Download file (legacy pipeline)?\n\n${fileInfo}`)
    if (!confirmation) {
        alert("Operation cancelled.")
        return
    }

    const password = prompt("(Optional) Decryption password:")
    if (password === null) {
        alert("Operation cancelled.")
        return
    }

    enqueueFileCardDownload(client, fileCardData, password, { legacy: true })
}

export async function fileLookup(client: TelegramClient, config: Config.Config) {
    const query = window.prompt("Search query (filename or UFID):")
    if (query === null) {
        return
    }
    const msgs = await client.getMessages("me", {
        search: buildFileCardSearchQuery(query),
        waitTime: 0,
    })
    let response = `Lookup results for "${query}":`
    const fileCards: FileCardData[] = []
    for (const record of extractFileCardRecords(msgs)) {
        const fileCardData = record.data
        fileCards.push(fileCardData)

        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${formatFileCardSize(fileCardData.size)}\nTimestamp: ${formatFileCardDate(record.date)}`
    }
    if (fileCards.length == 0) {
        alert(`No results found for "${query}".`)
        return
    }
    let selection = 1
    if (fileCards.length == 1) {
        response += "\n\nCopying UFID to clipboard."
        alert(response)
    } else {
        response += `\n\nChoose a file (1-${fileCards.length}) to copy UFID to clipboard [1]:`
        const selectionString = prompt(response)
        if (selectionString !== null && selectionString.trim() !== "") {
            selection = parseInt(selectionString, 10)
            if (isNaN(selection) || selection < 1 || selection > fileCards.length) {
                selection = 1
            }
        }
    }
    const UFID = fileCards[selection - 1].ufid
    await navigator.clipboard.writeText(UFID)
}

export async function fileReceive(client: TelegramClient, config: Config.Config) {
    await gramJsReady
    const source = prompt("Enter sender or receipt location:")?.trim()
    if (!source) {
        alert("No sender or receipt location provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages(source, {
        search: buildFileCardSearchQuery(),
        waitTime: 0,
    })
    let response = `Available files from ${source}:`
    const fileRecords = extractFileCardRecords(msgs)
    const fileCards: FileCardData[] = []
    for (const record of fileRecords) {
        const fileCardData = record.data
        fileCards.push(fileCardData)

        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${formatFileCardSize(fileCardData.size)}\nTimestamp: ${formatFileCardDate(record.date)}`
    }
    if (fileCards.length == 0) {
        alert(`No files found at ${source}.`)
        return
    }
    response += `\n\nChoose a file (1-${fileCards.length}) to copy UFID to clipboard:`
    const selectionString = prompt(response)
    if (selectionString === null || selectionString.trim() === "") {
        alert("No selection provided. Operation cancelled.")
        return
    }
    const parsedSelection = parseInt(selectionString, 10)
    if (isNaN(parsedSelection) || parsedSelection < 1 || parsedSelection > fileCards.length) {
        alert("Invalid selection. Aborting.")
        return
    }
    const selection = parsedSelection - 1
    let result
    try {
        let newChunkIds: number[] = []
        // Forward chunk messages to Saved Messages in batches.
        await (async () => {
            for (let i = 0; i < fileCards[selection].chunks.length; i += BATCH_LIMIT) {
                try {
                    for (let j = i; j < Math.min(i + BATCH_LIMIT, fileCards[selection].chunks.length); j++) {
                        result = await client.invoke(
                            new Api.messages.ForwardMessages({
                                fromPeer: source,
                                toPeer: "me",
                                id: [fileCards[selection].chunks[j]],
                            }),
                        )
                        newChunkIds.push(result.updates[0].id)
                    }
                } catch (error: any) {
                    alert("Failed to receive some chunks:" + error.message)
                    return
                }
                await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY))
            }
        })()
        // Send updated file card to Saved Messages.
        fileCards[selection].chunks = newChunkIds
        result = await client.sendMessage("me", { message: serializeFileCardMessage(fileCards[selection]) })
    } catch (error: any) {
        alert("Failed to receive file:" + error.message)
        return
    }
    if (result) {
        alert(`File successfully received from ${source}.`)
    } else {
        alert("Failed to receive file.")
    }
}

export async function fileRename(client: TelegramClient, config: Config.Config) {
    await gramJsReady
    const fileUfid = prompt("Enter UFID of file to rename:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: buildFileCardUfidLookupQuery(fileUfid),
    })
    if (msgs.length === 0) {
        throw new Error("File not found.")
    }

    const fileCardData = parseTelegramFileCardMessage(msgs[0].message)

    const humanReadableFileSize = humanReadableSize(fileCardData.size)
    const date = new Date(msgs[0].date * 1000)
    const formattedDate = date
        .toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        })
        .replace(",", "") // Remove the comma between date and time.

    const fileInfo = `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`

    const newName = prompt(`Renaming file:\n\n${fileInfo}\n\nEnter new name:`)
    if (!newName || newName.trim() === "") {
        alert("No new name provided. Operation cancelled.")
        return
    }
    fileCardData.name = newName
    const result = await client.invoke(
        new Api.messages.EditMessage({
            peer: msgs[0].peerId,
            id: msgs[0].id,
            message: serializeFileCardMessage(fileCardData),
        }),
    )

    if (result) {
        alert(`File successfully renamed to ${newName}.`)
    } else {
        alert("Failed to rename file.")
    }
}

export async function fileSend(client: TelegramClient, config: Config.Config) {
    await gramJsReady
    const fileUfid = prompt("Enter UFID of file to send:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: buildFileCardUfidLookupQuery(fileUfid),
    })
    if (msgs.length === 0) {
        alert("File not found.")
        return
    }

    const fileCardData = parseTelegramFileCardMessage(msgs[0].message)

    const humanReadableFileSize = humanReadableSize(fileCardData.size)
    const date = new Date(msgs[0].date * 1000)
    const formattedDate = date
        .toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        })
        .replace(",", "") // Remove the comma between date and time.

    const fileInfo = `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`

    const fileRecipient = prompt(`Sending file:\n\n${fileInfo}\n\nEnter recipient:`)
    if (!fileRecipient || fileRecipient.trim() === "") {
        alert("No recipient provided. Operation cancelled.")
        return
    }

    let result
    try {
        let newChunkIds: number[] = []
        // Forward chunk messages in batches.
        await (async () => {
            for (let i = 0; i < fileCardData.chunks.length; i += BATCH_LIMIT) {
                try {
                    for (let j = i; j < Math.min(i + BATCH_LIMIT, fileCardData.chunks.length); j++) {
                        result = await client.invoke(
                            new Api.messages.ForwardMessages({
                                fromPeer: "me",
                                toPeer: fileRecipient,
                                id: [fileCardData.chunks[j]],
                                silent: true,
                            }),
                        )
                        newChunkIds.push(result.updates[0].id)
                    }
                } catch (error: any) {
                    alert("Failed to forward some chunks:" + error.message)
                    return
                }
                await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY))
            }
        })()
        // Send updated file card to recipient.
        fileCardData.chunks = newChunkIds
        result = await client.sendMessage(fileRecipient, { message: serializeFileCardMessage(fileCardData) })
    } catch (error: any) {
        alert("Failed to send file: " + error.message)
        return
    }
    if (result) {
        alert(`File successfully sent to ${fileRecipient}.`)
    } else {
        alert("Failed to send file.")
    }
}

export async function fileUnsend(client: TelegramClient, config: Config.Config) {
    await gramJsReady
    const source = prompt("Enter sender or receipt location:")?.trim()
    if (!source) {
        alert("No sender or receipt location provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages(source, {
        search: buildFileCardSearchQuery(),
    })
    let response = `Available files from ${source}:`
    const fileCards: FileCardData[] = []
    for (const record of extractFileCardRecords(msgs)) {
        const fileCardData = record.data
        fileCards.push(fileCardData)

        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${formatFileCardSize(fileCardData.size)}\nTimestamp: ${formatFileCardDate(record.date)}`
    }
    if (fileCards.length == 0) {
        alert(`No files found at ${source}.`)
        return
    }
    response += `\n\nChoose a file (1-${fileCards.length}) to copy UFID to clipboard:`
    const selectionString = prompt(response)
    let selection = NaN // Necessary to initialize to NaN for TypeScript not to complain.
    if (selectionString !== null && selectionString.trim() !== "") {
        selection = parseInt(selectionString, 10)
        if (isNaN(selection) || selection < 1 || selection > fileCards.length) {
            alert("Invalid selection. Aborting.")
            return
        }
        selection-- // Adjust to 0-based index.
    }
    // Unsend chunk messages in batches.
    await (async () => {
        for (let i = 0; i < fileCards[selection].chunks.length; i += BATCH_LIMIT) {
            const batch = fileCards[selection].chunks.slice(i, i + BATCH_LIMIT)
            try {
                await client.invoke(
                    new Api.messages.DeleteMessages({
                        id: batch,
                    }),
                )
            } catch (error: any) {
                alert("Failed to unsend some chunks:" + error.message)
                return
            }
            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY))
        }
    })()
    // Unsend file card.
    let result = await client.invoke(
        new Api.messages.DeleteMessages({
            id: [fileRecords[selection].msgId],
        }),
    )
    if (result) {
        alert(`File successfully unsent from ${source}.`)
    } else {
        alert("Failed to unsend file.")
    }
}
export function resolveUploadParentFolderId(
    options: { parentFolderId?: string } = {},
    browserContext: { browserWasVisible?: boolean; browserParentFolderId?: string } = {},
) {
    const explicitParentFolderId = options.parentFolderId?.trim()
    if (explicitParentFolderId) {
        return explicitParentFolderId
    }
    const browserParentFolderId = browserContext.browserWasVisible
        ? browserContext.browserParentFolderId?.trim()
        : undefined
    return browserParentFolderId || TGLFS_ROOT_PARENT_ID
}

/**
 * Runs `restoreUploadUi`, then (for completed uploads) asks the file browser to refresh. When `parentFolderId` is
 * given it rides along on the event as `tglfsParentFolderId`, so the browser can skip the refresh if the user is
 * looking at a different folder by the time a queued upload finishes.
 */
export function restoreUploadUiAndMaybeRefreshBrowser(
    restoreUploadUi: () => void,
    uploadCompleted: boolean,
    parentFolderId?: string,
) {
    restoreUploadUi()
    if (uploadCompleted) {
        const event = new Event("tglfs:refresh-browser")
        if (parentFolderId) {
            ;(event as Event & { tglfsParentFolderId?: string }).tglfsParentFolderId = parentFolderId
        }
        window.dispatchEvent(event)
    }
}

type VideoRemuxModule = typeof import("./web/videoRemux")

export type UploadJob = {
    files: File[]
    /** Encryption password ("" for none). Collected before the job is queued. */
    password: string
    /** Destination folder, captured when the upload was queued. */
    parentFolderId: string
    /** Archive name for multi-file uploads (defaults to a timestamped name when the job starts). */
    archiveName?: string
    /** Set when the user chose to optimize a single video for streaming. */
    remux?: { module: VideoRemuxModule; kind: import("./web/videoRemux").RemuxableVideoKind } | null
    /**
     * Resume this specific incomplete file card (the browser's "Resume upload…" action, already confirmed). Without
     * it, an upload whose UFID matches an incomplete card asks whether to resume that card instead.
     */
    resume?: { msgId: number; name?: string }
}

export type UploadJobResult = {
    msgId: number
    data: FileCardData
    parentFolderId: string
}

/**
 * Uploads `files` (one file, or several packed into a tar archive) inside a transfer-queue slot. Checks the
 * transfer's AbortSignal between upload parts; a cancelled upload stops exactly like a failed one, leaving the
 * incomplete file card as-is (no records are deleted or rewritten) — and resumable later.
 *
 * Resuming: when the content's UFID matches an incomplete card (or `job.resume` names one), the upload continues
 * into that card from its last completed chunk instead of failing as a duplicate. See `prepareResume` and
 * `packages/tglfs-cli/src/shared/upload-resume.ts` for what is verified before anything new is written.
 *
 * `options.span` maps this upload into a sub-range of the transfer's overall progress (used when the upload is
 * the last step of a longer task, e.g. "Make MP4 previewable").
 */
export async function runFileUploadJob(
    client: TelegramClient,
    config: Config.Config,
    job: UploadJob,
    transfer: Transfers.TransferHandle,
    options: { span?: [number, number] } = {},
): Promise<UploadJobResult> {
    await gramJsReady
    if (config.chunkSize < UPLOAD_PART_SIZE) {
        throw new Error(
            `config.chunkSize (${config.chunkSize}) must be larger than UPLOAD_PART_SIZE (${UPLOAD_PART_SIZE}).`,
        )
    }
    const [spanStart, spanEnd] = options.span ?? [0, 1]
    const sub = (from: number, to: number): [number, number] => [
        spanStart + (spanEnd - spanStart) * from,
        spanStart + (spanEnd - spanStart) * to,
    ]

    let files = job.files
    const single = files.length === 1
    let file = files[0]
    const parentFolderId = job.parentFolderId
    let prepareStart = 0

    if (single && job.remux) {
        const { module: remuxModule, kind: remuxKind } = job.remux
        transfer.setPhase("Optimizing for streaming", { span: sub(0, 0.3), total: 100, unit: "percent" })
        try {
            file = await remuxModule.remuxToStreamingMp4(file, remuxKind, (progress) => {
                transfer.update({ bytes: progress })
            })
        } catch (error) {
            transfer.throwIfCancelled()
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Couldn't optimize the video for streaming: ${message}`)
        }
        files = [file]
        transfer.update({ name: file.name, size: file.size })
        console.log(`Remuxed upload for streaming: ${file.name}`)
        prepareStart = 0.3
    }
    transfer.throwIfCancelled()

    let displayName: string
    let totalBytes: number
    let inputStream: ReadableStream<Uint8Array>
    let ufidStream: ReadableStream<Uint8Array> | null = null
    if (single) {
        displayName = file.name
        totalBytes = file.size
        inputStream = file.stream()
    } else {
        displayName = job.archiveName || Archive.defaultArchiveName()
        totalBytes = Archive.computeTarSize(files)
        const tarStream = Archive.createTarStream(files)
        const teed = tarStream.tee()
        ufidStream = teed[0]
        inputStream = teed[1]
    }
    if (job.resume?.name) displayName = job.resume.name
    transfer.update({ name: displayName, size: totalBytes })

    const uploadStart = prepareStart + (1 - prepareStart) * 0.05
    transfer.setPhase("Preparing", { span: sub(prepareStart, uploadStart), total: totalBytes })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const onUfidProgress = (bytesProcessed: number) => {
        // Throwing here aborts the UFID pass at the next 64 KiB block.
        transfer.throwIfCancelled()
        transfer.update({ bytes: bytesProcessed })
    }
    console.log(`Starting UFID generation for ${displayName}`)
    const UFID = single
        ? await FileProcessing.UFID(file, onUfidProgress)
        : await FileProcessing.UFIDFromStream(ufidStream!, onUfidProgress, totalBytes)
    console.log(`UFID generated for ${displayName}: ${UFID}`)
    transfer.throwIfCancelled()

    transfer.setPhase(null, { span: sub(uploadStart, 1), total: totalBytes })
    let bytesProcessed = 0

    // Is this content already stored, or is there an interrupted upload of it to resume?
    const existing = await findExistingUploads(client, UFID)
    transfer.throwIfCancelled()
    let resumeTarget: ExistingUpload | null = null
    if (job.resume) {
        resumeTarget = await fetchResumeTarget(client, job.resume.msgId)
        if (resumeTarget.data.ufid !== UFID) {
            transfer.update({ ufid: UFID })
            const message = UploadResume.describeResumeRefusal("ufid-mismatch")
            showToast(message, { durationMs: 6000 })
            throw new Error(message)
        }
        if (existing.complete) {
            transfer.update({ ufid: UFID })
            throw new Error("This file is already stored in full (duplicate UFID). The incomplete copy can be deleted.")
        }
    } else {
        if (existing.complete || existing.unreadable) {
            transfer.update({ ufid: UFID })
            throw new Error("A file with identical contents is already stored (duplicate UFID).")
        }
        resumeTarget = pickResumeCandidate(existing.incomplete)
        if (resumeTarget) {
            const stored = Math.min(resumeTarget.data.chunks.length * config.chunkSize, resumeTarget.data.size)
            const cardParent = parentFolderIdOfCard(resumeTarget.data)
            const elsewhere = cardParent !== undefined && cardParent !== parentFolderId
            const resume = await requestConfirm({
                title: "Resume interrupted upload?",
                message:
                    `${formatFileCardSize(stored)} of ${formatFileCardSize(resumeTarget.data.size)} already in Telegram.` +
                    (resumeTarget.data.name !== displayName ? ` It continues as “${resumeTarget.data.name}”.` : "") +
                    (elsewhere ? " It finishes in the folder where it was started." : ""),
                confirmLabel: "Resume",
                cancelLabel: "Cancel",
                icon: "cloudUp",
            })
            if (!resume) {
                transfer.markCancelled()
                throw Transfers.abortError("Upload skipped: an interrupted upload of this file exists.")
            }
        }
    }
    transfer.throwIfCancelled()

    // Progress reflects bytes actually stored in Telegram, not bytes read from disk: plaintext is read far ahead of
    // the upload (compression + the encryption buffer), so scale the plaintext read so far by the share of the
    // compressed stream that is stored. AES-CTR keeps ciphertext the same length as the compressed bytes.
    let compressedBytesRead = 0
    let storedBytesBefore = 0 // Ciphertext already in Telegram when this run started (resume only).
    let encryptedBytesSent = 0
    let uploading = true
    const reportUploadProgress = () => {
        if (!uploading) return
        const storedShare =
            compressedBytesRead > 0 ? Math.min(1, (storedBytesBefore + encryptedBytesSent) / compressedBytesRead) : 0
        transfer.update({ bytes: Math.round(bytesProcessed * storedShare) })
    }

    let cardWriter: UploadCardWriter
    let aesKey: CryptoKey
    let initialCounter: Uint8Array
    let pipelineResume: UploadPipeline.UploadPipelineResume | undefined
    let resultParentFolderId = parentFolderId

    if (resumeTarget) {
        const prepared = await prepareResume(client, config, resumeTarget, {
            ufid: UFID,
            size: totalBytes,
            password: job.password,
            transfer,
        })
        aesKey = prepared.key
        initialCounter = prepared.card.initialCounter
        cardWriter = createResumedCardWriter(client, resumeTarget.msgId, prepared.card, resumeTarget.peerId)
        resultParentFolderId = parentFolderIdOfCard(prepared.card.data) ?? TGLFS_ROOT_PARENT_ID
        displayName = prepared.card.data.name
        storedBytesBefore = prepared.plan.resumeOffset
        const resumeOffset = prepared.plan.resumeOffset
        // Start the bar at what's already stored; re-reading the stored part is shown in the detail line.
        uploading = false
        transfer.update({
            name: displayName,
            ufid: UFID,
            phase: "Resuming…",
            bytes: Math.min(resumeOffset, totalBytes),
            detail: resumeOffset > 0 ? "Checking what's already in Telegram…" : null,
        })
        let lastDetailPercent = -1
        pipelineResume = {
            offset: resumeOffset,
            startChunkIndex: prepared.plan.nextChunkIndex,
            verifyWindows: prepared.plan.verifyWindows,
            fetchReference: (window) =>
                window.chunkIndex === 0 && window.offsetInChunk === 0 && prepared.head
                    ? Promise.resolve(prepared.head.subarray(0, window.length))
                    : downloadChunkRange(client, prepared.chunkMessages[window.chunkIndex], window.offsetInChunk, window.length),
            onFastForward(position, offset) {
                const percent = Math.floor((position / offset) * 100)
                if (percent !== lastDetailPercent) {
                    lastDetailPercent = percent
                    transfer.update({ detail: `Checking what's already in Telegram · ${percent}%` })
                }
            },
            onResumePoint() {
                uploading = true
                const stored = compressedBytesRead > 0 ? Math.round(bytesProcessed * Math.min(1, resumeOffset / compressedBytesRead)) : 0
                transfer.update({ phase: null, detail: null, bytes: stored })
                console.log(`Resuming upload of ${displayName} at chunk ${prepared.plan.nextChunkIndex + 1}.`)
            },
        }
    } else {
        const salt = window.crypto.getRandomValues(new Uint8Array(16))
        aesKey = await Encryption.deriveAESKeyFromPassword(job.password, salt)
        initialCounter = window.crypto.getRandomValues(new Uint8Array(16))
        // Produce initialization vector for AES-CTR encryption (salt & initial counter).
        const IVBytes = new Uint8Array(salt.length + initialCounter.length)
        IVBytes.set(salt, 0)
        IVBytes.set(initialCounter, salt.length)
        cardWriter = await createNewCardWriter(client, {
            name: displayName,
            ufid: UFID,
            size: totalBytes,
            IV: bytesToBase64(IVBytes),
            parentFolderId,
        })
    }
    console.log(`Upload begins for ${displayName}`)

    const byteCounterStream = new TransformStream({
        transform(chunk, controller) {
            bytesProcessed += chunk.length;
            controller.enqueue(chunk);
        },
    })
    const compressedStream = inputStream.pipeThrough(byteCounterStream).pipeThrough(new CompressionStream("gzip"))
    const reader = compressedStream.getReader()

    const sink: UploadPipeline.UploadChunkSink = {
        async savePart(part) {
            // Cancellation checkpoint: stop between parts, before anything new is written to Telegram.
            transfer.throwIfCancelled()
            const result = await client.invoke(
                new Api.upload.SaveBigFilePart({
                    fileId: part.fileId,
                    filePart: part.filePart,
                    fileTotalParts: part.fileTotalParts,
                    bytes: Buffer.from(part.bytes),
                } as any),
            )
            if (!result) {
                throw new Error(`Failed to upload part ${part.filePart + 1}.`)
            }
            encryptedBytesSent += part.bytes.length
            reportUploadProgress()
        },
        async finalizeChunk(chunk) {
            const chunkFileUploaded = new Api.InputFileBig({
                id: chunk.fileId as any,
                parts: chunk.parts,
                name: `${UFID}.chunk${chunk.chunkIndex + 1}`,
            })
            // Send the chunk message, then record it in the file card.
            const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded })
            console.log(`Uploaded chunk ${chunk.chunkIndex + 1}.`)
            await cardWriter.appendChunk(chunkMessage.id, chunk.last)
        },
    }

    let pipelineResult: UploadPipeline.UploadPipelineResult
    try {
        pipelineResult = await UploadPipeline.runUploadPipeline({
            compressed: reader,
            key: aesKey,
            initialCounter,
            chunkSize: config.chunkSize,
            partSize: UPLOAD_PART_SIZE,
            encryptionBufferSize: Encryption.ENCRYPTION_CHUNK_SIZE,
            sink,
            resume: pipelineResume,
            checkpoint: () => transfer.throwIfCancelled(),
            onCompressedBytes(byteCount) {
                compressedBytesRead += byteCount
                reportUploadProgress()
            },
        })
    } catch (error) {
        void reader.cancel().catch(() => {})
        throw error
    }
    if (!pipelineResult.finalChunkSent) {
        // The data ended exactly at a chunk boundary: every chunk is stored, only the completion flag is missing.
        await cardWriter.markComplete()
    }
    const fileCardData = cardWriter.data()
    transfer.update({ bytes: totalBytes, ufid: fileCardData.ufid })
    console.log(`Upload complete: ${displayName} (${humanReadableSize(fileCardData.size)})`)
    restoreUploadUiAndMaybeRefreshBrowser(() => {}, true, resultParentFolderId)
    return { msgId: cardWriter.msgId, data: fileCardData, parentFolderId: resultParentFolderId }
}

/* ------------------------------------------------------------------------------------------- Upload resume */

type ExistingUpload = {
    msgId: number
    peerId?: unknown
    date: number
    data: FileCardData
    message: string
}

type UploadCardWriter = {
    readonly msgId: number
    appendChunk(chunkMessageId: number, complete: boolean): Promise<void>
    markComplete(): Promise<void>
    data(): FileCardData
}

function parentFolderIdOfCard(data: FileCardData): string | undefined {
    return "parentFolderId" in data && typeof data.parentFolderId === "string" ? data.parentFolderId : undefined
}

/**
 * Looks up stored cards with this UFID. Telegram search is fuzzy, so only exact UFID matches count; a hit that
 * mentions the UFID but can't be read (e.g. a newer card version) blocks the upload, as before (fail closed).
 */
async function findExistingUploads(client: TelegramClient, ufid: string) {
    const messages = await client.getMessages("me", { search: buildFileCardUfidLookupQuery(ufid) })
    const incomplete: ExistingUpload[] = []
    let complete = false
    let unreadable = false
    for (const message of messages as unknown as Array<{ id: number; date: number; message?: string; peerId?: unknown }>) {
        if (!message || typeof message.message !== "string") continue
        const data = parseFileCardMessage(message.message)
        if (!data) {
            // A file card we can't read (e.g. a newer version) that mentions this UFID: don't guess, block.
            if (message.message.startsWith(FILE_CARD_PREFIX) && message.message.includes(ufid)) unreadable = true
            continue
        }
        if (data.ufid !== ufid) continue
        if (data.uploadComplete) {
            complete = true
        } else {
            incomplete.push({ msgId: message.id, peerId: message.peerId, date: message.date, data, message: message.message })
        }
    }
    return { complete, unreadable, incomplete }
}

/** The interrupted upload that got furthest (newest on ties). Other incomplete copies are left alone. */
function pickResumeCandidate(candidates: ExistingUpload[]): ExistingUpload | null {
    let best: ExistingUpload | null = null
    for (const candidate of candidates) {
        if (
            !best ||
            candidate.data.chunks.length > best.data.chunks.length ||
            (candidate.data.chunks.length === best.data.chunks.length && candidate.msgId > best.msgId)
        ) {
            best = candidate
        }
    }
    return best
}

async function fetchCardMessage(client: TelegramClient, msgId: number) {
    const [message] = (await client.getMessages("me", { ids: [msgId] })) as unknown as Array<
        { id: number; date: number; message?: string; peerId?: unknown } | undefined
    >
    return message && message.id === msgId && typeof message.message === "string" ? message : null
}

async function fetchResumeTarget(client: TelegramClient, msgId: number): Promise<ExistingUpload> {
    const message = await fetchCardMessage(client, msgId)
    if (!message) {
        throw new Error("The interrupted upload's file card no longer exists.")
    }
    const data = parseFileCardMessage(message.message!)
    const parsed = UploadResume.parseResumableFileCard(message.message)
    if (!data || !parsed.ok) {
        throw new Error(parsed.ok ? UploadResume.describeResumeRefusal("malformed-card") : parsed.message)
    }
    return { msgId, peerId: message.peerId, date: message.date, data, message: message.message! }
}

/** Downloads `length` bytes at `offset` of a chunk document (offset/length must satisfy `upload.getFile` rules). */
async function downloadChunkRange(
    client: TelegramClient,
    chunkMessage: any,
    offset: number,
    length: number,
): Promise<Uint8Array> {
    const result = await client.invoke(
        new Api.upload.GetFile({
            location: getFileInfo(chunkMessage.media).location,
            offset: offset as any,
            limit: length,
            precise: false,
            cdnSupported: false,
        }),
    )
    const bytes = (result as any)?.bytes as Uint8Array | undefined
    if (!bytes || bytes.length !== length) {
        throw new Error("Couldn't read back the already-uploaded data from Telegram, so the upload can't be resumed right now.")
    }
    return new Uint8Array(bytes)
}

/**
 * Validates an interrupted upload against the file being uploaded now and the password, before anything new is
 * written: card shape/version, UFID and size, every completed chunk message (exists, expected size), and the
 * password (the first stored block must decrypt to a gzip header). Byte-for-byte checks of the stored data happen
 * while the pipeline re-reads the file (see `runUploadPipeline`).
 */
async function prepareResume(
    client: TelegramClient,
    config: Config.Config,
    target: ExistingUpload,
    options: { ufid: string; size: number; password: string; transfer: Transfers.TransferHandle },
) {
    const parsed = UploadResume.parseResumableFileCard(target.message)
    if (!parsed.ok) {
        throw new Error(parsed.message)
    }
    const card = parsed.card
    // Start the bar at what the card says is already stored (verified below and while re-reading the file).
    options.transfer.update({
        phase: "Resuming…",
        bytes: Math.min(card.data.chunks.length * config.chunkSize, options.size),
        detail: "Checking the interrupted upload…",
    })

    const chunkIds = card.data.chunks
    const fetched = chunkIds.length > 0
        ? ((await client.getMessages("me", { ids: chunkIds })) as unknown as Array<any>)
        : []
    const byId = new Map<number, any>()
    for (const message of fetched) {
        if (message && typeof message.id === "number") byId.set(message.id, message)
    }
    const chunkMessages = chunkIds.map((id) => byId.get(id) ?? null)
    const chunkDocumentSizes = chunkMessages.map((message) =>
        message?.media?.document ? UploadResume.coerceDocumentSize(message.media.document.size) : null,
    )
    const planned = UploadResume.planUploadResume(card, {
        ufid: options.ufid,
        size: options.size,
        chunkSize: config.chunkSize,
        partSize: UPLOAD_PART_SIZE,
        chunkDocumentSizes,
    })
    if (!planned.ok) {
        throw new Error(planned.message)
    }
    options.transfer.throwIfCancelled()

    let head: Uint8Array | null = null
    if (chunkIds.length > 0) {
        head = await downloadChunkRange(client, chunkMessages[0], 0, Math.min(UploadResume.RESUME_HEAD_WINDOW_BYTES, config.chunkSize))
    }
    let password = options.password
    while (true) {
        const key = await Encryption.deriveAESKeyFromPassword(password, card.salt)
        if (!head) {
            // Nothing is stored yet, so there is nothing a password could mismatch.
            return { card, plan: planned.plan, key, head, chunkMessages }
        }
        const firstBlock = await UploadPipeline.encryptCtrAt(key, card.initialCounter, 0, head.subarray(0, 16))
        if (UploadResume.looksLikeGzipHeader(firstBlock)) {
            return { card, plan: planned.plan, key, head, chunkMessages }
        }
        options.transfer.throwIfCancelled()
        const retry = await requestText({
            title: "That password doesn't match",
            message: `That password doesn't match the interrupted upload of “${card.data.name}”. Enter the password you used when the upload started.`,
            label: "Encryption password",
            inputType: "password",
            allowEmpty: true,
            confirmLabel: "Resume",
            icon: "key",
        })
        if (retry === null) {
            options.transfer.markCancelled()
            throw Transfers.abortError("Resume cancelled: the password didn't match.")
        }
        password = retry
    }
}

async function createNewCardWriter(
    client: TelegramClient,
    fields: { name: string; ufid: string; size: number; IV: string; parentFolderId: string },
): Promise<UploadCardWriter> {
    const fileCardData: FileCardData = createFileCardData({
        name: fields.name,
        ufid: fields.ufid,
        size: fields.size,
        uploadComplete: false,
        chunks: [],
        IV: fields.IV,
        parentFolderId: fields.parentFolderId,
    })
    const fileCardMessage = await client.sendMessage("me", { message: serializeFileCardMessage(fileCardData) })
    const edit = () =>
        client.invoke(
            new Api.messages.EditMessage({
                peer: fileCardMessage.peerId,
                id: fileCardMessage.id,
                message: serializeFileCardMessage(fileCardData),
            }),
        )
    return {
        msgId: fileCardMessage.id,
        async appendChunk(chunkMessageId, complete) {
            fileCardData.chunks.push(chunkMessageId)
            fileCardData.uploadComplete = complete
            await edit()
        },
        async markComplete() {
            if (fileCardData.uploadComplete) return
            fileCardData.uploadComplete = true
            await edit()
        },
        data: () => fileCardData,
    }
}

/**
 * Edits an existing incomplete card in place: only `chunks` and `uploadComplete` change; its protocol version and
 * any unknown fields are kept. Before every edit the card is re-read; if anything else changed it in the meantime
 * (another device resuming, a delete), the upload stops without touching it.
 */
function createResumedCardWriter(
    client: TelegramClient,
    msgId: number,
    card: UploadResume.ResumableFileCard,
    peerId: unknown,
): UploadCardWriter {
    const chunks = card.data.chunks.slice()
    let complete = false
    const write = async (nextChunks: number[], nextComplete: boolean) => {
        const fresh = await fetchCardMessage(client, msgId)
        const parsed = fresh ? UploadResume.parseResumableFileCard(fresh.message) : null
        if (
            !parsed?.ok ||
            parsed.card.data.ufid !== card.data.ufid ||
            parsed.card.data.chunks.length !== chunks.length ||
            parsed.card.data.chunks.some((id, index) => id !== chunks[index])
        ) {
            throw new Error(
                "The interrupted upload's file card changed while resuming (another device may be uploading it), so the upload stopped without changing it.",
            )
        }
        await client.invoke(
            new Api.messages.EditMessage({
                peer: (peerId ?? "me") as any,
                id: msgId,
                message: UploadResume.serializeResumedFileCard(card, { chunks: nextChunks, uploadComplete: nextComplete }),
            }),
        )
        chunks.splice(0, chunks.length, ...nextChunks)
        complete = nextComplete
    }
    return {
        msgId,
        appendChunk: (chunkMessageId, nextComplete) => write([...chunks, chunkMessageId], nextComplete),
        async markComplete() {
            if (complete) return
            await write(chunks.slice(), true)
        },
        data: () => {
            const parsed = parseFileCardMessage(UploadResume.serializeResumedFileCard(card, { chunks, uploadComplete: complete }))
            return parsed!
        },
    }
}

/**
 * Asks for the upload password (and, for videos, whether to optimize for streaming), captures the destination
 * folder, and queues the upload in the transfer tray. Returns once the upload is queued, not when it finishes.
 */
export async function fileUpload(
    client: TelegramClient,
    config: Config.Config,
    sharedFiles?: File[],
    options: { parentFolderId?: string } = {},
) {
    await gramJsReady
    if (config.chunkSize < UPLOAD_PART_SIZE) {
        throw new Error(
            `config.chunkSize (${config.chunkSize}) must be larger than UPLOAD_PART_SIZE (${UPLOAD_PART_SIZE}).`,
        )
    }

    let files: File[] | null = null
    if (sharedFiles && sharedFiles.length > 0) {
        files = sharedFiles
    } else {
        const uploadFileInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
        const selectedFiles = uploadFileInput?.files
        if (!selectedFiles || selectedFiles.length === 0) {
            showToast("No file selected.", { tone: "error" })
            return
        }
        files = Array.from(selectedFiles)
    }
    const single = files.length === 1
    const file = files[0]
    console.log(single ? `Selected file: ${file.name}` : `Selected ${files.length} files for archive upload.`)

    // Capture the destination now: with a queue, the user may have navigated elsewhere by the time this starts.
    const browserDiv = document.getElementById("fileBrowser")
    const parentFolderId = resolveUploadParentFolderId(options, {
        browserWasVisible: !!browserDiv && !browserDiv.hasAttribute("hidden"),
        browserParentFolderId: (window as any).__tglfsUploadParentFolderId,
    })

    const password = await requestText({
        title: single ? "Upload file" : `Upload ${files.length} files`,
        message: single ? file.name : "Multiple files are packed into a single archive before upload.",
        label: "Encryption password (optional)",
        inputType: "password",
        allowEmpty: true,
        confirmLabel: "Upload",
        icon: "upload",
    })
    if (password === null) {
        return
    }

    let remuxModule: VideoRemuxModule | null = null
    let remuxKind: import("./web/videoRemux").RemuxableVideoKind | null = null
    if (single && isPotentialStreamingRemuxCandidate(file)) {
        remuxModule = await import("./web/videoRemux")
        remuxKind = remuxModule.getRemuxableVideoKind(file)
    }
    const shouldRemuxForStreaming =
        remuxModule !== null && remuxKind !== null
            ? await requestConfirm({
                title: "Optimize video for streaming?",
                message: remuxModule.getRemuxConfirmMessage(file, remuxKind),
                confirmLabel: "Optimize",
                cancelLabel: "Upload as is",
                icon: "film",
            })
            : false

    const archiveName = single ? undefined : Archive.defaultArchiveName()
    const job: UploadJob = {
        files,
        password,
        parentFolderId,
        archiveName,
        remux: shouldRemuxForStreaming && remuxModule && remuxKind ? { module: remuxModule, kind: remuxKind } : null,
    }
    void Transfers.enqueue(
        {
            direction: "upload",
            name: single ? file.name : archiveName!,
            size: single ? file.size : Archive.computeTarSize(files),
            meta: { parentFolderId },
        },
        (transfer) => runFileUploadJob(client, config, job, transfer),
    ).catch((error) => console.warn("Upload failed:", error))
}

export type ResumeUploadOutcome = "queued" | "cancelled" | "pick-again"

/**
 * "Resume upload…" on an incomplete file: checks the picked file(s) against the card, confirms, asks for the
 * password and queues the resumed upload. Returns "pick-again" when the user wants to choose a different file.
 * The UFID (content hash) is verified inside the queued job, before anything is written.
 */
export async function resumeFileUpload(
    client: TelegramClient,
    config: Config.Config,
    target: { msgId: number; data: FileCardData },
    files: File[],
): Promise<ResumeUploadOutcome> {
    await gramJsReady
    if (files.length === 0) return "cancelled"
    const card = target.data
    if (card.uploadComplete) {
        showToast(UploadResume.describeResumeRefusal("already-complete"))
        return "cancelled"
    }
    const single = files.length === 1
    const pickedSize = single ? files[0].size : Archive.computeTarSize(files)
    const pickedLabel = single ? `“${files[0].name}”` : `These ${files.length} files`
    if (pickedSize !== card.size) {
        const again = await requestConfirm({
            title: "That's a different file",
            message:
                `${pickedLabel} ${single ? "is" : "add up to"} ${formatFileCardSize(pickedSize)}, but the interrupted upload of ` +
                `“${card.name}” is ${formatFileCardSize(card.size)}. Choose the exact file you were uploading` +
                (single ? "." : ", selected the same way as before."),
            confirmLabel: "Choose another file",
            cancelLabel: "Close",
            icon: "file",
        })
        return again ? "pick-again" : "cancelled"
    }

    const stored = Math.min(card.chunks.length * config.chunkSize, card.size)
    const confirmed = await requestConfirm({
        title: "Resume interrupted upload?",
        message:
            `${formatFileCardSize(stored)} of ${formatFileCardSize(card.size)} already in Telegram. ` +
            `TGLFS re-reads the file to check it matches, then uploads the rest into “${card.name}”.`,
        confirmLabel: "Resume",
        cancelLabel: "Cancel",
        icon: "cloudUp",
    })
    if (!confirmed) return "cancelled"

    const password = await requestText({
        title: "Resume upload",
        message: `Use the same password as when the upload of “${card.name}” started.`,
        label: "Encryption password",
        inputType: "password",
        allowEmpty: true,
        confirmLabel: "Resume",
        icon: "cloudUp",
    })
    if (password === null) return "cancelled"

    const parentFolderId = parentFolderIdOfCard(card) ?? TGLFS_ROOT_PARENT_ID
    const job: UploadJob = {
        files,
        password,
        parentFolderId,
        archiveName: single ? undefined : card.name,
        remux: null,
        resume: { msgId: target.msgId, name: card.name },
    }
    void Transfers.enqueue(
        {
            direction: "upload",
            name: card.name,
            size: card.size,
            meta: { parentFolderId, resume: true },
        },
        (transfer) => runFileUploadJob(client, config, job, transfer),
    ).catch((error) => console.warn("Resumed upload failed:", error))
    return "queued"
}

export async function listFileCards(
    client: TelegramClient,
    opts?: { query?: string; parentFolderId?: string; limit?: number; offsetId?: number },
): Promise<Array<{ msgId: number; date: number; data: FileCardData }>> {
    return sharedListFileCards(client, opts)
}

export async function countFileCards(
    client: TelegramClient,
    opts?: { query?: string; parentFolderId?: string },
): Promise<number> {
    await gramJsReady
    return sharedCountFileCards(client, opts)
}

export async function getFileCardByUfid(
    client: TelegramClient,
    ufid: string,
): Promise<{ msgId: number; date: number; data: FileCardData } | null> {
    await gramJsReady
    return sharedLookupFileCardByUfid(client, ufid)
}

function telegramMessageSearchTotal(messages: any[]) {
    const total = (messages as any).total
    return typeof total === "number" && Number.isFinite(total) ? total : messages.length
}

export async function countFolderRecords(
    client: TelegramClient,
    opts?: { query?: string; parentFolderId?: string },
): Promise<number> {
    await gramJsReady
    const query = (opts?.query || "").trim()
    const search = opts?.parentFolderId
        ? buildFolderParentSearchQuery(opts.parentFolderId, query)
        : query ? `${TGLFS_FOLDER_TYPE} ${query}` : buildFolderSearchQuery()
    const messages = await client.getMessages("me", {
        search,
        limit: 0,
        addOffset: 0,
        minId: 0,
        maxId: 0,
        waitTime: 0,
    } as any)
    return telegramMessageSearchTotal(messages)
}

export async function countDirectoryEntries(
    client: TelegramClient,
    opts?: { query?: string; parentFolderId?: string },
): Promise<{ folders: number; files: number; total: number }> {
    const [folders, files] = await Promise.all([
        countFolderRecords(client, opts),
        countFileCards(client, opts),
    ])
    return { folders, files, total: folders + files }
}

export async function listFolderRecords(
    client: TelegramClient,
    opts?: { query?: string; parentFolderId?: string; limit?: number; offsetId?: number },
): Promise<TglfsFolderRecord[]> {
    await gramJsReady
    const query = (opts?.query || "").trim()
    const parentFolderId = opts?.parentFolderId?.trim()
    const targetLimit = opts?.limit ?? 50
    const requestLimit = targetLimit
    const search = opts?.parentFolderId
        ? buildFolderParentSearchQuery(opts.parentFolderId, query)
        : query ? `${TGLFS_FOLDER_TYPE} ${query}` : buildFolderSearchQuery()
    const records: TglfsFolderRecord[] = []
    const seenFolderIds = new Set<string>()
    let offsetId = opts?.offsetId ?? 0

    while (records.length < targetLimit) {
        const messages = await client.getMessages("me", {
            search,
            limit: requestLimit,
            addOffset: 0,
            minId: 0,
            maxId: offsetId,
            waitTime: 0,
        } as any)
        if (messages.length === 0) {
            break
        }

        let nextOffsetId = offsetId
        for (const message of messages) {
            nextOffsetId = message.id
            const record = extractTglfsFolderRecord(message as any)
            if (!record || record.data.deleted || seenFolderIds.has(record.data.folderId)) {
                continue
            }
            if (parentFolderId && record.data.parentFolderId !== parentFolderId) {
                continue
            }
            if (parentFolderId && record.data.folderId === parentFolderId) {
                continue
            }
            seenFolderIds.add(record.data.folderId)
            records.push(record)
            if (records.length >= targetLimit) {
                break
            }
        }

        if (messages.length < requestLimit || nextOffsetId === offsetId) {
            break
        }
        offsetId = nextOffsetId
    }
    return records
}

export async function getFolderRecord(
    client: TelegramClient,
    folderId: string,
): Promise<TglfsFolderRecord | null> {
    await gramJsReady
    const messages = await client.getMessages("me", {
        search: buildFolderSearchQuery(folderId),
        limit: 10,
        waitTime: 0,
    } as any)
    for (const message of messages) {
        const record = extractTglfsFolderRecord(message as any)
        if (record?.data.folderId === folderId && !record.data.deleted) {
            return record
        }
    }
    return null
}

function downloadedMediaToText(media: unknown): string | null {
    if (typeof media === "string") {
        return media
    }
    if (media instanceof ArrayBuffer) {
        return new TextDecoder().decode(new Uint8Array(media))
    }
    if (ArrayBuffer.isView(media)) {
        return new TextDecoder().decode(new Uint8Array(media.buffer, media.byteOffset, media.byteLength))
    }
    if (media && typeof (media as { toString?: unknown }).toString === "function") {
        const text = (media as { toString: (encoding?: string) => string }).toString("utf8")
        return text === "[object Object]" ? null : text
    }
    return null
}

async function readAttachedFolderEntries(
    client: TelegramClient,
    record: TglfsFolderRecord,
): Promise<TglfsFolderManifestRecord | null> {
    if (!record.raw || !record.raw.media || !record.data.entriesHash) {
        return null
    }
    const media = await client.downloadMedia(record.raw as any, {})
    const text = downloadedMediaToText(media)
    if (!text) {
        return null
    }
    const entries = parseTglfsFolderEntriesJson(text)
    if (!entries || entries.folderId !== record.data.folderId) {
        return null
    }
    const hash = await hashTglfsFolderEntries(entries)
    if (hash !== record.data.entriesHash) {
        return null
    }
    return { msgId: record.msgId, date: record.date, peerId: record.peerId, data: entries, raw: record.raw }
}

export async function getFolderManifest(
    client: TelegramClient,
    folderId: string,
): Promise<TglfsFolderManifestRecord | null> {
    await gramJsReady
    const folderRecord = await getFolderRecord(client, folderId)
    if (folderRecord?.data.version === 2 && folderRecord.data.entriesHash) {
        return readAttachedFolderEntries(client, folderRecord)
    }

    const messages = await client.getMessages("me", {
        search: buildFolderManifestSearchQuery(folderId),
        limit: 10,
        waitTime: 0,
    } as any)
    for (const message of messages) {
        const record = extractTglfsFolderManifestRecord(message as any)
        if (record?.data.folderId === folderId) {
            return record
        }
    }
    return null
}

export type RawRecordMessage = { msgId: number; date: number; text: string }

async function searchRawRecordMessages(
    client: TelegramClient,
    search: string,
    accepts: (text: string) => boolean,
    limit: number,
): Promise<RawRecordMessage[]> {
    const results: RawRecordMessage[] = []
    const pageSize = Math.min(100, Math.max(1, limit))
    let offsetId = 0
    while (results.length < limit) {
        const messages = await client.getMessages("me", {
            search,
            limit: pageSize,
            addOffset: 0,
            minId: 0,
            maxId: offsetId,
            waitTime: 0,
        } as any)
        if (messages.length === 0) break
        let nextOffsetId = offsetId
        for (const message of messages as any[]) {
            nextOffsetId = message.id
            if (typeof message.message === "string" && accepts(message.message)) {
                results.push({ msgId: message.id, date: message.date, text: message.message })
                if (results.length >= limit) break
            }
        }
        if (messages.length < pageSize || nextOffsetId === offsetId) break
        offsetId = nextOffsetId
    }
    return results
}

/**
 * Read-only: every folder record message for a parent folder or a folder id, including deleted and
 * superseded records (unlike listFolderRecords/getFolderRecord). Used to reconstruct folder history.
 */
export async function listFolderRecordMessages(
    client: TelegramClient,
    opts: { parentFolderId?: string; folderId?: string; limit?: number },
): Promise<RawRecordMessage[]> {
    await gramJsReady
    const search = opts.folderId
        ? buildFolderSearchQuery(opts.folderId)
        : buildFolderParentSearchQuery(opts.parentFolderId ?? TGLFS_ROOT_PARENT_ID)
    const isFolderRecord = (text: string) => text.startsWith(TGLFS_FOLDER_TYPE) && !text.startsWith(TGLFS_FOLDER_MANIFEST_TYPE)
    return searchRawRecordMessages(client, search, isFolderRecord, opts.limit ?? 500)
}

/** Read-only: every legacy `tglfs:folder-manifest` message for a folder (older snapshots of its entries). */
export async function listFolderManifestMessages(
    client: TelegramClient,
    folderId: string,
    limit = 20,
): Promise<RawRecordMessage[]> {
    await gramJsReady
    return searchRawRecordMessages(client, buildFolderManifestSearchQuery(folderId), (text) => text.startsWith(TGLFS_FOLDER_MANIFEST_TYPE), limit)
}

type DirectoryParentMigrationPhase =
    | "scanning-folders"
    | "reading-manifests"
    | "scanning-files"
    | "planning"
    | "editing-folders"
    | "editing-files"
    | "waiting"
    | "complete"
    | "failed"

export type DirectoryParentMigrationProgress = {
    phase: DirectoryParentMigrationPhase
    message: string
    completed: number
    total?: number
    foldersScanned?: number
    filesScanned?: number
    manifestsRead?: number
    foldersUpdated?: number
    filesUpdated?: number
    waitSeconds?: number
}

export type DirectoryParentMigrationOptions = {
    onProgress?: (progress: DirectoryParentMigrationProgress) => void
    editDelayMs?: number
    floodWaitPaddingMs?: number
}

function emitDirectoryMigrationProgress(
    options: DirectoryParentMigrationOptions | undefined,
    progress: DirectoryParentMigrationProgress,
) {
    options?.onProgress?.(progress)
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms))
}

async function waitForDirectoryMigration(
    ms: number,
    options: DirectoryParentMigrationOptions | undefined,
    progress: Omit<DirectoryParentMigrationProgress, "waitSeconds">,
) {
    const end = Date.now() + ms
    while (true) {
        const remainingMs = end - Date.now()
        if (remainingMs <= 0) {
            return
        }
        emitDirectoryMigrationProgress(options, {
            ...progress,
            waitSeconds: Math.ceil(remainingMs / 1000),
        })
        await sleep(Math.min(1000, remainingMs))
    }
}

async function listAllFileCardRecords(
    client: TelegramClient,
    options?: DirectoryParentMigrationOptions,
): Promise<FileCardRecord[]> {
    const records: FileCardRecord[] = []
    const seen = new Set<number>()
    let offsetId: number | undefined
    while (true) {
        const page = await listFileCards(client, { limit: 500, offsetId })
        for (const record of page) {
            if (!seen.has(record.msgId)) {
                seen.add(record.msgId)
                records.push(record)
            }
        }
        emitDirectoryMigrationProgress(options, {
            phase: "scanning-files",
            message: `Scanning file cards: ${records.length} found`,
            completed: records.length,
            filesScanned: records.length,
        })
        if (page.length < 500) break
        const nextOffsetId = page[page.length - 1]?.msgId
        if (!nextOffsetId || nextOffsetId === offsetId) break
        offsetId = nextOffsetId
    }
    return records
}

async function listAllFolderRecords(
    client: TelegramClient,
    options?: DirectoryParentMigrationOptions,
): Promise<TglfsFolderRecord[]> {
    const records: TglfsFolderRecord[] = []
    const seen = new Set<string>()
    let offsetId: number | undefined
    while (true) {
        const page = await listFolderRecords(client, { limit: 500, offsetId })
        for (const record of page) {
            if (!seen.has(record.data.folderId)) {
                seen.add(record.data.folderId)
                records.push(record)
            }
        }
        emitDirectoryMigrationProgress(options, {
            phase: "scanning-folders",
            message: `Scanning folders: ${records.length} found`,
            completed: records.length,
            foldersScanned: records.length,
        })
        if (page.length < 500) break
        const nextOffsetId = page[page.length - 1]?.msgId
        if (!nextOffsetId || nextOffsetId === offsetId) break
        offsetId = nextOffsetId
    }
    return records
}

export type DirectoryParentMigrationResult = {
    foldersScanned: number
    filesScanned: number
    manifestsRead: number
    foldersUpdated: number
    filesUpdated: number
    folderParentConflicts: string[]
    fileParentConflicts: string[]
}

async function runDirectoryMigrationEdit(
    operation: () => Promise<void>,
    options: DirectoryParentMigrationOptions | undefined,
    progress: Omit<DirectoryParentMigrationProgress, "waitSeconds">,
): Promise<boolean> {
    let slowedAfterFloodWait = false
    while (true) {
        try {
            emitDirectoryMigrationProgress(options, progress)
            await operation()
            return slowedAfterFloodWait
        } catch (error) {
            const floodWaitSeconds = extractTelegramFloodWaitSeconds(error)
            if (!floodWaitSeconds) {
                throw error
            }
            slowedAfterFloodWait = true
            const paddingMs = options?.floodWaitPaddingMs ?? DIRECTORY_MIGRATION_FLOOD_WAIT_PADDING_MS
            await waitForDirectoryMigration(
                floodWaitSeconds * 1000 + paddingMs,
                options,
                {
                    ...progress,
                    phase: "waiting",
                    message: `Telegram requested a ${floodWaitSeconds}s wait. Waiting and then resuming.`,
                },
            )
        }
    }
}

function setDirectoryMigrationFloodThreshold(client: TelegramClient) {
    const target = client as unknown as { floodSleepThreshold?: number }
    const original = target.floodSleepThreshold
    target.floodSleepThreshold = 0
    return () => {
        if (original === undefined) {
            delete target.floodSleepThreshold
        } else {
            target.floodSleepThreshold = original
        }
    }
}

export async function migrateDirectoryParentRefs(
    client: TelegramClient,
    options?: DirectoryParentMigrationOptions,
): Promise<DirectoryParentMigrationResult> {
    const restoreFloodThreshold = setDirectoryMigrationFloodThreshold(client)
    try {
        while (true) {
            try {
                return await migrateDirectoryParentRefsOnce(client, options)
            } catch (error) {
                const floodWaitSeconds = extractTelegramFloodWaitSeconds(error)
                if (!floodWaitSeconds) {
                    throw error
                }
                const paddingMs = options?.floodWaitPaddingMs ?? DIRECTORY_MIGRATION_FLOOD_WAIT_PADDING_MS
                await waitForDirectoryMigration(
                    floodWaitSeconds * 1000 + paddingMs,
                    options,
                    {
                        phase: "waiting",
                        message: `Telegram requested a ${floodWaitSeconds}s wait. Waiting and then resuming the migration.`,
                        completed: 0,
                    },
                )
            }
        }
    } finally {
        restoreFloodThreshold()
    }
}

async function migrateDirectoryParentRefsOnce(
    client: TelegramClient,
    options?: DirectoryParentMigrationOptions,
): Promise<DirectoryParentMigrationResult> {
    await gramJsReady
    const now = new Date().toISOString()
    emitDirectoryMigrationProgress(options, {
        phase: "scanning-folders",
        message: "Scanning folders...",
        completed: 0,
    })
    const folderRecords = await listAllFolderRecords(client, options)

    const manifestRecords: TglfsFolderManifestRecord[] = []
    for (const [index, record] of folderRecords.entries()) {
        const manifest = await getFolderManifest(client, record.data.folderId).catch(() => null)
        if (manifest) {
            manifestRecords.push(manifest)
        }
        emitDirectoryMigrationProgress(options, {
            phase: "reading-manifests",
            message: `Reading folder manifests: ${index + 1} / ${folderRecords.length}`,
            completed: index + 1,
            total: folderRecords.length,
            foldersScanned: folderRecords.length,
            manifestsRead: manifestRecords.length,
        })
    }

    emitDirectoryMigrationProgress(options, {
        phase: "scanning-files",
        message: "Scanning file cards...",
        completed: 0,
        foldersScanned: folderRecords.length,
        manifestsRead: manifestRecords.length,
    })
    const fileRecords = await listAllFileCardRecords(client, options)
    emitDirectoryMigrationProgress(options, {
        phase: "planning",
        message: "Planning parent-ref updates...",
        completed: 0,
        foldersScanned: folderRecords.length,
        filesScanned: fileRecords.length,
        manifestsRead: manifestRecords.length,
    })
    const plan = planDirectoryParentMigration(folderRecords, manifestRecords, fileRecords)
    const totalUpdates = plan.folderUpdates.length + plan.fileUpdates.length
    let completedUpdates = 0
    let foldersUpdated = 0
    let filesUpdated = 0
    let editDelayMs = options?.editDelayMs ?? DIRECTORY_MIGRATION_EDIT_DELAY_MS

    const waitBeforeNextEdit = async (phase: DirectoryParentMigrationPhase, message: string) => {
        if (completedUpdates === 0 || editDelayMs <= 0) {
            return
        }
        await waitForDirectoryMigration(editDelayMs, options, {
            phase: "waiting",
            message,
            completed: completedUpdates,
            total: totalUpdates,
            foldersScanned: folderRecords.length,
            filesScanned: fileRecords.length,
            manifestsRead: manifestRecords.length,
            foldersUpdated,
            filesUpdated,
        })
        emitDirectoryMigrationProgress(options, {
            phase,
            message: `Applying parent-ref updates: ${completedUpdates} / ${totalUpdates}`,
            completed: completedUpdates,
            total: totalUpdates,
            foldersScanned: folderRecords.length,
            filesScanned: fileRecords.length,
            manifestsRead: manifestRecords.length,
            foldersUpdated,
            filesUpdated,
        })
    }

    for (const update of plan.folderUpdates) {
        await waitBeforeNextEdit("editing-folders", "Pacing Telegram edits before the next folder update...")
        const slowedAfterFloodWait = await runDirectoryMigrationEdit(
            () => writeFolderRecord(client, {
                ...update.record.data,
                parentFolderId: update.parentFolderId,
                updatedAt: now,
            }, update.record).then(() => undefined),
            options,
            {
                phase: "editing-folders",
                message: `Updating folder parent refs: ${foldersUpdated + 1} / ${plan.folderUpdates.length}`,
                completed: completedUpdates,
                total: totalUpdates,
                foldersScanned: folderRecords.length,
                filesScanned: fileRecords.length,
                manifestsRead: manifestRecords.length,
                foldersUpdated,
                filesUpdated,
            },
        )
        if (slowedAfterFloodWait) {
            editDelayMs = Math.max(editDelayMs, DIRECTORY_MIGRATION_RECOVERY_EDIT_DELAY_MS)
        }
        foldersUpdated += 1
        completedUpdates += 1
        emitDirectoryMigrationProgress(options, {
            phase: "editing-folders",
            message: `Updated folder parent refs: ${foldersUpdated} / ${plan.folderUpdates.length}`,
            completed: completedUpdates,
            total: totalUpdates,
            foldersScanned: folderRecords.length,
            filesScanned: fileRecords.length,
            manifestsRead: manifestRecords.length,
            foldersUpdated,
            filesUpdated,
        })
    }

    for (const update of plan.fileUpdates) {
        await waitBeforeNextEdit("editing-files", "Pacing Telegram edits before the next file-card update...")
        const slowedAfterFloodWait = await runDirectoryMigrationEdit(
            () => updateFileCardParent(
                client,
                update.record.msgId,
                "me",
                update.record.data,
                update.parentFolderId,
            ).then(() => undefined),
            options,
            {
                phase: "editing-files",
                message: `Updating file-card parent refs: ${filesUpdated + 1} / ${plan.fileUpdates.length}`,
                completed: completedUpdates,
                total: totalUpdates,
                foldersScanned: folderRecords.length,
                filesScanned: fileRecords.length,
                manifestsRead: manifestRecords.length,
                foldersUpdated,
                filesUpdated,
            },
        )
        if (slowedAfterFloodWait) {
            editDelayMs = Math.max(editDelayMs, DIRECTORY_MIGRATION_RECOVERY_EDIT_DELAY_MS)
        }
        filesUpdated += 1
        completedUpdates += 1
        emitDirectoryMigrationProgress(options, {
            phase: "editing-files",
            message: `Updated file-card parent refs: ${filesUpdated} / ${plan.fileUpdates.length}`,
            completed: completedUpdates,
            total: totalUpdates,
            foldersScanned: folderRecords.length,
            filesScanned: fileRecords.length,
            manifestsRead: manifestRecords.length,
            foldersUpdated,
            filesUpdated,
        })
    }

    emitDirectoryMigrationProgress(options, {
        phase: "complete",
        message: "Folder index migration complete.",
        completed: totalUpdates,
        total: totalUpdates,
        foldersScanned: folderRecords.length,
        filesScanned: fileRecords.length,
        manifestsRead: manifestRecords.length,
        foldersUpdated,
        filesUpdated,
    })

    return {
        foldersScanned: folderRecords.length,
        filesScanned: fileRecords.length,
        manifestsRead: manifestRecords.length,
        foldersUpdated,
        filesUpdated,
        folderParentConflicts: plan.folderParentConflicts,
        fileParentConflicts: plan.fileParentConflicts,
    }
}

export async function writeFolderRecord(
    client: TelegramClient,
    folder: TglfsFolder,
    existing?: TglfsFolderRecord | null,
): Promise<TglfsFolderRecord> {
    await gramJsReady
    const message = serializeTglfsFolderMessage(folder)
    if (!existing) {
        const result = await client.sendMessage("me", { message })
        return { msgId: result.id, date: result.date, peerId: result.peerId, data: folder }
    }
    await client.invoke(
        new Api.messages.EditMessage({
            peer: existing.peerId ?? "me",
            id: existing.msgId,
            message,
        }),
    )
    return { ...existing, data: folder }
}

async function markSupersededFolderRecordDeleted(
    client: TelegramClient,
    record: TglfsFolderRecord,
    now: string,
) {
    await client.invoke(
        new Api.messages.EditMessage({
            peer: record.peerId ?? "me",
            id: record.msgId,
            message: serializeTglfsFolderMessage({
                ...record.data,
                deleted: true,
                updatedAt: now,
            }),
        }),
    )
}

export async function writeFolderManifest(
    client: TelegramClient,
    manifest: TglfsFolderManifest,
    existing?: TglfsFolderManifestRecord | null,
    folderForCreate?: TglfsFolder,
): Promise<TglfsFolderManifestRecord> {
    await gramJsReady
    const folderRecord = await getFolderRecord(client, manifest.folderId)
    if (!folderRecord) {
        if (!folderForCreate) {
            const compactManifest = toLegacyTglfsFolderManifest(compactTglfsFolderManifest(manifest))
            const message = serializeTglfsFolderManifestMessage(compactManifest)
            if (!existing) {
                const result = await client.sendMessage("me", { message })
                return { msgId: result.id, date: result.date, peerId: result.peerId, data: compactManifest }
            }
            await client.invoke(
                new Api.messages.EditMessage({
                    peer: existing.peerId ?? "me",
                    id: existing.msgId,
                    message,
                }),
            )
            return { ...existing, data: compactManifest }
        }
    }

    const revision = Math.max(
        folderRecord?.data.entriesRevision ?? folderForCreate?.entriesRevision ?? 0,
        manifest.revision ?? 0,
        existing?.data.revision ?? 0,
    ) + 1
    const compactManifest = toTglfsFolderEntriesManifest(compactTglfsFolderManifest(manifest), revision)
    const entriesJson = serializeTglfsFolderEntriesJson(compactManifest)
    const entriesHash = await hashTglfsFolderEntries(compactManifest)
    const entriesFileName = createTglfsFolderEntriesFileName(manifest.folderId, revision)
    const folder = {
        ...(folderRecord?.data ?? folderForCreate),
        updatedAt: manifest.updatedAt,
        entriesRevision: revision,
        entriesHash,
        entriesFileName,
    } as TglfsFolder
    const message = serializeTglfsFolderMessage(folder)
    const entriesFile = new File([entriesJson], entriesFileName, { type: TGLFS_FOLDER_ENTRIES_MIME_TYPE })
    const uploadedEntries = await client.uploadFile({
        file: entriesFile,
        workers: 1,
    })
    const media = new Api.InputMediaUploadedDocument({
        file: uploadedEntries,
        mimeType: TGLFS_FOLDER_ENTRIES_MIME_TYPE,
        attributes: [new Api.DocumentAttributeFilename({ fileName: entriesFileName })],
        forceFile: true,
    })
    if (folderRecord?.raw?.media) {
        await client.invoke(
            new Api.messages.EditMessage({
                peer: folderRecord.peerId ?? "me",
                id: folderRecord.msgId,
                message,
                media,
            }),
        )
        return { msgId: folderRecord.msgId, date: folderRecord.date, peerId: folderRecord.peerId, data: compactManifest, raw: folderRecord.raw }
    }

    const result = await client.sendFile("me", {
        file: uploadedEntries,
        caption: message,
    } as any)
    if (folderRecord) {
        try {
            await markSupersededFolderRecordDeleted(client, folderRecord, manifest.updatedAt)
        } catch {
            // The new media-backed folder record is complete. If the old text-only
            // record cannot be marked deleted, readers prefer the newer record.
        }
    }
    return { msgId: result.id, date: result.date, peerId: result.peerId, data: compactManifest, raw: result }
}

export async function renameFileCard(
    client: TelegramClient,
    msgId: number,
    peer: any,
    data: FileCardData,
    newName: string,
): Promise<void> {
    await gramJsReady
    await sharedRenameFileCardMessage(client, {
        Api,
        peer,
        msgId,
        peerId: peer,
        data,
        newName,
    })
}

export async function updateFileCardParent(
    client: TelegramClient,
    msgId: number,
    peer: any,
    data: FileCardData,
    parentFolderId: string,
): Promise<FileCardData> {
    await gramJsReady
    const nextData = createFileCardData({
        ...data,
        parentFolderId,
    })
    await client.invoke(
        new Api.messages.EditMessage({
            peer,
            id: msgId,
            message: serializeFileCardMessage(nextData),
        }),
    )
    return nextData
}

export async function deleteFileCard(
    client: TelegramClient,
    msgId: number,
    data: FileCardData,
): Promise<void> {
    await gramJsReady
    await sharedDeleteFileCardMessages(client, {
        Api,
        msgId,
        data,
    })
}

export async function sendFileCard(
    client: TelegramClient,
    data: FileCardData,
    recipient: string,
): Promise<void> {
    await gramJsReady
    await sharedTransferFileCard(client, {
        Api,
        record: {
            msgId: 0,
            date: 0,
            data,
        },
        sourcePeer: "me",
        targetPeer: recipient,
        silent: true,
    })
}

export async function downloadFileCard(
    client: TelegramClient,
    config: Config.Config,
    data: FileCardData,
    password: string | null,
): Promise<void> {
    await gramJsReady
    // Queues the download in the transfer tray and returns immediately; progress, errors and cancellation are
    // handled there.
    enqueueFileCardDownload(client, data, password ?? "")
}

export type AuthHandlers = {
    getPhoneCode?: () => Promise<string>
    /** Receives Telegram's 2FA password hint when one is set. */
    getPassword?: (hint?: string) => Promise<string>
    onError?: (error: unknown) => void
    /** Aborting cancels the sign-in and disconnects the half-open client. */
    signal?: AbortSignal
}

export type QrLoginCode = {
    /** Raw `auth.loginToken` bytes; encode as `tg://login?token=<base64url>` for the QR code. */
    token: Uint8Array
    /** Local wall-clock time (ms) after which the code should be treated as expired. */
    expiresAt: number
}

export type QrLoginHandlers = {
    /** Called with every fresh login token; GramJS rotates tokens about every 30 seconds. */
    onQrCode: (code: QrLoginCode) => void
    /** Called once Telegram reports that the code was scanned and accepted on another device. */
    onScanned?: () => void
    getPassword: (hint?: string) => Promise<string>
    onError?: (error: unknown) => void
    signal?: AbortSignal
}

export type TelegramAccount = {
    id: string
    phone?: string
    username?: string
    firstName?: string
    lastName?: string
}

export const TELEGRAM_LOGIN_CANCELLED = "LOGIN_CANCELLED"
export const TELEGRAM_SESSION_NOT_AUTHORIZED = "SESSION_NOT_AUTHORIZED"

/** Telegram rotates QR login tokens on this cadence (mirrors GramJS's QR loop). */
const TELEGRAM_QR_TOKEN_REFRESH_MS = 30_000

type MutableTelegramStoreSession = {
    load: () => Promise<void>
    setDC: (dcId: number, serverAddress: string, port: number) => void
    setAuthKey: (authKey: unknown) => void
    dcId?: number
    serverAddress?: string
    port?: number
    authKey?: unknown
}

type TelegramSessionSnapshot = {
    dcId?: number
    serverAddress?: string
    port?: number
    authKey?: unknown
}

function snapshotTelegramSession(session: MutableTelegramStoreSession): TelegramSessionSnapshot {
    return {
        dcId: session.dcId,
        serverAddress: session.serverAddress,
        port: session.port,
        authKey: session.authKey,
    }
}

function restoreTelegramSession(session: MutableTelegramStoreSession, snapshot: TelegramSessionSnapshot) {
    if (snapshot.dcId !== undefined && snapshot.serverAddress && snapshot.port !== undefined) {
        session.setDC(snapshot.dcId, snapshot.serverAddress, snapshot.port)
    }
    session.setAuthKey(snapshot.authKey)
}

function configureTelegramSessionForWebDc(
    session: MutableTelegramStoreSession,
    host: string,
    originalSession: TelegramSessionSnapshot,
) {
    const endpoint = getTelegramWebDcEndpoint(host)
    if (!endpoint) {
        return host
    }

    session.setDC(endpoint.dcId, endpoint.host, 443)
    if (originalSession.dcId === endpoint.dcId) {
        session.setAuthKey(originalSession.authKey)
    } else {
        // Auth keys are DC-scoped. Reusing a Pluto key against Venus just turns
        // a DC outage into another handshake failure.
        session.setAuthKey(undefined)
    }
    return endpoint.host
}

function createBrowserTelegramClient(config: Config.Config, storeSession: MutableTelegramStoreSession): TelegramClient {
    return new TelegramClientCtor(storeSession as any, config.apiId, config.apiHash, {
        connectionRetries: 5,
        useWSS: true,
        networkSocket: PromisedWebSocketsCtor as any,
    })
}

async function connectTelegramClientWithTimeout(client: TelegramClient, host: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const connectPromise = client.connect()
    connectPromise.catch(() => undefined)
    try {
        await Promise.race([
            connectPromise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`Timed out starting Telegram web DC ${host}`))
                }, TELEGRAM_WEB_DC_START_TIMEOUT_MS)
            }),
        ])
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout)
        }
    }
    if (!client.connected) {
        throw new Error(`Telegram web DC ${host} did not connect`)
    }
}

/**
 * Signs a connected client in. `markInteractive` must be called as soon as the
 * user has been asked for input, after which connection errors no longer fall
 * back to the next web DC (the auth state lives on the current connection).
 */
type TelegramClientAuthenticator = (client: TelegramClient, markInteractive: () => void) => Promise<void>

function createLoginCancelledError() {
    return new Error(TELEGRAM_LOGIN_CANCELLED)
}

/** Rejects as soon as `signal` aborts, so a hung GramJS auth step cannot pin the login flow. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise
    }
    if (signal.aborted) {
        promise.catch(() => undefined)
        return Promise.reject(createLoginCancelledError())
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createLoginCancelledError())
        signal.addEventListener("abort", onAbort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort)
                resolve(value)
            },
            (error) => {
                signal.removeEventListener("abort", onAbort)
                reject(error)
            },
        )
    })
}

async function startTelegramClientWithWebDcFallback(
    config: Config.Config,
    storeSession: MutableTelegramStoreSession,
    authenticate: TelegramClientAuthenticator,
    signal?: AbortSignal,
): Promise<TelegramClient> {
    await storeSession.load()
    const originalSession = snapshotTelegramSession(storeSession)
    const initialAddress = originalSession.serverAddress ?? TELEGRAM_WEB_DC_ENDPOINTS[3].host
    const hosts = getTelegramWebDcFallbackHosts(initialAddress)
    let lastError: unknown
    let interactive = false
    const markInteractive = () => {
        interactive = true
    }

    for (const host of hosts) {
        if (signal?.aborted) {
            restoreTelegramSession(storeSession, originalSession)
            throw createLoginCancelledError()
        }
        const activeHost = configureTelegramSessionForWebDc(storeSession, host, originalSession)
        const client = createBrowserTelegramClient(config, storeSession)
        const disconnectOnAbort = () => {
            void client.disconnect().catch(() => undefined)
        }
        signal?.addEventListener("abort", disconnectOnAbort, { once: true })
        try {
            console.info(`Trying Telegram web DC ${activeHost}`)
            await raceAbort(connectTelegramClientWithTimeout(client, activeHost), signal)
            await raceAbort(authenticate(client, markInteractive), signal)
            return client
        } catch (error) {
            lastError = error
            const fatal = signal?.aborted || interactive || !isTelegramWebDcConnectionError(error)
            if (fatal) {
                // Restore synchronously, before awaiting the disconnect, so a quickly started
                // next attempt never has its freshly stored session overwritten by this one.
                restoreTelegramSession(storeSession, originalSession)
            }
            await client.disconnect().catch(() => undefined)
            if (fatal) {
                throw signal?.aborted ? createLoginCancelledError() : error
            }
            console.warn(`Telegram web DC ${activeHost} failed, trying next fallback`, error)
        } finally {
            signal?.removeEventListener("abort", disconnectOnAbort)
        }
    }

    restoreTelegramSession(storeSession, originalSession)
    throw lastError instanceof Error ? lastError : new Error("Failed to connect to Telegram web DCs")
}

/** Shared connection setup for every sign-in path: stored session + web DC fallback. */
async function connectWithStoredSession(
    config: Config.Config,
    authenticate: TelegramClientAuthenticator,
    signal?: AbortSignal,
): Promise<TelegramClient> {
    await gramJsReady
    console.log("Starting up...")
    // Load the previous session (persisted in localStorage under ./tglfs.session:*).
    const storeSession = new StoreSession("./tglfs.session")
    // GramJS types StoreSession's DC fields as accessors; the fallback only needs this structural subset.
    const client = await startTelegramClientWithWebDcFallback(
        config,
        storeSession as unknown as MutableTelegramStoreSession,
        authenticate,
        signal,
    )
    console.log("You are now logged in!")
    return client
}

/**
 * GramJS keeps retrying an auth step for as long as `onError` returns falsy.
 * Returning true once the attempt is aborted makes it stop with AUTH_USER_CANCEL
 * instead of re-asking a prompt that will never be answered.
 */
function createAuthErrorHandler(onError: ((error: unknown) => void) | undefined, signal?: AbortSignal) {
    return async (error: Error) => {
        if (signal?.aborted) {
            return true
        }
        onError?.(error)
        console.error(error)
        return false
    }
}

function createPasswordPrompt(
    getPassword: ((hint?: string) => Promise<string>) | undefined,
    markInteractive: () => void,
    signal?: AbortSignal,
) {
    return async (hint?: string) => {
        markInteractive()
        if (signal?.aborted) {
            throw createLoginCancelledError()
        }
        const pwd = getPassword ? await getPassword(hint) : prompt("Enter your password: ")
        if (!pwd) {
            throw new Error("No password provided.")
        }
        return pwd
    }
}

/** Phone-number login (code + optional 2FA). An already-authorized stored session is reused as-is. */
export async function init(config: Config.Config, authHandlers: AuthHandlers = {}): Promise<TelegramClient> {
    const { signal } = authHandlers
    return connectWithStoredSession(
        config,
        async (client, markInteractive) => {
            await client.start({
                phoneNumber: config.phone,
                password: createPasswordPrompt(authHandlers.getPassword, markInteractive, signal),
                phoneCode: async () => {
                    markInteractive()
                    if (signal?.aborted) {
                        throw createLoginCancelledError()
                    }
                    const code = authHandlers.getPhoneCode
                        ? await authHandlers.getPhoneCode()
                        : prompt("Enter the code you received: ")
                    if (!code) {
                        throw new Error("No code provided.")
                    }
                    return code
                },
                onError: createAuthErrorHandler(authHandlers.onError, signal),
            })
        },
        signal,
    )
}

function computeQrExpiresAt(expires: number) {
    // `expires` is a server unix timestamp; tolerate local clock skew by falling
    // back to GramJS's refresh cadence, and never promise more than that.
    let ttl = expires * 1000 - Date.now()
    if (!(ttl > 5_000 && ttl <= 120_000)) {
        ttl = TELEGRAM_QR_TOKEN_REFRESH_MS
    }
    return Date.now() + Math.min(ttl, TELEGRAM_QR_TOKEN_REFRESH_MS)
}

/**
 * QR-code login: Telegram issues short-lived login tokens that an already
 * logged-in Telegram app scans (Settings > Devices > Link Desktop Device).
 * GramJS rotates the tokens, migrates DC after the scan and runs the 2FA step.
 */
export async function initWithQrCode(config: Config.Config, handlers: QrLoginHandlers): Promise<TelegramClient> {
    const { signal } = handlers
    return connectWithStoredSession(
        config,
        async (client, markInteractive) => {
            if (await client.checkAuthorization()) {
                return
            }
            let settled = false
            client.addEventHandler((update: unknown) => {
                if (!settled && update instanceof Api.UpdateLoginToken) {
                    handlers.onScanned?.()
                }
            })
            try {
                await client.signInUserWithQrCode(
                    { apiId: config.apiId, apiHash: config.apiHash },
                    {
                        qrCode: async ({ token, expires }) => {
                            if (signal?.aborted) {
                                throw createLoginCancelledError()
                            }
                            markInteractive()
                            handlers.onQrCode({
                                token: new Uint8Array(token),
                                expiresAt: computeQrExpiresAt(expires),
                            })
                        },
                        password: createPasswordPrompt(handlers.getPassword, markInteractive, signal),
                        onError: createAuthErrorHandler(handlers.onError, signal),
                    },
                )
            } finally {
                settled = true
            }
        },
        signal,
    )
}

/**
 * Reconnects with the stored session without starting an interactive sign-in.
 * Rejects with SESSION_NOT_AUTHORIZED when Telegram no longer accepts the session.
 */
export async function resumeStoredSession(config: Config.Config, signal?: AbortSignal): Promise<TelegramClient> {
    return connectWithStoredSession(
        config,
        async (client) => {
            try {
                await client.invoke(new Api.updates.GetState())
            } catch (error) {
                // Only a definitive "not authorized" answer counts; network trouble is rethrown
                // so a flaky connection never looks like a revoked session.
                const rpc = error as { code?: number; errorMessage?: string; message?: string }
                const text = `${rpc?.errorMessage ?? ""} ${rpc?.message ?? ""}`
                if (rpc?.code === 401 || /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i.test(text)) {
                    throw new Error(TELEGRAM_SESSION_NOT_AUTHORIZED)
                }
                throw error
            }
        },
        signal,
    )
}

/** Reads the signed-in account so a QR login can be persisted like a phone login. */
export async function getSignedInAccount(client: TelegramClient): Promise<TelegramAccount> {
    const me = (await client.getMe()) as TelegramApi.User
    const phone = typeof me.phone === "string" ? me.phone.replace(/\s+/g, "") : ""
    return {
        id: String(me.id),
        phone: phone ? (phone.startsWith("+") ? phone : `+${phone}`) : undefined,
        username: me.username || undefined,
        firstName: me.firstName || undefined,
        lastName: me.lastName || undefined,
    }
}
