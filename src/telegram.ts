/**
 * Telegram client methods.
 * @module Telegram
 */

// TODO: Add `tglfs:chunk` annotation to chunk files.

import { Api, TelegramClient } from "telegram"
import { StoreSession } from "telegram/sessions"
import { getFileInfo } from "telegram/Utils"

import * as Config from "./config"
import * as Encryption from "./web/encryption"
import * as FileProcessing from "./web/fileProcessing"

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

// TODO: Consider moving this type definition to a more appropriate place.
type FileCardData = {
    name: string
    ufid: string
    size: number
    uploadComplete: boolean
    chunks: number[]
    IV: string
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

export async function fileDelete(client: TelegramClient, config: Config.Config) {
    const fileUfid = prompt("Enter UFID of file to delete:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: 'tglfs:file "ufid":"' + fileUfid.trim() + '"',
    })
    if (msgs.length === 0) {
        throw new Error("File not found.")
    }

    const fileCardData: FileCardData = JSON.parse(msgs[0].message.substring(msgs[0].message.indexOf("{")))

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
    // TODO: Implement file validation via UFID comparison.
    const fileUfid = prompt("Enter UFID of file to download:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: 'tglfs:file "ufid":"' + fileUfid.trim() + '"',
    })
    if (msgs.length === 0) {
        alert("File not found.")
        return
    }

    const fileCardData: FileCardData = JSON.parse(msgs[0].message.substring(msgs[0].message.indexOf("{")))
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

    // Request chunk messages by their IDs in the file card.
    const chunkMsgs: Api.messages.Messages = await client.getMessages("me", { ids: fileCardData.chunks })

    const IVBytes = base64ToBytes(fileCardData.IV)
    // TODO: DRY-ify the salt & counter byte size. Should be
    // module-level constants.
    const salt = IVBytes.subarray(0, 16)
    const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt)
    let decryptionCounter = IVBytes.slice(16)

    let aesBlockBytesWritten = 0
    const decryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)

    let decompressionStreamController: ReadableStreamController<Uint8Array> | null = null
    const decompressionReadableStream = new ReadableStream({
        start(controller) {
            decompressionStreamController = controller
        },
    })
    const decompressionStream = new DecompressionStream("gzip")
    const decompressedDataStream = decompressionReadableStream.pipeThrough(decompressionStream)
    const decompressedDataStreamReader = decompressedDataStream.getReader()

    async function downloadFile(serviceWorkerRegistration: ServiceWorkerRegistration) {
        // Inform the service worker of the file name.
        serviceWorkerRegistration.active?.postMessage({
            type: "SET_FILE_NAME",
            fileName: fileCardData.name,
        })
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
                    decryptionCounter = Encryption.incrementCounter(decryptionCounter)
                    aesBlockBytesWritten = 0

                    // gzip-decompress the decrypted data.
                    decompressionStreamController?.enqueue(decryptedData)
                    let decompressedData = new Uint8Array(0)
                    let bytesRead = 0
                    while (bytesRead < decryptionBuffer.length) {
                        const { value } = await decompressedDataStreamReader.read()
                        if (!value) {
                            continue
                        }
                        const newDecompressedData = new Uint8Array(decompressedData.length + value.length)
                        newDecompressedData.set(decompressedData)
                        newDecompressedData.set(value, decompressedData.length)
                        decompressedData = newDecompressedData
                        bytesRead += value.length
                    }

                    // Send the decompressed data to the service worker.
                    serviceWorkerRegistration.active?.postMessage(
                        {
                            type: "PROCESSED_DATA",
                            data: decompressedData,
                        },
                        [decompressedData.buffer],
                    )
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

            // gzip-decompress the decrypted data.
            decompressionStreamController?.enqueue(decryptedData)
            decompressionStreamController?.close()
            let decompressedData = new Uint8Array(0)
            let value, done
            try {
                while ((({ value, done } = await decompressedDataStreamReader.read()), !done)) {
                    const newDecompressedData = new Uint8Array(decompressedData.length + value.length)
                    newDecompressedData.set(decompressedData)
                    newDecompressedData.set(value, decompressedData.length)
                    decompressedData = newDecompressedData
                }
            } catch (e) {
                if (e instanceof TypeError) {
                    alert("Incorrect decryption password entered. Aborting download.")
                } else {
                    console.error(e)
                }
            }

            // Send the decompressed data to the service worker.
            serviceWorkerRegistration.active?.postMessage(
                {
                    type: "PROCESSED_DATA",
                    data: decompressedData,
                },
                [decompressedData.buffer],
            )
        } else {
            decompressionStreamController?.close()
        }

        // Notify the service worker that data transmission is complete.
        serviceWorkerRegistration.active?.postMessage({
            type: "DOWNLOAD_COMPLETE",
        })
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
}

