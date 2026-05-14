export function extractTelegramFloodWaitSeconds(error: unknown): number | null {
    const textParts: string[] = []
    const seen = new Set<object>()
    const directSeconds = findTelegramFloodWaitSeconds(error, textParts, seen)
    if (directSeconds !== null) {
        return directSeconds
    }

    if (textParts.length === 0) textParts.push(String(error))
    const text = textParts.join("\n")
    const floodWaitMatch = /\bFLOOD(?:_PREMIUM)?_WAIT_(\d+)\b/i.exec(text)
    if (floodWaitMatch) {
        return Number(floodWaitMatch[1])
    }
    const waitMatch = /\bwait of (\d+) seconds?\b/i.exec(text)
    if (waitMatch) {
        return Number(waitMatch[1])
    }
    const requiredSecondsMatch = /\b(\d+) seconds? is required\b/i.exec(text)
    if (requiredSecondsMatch) {
        return Number(requiredSecondsMatch[1])
    }
    if (/\bFLOOD(?:_PREMIUM)?_WAIT\b/i.test(text) || /\bwait\b/i.test(text) && /\bmessages\.EditMessage\b/i.test(text)) {
        return 300
    }
    return null
}

function findTelegramFloodWaitSeconds(value: unknown, textParts: string[], seen: Set<object>, depth = 0): number | null {
    if (value === null || value === undefined || depth > 3) {
        return null
    }
    if (typeof value === "string") {
        textParts.push(value)
        return null
    }
    if (typeof value !== "object") {
        return null
    }
    if (seen.has(value)) {
        return null
    }
    seen.add(value)

    const record = value as Record<string, unknown>
    const secondsValue = Number(record.seconds)
    if (Number.isFinite(secondsValue) && secondsValue > 0) {
        return Math.ceil(secondsValue)
    }
    const capturedSecondsValue = Number(record.value ?? record.capture)

    if (value instanceof Error) {
        textParts.push(value.name, value.message, value.stack ?? "")
    }
    const keys = new Set([
        "name",
        "message",
        "errorMessage",
        "stack",
        "className",
        "request",
        "cause",
        "originalError",
    ])
    for (const key of Object.keys(record)) {
        keys.add(key)
    }

    for (const key of keys) {
        const child = record[key]
        if (typeof child === "string") {
            textParts.push(child)
            continue
        }
        if (child && typeof child === "object") {
            const nestedSeconds = findTelegramFloodWaitSeconds(child, textParts, seen, depth + 1)
            if (nestedSeconds !== null) {
                return nestedSeconds
            }
        }
    }
    if (
        Number.isFinite(capturedSecondsValue) &&
        capturedSecondsValue > 0 &&
        /\bFLOOD|\bwait\b/i.test(textParts.join("\n"))
    ) {
        return Math.ceil(capturedSecondsValue)
    }
    return null
}
