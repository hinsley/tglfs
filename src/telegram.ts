/**
 * Telegram client methods. 
 * @module Telegram
 */

import { Api, TelegramClient } from "telegram";
import { StoreSession, StringSession } from "telegram/sessions";

import * as Config from "./config";
import * as Encryption from "./web/encryption";
import * as FileProcessing from "./web/fileProcessing";

// https://core.telegram.org/api/files
// Must be divisible by 1 KB.
// Must divide 512 KB.
const UPLOAD_PART_SIZE = 512 * 1024; // 512 KB.

// TODO: Consider moving this type definition to a more appropriate place.
type FileCardData = {
    name: string;
    ufid: string;
    size: number;
    uploadComplete: boolean;
    chunks: number[];
    IV: string;
}

// TODO: Move this function to a more appropriate place.
function bytesToBase64(bytes: Uint8Array) {
    const binString = Array.from(bytes, (byte: number) => String.fromCodePoint(byte)).join("");
    return btoa(binString);
}

// TODO: Move this function to a more appropriate place.
function base64ToBytes(base64: string) {
    const binString = atob(base64);
    return Uint8Array.from(binString, (char: string) => {
        const code = char.codePointAt(0);
        if (code === undefined) {
            throw new Error("Invalid character in base64 string");
        }
        return code;
    });
}

// TODO: Move this function to a more appropriate place.
function humanReadableSize(size: number): string {
    const i = Math.floor(Math.log(size) / Math.log(1024));
    const sizes = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    return (size / Math.pow(1024, i)).toFixed(i == 0 ? 0 : 2) + ' ' + sizes[i];
}

export async function fileDelete(client: TelegramClient, config: Config.Config) {
    const fileUfid = prompt("Enter UFID of file to delete:");
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.");
        return;
    }
    const msgs = await client.getMessages("me", {
        search: "tglfs:file \"ufid\":\"" + fileUfid.trim() + "\""
    });
    if (msgs.length === 0) {
        throw new Error("File not found.");
    }

    const fileCardData: FileCardData = JSON.parse(msgs[0].message.substring(msgs[0].message.indexOf("{")));
    
    const humanReadableFileSize = humanReadableSize(fileCardData.size);
    const date = new Date(msgs[0].date * 1000);
    const formattedDate = date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).replace(",", ""); // Remove the comma between date and time.
    
    const fileInfo = `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`;

    const confirmation = confirm(`Delete file?\n\n${fileInfo}`);
    if (!confirmation) {
        alert("Operation cancelled.");
        return;
    }
    const result = await client.invoke(new Api.messages.DeleteMessages({
        id: [...fileCardData.chunks, msgs[0].id], // Delete chunk messages and file card message.
    }));
    if (result) {
        alert(`File ${fileCardData.name} successfully deleted.`);
    } else {
        alert(`Failed to delete file ${fileCardData.name}.`);
    }
}

export async function fileDownload(client: TelegramClient, config: Config.Config) {
    const fileUfid = prompt("Enter UFID of file to download:");
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.");
        return;
    }
    const msgs = await client.getMessages("me", {
        search: "tglfs:file \"ufid\":\"" + fileUfid.trim() + "\""
    });
    if (msgs.length === 0) {
        throw new Error("File not found.");
    }

    const fileCardData: FileCardData = JSON.parse(msgs[0].message.substring(msgs[0].message.indexOf("{")));

    const humanReadableFileSize = humanReadableSize(fileCardData.size);
    const date = new Date(msgs[0].date * 1000);
    const formattedDate = date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).replace(",", ""); // Remove the comma between date and time.

    const fileInfo = `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`;

    const confirmation = confirm(`Download file?\n\n${fileInfo}`);
    if (!confirmation) {
        alert("Operation cancelled.");
        return;
    }
    
    // Download file to OPFS.

}

