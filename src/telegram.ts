/**
 * Telegram client methods.
 * @module Telegram
 */

// TODO: Add `tglfs:chunk` annotation to chunk files.

import type { Api as TelegramApi, TelegramClient } from "telegram"

import * as Config from "./config"
import { getGramJs } from "./gramjs"
import {
    buildFileCardSearchQuery,
    buildFileCardUfidLookupQuery,
    createFileCardData,
    extractFileCardRecords,
    formatFileCardDate,
    formatFileCardSize,
    parseFileCardMessage,
    serializeFileCardMessage,
} from "../packages/tglfs-cli/src/shared/file-cards"
import { TGLFS_ROOT_PARENT_ID } from "../packages/tglfs-cli/src/shared/constants"
import { planDirectoryParentMigration } from "../packages/tglfs-cli/src/shared/directory-migration"
import { extractTelegramFloodWaitSeconds } from "../packages/tglfs-cli/src/shared/telegram-rate-limit"
import { createTelegramWebDcFallbackSocket } from "../packages/tglfs-cli/src/shared/telegram-web-dc"
import {
    TGLFS_FOLDER_ENTRIES_MIME_TYPE,
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
    deleteFileCardMessages as sharedDeleteFileCardMessages,
    listFileCards as sharedListFileCards,
    lookupFileCardByUfid as sharedLookupFileCardByUfid,
    renameFileCardMessage as sharedRenameFileCardMessage,
    transferFileCard as sharedTransferFileCard,
} from "../packages/tglfs-cli/src/shared/telegram-files"
import * as Encryption from "./web/encryption"
import * as FileProcessing from "./web/fileProcessing"
import * as Archive from "../packages/tglfs-cli/src/shared/archive"
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

    // Hide UI and show progress bar.
    const controlsDiv = document.getElementById("controls")
    const browserDiv = document.getElementById("fileBrowser")
    const progressDiv = document.getElementById("progressBarContainer")
    const controlsWasVisible = !!controlsDiv && !controlsDiv.hasAttribute("hidden")
    const browserWasVisible = !!browserDiv && !browserDiv.hasAttribute("hidden")
    if (controlsDiv) controlsDiv.setAttribute("hidden", "")
    if (browserDiv) browserDiv.setAttribute("hidden", "")
    document.body.classList.remove("file-browser-active")
    progressDiv?.removeAttribute("hidden")

    // Set up progress bar view.
    const progressBarText = document.getElementById("progressBarText")
    const progressBar = document.getElementById("progress")
    const progressBytesText = document.getElementById("progressBytesText")
    const progressTimeText = document.getElementById("progressTimeText")
    if (progressBarText && progressBar) {
        progressBarText.textContent = `Downloading ${fileCardData.name}`
        progressBar.style.width = "0%"
        progressBar.textContent = "0%"
        progressBar.setAttribute("aria-valuenow", "0")
        if (progressBytesText) progressBytesText.textContent = `0 / ${fileCardData.size} B`
        if (progressTimeText) progressTimeText.textContent = `Elapsed: 00:00:00 • Remaining: --:--:--`
    }

    try {
        // Request chunk messages by their IDs in the file card.
        const chunkMsgs: TelegramApi.messages.Messages = await client.getMessages("me", { ids: fileCardData.chunks })

        const IVBytes = base64ToBytes(fileCardData.IV)
        // TODO: DRY-ify the salt & counter byte size. Should be
        // module-level constants.
        const salt = IVBytes.subarray(0, 16)
        const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt)
        let decryptionCounter = IVBytes.slice(16)

        let aesBlockBytesWritten = 0
        const decryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)

        let bytesProcessed = 0
        const startTimeMs = Date.now()
        // For streaming UFID verification.
        const UFIDChunkSize = 64 * 1024 // 64 KiB.
        let ufidRolling = new Uint8Array(0)
        let ufidPending = new Uint8Array(0)
        const byteCounterStream = new TransformStream({
            async transform(chunk, controller) {
                bytesProcessed += chunk.length
                if (progressBar) {
                    const progressPercentage = Math.round((bytesProcessed / fileCardData.size) * 100).toString()
                    progressBar.style.width = `${progressPercentage}%`
                    progressBar.textContent = `${progressPercentage}%`
                    progressBar.setAttribute("aria-valuenow", progressPercentage)
                }
                if (progressBytesText) {
                    const units = ["B", "KiB", "MiB", "GiB", "PiB"] as const
                    const pickUnit = (n: number) => {
                        let i = 0
                        while (i < units.length - 1 && n >= 1024) {
                            n = n / 1024
                            i++
                        }
                        return { value: n, unit: units[i] }
                    }
                    const sofar = pickUnit(bytesProcessed)
                    const total = pickUnit(fileCardData.size)
                    progressBytesText.textContent = `${sofar.value.toFixed(sofar.unit === "B" ? 0 : 2)} ${sofar.unit} / ${total.value.toFixed(total.unit === "B" ? 0 : 2)} ${total.unit}`
                }
                if (progressTimeText) {
                    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000))
                    const rate = elapsedSec > 0 ? bytesProcessed / elapsedSec : 0
                    const remainingBytes = Math.max(0, fileCardData.size - bytesProcessed)
                    const etaSec = rate > 0 ? Math.ceil(remainingBytes / rate) : 0
                    const fmt = (s: number) => {
                        const h = Math.floor(s / 3600)
                        const m = Math.floor((s % 3600) / 60)
                        const sec = s % 60
                        const pad = (n: number) => n.toString().padStart(2, "0")
                        return `${pad(h)}:${pad(m)}:${pad(sec)}`
                    }
                    progressTimeText.textContent = `Elapsed: ${fmt(elapsedSec)} • Remaining: ${etaSec ? fmt(etaSec) : "--:--:--"}`
                }
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
                controller.enqueue(chunk)
            },
        })

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
                    while (chunkBytesWritten < chunkMsg.media.document.size) {
                        // Download the next (up to) `DOWNLOAD_PART_SIZE` bytes of the chunk file.
                        const chunkPart = await client.invoke(
                            new Api.upload.GetFile({
                                location: getFileInfo(chunkMsg.media).location,
                                offset: chunkBytesWritten,
                                limit: DOWNLOAD_PART_SIZE,
                                precise: false,
                                cdnSupported: false,
                            }),
                        )
                        chunkBytesWritten += chunkPart.bytes.length

                        // Write the chunk part to the decryption buffer.
                        decryptionBuffer.set(chunkPart.bytes, aesBlockBytesWritten)
                        aesBlockBytesWritten += chunkPart.bytes.length

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
                            const blocks = Math.ceil(decryptionBuffer.length / 16)
                            decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, blocks)
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
                    const tailBlocks = Math.ceil(aesBlockBytesWritten / 16)
                    decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, tailBlocks)

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
                if (streamError instanceof Error && streamError.message === "Incorrect decryption password.") {
                    alert("Incorrect decryption password entered. Aborting download.")
                }
                throw streamError
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
            if (computedUfid !== fileCardData.ufid) {
                alert("UFID mismatch. The downloaded file may be corrupted or the wrong password was used.")
            }
        }

        const sanitizedUfid = encodeURIComponent(fileCardData.ufid)
        const responsePromise = fetch("/download-file?ufid=" + sanitizedUfid)

        const response = await responsePromise
        if (!response.ok) {
            console.error("Failed to download file.")
            alert("Failed to download file.")
            return
        }

        const serviceWorkerRegistration = await navigator.serviceWorker.ready
        if (serviceWorkerRegistration.active) {
            await downloadFile(serviceWorkerRegistration)
            alert("Download complete.") // TODO: Remove.
        } else {
            console.error("Service worker is not active.")
            alert("Service worker is not active. Cannot proceed with the download.")
        }

        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = fileCardData.name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    } catch (error) {
        console.error(error)
    } finally {
        // Restore previous UI.
        progressDiv?.setAttribute("hidden", "")
        if (browserWasVisible) {
            browserDiv?.removeAttribute("hidden")
            document.body.classList.add("file-browser-active")
        } else if (controlsWasVisible) {
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        } else {
            // Default to showing controls.
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        }
    }
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

    // Hide UI and show progress bar.
    const controlsDiv = document.getElementById("controls")
    const browserDiv = document.getElementById("fileBrowser")
    const progressDiv = document.getElementById("progressBarContainer")
    const controlsWasVisible = !!controlsDiv && !controlsDiv.hasAttribute("hidden")
    const browserWasVisible = !!browserDiv && !browserDiv.hasAttribute("hidden")
    if (controlsDiv) controlsDiv.setAttribute("hidden", "")
    if (browserDiv) browserDiv.setAttribute("hidden", "")
    document.body.classList.remove("file-browser-active")
    progressDiv?.removeAttribute("hidden")

    // Set up progress bar view.
    const progressBarText = document.getElementById("progressBarText")
    const progressBar = document.getElementById("progress")
    const progressBytesText = document.getElementById("progressBytesText")
    const progressTimeText = document.getElementById("progressTimeText")
    if (progressBarText && progressBar) {
        progressBarText.textContent = `Downloading ${fileCardData.name}`
        progressBar.style.width = "0%"
        progressBar.textContent = "0%"
        progressBar.setAttribute("aria-valuenow", "0")
        if (progressBytesText) progressBytesText.textContent = `0 / ${fileCardData.size} B`
        if (progressTimeText) progressTimeText.textContent = `Elapsed: 00:00:00 • Remaining: --:--:--`
    }

    try {
        // Request chunk messages by their IDs in the file card.
        const chunkMsgs: TelegramApi.messages.Messages = await client.getMessages("me", { ids: fileCardData.chunks })

        const IVBytes = base64ToBytes(fileCardData.IV)
        // TODO: DRY-ify the salt & counter byte size. Should be
        // module-level constants.
        const salt = IVBytes.subarray(0, 16)
        const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt)
        let decryptionCounter = IVBytes.slice(16)

        let aesBlockBytesWritten = 0
        const decryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)

        let bytesProcessed = 0
        const startTimeMs = Date.now()
        const byteCounterStream = new TransformStream({
            transform(chunk, controller) {
                bytesProcessed += chunk.length
                controller.enqueue(chunk)
                if (progressBar) {
                    const progressPercentage = Math.round((bytesProcessed / fileCardData.size) * 100).toString()
                    progressBar.style.width = `${progressPercentage}%`
                    progressBar.textContent = `${progressPercentage}%`
                    progressBar.setAttribute("aria-valuenow", progressPercentage)
                }
                if (progressBytesText) {
                    const units = ["B", "KiB", "MiB", "GiB", "PiB"] as const
                    const pickUnit = (n: number) => {
                        let i = 0
                        while (i < units.length - 1 && n >= 1024) {
                            n = n / 1024
                            i++
                        }
                        return { value: n, unit: units[i] }
                    }
                    const sofar = pickUnit(bytesProcessed)
                    const total = pickUnit(fileCardData.size)
                    progressBytesText.textContent = `${sofar.value.toFixed(sofar.unit === "B" ? 0 : 2)} ${sofar.unit} / ${total.value.toFixed(total.unit === "B" ? 0 : 2)} ${total.unit}`
                }
                if (progressTimeText) {
                    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000))
                    const rate = elapsedSec > 0 ? bytesProcessed / elapsedSec : 0
                    const remainingBytes = Math.max(0, fileCardData.size - bytesProcessed)
                    const etaSec = rate > 0 ? Math.ceil(remainingBytes / rate) : 0
                    const fmt = (s: number) => {
                        const h = Math.floor(s / 3600)
                        const m = Math.floor((s % 3600) / 60)
                        const sec = s % 60
                        const pad = (n: number) => n.toString().padStart(2, "0")
                        return `${pad(h)}:${pad(m)}:${pad(sec)}`
                    }
                    progressTimeText.textContent = `Elapsed: ${fmt(elapsedSec)} • Remaining: ${etaSec ? fmt(etaSec) : "--:--:--"}`
                }
            },
        })

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
                    while (chunkBytesWritten < chunkMsg.media.document.size) {
                        // Download the next (up to) `DOWNLOAD_PART_SIZE` bytes of the chunk file.
                        const chunkPart = await client.invoke(
                            new Api.upload.GetFile({
                                location: getFileInfo(chunkMsg.media).location,
                                offset: chunkBytesWritten,
                                limit: DOWNLOAD_PART_SIZE,
                                precise: false,
                                cdnSupported: false,
                            }),
                        )
                        chunkBytesWritten += chunkPart.bytes.length

                        // Write the chunk part to the decryption buffer.
                        decryptionBuffer.set(chunkPart.bytes, aesBlockBytesWritten)
                        aesBlockBytesWritten += chunkPart.bytes.length

                        // If the decryption buffer is full, decrypt.
                        if (aesBlockBytesWritten === decryptionBuffer.length) {
                            const decryptedData = new Uint8Array(
                                await window.crypto.subtle.decrypt(
                                    { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                                    aesKey,
                                    decryptionBuffer,
                                ),
                            )
                            // Legacy behavior: increment the counter by 1 per 1 MiB block.
                            decryptionCounter = Encryption.incrementCounter(decryptionCounter)
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
                            { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                            aesKey,
                            decryptionBuffer.subarray(0, aesBlockBytesWritten),
                        ),
                    )
                    // Legacy behavior: increment the counter by 1 per trailing block set.
                    decryptionCounter = Encryption.incrementCounter(decryptionCounter)

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
                if (streamError instanceof Error && streamError.message === "Incorrect decryption password.") {
                    alert("Incorrect decryption password entered. Aborting download.")
                }
                throw streamError
            }
        }

        const sanitizedUfid = encodeURIComponent(fileCardData.ufid)
        const responsePromise = fetch("/download-file?ufid=" + sanitizedUfid)

        const response = await responsePromise
        if (!response.ok) {
            console.error("Failed to download file.")
            alert("Failed to download file.")
            return
        }

        const serviceWorkerRegistration = await navigator.serviceWorker.ready
        if (serviceWorkerRegistration.active) {
            await downloadFile(serviceWorkerRegistration)
            alert("Download complete.") // TODO: Remove.
        } else {
            console.error("Service worker is not active.")
            alert("Service worker is not active. Cannot proceed with the download.")
        }

        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = fileCardData.name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    } catch (error) {
        console.error(error)
    } finally {
        // Restore previous UI.
        progressDiv?.setAttribute("hidden", "")
        if (browserWasVisible) {
            browserDiv?.removeAttribute("hidden")
            document.body.classList.add("file-browser-active")
        } else if (controlsWasVisible) {
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        } else {
            // Default to showing controls.
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        }
    }
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

