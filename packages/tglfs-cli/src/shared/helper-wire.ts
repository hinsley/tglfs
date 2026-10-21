import { Buffer } from "buffer"

export const HELPER_PROTOCOL_VERSION = 1 as const
export const HELPER_DEFAULT_PORT = 27386
export class HelperRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message)
        this.name = "HelperRequestError"
    }
}
export type HelperPairing = { port: number; token: string }
export type HelperSecret = { type: "tglfs:helper-secret"; version: 1; iv: string; ciphertext: string }
const bytes = (text: string) => new TextEncoder().encode(text)
const hex = (data: ArrayBuffer) => Buffer.from(data).toString("hex")
export function parseHelperPairing(value: string): HelperPairing {
    const match = /^tglfs-helper:1:([0-9]{1,5}):([A-Za-z0-9_-]{43})$/.exec(value.trim())
    if (!match || +match[1] < 1024 || +match[1] > 65535)
        throw new Error("This helper pairing code is malformed or uses an unsupported version.")
    return { port: +match[1], token: match[2] }
}
export function helperPairingCode(pair: HelperPairing): string {
    return `tglfs-helper:1:${pair.port}:${pair.token}`
}
async function signingKey(token: string) {
    return crypto.subtle.importKey(
        "raw",
        Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    )
}
async function signature(token: string, fields: unknown[]) {
    return hex(
        await crypto.subtle.sign(
            "HMAC",
            await signingKey(token),
            bytes(JSON.stringify(["tglfs:helper-http", 1, ...fields])),
        ),
    )
}
export async function bodyHash(body: string) {
    return hex(await crypto.subtle.digest("SHA-256", bytes(body)))
}
export async function requestSignature(
    token: string,
    method: string,
    path: string,
    time: string,
    nonce: string,
    body: string,
) {
    return signature(token, ["request", method, path, time, nonce, await bodyHash(body)])
}
export async function responseSignature(token: string, nonce: string, status: number, body: string) {
    return signature(token, ["response", nonce, status, await bodyHash(body)])
}
async function secretKey(token: string) {
    const material = await crypto.subtle.importKey(
        "raw",
        Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
        "HKDF",
        false,
        ["deriveKey"],
    )
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: bytes("tglfs:helper-secret:1"), info: bytes("file-password") },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    )
}
export async function sealHelperPassword(password: string, token: string, requestId: string): Promise<HelperSecret> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: bytes(requestId) },
        await secretKey(token),
        bytes(password),
    )
    return {
        type: "tglfs:helper-secret",
        version: 1,
        iv: Buffer.from(iv).toString("base64"),
        ciphertext: Buffer.from(encrypted).toString("base64"),
    }
}
export async function openHelperPassword(secret: HelperSecret, token: string, requestId: string): Promise<string> {
    if (
        !secret ||
        secret.type !== "tglfs:helper-secret" ||
        secret.version !== 1 ||
        typeof secret.iv !== "string" ||
        typeof secret.ciphertext !== "string" ||
        secret.ciphertext.length > 32768
    )
        throw new Error("Unsupported helper secret.")
    try {
        const iv = Buffer.from(secret.iv, "base64"),
            ciphertext = Buffer.from(secret.ciphertext, "base64")
        if (
            iv.length !== 12 ||
            iv.toString("base64") !== secret.iv ||
            ciphertext.toString("base64") !== secret.ciphertext
        )
            throw new Error()
        return new TextDecoder("utf-8", { fatal: true }).decode(
            await crypto.subtle.decrypt(
                { name: "AES-GCM", iv, additionalData: bytes(requestId) },
                await secretKey(token),
                ciphertext,
            ),
        )
    } catch {
        throw new Error("The helper could not authenticate the transfer password.")
    }
}
export async function helperRequest(
    pair: HelperPairing,
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<any> {
    parseHelperPairing(helperPairingCode(pair))
    if (!/^\/v1\/[a-z/]+$/.test(path)) throw new Error("Invalid helper endpoint.")
    const method = body === undefined ? "GET" : "POST",
        payload = body === undefined ? "" : JSON.stringify(body)
    const time = String(Date.now()),
        nonce = crypto.randomUUID().replace(/-/g, "")
    const response = await (options.fetch ?? fetch)(`http://127.0.0.1:${pair.port}${path}`, {
        method,
        body: method === "POST" ? payload : undefined,
        signal: options.signal,
        headers: {
            "Content-Type": "application/json",
            "X-TGLFS-Time": time,
            "X-TGLFS-Nonce": nonce,
            "X-TGLFS-Signature": await requestSignature(pair.token, method, path, time, nonce, payload),
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        targetAddressSpace: "loopback",
    } as RequestInit)
    let text = "",
        length = 0
    const reader = response.body?.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true })
    if (reader) {
        try {
            while (true) {
                const part = await reader.read()
                if (part.done) break
                length += part.value.byteLength
                if (length > 2 * 1024 * 1024) throw new Error("The helper response exceeds its size limit.")
                text += decoder.decode(part.value, { stream: true })
            }
            text += decoder.decode()
        } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    }
    if (
        text.length > 2 * 1024 * 1024 ||
        response.headers.get("X-TGLFS-Signature") !==
            (await responseSignature(pair.token, nonce, response.status, text))
    )
        throw new Error("The local helper response could not be authenticated. Pair with the helper again.")
    const result = JSON.parse(text)
    if (result?.type !== "tglfs:helper-response" || result.version !== 1)
        throw new Error("Unsupported helper response version.")
    if (!response.ok || !result.ok)
        throw new HelperRequestError(result.error || "The local helper request failed.", response.status)
    return result.data
}
