import type { JsonEnvelope } from "./types.js"

export function printJson<T>(payload: JsonEnvelope<T>) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n")
}