export async function fileUpload(
    client: TelegramClient,
    config: Config.Config,
    sharedFiles?: File[],
    options: { parentFolderId?: string } = {},
) {
    await gramJsReady
    // TODO: Implement upload resumption.
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
            alert("No file selected. Aborting.")
            return
        }
        files = Array.from(selectedFiles)
    }
    const single = files.length === 1
    let file = files[0]
    console.log(single ? `Selected file: ${file.name}` : `Selected ${files.length} files for archive upload.`)

    let password = prompt("(Optional) Encryption password:")
    if (password === null) {
        return
    }

    let remuxModule: typeof import("./web/videoRemux") | null = null
    let remuxKind: import("./web/videoRemux").RemuxableVideoKind | null = null
    if (single && isPotentialStreamingRemuxCandidate(file)) {
        remuxModule = await import("./web/videoRemux")
        remuxKind = remuxModule.getRemuxableVideoKind(file)
    }
    const shouldRemuxForStreaming =
        remuxModule !== null && remuxKind !== null
            ? confirm(remuxModule.getRemuxConfirmMessage(file, remuxKind))
            : false
    
    // Hide UI and show progress bar.
    const controlsDiv = document.getElementById("controls")
    const browserDiv = document.getElementById("fileBrowser")
    const progressDiv = document.getElementById("progressBarContainer")
    const controlsWasVisible = !!controlsDiv && !controlsDiv.hasAttribute("hidden")
    const browserWasVisible = !!browserDiv && !browserDiv.hasAttribute("hidden")
    if (controlsDiv) controlsDiv.setAttribute("hidden", "")
    if (browserDiv) browserDiv.setAttribute("hidden", "")
    document.body.classList.remove("file-browser-active")
    progressDiv?.removeAttribute("hidden")
    const restoreUploadUi = () => {
        progressDiv?.setAttribute("hidden", "")
        if (browserWasVisible) {
            browserDiv?.removeAttribute("hidden")
            document.body.classList.add("file-browser-active")
        } else if (controlsWasVisible) {
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        } else {
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        }
    }
    
    // Set up progress bar view.
    const progressBarText = document.getElementById("progressBarText")
    const progressBar = document.getElementById("progress")
    const progressBytesText = document.getElementById("progressBytesText")
    const progressTimeText = document.getElementById("progressTimeText")
    let displayName = single ? file.name : Archive.defaultArchiveName()
    let totalBytes = single ? file.size : Archive.computeTarSize(files)
    let inputStream: ReadableStream<Uint8Array>
    let ufidStream: ReadableStream<Uint8Array> | null = null
    const progressUnits = ["B", "KiB", "MiB", "GiB", "PiB"] as const
    const pickProgressUnit = (n: number) => {
        let i = 0
        let unitValue = n
        while (i < progressUnits.length - 1 && unitValue >= 1024) {
            unitValue = unitValue / 1024
            i++
        }
        return { value: unitValue, unit: progressUnits[i] }
    }
    const progressFormatDuration = (s: number) => {
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        const pad = (n: number) => n.toString().padStart(2, "0")
        return `${pad(h)}:${pad(m)}:${pad(sec)}`
    }
    const setProgressPhase = (phaseText: string) => {
        if (progressBarText) {
            progressBarText.textContent = phaseText
        }
        if (progressBar) {
            progressBar.style.width = "0%"
            progressBar.textContent = "0%"
            progressBar.setAttribute("aria-valuenow", "0")
        }
        if (progressBytesText) progressBytesText.textContent = `0 / ${totalBytes} B`
        if (progressTimeText) progressTimeText.textContent = `Elapsed: 00:00:00 • Remaining: --:--:--`
    }
    const updateProgressBar = (bytesProcessed: number, phaseStartMs: number, phaseText: string) => {
        const progress = totalBytes > 0 ? Math.round((bytesProcessed / totalBytes) * 100) : 0
        if (progressBar) {
            progressBar.style.width = `${progress}%`
            progressBar.textContent = `${progress}%`
            progressBar.setAttribute("aria-valuenow", progress.toString())
        }
        if (progressBytesText) {
            const sofar = pickProgressUnit(bytesProcessed)
            const total = pickProgressUnit(totalBytes)
            progressBytesText.textContent = `${sofar.value.toFixed(sofar.unit === "B" ? 0 : 2)} ${sofar.unit} / ${total.value.toFixed(total.unit === "B" ? 0 : 2)} ${total.unit}`
        }
        if (progressTimeText) {
            const elapsedSec = Math.max(0, Math.floor((Date.now() - phaseStartMs) / 1000))
            const rate = elapsedSec > 0 ? bytesProcessed / elapsedSec : 0
            const remainingBytes = Math.max(0, totalBytes - bytesProcessed)
            const etaSec = rate > 0 ? Math.ceil(remainingBytes / rate) : 0
            progressTimeText.textContent = `Elapsed: ${progressFormatDuration(elapsedSec)} • Remaining: ${
                etaSec ? progressFormatDuration(etaSec) : "--:--:--"
            }`
        }
        if (progressBarText) {
            progressBarText.textContent = phaseText
        }
    }

    if (shouldRemuxForStreaming && remuxModule !== null && remuxKind !== null) {
        const remuxPhaseLabel = `Remuxing ${file.name} for streaming`
        const remuxStartMs = Date.now()
        setProgressPhase(remuxPhaseLabel)
        try {
            file = await remuxModule.remuxToStreamingMp4(file, remuxKind, (progress) => {
                updateProgressBar(Math.round((progress / 100) * totalBytes), remuxStartMs, remuxPhaseLabel)
            })
            files = [file]
            displayName = file.name
            totalBytes = file.size
            console.log(`Remuxed upload for streaming: ${displayName}`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            alert(`Remux failed.\n\n${message}`)
            restoreUploadUi()
            return
        }
    }

    if (single) {
        displayName = file.name
        totalBytes = file.size
        inputStream = file.stream()
    } else {
        displayName = Archive.defaultArchiveName()
        totalBytes = Archive.computeTarSize(files)
        const tarStream = Archive.createTarStream(files)
        const teed = tarStream.tee()
        ufidStream = teed[0]
        inputStream = teed[1]
    }

    const ufidPhaseLabel = `Calculating UFID for ${displayName}`
    const uploadPhaseLabel = `Uploading ${displayName}`
    setProgressPhase(ufidPhaseLabel)

    try {
        const salt = window.crypto.getRandomValues(new Uint8Array(16))
        const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt)
        const initialCounter = window.crypto.getRandomValues(new Uint8Array(16))
        // Produce initialization vector for AES-CTR encryption (salt & initial counter).
        const IVBytes = new Uint8Array(salt.length + initialCounter.length)
        IVBytes.set(salt, 0)
        IVBytes.set(initialCounter, salt.length)
        const IV = bytesToBase64(IVBytes)
        let encryptionCounter = new Uint8Array(initialCounter)

        const ufidStartMs = Date.now()
        updateProgressBar(0, ufidStartMs, ufidPhaseLabel)
        await new Promise((resolve) => setTimeout(resolve, 0))
        const onUfidProgress = (bytesProcessed: number) => {
            updateProgressBar(bytesProcessed, ufidStartMs, ufidPhaseLabel)
        }
        console.log(`Starting UFID generation for ${displayName}`)
        const UFID = single
            ? await FileProcessing.UFID(file, onUfidProgress)
            : await FileProcessing.UFIDFromStream(ufidStream!, onUfidProgress, totalBytes)
        console.log(`UFID generated for ${displayName}: ${UFID}`)

        setProgressPhase(uploadPhaseLabel)
        console.log(`Upload begins for ${displayName}`)
        const startTimeMs = Date.now()
        let bytesProcessed = 0

        const existingMsgs = await client.getMessages("me", {
            search: buildFileCardUfidLookupQuery(UFID),
        })

        if (existingMsgs.length > 0) {
            alert(`Error: Duplicate UFID.\n\nA file with the same contents already exists.\n\nCopying UFID to clipboard.`)
            await navigator.clipboard.writeText(UFID)
            return
        }

        const browserDiv = document.getElementById("fileBrowser")
        const browserVisible = !!browserDiv && !browserDiv.hasAttribute("hidden")
        const browserParentFolderId = browserVisible ? (window as any).__tglfsUploadParentFolderId : undefined
        const parentFolderId = options.parentFolderId?.trim() || browserParentFolderId?.trim?.() || TGLFS_ROOT_PARENT_ID

        let fileCardData: FileCardData = createFileCardData({
            name: displayName,
            ufid: UFID,
            size: totalBytes,
            uploadComplete: false,
            chunks: [],
            IV: IV,
            parentFolderId,
        })
        const fileCardMessage = await client.sendMessage("me", { message: serializeFileCardMessage(fileCardData) })

        const byteCounterStream = new TransformStream({
            transform(chunk, controller) {
                bytesProcessed += chunk.length;
                controller.enqueue(chunk);
            },
        })

        const fileStream = inputStream.pipeThrough(byteCounterStream)
        const compressedStream = fileStream.pipeThrough(new CompressionStream("gzip"))
        const reader = compressedStream.getReader()

        let aesBlockBytesWritten = 0
        const encryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)
        let partBytesWritten = 0
        const partBuffer = new Uint8Array(UPLOAD_PART_SIZE)
        let partIndex = 0
        let chunkIndex = 0
        let chunkBytesWritten = 0
        let chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))

        let done, value
        while ((({ done, value } = await reader.read()), !done)) {
            let valueBytesProcessed = 0
            // Write the value to encryptionBuffer.
            while (valueBytesProcessed < value.length) {
                const remainingEncryptionBufferSpace = encryptionBuffer.length - aesBlockBytesWritten // Remaining space in encryptionBuffer.
                const remainingValueBytesToProcess = value.length - valueBytesProcessed
                const bytesToCopy = Math.min(remainingValueBytesToProcess, remainingEncryptionBufferSpace)
                encryptionBuffer.set(
                    value.subarray(valueBytesProcessed, valueBytesProcessed + bytesToCopy),
                    aesBlockBytesWritten,
                )
                aesBlockBytesWritten += bytesToCopy
                valueBytesProcessed += bytesToCopy
                if (aesBlockBytesWritten === encryptionBuffer.length) {
                    // encryptionBuffer is full. Encrypt it.
                    const encryptedData = new Uint8Array(
                        await window.crypto.subtle.encrypt(
                            {
                                name: "AES-CTR",
                                counter: encryptionCounter,
                                length: 64, // Bit length of the counter block.
                            },
                            aesKey,
                            encryptionBuffer,
                        ),
                    )
                    // Reset the encryption buffer and advance AES-CTR counter by blocks processed.
                    aesBlockBytesWritten = 0
                    const blocks = Math.ceil(encryptionBuffer.length / 16)
                    encryptionCounter = Encryption.incrementCounter64By(encryptionCounter, blocks)
                    // Write the encrypted data to partBuffer in a loop.
                    let encryptedDataBytesProcessed = 0
                    while (encryptedDataBytesProcessed < encryptedData.length) {
                        const remainingPartBufferSpace = partBuffer.length - partBytesWritten
                        const remainingEncryptedDataBytesToProcess = encryptedData.length - encryptedDataBytesProcessed
                        const bytesToCopy = Math.min(remainingEncryptedDataBytesToProcess, remainingPartBufferSpace)
                        partBuffer.set(
                            encryptedData.subarray(encryptedDataBytesProcessed, encryptedDataBytesProcessed + bytesToCopy),
                            partBytesWritten,
                        )
                        partBytesWritten += bytesToCopy
                        encryptedDataBytesProcessed += bytesToCopy
                        if (partBytesWritten === UPLOAD_PART_SIZE) {
                            // partBuffer is full. Send as much as will fit in this chunk.
                            const remainingChunkSpace = config.chunkSize - chunkBytesWritten
                            if (remainingChunkSpace <= UPLOAD_PART_SIZE) {
                                // Part overflows chunk size. Finalize the chunk
                                // and populate next one with leftover data in partBuffer.
                                const partBufferSubarray = partBuffer.subarray(0, remainingChunkSpace)
                                // Send partBufferSubarray as a file part to Telegram.
                                const result = await client.invoke(
                                    new Api.upload.SaveBigFilePart({
                                        fileId: chunkFileId,
                                        filePart: partIndex,
                                        fileTotalParts: partIndex + 1,
                                        bytes: Buffer.from(partBufferSubarray),
                                    }),
                                )
                                if (!result) {
                                    throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
                                }
                                console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`)

                                // Finalize the chunk.
                                const chunkFileUploaded = new Api.InputFileBig({
                                    id: chunkFileId,
                                    parts: partIndex + 1,
                                    name: `${UFID}.chunk${chunkIndex + 1}`,
                                })
                                // Send the chunk message.
                                const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded })

                                // Update file card.
                                fileCardData.chunks.push(chunkMessage.id)
                                await client.invoke(
                                    new Api.messages.EditMessage({
                                        peer: fileCardMessage.peerId,
                                        id: fileCardMessage.id,
                                        message: serializeFileCardMessage(fileCardData),
                                    }),
                                )

                                // Reset chunk index and fileId for the next chunk.
                                chunkIndex++
                                chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))

                                // Left shift bytes in partBuffer by remainingChunkSpace.
                                partBuffer.copyWithin(0, remainingChunkSpace)
                                partBytesWritten -= remainingChunkSpace
                                partIndex = 0

                                // Update chunkBytesWritten with the size of the roll-over data.
                                chunkBytesWritten = UPLOAD_PART_SIZE - remainingChunkSpace
                            } else {
                                // Send the partBuffer data as a file part.
                                const result = await client.invoke(
                                    new Api.upload.SaveBigFilePart({
                                        fileId: chunkFileId,
                                        filePart: partIndex,
                                        fileTotalParts: -1,
                                        bytes: Buffer.from(partBuffer),
                                    }),
                                )
                                if (!result) {
                                    throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
                                }
                                console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
                                partBytesWritten = 0
                                partIndex++

                                // Update chunkBytesWritten.
                                chunkBytesWritten += UPLOAD_PART_SIZE
                            }
                        }
                    }
                }
            }
            // Update the progress UI.
            updateProgressBar(bytesProcessed, startTimeMs, uploadPhaseLabel)
        }
        // Flush encryptionBuffer.
        if (aesBlockBytesWritten > 0) {
            const encryptedData = new Uint8Array(
                await window.crypto.subtle.encrypt(
                    {
                        name: "AES-CTR",
                        counter: encryptionCounter,
                        length: 64, // Bit length of the counter block.
                    },
                    aesKey,
                    encryptionBuffer.subarray(0, aesBlockBytesWritten),
                ),
            )
            const tailBlocks = Math.ceil(aesBlockBytesWritten / 16)
            encryptionCounter = Encryption.incrementCounter64By(encryptionCounter, tailBlocks)
            let encryptedDataBytesProcessed = 0
            while (encryptedDataBytesProcessed < encryptedData.length) {
                const remainingPartBufferSpace = partBuffer.length - partBytesWritten
                const remainingEncryptedDataBytesToProcess = encryptedData.length - encryptedDataBytesProcessed
                const bytesToCopy = Math.min(remainingEncryptedDataBytesToProcess, remainingPartBufferSpace)
                partBuffer.set(
                    encryptedData.subarray(encryptedDataBytesProcessed, encryptedDataBytesProcessed + bytesToCopy),
                    partBytesWritten,
                )
                partBytesWritten += bytesToCopy
                encryptedDataBytesProcessed += bytesToCopy

                if (partBytesWritten === UPLOAD_PART_SIZE) {
                    // Part buffer is full. Send as much as will fit in this chunk.
                    const remainingChunkSpace = config.chunkSize - chunkBytesWritten
                    if (remainingChunkSpace <= UPLOAD_PART_SIZE) {
                        // Part overflows chunk size. Finalize the chunk
                        // and populate next one with leftover data in partBuffer.
                        const partBufferSubarray = partBuffer.subarray(0, remainingChunkSpace)
                        const result = await client.invoke(
                            new Api.upload.SaveBigFilePart({
                                fileId: chunkFileId,
                                filePart: partIndex,
                                fileTotalParts: partIndex + 1,
                                bytes: Buffer.from(partBufferSubarray),
                            }),
                        )
                        if (!result) {
                            throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
                        }
                        console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`)

                        const chunkFileUploaded = new Api.InputFileBig({
                            id: chunkFileId,
                            parts: partIndex + 1,
                            name: `${UFID}.chunk${chunkIndex + 1}`,
                        })
                        // Send the chunk message.
                        const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded })

                        // Update file card.
                        fileCardData.chunks.push(chunkMessage.id)
                        await client.invoke(
                            new Api.messages.EditMessage({
                                peer: fileCardMessage.peerId,
                                id: fileCardMessage.id,
                                message: serializeFileCardMessage(fileCardData),
                            }),
                        )

                        // Reset chunk index and fileId for the next chunk.
                        chunkIndex++
                        chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))

                        // Left shift bytes in partBuffer by remainingChunkSpace.
                        partBuffer.copyWithin(0, remainingChunkSpace)
                        partBytesWritten -= remainingChunkSpace
                        partIndex = 0

                        // Update chunkBytesWritten with the size of the roll-over data.
                        chunkBytesWritten = UPLOAD_PART_SIZE - remainingChunkSpace
                    } else {
                        const result = await client.invoke(
                            new Api.upload.SaveBigFilePart({
                                fileId: chunkFileId,
                                filePart: partIndex,
                                fileTotalParts: -1,
                                bytes: Buffer.from(partBuffer),
                            }),
                        )
                        if (!result) {
                            throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
                        }
                        console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
                        partBytesWritten = 0
                        partIndex++

                        // Update chunkBytesWritten.
                        chunkBytesWritten += UPLOAD_PART_SIZE
                    }
                }
            }
        }
        // Flush partBuffer.
        if (partBytesWritten > 0) {
            const remainingChunkSpace = config.chunkSize - chunkBytesWritten
            if (remainingChunkSpace <= partBytesWritten) {
                // Part overflows chunk size. Finalize the chunk
                // and populate next one with leftover data in partBuffer.
                const partBufferSubarray = partBuffer.subarray(0, remainingChunkSpace)
                const result = await client.invoke(
                    new Api.upload.SaveBigFilePart({
                        fileId: chunkFileId,
                        filePart: partIndex,
                        fileTotalParts: partIndex + 1,
                        bytes: Buffer.from(partBufferSubarray),
                    }),
                )
                if (!result) {
                    throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
                }
                console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`)

                const chunkFileUploaded = new Api.InputFileBig({
                    id: chunkFileId,
                    parts: partIndex + 1,
                    name: `${UFID}.chunk${chunkIndex + 1}`,
                })
                // Send the chunk message.
                const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded })

                // Update file card.
                fileCardData.chunks.push(chunkMessage.id)
                await client.invoke(
                    new Api.messages.EditMessage({
                        peer: fileCardMessage.peerId,
                        id: fileCardMessage.id,
                        message: serializeFileCardMessage(fileCardData),
                    }),
                )

                // Reset chunk index and fileId for the next chunk.
                chunkIndex++
                chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))

                // Left shift bytes in partBuffer by remainingChunkSpace.
                partBuffer.copyWithin(0, remainingChunkSpace)
                partBytesWritten -= remainingChunkSpace
                partIndex = 0

                // Note: We don't need chunkBytesWritten anymore,
                // so we don't update it here as we did before.
            }
            // Upload the roll-over data in partBuffer as the last chunk.
            const partBufferSubarray = partBuffer.subarray(0, partBytesWritten)
            const result = await client.invoke(
                new Api.upload.SaveBigFilePart({
                    fileId: chunkFileId,
                    filePart: partIndex,
                    fileTotalParts: partIndex + 1,
                    bytes: Buffer.from(partBufferSubarray),
                }),
            )
            if (!result) {
                throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
            }
            console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`)
        }
        const chunkFileUploaded = new Api.InputFileBig({
            id: chunkFileId,
            parts: partIndex + 1,
            name: `${UFID}.chunk${chunkIndex + 1}`,
        })
        // Send the chunk message.
        const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded })

        // Update file card with last chunk included and uploadComplete being true.
        fileCardData.chunks.push(chunkMessage.id)
        fileCardData.uploadComplete = true
        await client.invoke(
            new Api.messages.EditMessage({
                peer: fileCardMessage.peerId,
                id: fileCardMessage.id,
                message: serializeFileCardMessage(fileCardData),
            }),
        )

        const humanReadableFileSize = humanReadableSize(fileCardData.size)
        const date = new Date(fileCardMessage.date * 1000)
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
    
        alert(`File upload complete:\n\n${fileInfo}\n\nCopying UFID to clipboard.`)

        await navigator.clipboard.writeText(fileCardData.ufid)

        // Notify the file browser (if visible) to refresh its listing.
        window.dispatchEvent(new Event("tglfs:refresh-browser"))
    } catch (error) {
        console.error(error)
    } finally {
        // Restore previous UI.
        restoreUploadUi()
    }
}

