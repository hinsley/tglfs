export const EXIT_CODES = {
    OK: 0,
    GENERAL_ERROR: 1,
    MISSING_AUTH: 10,
    INTERACTIVE_REQUIRED: 11,
    FILE_NOT_FOUND: 12,
    DECRYPTION_FAILED: 13,
    UFID_MISMATCH: 14,
    INVALID_FILE_CARD: 15,
} as const

export class CliError extends Error {
    readonly code: string
    readonly exitCode: number
    readonly details?: unknown

    constructor(code: string, message: string, exitCode: number, details?: unknown) {
        super(message)
        this.name = "CliError"
        this.code = code
        this.exitCode = exitCode
        this.details = details
    }
}

export function isCliError(error: unknown): error is CliError {
    return error instanceof CliError
}

export function toCliError(error: unknown): CliError {
    if (isCliError(error)) {
        return error
    }
    if (error instanceof Error) {
        return new CliError("internal_error", error.message, EXIT_CODES.GENERAL_ERROR)
    }
    return new CliError("internal_error", String(error), EXIT_CODES.GENERAL_ERROR)
}
