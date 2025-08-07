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

/**
 * Increment only the low 64 bits of the 128-bit counter block by a given
 * number of 16-byte blocks, preserving the high 64-bit nonce portion.
 */
export function incrementCounter64By(counter: Uint8Array, blocks: number): Uint8Array {
    const result = new Uint8Array(counter)
    let carry = blocks >>> 0 // Ensure unsigned 32-bit for shifts.
    // Increment last 8 bytes (low 64 bits) as big-endian.
    for (let i = result.length - 1; i >= result.length - 8; i--) {
        const byteSum = result[i] + (carry & 0xff)
        result[i] = byteSum & 0xff
        // Propagate carry: combine leftover carry bytes and overflow from this byte.
        carry = (carry >>> 8) + (byteSum >>> 8)
        if (carry === 0 && i < result.length - 1) {
            // Early exit if no more carry to propagate.
            break
        }
    }
    return result
}