export async function listFileCards(
    client: TelegramClient,
    opts?: { query?: string; parentFolderId?: string; limit?: number; offsetId?: number },
): Promise<Array<{ msgId: number; date: number; data: FileCardData }>> {
    return sharedListFileCards(client, opts)
}

export async function getFileCardByUfid(
    client: TelegramClient,
    ufid: string,
): Promise<{ msgId: number; date: number; data: FileCardData } | null> {
    await gramJsReady
    return sharedLookupFileCardByUfid(client, ufid)
}

export async function listFolderRecords(
    client: TelegramClient,
    opts?: { query?: string; parentFolderId?: string; limit?: number; offsetId?: number },
): Promise<TglfsFolderRecord[]> {
    await gramJsReady
    const query = (opts?.query || "").trim()
    const search = opts?.parentFolderId
        ? buildFolderParentSearchQuery(opts.parentFolderId, query)
        : query ? `${TGLFS_FOLDER_TYPE} ${query}` : buildFolderSearchQuery()
    const messages = await client.getMessages("me", {
        search,
        limit: opts?.limit ?? 50,
        addOffset: 0,
        minId: 0,
        maxId: opts?.offsetId ?? 0,
        waitTime: 0,
    } as any)
    const records: TglfsFolderRecord[] = []
    const seenFolderIds = new Set<string>()
    for (const message of messages) {
        const record = extractTglfsFolderRecord(message as any)
        if (record && !record.data.deleted && !seenFolderIds.has(record.data.folderId)) {
            seenFolderIds.add(record.data.folderId)
            records.push(record)
        }
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
    // Lightweight wrapper calling existing fileDownload code path with minor factoring would be ideal.
    // For now, reuse core logic by temporarily stashing into window and invoking a specialized path is not necessary.
    // We inline minimal setup and call the internal logic similar to fileDownload, but without prompts.
    const controlsDiv = document.getElementById("controls")
    const browserDiv = document.getElementById("fileBrowser")
    const progressDiv = document.getElementById("progressBarContainer")
    const controlsWasVisible = !!controlsDiv && !controlsDiv.hasAttribute("hidden")
    const browserWasVisible = !!browserDiv && !browserDiv.hasAttribute("hidden")
    if (controlsDiv) controlsDiv.setAttribute("hidden", "")
    if (browserDiv) browserDiv.setAttribute("hidden", "")
    document.body.classList.remove("file-browser-active")
    progressDiv?.removeAttribute("hidden")

    const progressBarText = document.getElementById("progressBarText")
    const progressBar = document.getElementById("progress")
    const progressBytesText = document.getElementById("progressBytesText")
    const progressTimeText = document.getElementById("progressTimeText")
    if (progressBarText && progressBar) {
        progressBarText.textContent = `Downloading ${data.name}`
        progressBar.style.width = "0%"
        progressBar.textContent = "0%"
        progressBar.setAttribute("aria-valuenow", "0")
        if (progressBytesText) progressBytesText.textContent = `0 / ${data.size} B`
        if (progressTimeText) progressTimeText.textContent = `Elapsed: 00:00:00 • Remaining: --:--:--`
    }

    try {
        const chunkMsgs: TelegramApi.messages.Messages = await client.getMessages("me", { ids: data.chunks })
        const IVBytes = base64ToBytes(data.IV)
        const salt = IVBytes.subarray(0, 16)
        const aesKey = await Encryption.deriveAESKeyFromPassword(password ?? "", salt)
        let decryptionCounter = IVBytes.slice(16)

        let aesBlockBytesWritten = 0
        const decryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)

        let bytesProcessed = 0
        const startTimeMs = Date.now()
        const UFIDChunkSize = 64 * 1024
        let ufidRolling = new Uint8Array(0)
        let ufidPending = new Uint8Array(0)
        const progressBytesTextEl = progressBytesText
        const progressBarEl = progressBar as HTMLElement | null
        const progressTimeTextEl = progressTimeText
        const byteCounterStream = new TransformStream<Uint8Array, Uint8Array>({
            async transform(chunk, controller) {
                bytesProcessed += chunk.length
                if (progressBarEl) {
                    const progressPercentage = Math.round((bytesProcessed / data.size) * 100).toString()
                    progressBarEl.style.width = `${progressPercentage}%`
                    progressBarEl.textContent = `${progressPercentage}%`
                    progressBarEl.setAttribute("aria-valuenow", progressPercentage)
                }
                if (progressBytesTextEl) {
                    const units = ["B", "KiB", "MiB", "GiB", "PiB"] as const
                    const pickUnit = (n: number) => {
                        let i = 0
                        while (i < units.length - 1 && n >= 1024) {
                            n = n / 1024
                            i++
                        }
                        return { value: n, unit: units[i] }
                    }
                    const sofar = pickUnit(bytesProcessed)
                    const total = pickUnit(data.size)
                    progressBytesTextEl.textContent = `${sofar.value.toFixed(sofar.unit === "B" ? 0 : 2)} ${sofar.unit} / ${total.value.toFixed(total.unit === "B" ? 0 : 2)} ${total.unit}`
                }
                if (progressTimeTextEl) {
                    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000))
                    const rate = elapsedSec > 0 ? bytesProcessed / elapsedSec : 0
                    const remainingBytes = Math.max(0, data.size - bytesProcessed)
                    const etaSec = rate > 0 ? Math.ceil(remainingBytes / rate) : 0
                    const fmt = (s: number) => {
                        const h = Math.floor(s / 3600)
                        const m = Math.floor((s % 3600) / 60)
                        const sec = s % 60
                        const pad = (n: number) => n.toString().padStart(2, "0")
                        return `${pad(h)}:${pad(m)}:${pad(sec)}`
                    }
                    progressTimeTextEl.textContent = `Elapsed: ${fmt(elapsedSec)} • Remaining: ${etaSec ? fmt(etaSec) : "--:--:--"}`
                }
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
                ufidPending = combined.subarray(offset)
                controller.enqueue(chunk)
            },
        })

        async function downloadFile(serviceWorkerRegistration: ServiceWorkerRegistration) {
            const downloadPump = createServiceWorkerDownloadPump(serviceWorkerRegistration, data.name, byteCounterStream)
            let streamError: unknown = null
            try {
                for (const chunkMsg of chunkMsgs) {
                    let chunkBytesWritten = 0
                    while (chunkBytesWritten < (chunkMsg as any).media.document.size) {
                        const chunkPart = await client.invoke(
                            new Api.upload.GetFile({
                                location: getFileInfo((chunkMsg as any).media).location,
                                offset: chunkBytesWritten,
                                limit: DOWNLOAD_PART_SIZE,
                                precise: false,
                                cdnSupported: false,
                            }),
                        )
                        chunkBytesWritten += (chunkPart as any).bytes.length
                        decryptionBuffer.set((chunkPart as any).bytes, aesBlockBytesWritten)
                        aesBlockBytesWritten += (chunkPart as any).bytes.length
                        if (aesBlockBytesWritten === decryptionBuffer.length) {
                            const decryptedData = new Uint8Array(
                                await window.crypto.subtle.decrypt(
                                    { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                                    aesKey,
                                    decryptionBuffer,
                                ),
                            )
                            const blocks = Math.ceil(decryptionBuffer.length / 16)
                            decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, blocks)
                            aesBlockBytesWritten = 0
                            await downloadPump.write(decryptedData)
                        }
                    }
                }
                if (aesBlockBytesWritten > 0) {
                    const decryptedData = new Uint8Array(
                        await window.crypto.subtle.decrypt(
                            { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                            aesKey,
                            decryptionBuffer.subarray(0, aesBlockBytesWritten),
                        ),
                    )
                    const tailBlocks = Math.ceil(aesBlockBytesWritten / 16)
                    decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, tailBlocks)
                    await downloadPump.write(decryptedData)
                }
                await downloadPump.close()
            } catch (error) {
                streamError = error
                await downloadPump.abort(error)
            } finally {
                serviceWorkerRegistration.active?.postMessage({ type: "DOWNLOAD_COMPLETE" })
            }
            if (streamError) {
                if (streamError instanceof Error && streamError.message === "Incorrect decryption password.") {
                    alert("Incorrect decryption password entered. Aborting download.")
                }
                throw streamError
            }
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
            if (computedUfid !== data.ufid) {
                alert("UFID mismatch. The downloaded file may be corrupted or the wrong password was used.")
            }
        }
        const sanitizedUfid = encodeURIComponent(data.ufid)
        const response = await fetch("/download-file?ufid=" + sanitizedUfid)
        if (!response.ok) {
            console.error("Failed to download file.")
            alert("Failed to download file.")
            return
        }
        const serviceWorkerRegistration = await navigator.serviceWorker.ready
        if (serviceWorkerRegistration.active) {
            await downloadFile(serviceWorkerRegistration)
            alert("Download complete.")
        } else {
            console.error("Service worker is not active.")
            alert("Service worker is not active. Cannot proceed with the download.")
        }
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = data.name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    } finally {
        progressDiv?.setAttribute("hidden", "")
        if (browserWasVisible) {
            browserDiv?.removeAttribute("hidden")
            document.body.classList.add("file-browser-active")
        } else if (controlsWasVisible) {
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        } else {
            // Default to showing controls.
            controlsDiv?.removeAttribute("hidden")
            document.body.classList.remove("file-browser-active")
        }
    }
}

