/**
 * Telegram client methods. 
 * @module Telegram
 */

import { Api, TelegramClient } from "telegram";
import { StoreSession, StringSession } from "telegram/sessions";

import * as Config from "./config";
import * as FileProcessing from "./web/fileProcessing";

const UPLOAD_PART_SIZE = 128 * 1024; // 128 KB.

// TODO: Consider moving these type definitions to a more appropriate place.
type FileChunk = {
    IV: string;
    messageId: number;
}

type FileCardData = {
    name: string;
    ufid: string;
    size: number;
    uploadComplete: boolean;
    chunks: FileChunk[];
}

export async function fileLookup(client: TelegramClient, config: Config.Config) {
    const query = prompt("Search query (filename or UFID):");
    if (query === null) {
        return;
    }
    const msgs = await client.getMessages("me", {
        search: ("tglfs:file " + query).trim(),
    });
    if (msgs.length == 0) {
        alert(`No results found for "${query}".`);
        return;
    }
    let response = `Lookup results for "${query}":`;
    const fileCards: FileCardData[] = [];
    for (const msg of msgs) {
        if (!msg.message.startsWith("tglfs:file")) {
            continue; // Not a file card message.
        }
        const fileCardData: FileCardData = JSON.parse(msg.message.substring(msg.message.indexOf("{")));
        fileCards.push(fileCardData);

        // TODO: Move this function to a more appropriate place.
        function humanReadableSize(size: number): string {
            const i = Math.floor(Math.log(size) / Math.log(1024));
            const sizes = ['bytes', 'KB', 'MB', 'GB', 'TB'];
            return (size / Math.pow(1024, i)).toFixed(i == 0 ? 0 : 2) + ' ' + sizes[i];
        }
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
        }).replace(",", ""); // Remove the comma between date and time
        response += `\n\nFile ${fileCards.length}\nName: ${fileCardData.name}\nUFID: ${fileCardData.ufid}\nSize: ${humanReadableFileSize}\nTimestamp: ${formattedDate}`;
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

export async function fileUpload(client: TelegramClient, config: Config.Config) {
    try {
        // TODO: Implement upload resumption.
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        console.log(`Selected file: ${file.name}`);

        let password = prompt("(Optional) Encryption password:");
        if (password === null) {
            password = "";
        }

        console.log("Calculating UFID...");
        const UFID = await FileProcessing.UFID(file);
        console.log(`UFID: ${UFID}`);

        let fileCardData: FileCardData = {
            name: file.name,
            ufid: UFID,
            size: 0, // In bytes.
            uploadComplete: false,
            chunks: []
        };
        const fileCardMessage = await client.sendMessage("me", { message: `tglfs:file\n${JSON.stringify(fileCardData)}` });

        // TODO: Move these helper function definitions to a more appropriate place.
        function bytesToBase64(bytes: Uint8Array) {
            const binString = Array.from(bytes, (byte: number) => String.fromCodePoint(byte)).join("");
            return btoa(binString);
        }
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

        let chunkIndex = 0;
        while (!fileCardData.uploadComplete) {
            // Compress and encrypt chunk.
            const [salt, initialCounter] = await FileProcessing.prepChunk(file, UFID, password ? password : "", config.chunkSize, chunkIndex);

            // Load the chunk file handle.
            const rootDir = await navigator.storage.getDirectory();
            const chunkFileName = `${UFID}.chunk${chunkIndex+1}`;
            const chunkFileHandle = await rootDir.getFileHandle(chunkFileName, { create: false });
            const chunkFile = await chunkFileHandle.getFile();

            // Upload chunk in parts (all in parallel with async).
            const fileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
            const totalParts = Math.ceil(chunkFile.size / UPLOAD_PART_SIZE);
            const partResults = [];
            for (let partIndex = 0; partIndex < totalParts; partIndex++) {
                const start = partIndex * UPLOAD_PART_SIZE;
                const end = Math.min(start + UPLOAD_PART_SIZE, chunkFile.size);
                const partBlob = chunkFile.slice(start, end);
                const partBuffer = Buffer.from(await partBlob.arrayBuffer()); // Gram.js wants a Buffer for uploads.
                partResults.push(client.invoke(new Api.upload.SaveBigFilePart({
                    fileId: fileId,
                    filePart: partIndex,
                    fileTotalParts: totalParts,
                    bytes: partBuffer,
                })));
            }
            for (let partIndex = 0; partIndex < totalParts; partIndex++) {
                const partResult = await partResults[partIndex];
                if (!partResult) {
                    throw new Error(`Failed to save file part ${partIndex}.`);
                } else {
                    console.log(`Uploaded chunk ${chunkIndex+1} part ${partIndex+1}/${totalParts}.`);
                }
            }
            const chunkFileUploaded = new Api.InputFileBig({
                id: fileId,
                parts: totalParts,
                name: chunkFileName,
            });
            const chunkMessage = await client.sendFile("me", { file: chunkFileUploaded });

            // Delete chunk file locally.
            try {
                await rootDir.removeEntry(chunkFileName);
            } catch (e: any) {
                if (e.name !== 'NotFoundError') {
                    console.error(`Failed to delete chunk file locally: ${chunkFileName}`, e);
                } else {
                    console.warn(`Chunk file not found locally: ${chunkFileName}`);
                }
            }

            // Encode initialization vector for storage.
            const IVBytes = new Uint8Array(salt.length + initialCounter.length);
            IVBytes.set(salt, 0);
            IVBytes.set(initialCounter, salt.length);
            const IV = bytesToBase64(IVBytes);

            // Update fileCard message.
            fileCardData.chunks.push({
                IV: IV,
                messageId: chunkMessage.id,
            });
            fileCardData.size += config.chunkSize;
            if (fileCardData.size >= file.size) {
                fileCardData.size = file.size;
                fileCardData.uploadComplete = true;
            }
            const result = await client.invoke(new Api.messages.EditMessage({
                peer: fileCardMessage.peerId,
                id: fileCardMessage.id,
                message: `tglfs:file\n${JSON.stringify(fileCardData)}`,
            }));

            chunkIndex += 1;
        }
        const copyUFID = confirm(`File upload complete. Press OK to copy UFID ${UFID} to clipboard, otherwise press Cancel.`);
        if (copyUFID) {
            await navigator.clipboard.writeText(UFID);
        }
    } catch (error) {
        console.error(
            "An error occurred during file upload:",
            (error as Error).name,
            (error as Error).message,
            error
        );
    }
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