export async function fileLookup(client: TelegramClient, config: Config.Config) {
    const query = window.prompt("Search query (filename or UFID):")
    if (query === null) {
        return
    }
    const msgs = await client.getMessages("me", {
        search: ("tglfs:file " + query).trim(),
    })
    let response = `Lookup results for "${query}":`
    const fileCards: FileCardData[] = []
    for (const msg of msgs) {
        if (!msg.message.startsWith("tglfs:file")) {
            continue // Not a file card message.
        }
        const fileCardData: FileCardData = JSON.parse(msg.message.substring(msg.message.indexOf("{")))
        fileCards.push(fileCardData)

        const humanReadableFileSize = humanReadableSize(fileCardData.size)
        // TODO: DRY-ify datetime formatting.
        const date = new Date(msg.date * 1000)
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
        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`
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
    const source = prompt("Enter sender or receipt location:")?.trim()
    if (!source) {
        alert("No sender or receipt location provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages(source, {
        search: "tglfs:file",
    })
    let response = `Available files from ${source}:`
    const fileCards: FileCardData[] = []
    for (const msg of msgs) {
        if (!msg.message.startsWith("tglfs:file")) {
            continue // Not a file card message.
        }
        const fileCardData: FileCardData = JSON.parse(msg.message.substring(msg.message.indexOf("{")))
        fileCards.push(fileCardData)

        const humanReadableFileSize = humanReadableSize(fileCardData.size)
        // TODO: DRY-ify datetime formatting.
        const date = new Date(msg.date * 1000)
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
        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`
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
        result = await client.sendMessage("me", { message: `tglfs:file\n${JSON.stringify(fileCards[selection])}` })
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
    const fileUfid = prompt("Enter UFID of file to rename:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: 'tglfs:file "ufid":"' + fileUfid.trim() + '"',
    })
    if (msgs.length === 0) {
        throw new Error("File not found.")
    }

    const fileCardData: FileCardData = JSON.parse(msgs[0].message.substring(msgs[0].message.indexOf("{")))

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
            message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
        }),
    )

    if (result) {
        alert(`File successfully renamed to ${newName}.`)
    } else {
        alert("Failed to rename file.")
    }
}

