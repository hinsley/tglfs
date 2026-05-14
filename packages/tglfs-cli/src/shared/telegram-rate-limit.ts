export function extractTelegramFloodWaitSeconds(error: unknown): number | null {
    const directSeconds = error && typeof error === "object" && "seconds" in error
        ? Number((error as { seconds?: unknown }).seconds)
        : NaN
    if (Number.isFinite(directSeconds) && directSeconds > 0) {
        return Math.ceil(directSeconds)
    }

    const textParts: string[] = []
    if (error instanceof Error) {
        textParts.push(error.message)
    }
    if (error && typeof error === "object") {
        for (const key of ["message", "errorMessage"] as const) {
            const value = (error as Record<string, unknown>)[key]
            if (typeof value === "string") {
                textParts.push(value)
            }
        }
    }
    if (textParts.length === 0) {
        textParts.push(String(error))
    }

    const text = textParts.join("\n")
    const floodWaitMatch = /\bFLOOD_WAIT_(\d+)\b/i.exec(text)
    if (floodWaitMatch) {
        return Number(floodWaitMatch[1])
    }
    const waitMatch = /\bwait of (\d+) seconds?\b/i.exec(text)
    if (waitMatch) {
        return Number(waitMatch[1])
    }
    return null
}