export type AuthHandlers = {
    getPhoneCode?: () => Promise<string>
    getPassword?: () => Promise<string>
    onError?: (error: unknown) => void
}

export async function init(config: Config.Config, authHandlers: AuthHandlers = {}): Promise<TelegramClient> {
    await gramJsReady
    console.log("Starting up...")
    // Load previous session from a session string.
    const storeSession = new StoreSession("./tglfs.session")
    // Connect.
    const client = new TelegramClientCtor(storeSession, config.apiId, config.apiHash, {
        connectionRetries: 5,
        useWSS: true,
        networkSocket: createTelegramWebDcFallbackSocket(PromisedWebSocketsCtor) as any,
    })
    // Provide credentials to the server.
    await client.start({
        phoneNumber: config.phone,
        password: async () => {
            if (authHandlers.getPassword) {
                const pwd = await authHandlers.getPassword()
                if (!pwd) {
                    throw new Error("No password provided.")
                }
                return pwd
            }
            const pwd = prompt("Enter your password: ")
            if (!pwd) {
                throw new Error("No password provided.")
            }
            return pwd
        },
        phoneCode: async () => {
            if (authHandlers.getPhoneCode) {
                const code = await authHandlers.getPhoneCode()
                if (!code) {
                    throw new Error("No code provided.")
                }
                return code
            }
            const code = prompt("Enter the code you received: ")
            if (!code) {
                throw new Error("No code provided.")
            }
            return code
        },
        onError: (error: any) => {
            authHandlers.onError?.(error)
            console.error(error)
        },
    })
    console.log("You are now logged in!")
    return client
}
