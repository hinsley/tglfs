/**
 * Utilities for (un)chunking files and processing before uploading and after
 * downloading.
 * @module fileProcessing
 */

import * as Encryption from "./encryption";

export const ENCRYPTION_CHUNK_SIZE = 32 * 1024 * 1024; // 32 MB.
/**
 * Prepares a file for upload by compressing and encrypting it.
 *
 * This function takes a file, compresses it using gzip, and then encrypts it using AES-CTR.
 * The encryption key is derived from the provided password using PBKDF2 with a random salt.
 * The file is processed in chunks of the specified size.
 *
 * @param {File} file - The file to be prepared.
 * @param {string} password - The password used to derive the encryption key.
 * @param {number} chunkSize - The size of each chunk to be processed.
 * @param {number} [offset=0] - The offset to start reading the file from. TODO: Implement.
 * @returns {Promise<[Uint8Array, Uint8Array]>} - A promise that resolves to a tuple containing the salt and the initial counter used for encryption.
 */

export async function prepFile(
    file: File,
    password: string,
    chunkSize: number,
    offset: number = 0
): Promise<[Uint8Array, Uint8Array]> {
    const fileStream = file.stream();
    const compressedStream = fileStream.pipeThrough(new CompressionStream("gzip"));

    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const aesKey = await Encryption.deriveAESKeyFromPassword(password, salt);

    // Generate a random initial counter for AES-CTR encryption/decryption.
    const initialCounter = window.crypto.getRandomValues(new Uint8Array(16));
    let encryptionCounter = new Uint8Array(initialCounter);
    let decryptionCounter = new Uint8Array(initialCounter);

    const reader = compressedStream.getReader();
    const encryptedChunks: Uint8Array[] = [];

    let done, value;

    while (({ done, value } = await reader.read()), !done) {
        let offset = 0;
        while (offset < value.length) {
            const encryptionChunk = value.slice(offset, offset + ENCRYPTION_CHUNK_SIZE);
            // TODO: Do processing of encryption chunk here.
            const encryptedChunk = await window.crypto.subtle.encrypt(
                {
                    name: "AES-CTR",
                    counter: encryptionCounter,
                    length: 64 // Bit length of the counter block.
                },
                aesKey,
                encryptionChunk
            );
            encryptionCounter = Encryption.incrementCounter(encryptionCounter);
            encryptedChunks.push(new Uint8Array(encryptedChunk));
            
            offset += ENCRYPTION_CHUNK_SIZE;
        }
    }

    const decryptedChunks: Uint8Array[] = [];
    for (const encryptedChunk of encryptedChunks) {
        const decryptedChunk = await window.crypto.subtle.decrypt(
            {
                name: "AES-CTR",
                counter: decryptionCounter,
                length: 64 // Bit length of the counter block.
            },
            aesKey,
            encryptedChunk
        );
        decryptionCounter = Encryption.incrementCounter(decryptionCounter);
        decryptedChunks.push(new Uint8Array(decryptedChunk));
    }

    // Pipe encryption chunks through a gzip DecompressionStream.
    const decryptedChunksStream = new ReadableStream({
        start(controller) {
            for (const decryptedChunk of decryptedChunks) {
                controller.enqueue(decryptedChunk);
            }
            controller.close();
        }
    });
    const decompressedStream = decryptedChunksStream.pipeThrough(new DecompressionStream("gzip"));
    const readerDecompressed = decompressedStream.getReader();

    while (({ done, value } = await readerDecompressed.read()), !done) {
        // console.log(value);
        const textDecoder = new TextDecoder();
        const decodedValue = textDecoder.decode(value);
        console.log(decodedValue);
    }

//     // let chunkFileIndex = 1;
//     // let chunkFileHandle;
//     // let chunkFileStream;
//     // let chunkFileWriter;
//     // let bytesWritten = 0;

//     // const rootDir = await navigator.storage.getDirectory();
//     // const fileName = file.name;

//     // // Codesmell. Should instead call createNewChunkFile, but TypeScript
//     // // compiler complains about possibly undefined variables.
//     // try {
//     //     // Remove chunk file if it exists.
//     //     await rootDir.removeEntry(`${fileName}.chunk${chunkFileIndex}`);
//     // } catch (e: any) {
//     //     if (e.name !== 'NotFoundError') {
//     //         throw e;
//     //     }
//     //     // Pass; the chunk file doesn't exist.
//     // }
//     // chunkFileHandle = await rootDir.getFileHandle(`${fileName}.chunk${chunkFileIndex}`, { create: true });
//     // chunkFileStream = await chunkFileHandle.createWritable();
//     // chunkFileWriter = chunkFileStream.getWriter();
//     // bytesWritten = 0;
//     // chunkFileIndex++;

//     // async function createNewChunkFile() {
//     //     try {
//     //         // Remove chunk file if it exists.
//     //         await rootDir.removeEntry(`${fileName}.chunk${chunkFileIndex}`);
//     //     } catch (e: any) {
//     //         if (e.name !== 'NotFoundError') {
//     //             throw e;
//     //         }
//     //         // Pass; the chunk file doesn't exist.
//     //     }
//     //     chunkFileHandle = await rootDir.getFileHandle(`${fileName}.chunk${chunkFileIndex}`, { create: true });
//     //     chunkFileStream = await chunkFileHandle.createWritable();
//     //     chunkFileWriter = chunkFileStream.getWriter();
//     //     bytesWritten = 0;
//     //     chunkFileIndex++;
//     // }

//     // const reader = encryptedStream.getReader();
//     // let done, value;

//     // while (({ done, value } = await reader.read()), !done) {
//     //     if (bytesWritten + value.length > chunkSize) {
//     //         const remainingSpace = chunkSize - bytesWritten;
//     //         await chunkFileWriter.write(value.slice(0, remainingSpace));
//     //         await chunkFileWriter.close();
//     //         await createNewChunkFile();
//     //         await chunkFileWriter.write(value.slice(remainingSpace));
//     //         bytesWritten = value.length - remainingSpace;
//     //     } else {
//     //         await chunkFileWriter.write(value);
//     //         bytesWritten += value.length;
//     //     }
//     // }

//     await chunkFileWriter.close();

    return [salt, initialCounter];
}

export async function decryptAndDecompressFile(
    fileName: string,
    key: Uint8Array,
    nonce: Uint8Array
) {
    const rootDir = await navigator.storage.getDirectory();
    const file = await rootDir.getFileHandle(fileName, { create: false });
    const fileStream = await file.getFile();
}