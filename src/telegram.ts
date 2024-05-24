/**
 * Telegram client methods. 
 * @module Telegram
 */

import { TelegramClient } from "telegram";
import { StoreSession, StringSession } from "telegram/sessions";

import * as Config from "./config";
import * as FileProcessing from "./web/fileProcessing";


export async function fileUpload(client: TelegramClient, config: Config.Config) {
    try {
        const password = "password";

        const [fileHandle] = await (window as any).showOpenFilePicker(); // Types are broken for this.
        const file = await fileHandle.getFile();
        console.log(`Selected file: ${file.name}`);

        console.log(await FileProcessing.prepFile(file, password, config.chunkSize, config.chunkSize));

        //////////
        // Proof of concept.
        // const fileStream: ReadableStream = file.stream();
        // const compressedStream = fileStream.pipeThrough(new CompressionStream("gzip"));

        // const salt = window.crypto.getRandomValues(new Uint8Array(16));

        // // Helper function to derive an AES key from a password
        // async function deriveAESKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
        //     const keyMaterial = await window.crypto.subtle.importKey(
        //         "raw",
        //         new TextEncoder().encode(password),
        //         { name: "PBKDF2" },
        //         false,
        //         ["deriveKey"]
        //     );

        //     return window.crypto.subtle.deriveKey(
        //         {
        //             name: "PBKDF2",
        //             salt: salt,
        //             iterations: 100000,
        //             hash: "SHA-256",
        //         },
        //         keyMaterial,
        //         { name: "AES-CTR", length: 256 },
        //         false,
        //         ["encrypt", "decrypt"]
        //     );
        // }

        // function incrementCounter(counter: Uint8Array): Uint8Array {
        //     const newCounter = new Uint8Array(counter.length);
        //     let carry = 1;
        //     for (let i = counter.length - 1; i >= 0; i--) {
        //         const sum = counter[i] + carry;
        //         newCounter[i] = sum & 0xff;
        //         carry = sum >> 8;
        //     }
        //     return newCounter;
        // }
        
        // // Derive the AES key from the password
        // const aesKey = await deriveAESKeyFromPassword(password, salt);

        // // Set up AES-CTR encryption with unique counter for each chunk
        // const initialCounter = window.crypto.getRandomValues(new Uint8Array(16)); // Initial CTR mode counter
        // let encryptionCounter = new Uint8Array(initialCounter); // Copy initial counter value
        // const CHUNK_SIZE = 32 * 1024 * 1024; // 32MB

        // let encryptionBuffer: Uint8Array;
        // const encryptedStream = compressedStream.pipeThrough(new TransformStream({
        //     start(controller) {
        //         encryptionBuffer = new Uint8Array(0);
        //     },
        //     async transform(chunk, controller) {
        //         const tempBuffer = new Uint8Array(encryptionBuffer.length + chunk.length);
        //         tempBuffer.set(encryptionBuffer);
        //         tempBuffer.set(chunk, encryptionBuffer.length);
        //         encryptionBuffer = tempBuffer;
        //         while (encryptionBuffer.length >= CHUNK_SIZE) {
        //             console.log(encryptionCounter);
        //             const chunkToEncrypt = encryptionBuffer.slice(0, CHUNK_SIZE);
        //             encryptionBuffer = encryptionBuffer.slice(CHUNK_SIZE);
        //             console.log("Compressed chunk:", chunkToEncrypt);

        //             const encryptedChunk = await window.crypto.subtle.encrypt(
        //                 {
        //                     name: "AES-CTR",
        //                     counter: encryptionCounter,
        //                     length: 64 // bit length of the counter block
        //                 },
        //                 aesKey,
        //                 chunkToEncrypt
        //             );

        //             controller.enqueue(new Uint8Array(encryptedChunk));
        //             encryptionCounter = incrementCounter(encryptionCounter);
        //         }
        //     },
        //     async flush(controller) {
        //         if (encryptionBuffer.length > 0) {
        //             const encryptedChunk = await window.crypto.subtle.encrypt(
        //                 {
        //                     name: "AES-CTR",
        //                     counter: encryptionCounter,
        //                     length: 64 // bit length of the counter block
        //                 },
        //                 aesKey,
        //                 encryptionBuffer
        //             );
        //             controller.enqueue(new Uint8Array(encryptedChunk));
        //         }
        //     }
        // }));

        // // Decryption Stream with unique counter for each chunk
        // let decryptionCounter = new Uint8Array(initialCounter); // Reset to initial counter value

        // let decryptionBuffer: Uint8Array;
        // const decryptedStream = encryptedStream.pipeThrough(new TransformStream({
        //     start(controller) {
        //         decryptionBuffer = new Uint8Array(0);
        //     },
        //     async transform(chunk, controller) {
        //         const tempBuffer = new Uint8Array(decryptionBuffer.length + chunk.length);
        //         tempBuffer.set(decryptionBuffer);
        //         tempBuffer.set(chunk, decryptionBuffer.length);
        //         decryptionBuffer = tempBuffer;

        //         while (decryptionBuffer.length >= CHUNK_SIZE) {
        //             const chunkToDecrypt = decryptionBuffer.slice(0, CHUNK_SIZE);
        //             decryptionBuffer = decryptionBuffer.slice(CHUNK_SIZE);

        //             const decryptedChunk = await window.crypto.subtle.decrypt(
        //                 {
        //                     name: "AES-CTR",
        //                     counter: decryptionCounter,
        //                     length: 64 // bit length of the counter block
        //                 },
        //                 aesKey,
        //                 chunkToDecrypt
        //             );

        //             console.log("Decrypted chunk:", new Uint8Array(decryptedChunk));
        //             controller.enqueue(new Uint8Array(decryptedChunk));
        //             console.log(decryptionCounter);
        //             decryptionCounter = incrementCounter(decryptionCounter);
        //         }
        //     },
        //     async flush(controller) {
        //         if (decryptionBuffer.length > 0) {
        //             const decryptedChunk = await window.crypto.subtle.decrypt(
        //                 {
        //                     name: "AES-CTR",
        //                     counter: decryptionCounter,
        //                     length: 64 // bit length of the counter block
        //                 },
        //                 aesKey,
        //                 decryptionBuffer
        //             );
        //             controller.enqueue(new Uint8Array(decryptedChunk));
        //         }
        //     }
        // }));

        // // Decompression Stream
        // const decompressedStream = decryptedStream.pipeThrough(new DecompressionStream("gzip"));

        // // Read and log the final decompressed data
        // const reader = decompressedStream.getReader();
        // const originalChunks = [];
        // while (true) {
        //     const { done, value } = await reader.read();
        //     if (done) break;
        //     originalChunks.push(value);
        // }

        // // Concatenate all the chunks into a single Uint8Array
        // const originalData = new Uint8Array(originalChunks.reduce((acc, chunk) => acc + chunk.length, 0));
        // let offset = 0;
        // for (const chunk of originalChunks) {
        //     originalData.set(chunk, offset);
        //     offset += chunk.length;
        // }

        // // Convert the result back to a string (assuming it was originally a text file)
        // const decoder = new TextDecoder();
        // const resultText = decoder.decode(originalData);
        // console.log(resultText);
    } catch (error) {
        console.error("An error occurred during file upload:", error);
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