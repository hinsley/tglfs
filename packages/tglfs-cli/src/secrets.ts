import { CliError, EXIT_CODES } from "./errors.js"
import { isInteractiveSession, promptPassword, readTrimmedStdin } from "./interactive.js"

type ResolveOptionalPasswordOptions = {
    password?: string
    passwordEnv?: string | boolean
    passwordStdin?: boolean
    defaultEnv: string
    promptMessage: string
    stdinMessage: string
    fallbackValue?: string
    promptOnInteractive?: boolean
}

export async function resolveOptionalPassword(options: ResolveOptionalPasswordOptions): Promise<string | undefined> {
    if (options.password !== undefined) {
        return options.password
    }

    const envName =
        typeof options.passwordEnv === "string" && options.passwordEnv.trim() !== ""
            ? options.passwordEnv.trim()
            : options.passwordEnv
              ? options.defaultEnv
              : undefined

    if (envName && process.env[envName] !== undefined) {
        return process.env[envName] ?? ""
    }
    if (process.env[options.defaultEnv] !== undefined) {
        return process.env[options.defaultEnv] ?? ""
    }
    if (options.passwordStdin) {
        if (process.stdin.isTTY) {
            throw new CliError("interactive_required", options.stdinMessage, EXIT_CODES.INTERACTIVE_REQUIRED)
        }
        return readTrimmedStdin(options.stdinMessage)
    }
    if (!isInteractiveSession() || options.promptOnInteractive === false) {
        return options.fallbackValue
    }
    return promptPassword(options.promptMessage)
}
