/**
 * Utilities for (un)chunking files and processing before uploading and after
 * downloading.
 * @module fileProcessing
 */

import * as Encryption from "./encryption";

export const STREAM_CHUNK_SIZE = 32 * 1024 * 1024; // 32 MB.

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
    const initialCounter = window.crypto.getRandomValues(new Uint8Array(12));
    let encryptionCounter = new Uint8Array(initialCounter);

    // To accumulate chunks for encryption (the stream interface feeds
    // arbitrary amounts at once, but we want to encrypt whole chunks atomically).
    let encryptionBuffer: Uint8Array;
    const encryptedStream = compressedStream.pipeThrough(new TransformStream({
        start(controller) {
            encryptionBuffer = new Uint8Array(0);
        },
        async transform(chunk, controller) {
            const tempBuffer = new Uint8Array(encryptionBuffer.length + chunk.length);
            tempBuffer.set(encryptionBuffer);
            tempBuffer.set(chunk, encryptionBuffer.length);
            encryptionBuffer = tempBuffer;
            while (encryptionBuffer.length >= STREAM_CHUNK_SIZE) {
                console.log(encryptionCounter);
                const chunkToEncrypt = encryptionBuffer.slice(0, STREAM_CHUNK_SIZE);
                encryptionBuffer = encryptionBuffer.slice(STREAM_CHUNK_SIZE);
                console.log("Compressed chunk:", chunkToEncrypt);

                const encryptedChunk = await window.crypto.subtle.encrypt(
                    {
                        name: "AES-CTR",
                        counter: encryptionCounter,
                        length: 64 // bit length of the counter block
                    },
                    aesKey,
                    chunkToEncrypt
                );

                controller.enqueue(new Uint8Array(encryptedChunk));
                encryptionCounter = Encryption.incrementCounter(encryptionCounter);
            }
        },
        async flush(controller) {
            if (encryptionBuffer.length > 0) {
                const encryptedChunk = await window.crypto.subtle.encrypt(
                    {
                        name: "AES-CTR",
                        counter: encryptionCounter,
                        length: 64 // bit length of the counter block
                    },
                    aesKey,
                    encryptionBuffer
                );
                controller.enqueue(new Uint8Array(encryptedChunk));
            }
        }
    }));
    
    let chunkFileIndex = 1;
    let chunkFileHandle;
    let chunkFileStream;
    let chunkFileWriter;
    let bytesWritten = 0;

    const rootDir = await navigator.storage.getDirectory();
    const fileName = file.name;

    // Codesmell. Should instead call createNewChunkFile, but TypeScript
    // compiler complains about possibly undefined variables.
    try {
        // Remove chunk file if it exists.
        await rootDir.removeEntry(`${fileName}.chunk${chunkFileIndex}`);
    } catch (e: any) {
        if (e.name !== 'NotFoundError') {
            throw e;
        }
        // Pass; the chunk file doesn't exist.
    }
    chunkFileHandle = await rootDir.getFileHandle(`${fileName}.chunk${chunkFileIndex}`, { create: true });
    chunkFileStream = await chunkFileHandle.createWritable();
    chunkFileWriter = chunkFileStream.getWriter();
    bytesWritten = 0;
    chunkFileIndex++;

    async function createNewChunkFile() {
        try {
            // Remove chunk file if it exists.
            await rootDir.removeEntry(`${fileName}.chunk${chunkFileIndex}`);
        } catch (e: any) {
            if (e.name !== 'NotFoundError') {
                throw e;
            }
            // Pass; the chunk file doesn't exist.
        }
        chunkFileHandle = await rootDir.getFileHandle(`${fileName}.chunk${chunkFileIndex}`, { create: true });
        chunkFileStream = await chunkFileHandle.createWritable();
        chunkFileWriter = chunkFileStream.getWriter();
        bytesWritten = 0;
        chunkFileIndex++;
    }

    const reader = encryptedStream.getReader();
    let done, value;

    // Why is this failing on reader.read()?
    while (({ done, value } = await reader.read()), !done) {
        if (bytesWritten + value.length > chunkSize) {
            const remainingSpace = chunkSize - bytesWritten;
            await chunkFileWriter.write(value.slice(0, remainingSpace));
            await chunkFileWriter.close();
            await createNewChunkFile();
            await chunkFileWriter.write(value.slice(remainingSpace));
            bytesWritten = value.length - remainingSpace;
        } else {
            await chunkFileWriter.write(value);
            bytesWritten += value.length;
        }
        console.log(bytesWritten);
    }

    await chunkFileWriter.close();

    return [salt, initialCounter];
}

export async function decryptAndDecompressFile(
    fileName: string,
    key: Uint8Array,
    nonce: Uint8Array
) {
    // const rootDir = await navigator.storage.getDirectory();
    // let chunkIndex = 1;
    // let chunkFileHandle;
    // let fileStream = new ReadableStream({
    //     async start(controller) {
    //         while (true) {
    //             try {
    //                 chunkFileHandle = await rootDir.getFileHandle(`${fileName}.chunk${chunkIndex}`, { create: false });
    //             } catch (e) {
    //                 break; // No more chunks
    //             }

    //             const file = await chunkFileHandle.getFile();
    //             const reader = file.stream().getReader();
    //             let done, value;

    //             while ({ done, value } = await reader.read(), !done) {
    //                 if (value) {
    //                     controller.enqueue(new Uint8Array(value.buffer));
    //                 }
    //             }

    //             chunkIndex++;
    //         }
    //         controller.close();
    //     }
    // });

    // // const decryptionStream = new Encryption.XChaCha20Poly1305DecryptStream(key, nonce);
    // const decompressionStream = new Compression.ZstdDecompressStream();

    // // const decryptedStream = fileStream.pipeThrough(new TransformStream(decryptionStream));
    // // const decompressedStream = decryptedStream.pipeThrough(new TransformStream(decompressionStream));
    // const decompressedStream = fileStream.pipeThrough(new TransformStream(decompressionStream));

    // const reader = decompressedStream.getReader();
    // let done, value;

    // while ({ done, value } = await reader.read(), !done) {
    //     const chunk = new Uint8Array(value);
    //     console.log(chunk);
    // }
}