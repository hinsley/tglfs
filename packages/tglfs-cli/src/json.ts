import type { JsonEnvelope } from "./types.js"

export function formatJson<T extends Record<string, unknown>>(payload: JsonEnvelope<T>) {
    return JSON.stringify(payload, null, 2) + "\n"
}

export function printJson<T extends Record<string, unknown>>(payload: JsonEnvelope<T>) {
    process.stdout.write(formatJson(payload))
}

export function printJsonError<T extends Record<string, unknown>>(payload: JsonEnvelope<T>) {
    process.stderr.write(formatJson(payload))
}