export async function fileSend(client: TelegramClient, config: Config.Config) {
    const fileUfid = prompt("Enter UFID of file to send:")
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages("me", {
        search: 'tglfs:file "ufid":"' + fileUfid.trim() + '"',
    })
    if (msgs.length === 0) {
        alert("File not found.")
        return
    }

    const fileCardData: FileCardData = JSON.parse(msgs[0].message.substring(msgs[0].message.indexOf("{")))

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
        result = await client.sendMessage(fileRecipient, { message: `tglfs:file\n${JSON.stringify(fileCardData)}` })
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
    const source = prompt("Enter sender or receipt location:")?.trim()
    if (!source) {
        alert("No sender or receipt location provided. Operation cancelled.")
        return
    }
    const msgs = await client.getMessages(source, {
        search: "tglfs:file",
    })
    let response = `Available files from ${source}:`
    const fileCards: FileCardData[] = []
    for (const msg of msgs) {
        if (!msg.message.startsWith("tglfs:file")) {
            continue
        }
        const fileCardData: FileCardData = JSON.parse(msg.message.substring(msg.message.indexOf("{")))
        fileCards.push(fileCardData)

        const humanReadableFileSize = humanReadableSize(fileCardData.size)
        // TODO: DRY-ify datetime formatting.
        const date = new Date(msg.date * 1000)
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
        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`
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
            id: [msgs[selection].id],
        }),
    )
    if (result) {
        alert(`File successfully unsent from ${source}.`)
    } else {
        alert("Failed to unsend file.")
    }
}

export async function fileUpload(client: TelegramClient, config: Config.Config) {
    // TODO: Implement upload resumption.
    if (config.chunkSize < UPLOAD_PART_SIZE) {
        throw new Error(
            `config.chunkSize (${config.chunkSize}) must be larger than UPLOAD_PART_SIZE (${UPLOAD_PART_SIZE}).`,
        )
    }

    const uploadFileInput = document.getElementById("uploadFileInput") as HTMLInputElement
    const selectedFiles = uploadFileInput.files
    if (!selectedFiles || selectedFiles.length === 0) {
        alert("No file selected. Aborting.")
        return
    }
    const file = selectedFiles[0]
    console.log(`Selected file: ${file.name}`)

    let password = prompt("(Optional) Encryption password:")
    if (password === null) {
        return
    }
    
    // Hide control panel and show progress bar.
    const controlsDiv = document.getElementById("controls")
    const progressDiv = document.getElementById("progressBarContainer")
    controlsDiv?.setAttribute("hidden", "")
    progressDiv?.removeAttribute("hidden")
    
    // Set up progress bar view.
    const progressBarText = document.getElementById("progressBarText")
    const progressBar = document.getElementById("progress")
    if (progressBarText && progressBar) {
        progressBarText.textContent = `Uploading ${file.name}`
        progressBar.style.width = `0%`
        progressBar.textContent = `0%`
        progressBar.setAttribute("aria-valuenow", "0")
    }

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

        console.log("Calculating UFID...")
        const UFID = await FileProcessing.UFID(file)
        console.log(`UFID: ${UFID}`)

        const existingMsgs = await client.getMessages("me", {
            search: `tglfs:file "ufid":"${UFID}"`,
        })

        if (existingMsgs.length > 0) {
            alert(`Error: Duplicate UFID.\n\nA file with the same contents already exists.\n\nCopying UFID to clipboard.`)
            await navigator.clipboard.writeText(UFID)
            return
        }

        let fileCardData: FileCardData = {
            name: file.name,
            ufid: UFID,
            size: file.size,
            uploadComplete: false,
            chunks: [],
            IV: IV,
        }
        const fileCardMessage = await client.sendMessage("me", { message: `tglfs:file\n${JSON.stringify(fileCardData)}` })

        let bytesProcessed = 0
        const byteCounterStream = new TransformStream({
            start(controller) {
                bytesProcessed = 0;
            },
            transform(chunk, controller) {
                bytesProcessed += chunk.length;
                controller.enqueue(chunk);
            },
            flush(controller) {
                // Executes when the stream is closed.
            }
        });

        const fileStream = file.stream().pipeThrough(byteCounterStream)
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
                    // Reset the encryption buffer and increment AES-CTR encryption counter.
                    aesBlockBytesWritten = 0
                    encryptionCounter = Encryption.incrementCounter(encryptionCounter)
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
                                        message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
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
            // Update the progress bar.
            if (progressBar) {
                let progress = Math.round(bytesProcessed / file.size * 100).toString()
                progressBar.style.width = `${progress}%`
                progressBar.textContent = `${progress}%`
                progressBar.setAttribute("aria-valuenow", progress)
            }
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
                                message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
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
                        message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
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
                message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
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
    } catch (error) {
        console.error(error)
    } finally {
        // Hide progress bar and return control panel.
        controlsDiv?.removeAttribute("hidden")
        progressDiv?.setAttribute("hidden", "")
    }
}

export async function init(config: Config.Config): Promise<TelegramClient> {
    console.log("Starting up...")
    // Load previous session from a session string.
    const storeSession = new StoreSession("./tglfs.session")
    // Connect.
    const client = new TelegramClient(storeSession, config.apiId, config.apiHash, { connectionRetries: 5 })
    // Provide credentials to the server.
    await client.start({
        phoneNumber: config.phone,
        password: async () => {
            const pwd = prompt("Enter your password: ")
            if (!pwd) {
                throw new Error("No password provided.")
            }
            return pwd
        },
        phoneCode: async () => {
            const code = prompt("Enter the code you received: ")
            if (!code) {
                throw new Error("No code provided.")
            }
            return code
        },
        onError: (error: any) => console.error(error),
    })
    console.log("You are now logged in!")
    return client
}
