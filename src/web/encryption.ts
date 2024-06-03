/**
 * Utilities for AES-CTR encryption and decryption.
 * @module encryption
 */

export const ENCRYPTION_CHUNK_SIZE = 1 * 1024 * 1024 // 32 MB.

export async function deriveAESKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"],
    )

    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-CTR", length: 256 },
        false,
        ["encrypt", "decrypt"],
    )
}

export function incrementCounter(counter: Uint8Array): Uint8Array {
    const newCounter = new Uint8Array(counter.length)
    let carry = 1
    for (let i = counter.length - 1; i >= 0; i--) {
        const sum = counter[i] + carry
        newCounter[i] = sum & 0xff
        carry = sum >> 8
    }
    return newCounter
}
