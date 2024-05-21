/**
 * Utilities for (un)chunking files and processing before uploading and after
 * downloading.
 * @module fileProcessing
 */

import * as Compression from "./WebStreams/compression";
import * as Encryption from "./WebStreams/encryption";
import * as Logging from "./WebStreams/logging";

import * as sodium from 'libsodium-wrappers-sumo';

export async function prepFile(file: File, offset: number = 0) {
    await sodium.ready;

    // Generate key and nonce for encryption using libsodium
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

    // Create a stream from the file starting at the given offset
    const fileStream = file.slice(offset).stream();

    // Initialize the compression, encryption, and logging streams
    const compressionStream = new TransformStream({
        async transform(chunk, controller) {
            await new Compression.ZstdCompressStream().transform(new Uint8Array(chunk), controller);
        }
    });

    const encryptionStream = new TransformStream({
        async transform(chunk, controller) {
            await new Encryption.XChaCha20Poly1305EncryptStream(key, nonce).transform(new Uint8Array(chunk), controller);
        }
    });

    const loggingStream = new TransformStream({
        transform(chunk, controller) {
            new Logging.LoggingStream().transform(new Uint8Array(chunk), controller);
        }
    });

    const decryptionStream = new TransformStream({
        async transform(chunk, controller) {
            await new Encryption.XChaCha20Poly1305DecryptStream(key, nonce).transform(new Uint8Array(chunk), controller);
        }
    });

    const decompressionStream = new TransformStream({
        async transform(chunk, controller) {
            await new Compression.ZstdDecompressStream().transform(new Uint8Array(chunk), controller);
        }
    });

    // Create the pipeline
    const compressedStream = fileStream.pipeThrough(compressionStream);
    const encryptedStream = compressedStream.pipeThrough(encryptionStream);
    const loggedStream = encryptedStream.pipeThrough(loggingStream);
    const decryptedStream = loggedStream.pipeThrough(decryptionStream);
    const decompressedStream = decryptedStream.pipeThrough(decompressionStream);

    // Read and log the decrypted and decompressed stream
    const reader = decompressedStream.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        console.log("Decrypted and Decompressed:", new TextDecoder().decode(value));
    }
}