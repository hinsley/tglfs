import { CliError, EXIT_CODES } from "./errors.js"

export const ENCRYPTION_CHUNK_SIZE = 1024 * 1024

export async function deriveAESKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"],
    )

    return globalThis.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-CTR", length: 256 },
        false,
        ["encrypt", "decrypt"],
    )
}

export function incrementCounter64By(counter: Uint8Array, blocks: number): Uint8Array {
    const result = new Uint8Array(counter)
    let carry = blocks >>> 0
    for (let i = result.length - 1; i >= result.length - 8; i -= 1) {
        const byteSum = result[i] + (carry & 0xff)
        result[i] = byteSum & 0xff
        carry = (carry >>> 8) + (byteSum >>> 8)
        if (carry === 0 && i < result.length - 1) {
            break
        }
    }
    return result
}

export function decodeIv(iv: string): { salt: Uint8Array; counter: Uint8Array } {
    const bytes = Uint8Array.from(Buffer.from(iv, "base64"))
    if (bytes.length !== 32) {
        throw new CliError(
            "invalid_file_card",
            "The file card IV is invalid or unsupported.",
            EXIT_CODES.INVALID_FILE_CARD,
        )
    }
    return {
        salt: bytes.subarray(0, 16),
        counter: bytes.slice(16),
    }
}
