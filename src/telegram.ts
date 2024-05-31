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

export async function fileUpload(client: TelegramClient, config: Config.Config) {
    try {
        // TODO: Implement upload resumption.
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        console.log(`Selected file: ${file.name}`);
        const UFID = await FileProcessing.UFID(file);
        console.log(`UFID: ${UFID}`);

        const password = prompt("(Optional) Encryption password:");

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

            // Upload chunk in parts.
            const fileId = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
            const totalParts = Math.ceil(chunkFile.size / UPLOAD_PART_SIZE);
            for (let partIndex = 0; partIndex < totalParts; partIndex++) {
                const start = partIndex * UPLOAD_PART_SIZE;
                const end = Math.min(start + UPLOAD_PART_SIZE, chunkFile.size);
                const partBlob = chunkFile.slice(start, end);
                const partBuffer = Buffer.from(await partBlob.arrayBuffer()); // Gram.js wants a Buffer for uploads.

                const partResult = await client.invoke(new Api.upload.SaveBigFilePart({
                    fileId: fileId,
                    filePart: partIndex,
                    fileTotalParts: totalParts,
                    bytes: partBuffer,
                    workers: 10, // TODO: Determine if this actually does anything.
                }));

                if (!partResult) {
                    throw new Error(`Failed to save file part ${partIndex}.`);
                } else {
                    console.log(`Uploaded chunk ${chunkIndex+1} part ${partIndex+1} of ${totalParts}.`);
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
        alert(`File upload complete. Copy the UFID: ${UFID}`);
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