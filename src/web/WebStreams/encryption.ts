/**
 * Streaming encryption utilities.
 * Inspired by [hat.sh](https://hat.sh/about/#technical-details).
 * @module encryption
 */

import * as sodium from 'libsodium-wrappers-sumo';

export class XChaCha20Poly1305EncryptStream {
    private key: Uint8Array;
    private nonce: Uint8Array;

    constructor(key: Uint8Array, nonce: Uint8Array) {
        this.key = key;
        this.nonce = nonce;
    }

    async transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
        await sodium.ready;  // Ensure sodium is ready
        try {
            console.log("Encrypting chunk...");
            const cipherText = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(chunk, null, null, this.nonce, this.key);
            controller.enqueue(cipherText);
            console.log("Encryption successful, chunk enqueued.");
        } catch (error) {
            console.error("Encryption error:", error);
            controller.error(error);
        }
    }
}

export class XChaCha20Poly1305DecryptStream {
    private key: Uint8Array;
    private nonce: Uint8Array;

    constructor(key: Uint8Array, nonce: Uint8Array) {
        this.key = key;
        this.nonce = nonce;
    }

    async transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
        await sodium.ready;  // Ensure sodium is ready
        try {
            console.log("Decrypting chunk...");
            const plainText = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, chunk, null, this.nonce, this.key);
            controller.enqueue(plainText);
            console.log("Decryption successful, chunk enqueued.");
        } catch (error) {
            console.error("Decryption error:", error);
            controller.error(error);
        }
    }
}