export async function fileLookup(client: TelegramClient, config: Config.Config) {
    const query = prompt("Search query (filename or UFID):");
    if (query === null) {
        return;
    }
    const msgs = await client.getMessages("me", {
        search: ("tglfs:file " + query).trim(),
    });
    let response = `Lookup results for "${query}":`;
    const fileCards: FileCardData[] = [];
    for (const msg of msgs) {
        if (!msg.message.startsWith("tglfs:file")) {
            continue; // Not a file card message.
        }
        const fileCardData: FileCardData = JSON.parse(msg.message.substring(msg.message.indexOf("{")));
        fileCards.push(fileCardData);

        const humanReadableFileSize = humanReadableSize(fileCardData.size);
        const date = new Date(msg.date * 1000);
        const formattedDate = date.toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }).replace(",", ""); // Remove the comma between date and time.
        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`;
    }
    if (fileCards.length == 0) {
        alert(`No results found for "${query}".`);
        return;
    }
    let selection = 1;
    if (fileCards.length == 1) {
        response += "\n\nCopying UFID to clipboard.";
        alert(response);
    } else {
        response += `\n\nChoose a file (1-${fileCards.length}) to copy UFID to clipboard [1]:`;
        const selectionString = prompt(response);
        if (selectionString !== null && selectionString.trim() !== "") {
            selection = parseInt(selectionString, 10);
            if (isNaN(selection) || selection < 1 || selection > fileCards.length) {
                selection = 1;
            }
        }
    }
    const UFID = fileCards[selection - 1].ufid;
    await navigator.clipboard.writeText(UFID);
}

export async function fileRename(client: TelegramClient, config: Config.Config) {
    const fileUfid = prompt("Enter UFID of file to rename:");
    if (!fileUfid || fileUfid.trim() === "") {
        alert("No UFID provided. Operation cancelled.");
        return;
    }
    const msgs = await client.getMessages("me", {
        search: "tglfs:file \"ufid\":\"" + fileUfid.trim() + "\""
    });
    if (msgs.length === 0) {
        throw new Error("File not found.");
    }

    const fileCardData: FileCardData = JSON.parse(msgs[0].message.substring(msgs[0].message.indexOf("{")));
    
    const humanReadableFileSize = humanReadableSize(fileCardData.size);
    const date = new Date(msgs[0].date * 1000);
    const formattedDate = date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).replace(",", ""); // Remove the comma between date and time.
    
    const fileInfo = `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`;
    
    const newName = prompt(`Renaming file:\n\n${fileInfo}\n\nEnter new name:`);
    if (!newName || newName.trim() === "") {
        alert("No new name provided. Operation cancelled.");
        return;
    }
    fileCardData.name = newName;
    const result = await client.invoke(new Api.messages.EditMessage({
        peer: msgs[0].peerId,
        id: msgs[0].id,
        message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
    }));

    if (result) {
        alert(`File successfully renamed to ${newName}.`);
    } else {
        alert("Failed to rename file.");
    }
}

export async function fileUpload(client: TelegramClient, config: Config.Config) {
    // TODO: Introduce byte counting for the original file's stream so we know
    // how close to being done the upload is.
    // TODO: Implement upload resumption.
    if (config.chunkSize < UPLOAD_PART_SIZE) {
        throw new Error(`config.chunkSize (${config.chunkSize}) must be larger than UPLOAD_PART_SIZE (${UPLOAD_PART_SIZE}).`);
    }

    const [fileHandle] = await (window as any).showOpenFilePicker();
    const file = await fileHandle.getFile();
    console.log(`Selected file: ${file.name}`);

    let password = prompt("(Optional) Encryption password:");
    if (password === null) {
        return;
    }
    alert("Beginning upload."); // TODO: Remove and introduce progress bar.
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt);
    const initialCounter = window.crypto.getRandomValues(new Uint8Array(16));
    const IVBytes = new Uint8Array(salt.length + initialCounter.length);
    IVBytes.set(salt, 0);
    IVBytes.set(initialCounter, salt.length);
    const IV = bytesToBase64(IVBytes);
    let encryptionCounter = new Uint8Array(initialCounter);

    console.log("Calculating UFID...");
    const UFID = await FileProcessing.UFID(file);
    console.log(`UFID: ${UFID}`);

    const existingMsgs = await client.getMessages("me", {
        search: `tglfs:file "ufid":"${UFID}"`
    });

    if (existingMsgs.length > 0) {
        alert(`Error: Duplicate UFID.\n\nA file with the same contents already exists.\n\nCopying UFID to clipboard.`);
        await navigator.clipboard.writeText(UFID);
        return;
    }

    let fileCardData: FileCardData = {
        name: file.name,
        ufid: UFID,
        size: file.size,
        uploadComplete: false,
        chunks: [],
        IV: IV,
    };
    const fileCardMessage = await client.sendMessage("me", { message: `tglfs:file\n${JSON.stringify(fileCardData)}` });

    const fileStream = file.stream();
    const compressedStream = fileStream.pipeThrough(new CompressionStream("gzip"));
    const reader = compressedStream.getReader();
    
    let aesBlockBytesWritten = 0;
    const encryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE);
    let partBytesWritten = 0;
    const partBuffer = new Uint8Array(UPLOAD_PART_SIZE);
    let partIndex = 0;
    let chunkIndex = 0;
    let chunkBytesWritten = 0;
    let chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

    let done, value;
    while ({ done, value } = await reader.read(), !done) {
        let valueBytesProcessed = 0;
        // Write the value to encryptionBuffer.
        while (valueBytesProcessed < value.length) {
            const remainingEncryptionBufferSpace = encryptionBuffer.length - aesBlockBytesWritten; // Remaining space in encryptionBuffer.
            const remainingValueBytesToProcess = value.length - valueBytesProcessed;
            const bytesToCopy = Math.min(
                remainingValueBytesToProcess,
                remainingEncryptionBufferSpace
            );
            encryptionBuffer.set(value.subarray(valueBytesProcessed, valueBytesProcessed + bytesToCopy), aesBlockBytesWritten);
            aesBlockBytesWritten += bytesToCopy;
            valueBytesProcessed += bytesToCopy;
            if (aesBlockBytesWritten === encryptionBuffer.length) {
                // encryptionBuffer is full. Encrypt it.
                const encryptedData = new Uint8Array(await window.crypto.subtle.encrypt(
                    {
                        name: "AES-CTR",
                        counter: encryptionCounter,
                        length: 64 // Bit length of the counter block.
                    },
                    aesKey,
                    encryptionBuffer
                ));
                // Reset the encryption buffer and increment AES-CTR encryption counter.
                aesBlockBytesWritten = 0;
                encryptionCounter = Encryption.incrementCounter(encryptionCounter);
                // Write the encrypted data to partBuffer in a loop.
                let encryptedDataBytesProcessed = 0;
                while (encryptedDataBytesProcessed < encryptedData.length) {
                    const remainingPartBufferSpace = partBuffer.length - partBytesWritten;
                    const remainingEncryptedDataBytesToProcess = encryptedData.length - encryptedDataBytesProcessed;
                    const bytesToCopy = Math.min(
                        remainingEncryptedDataBytesToProcess,
                        remainingPartBufferSpace,
                    );
                    partBuffer.set(
                        encryptedData.subarray(
                            encryptedDataBytesProcessed,
                            encryptedDataBytesProcessed + bytesToCopy
                        ),
                        partBytesWritten
                    );
                    partBytesWritten += bytesToCopy;
                    if (partBytesWritten === UPLOAD_PART_SIZE) {
                        // partBuffer is full. Send as much as will fit in this chunk.
                        const remainingChunkSpace = config.chunkSize - chunkBytesWritten;
                        if (remainingChunkSpace <= UPLOAD_PART_SIZE) {
                            // Part overflows chunk size. Finalize the chunk
                            // and populate next one with leftover data in partBuffer.
                            const partBufferSubarray = partBuffer.subarray(0, remainingChunkSpace);
                            // Send partBufferSubarray as a file part to Telegram.
                            const result = await client.invoke(new Api.upload.SaveBigFilePart({
                                fileId: chunkFileId,
                                filePart: partIndex,
                                fileTotalParts: partIndex + 1,
                                bytes: Buffer.from(partBufferSubarray),
                            }));
                            if (!result) {
                                throw new Error(`Failed to upload chunk ${chunkIndex+1} part ${partIndex+1}.`);
                            }
                            console.log(`Uploaded chunk ${chunkIndex+1} part ${partIndex+1}.`);

                            // Finalize the chunk.
                            const chunkFileUploaded = new Api.InputFileBig({
                                id: chunkFileId,
                                parts: partIndex+1,
                                name: `${UFID}.chunk${chunkIndex+1}`,
                            });
                            // Send the chunk message.
                            const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded });

                            // Update file card.
                            fileCardData.chunks.push(chunkMessage.id);
                            await client.invoke(new Api.messages.EditMessage({
                                peer: fileCardMessage.peerId,
                                id: fileCardMessage.id,
                                message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
                            }));

                            // Reset chunk index and fileId for the next chunk.
                            chunkIndex++;
                            chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

                            // Left shift bytes in partBuffer by remainingChunkSpace.
                            partBuffer.copyWithin(0, remainingChunkSpace);
                            partBytesWritten -= remainingChunkSpace;
                            partIndex = 0;

                            // Update chunkBytesWritten with the size of the roll-over data.
                            chunkBytesWritten = UPLOAD_PART_SIZE - remainingChunkSpace;
                        } else {
                            // Send the partBuffer data as a file part.
                            const result = await client.invoke(new Api.upload.SaveBigFilePart({
                                fileId: chunkFileId,
                                filePart: partIndex,
                                fileTotalParts: -1,
                                bytes: Buffer.from(partBuffer),
                            }));
                            if (!result) {
                                throw new Error(`Failed to upload chunk ${chunkIndex+1} part ${partIndex+1}.`);
                            }
                            console.log(`Uploaded chunk ${chunkIndex+1} part ${partIndex+1}.`);
                            partBytesWritten = 0;
                            partIndex++;

                            // Update chunkBytesWritten.
                            chunkBytesWritten += UPLOAD_PART_SIZE;
                        }
                    }
                }
            }
        }
    }
    // Flush encryptionBuffer.
    if (aesBlockBytesWritten > 0) {
        const encryptedData = new Uint8Array(await window.crypto.subtle.encrypt(
            {
                name: "AES-CTR",
                counter: encryptionCounter,
                length: 64 // Bit length of the counter block.
            },
            aesKey,
            encryptionBuffer.subarray(0, aesBlockBytesWritten)
        ));
        let encryptedDataBytesProcessed = 0;
        while (encryptedDataBytesProcessed < encryptedData.length) {
            const remainingPartBufferSpace = partBuffer.length - partBytesWritten;
            const remainingEncryptedDataBytesToProcess = encryptedData.length - encryptedDataBytesProcessed;
            const bytesToCopy = Math.min(
                remainingEncryptedDataBytesToProcess,
                remainingPartBufferSpace,
            );
            partBuffer.set(
                encryptedData.subarray(
                    encryptedDataBytesProcessed,
                    encryptedDataBytesProcessed + bytesToCopy
                ),
                partBytesWritten
            );
            partBytesWritten += bytesToCopy;
            encryptedDataBytesProcessed += bytesToCopy;

            if (partBytesWritten === UPLOAD_PART_SIZE) {
                // Part buffer is full. Send as much as will fit in this chunk.
                const remainingChunkSpace = config.chunkSize - chunkBytesWritten;
                if (remainingChunkSpace <= UPLOAD_PART_SIZE) {
                    // Part overflows chunk size. Finalize the chunk
                    // and populate next one with leftover data in partBuffer.
                    const partBufferSubarray = partBuffer.subarray(0, remainingChunkSpace);
                    const result = await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: chunkFileId,
                        filePart: partIndex,
                        fileTotalParts: partIndex + 1,
                        bytes: Buffer.from(partBufferSubarray),
                    }));
                    if (!result) {
                        throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`);
                    }
                    console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`);

                    const chunkFileUploaded = new Api.InputFileBig({
                        id: chunkFileId,
                        parts: partIndex + 1,
                        name: `${UFID}.chunk${chunkIndex + 1}`,
                    });
                    // Send the chunk message.
                    const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded });

                    // Update file card.
                    fileCardData.chunks.push(chunkMessage.id);
                    await client.invoke(new Api.messages.EditMessage({
                        peer: fileCardMessage.peerId,
                        id: fileCardMessage.id,
                        message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
                    }));

                    // Reset chunk index and fileId for the next chunk.
                    chunkIndex++;
                    chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

                    // Left shift bytes in partBuffer by remainingChunkSpace.
                    partBuffer.copyWithin(0, remainingChunkSpace);
                    partBytesWritten -= remainingChunkSpace;
                    partIndex = 0;

                    // Update chunkBytesWritten with the size of the roll-over data.
                    chunkBytesWritten = UPLOAD_PART_SIZE - remainingChunkSpace;
                } else {
                    const result = await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: chunkFileId,
                        filePart: partIndex,
                        fileTotalParts: -1,
                        bytes: Buffer.from(partBuffer),
                    }));
                    if (!result) {
                        throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`);
                    }
                    console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`);
                    partBytesWritten = 0;
                    partIndex++;

                    // Update chunkBytesWritten.
                    chunkBytesWritten += UPLOAD_PART_SIZE;
                }
            }
        }
    }
    // Flush partBuffer.
    if (partBytesWritten > 0) {
        const remainingChunkSpace = config.chunkSize - chunkBytesWritten;
        if (remainingChunkSpace <= partBytesWritten) {
            // Part overflows chunk size. Finalize the chunk
            // and populate next one with leftover data in partBuffer.
            const partBufferSubarray = partBuffer.subarray(0, remainingChunkSpace);
            const result = await client.invoke(new Api.upload.SaveBigFilePart({
                fileId: chunkFileId,
                filePart: partIndex,
                fileTotalParts: partIndex + 1,
                bytes: Buffer.from(partBufferSubarray),
            }));
            if (!result) {
                throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`);
            }
            console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`);

            const chunkFileUploaded = new Api.InputFileBig({
                id: chunkFileId,
                parts: partIndex + 1,
                name: `${UFID}.chunk${chunkIndex + 1}`,
            });
            // Send the chunk message.
            const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded });

            // Update file card.
            fileCardData.chunks.push(chunkMessage.id);
            await client.invoke(new Api.messages.EditMessage({
                peer: fileCardMessage.peerId,
                id: fileCardMessage.id,
                message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
            }));

            // Reset chunk index and fileId for the next chunk.
            chunkIndex++;
            chunkFileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

            // Left shift bytes in partBuffer by remainingChunkSpace.
            partBuffer.copyWithin(0, remainingChunkSpace);
            partBytesWritten -= remainingChunkSpace;
            partIndex = 0;

            // Note: We don't need chunkBytesWritten anymore,
            // so we don't update it here as we did before.
        }
        // Upload the roll-over data in partBuffer as the last chunk.
        const partBufferSubarray = partBuffer.subarray(0, partBytesWritten);
        const result = await client.invoke(new Api.upload.SaveBigFilePart({
            fileId: chunkFileId,
            filePart: partIndex,
            fileTotalParts: partIndex + 1,
            bytes: Buffer.from(partBufferSubarray),
        }));
        if (!result) {
            throw new Error(`Failed to upload chunk ${chunkIndex + 1} part ${partIndex + 1}.`);
        }
        console.log(`Uploaded chunk ${chunkIndex + 1} part ${partIndex + 1}.`);
    }
    const chunkFileUploaded = new Api.InputFileBig({
        id: chunkFileId,
        parts: partIndex + 1,
        name: `${UFID}.chunk${chunkIndex + 1}`,
    });
    // Send the chunk message.
    const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded });

    // Update file card with last chunk included and uploadComplete being true.
    fileCardData.chunks.push(chunkMessage.id);
    fileCardData.uploadComplete = true;
    await client.invoke(new Api.messages.EditMessage({
        peer: fileCardMessage.peerId,
        id: fileCardMessage.id,
        message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
    }));

    const humanReadableFileSize = humanReadableSize(fileCardData.size);
    const date = new Date(fileCardMessage.date * 1000);
    const formattedDate = date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).replace(",", ""); // Remove the comma between date and time.

    const fileInfo = `Name: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`;
    
    alert(`File upload complete:\n\n${fileInfo}\n\nCopying UFID to clipboard.`);
    
    await navigator.clipboard.writeText(fileCardData.ufid);
}

export async function init(config: Config.Config): Promise<TelegramClient> {
    console.log("Starting up...");
    // Load previous session from a session string.
    const storeSession = new StoreSession("./tglfs.session");
    // Connect.
    const client = new TelegramClient(storeSession, config.apiId, config.apiHash, { connectionRetries: 5 });
    // Provide credentials to the server.
    await client.start({
        phoneNumber: config.phone,
        password: async () => {
            const pwd = prompt("Enter your password: ");
            if (!pwd) {
                throw new Error("No password provided.");
            }
            return pwd;
        },
        phoneCode: async () => {
            const code = prompt("Enter the code you received: ");
            if (!code) {
                throw new Error("No code provided.");
            }
            return code;
        },
        onError: (error) => console.error(error),
    });
    console.log("You are now logged in!");
    return client;
}