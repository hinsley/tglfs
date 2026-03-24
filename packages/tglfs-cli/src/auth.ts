import type { TelegramClient } from "telegram/client/TelegramClient.js"
import type { StringSession } from "telegram/sessions/StringSession.js"

import { CliError, EXIT_CODES } from "./errors.js"
import { createQuietTelegramClient, createStringSession } from "./gramjs.js"
import { isInteractiveSession, promptPassword, promptText, readTrimmedStdin } from "./interactive.js"
import { BUNDLED_CHUNK_SIZE } from "./shared/constants.js"
import { clearPersistedState, loadConfig, loadSessionString, saveConfig, saveSessionString, sessionExists, storePaths } from "./store.js"
import type { PersistedConfig } from "./types.js"

export const BUNDLED_TELEGRAM_API_ID = 20227969
export const BUNDLED_TELEGRAM_API_HASH = "3fc5e726fcc1160a81704958b2243109"

type LoginOptions = {
    apiId?: string
    apiHash?: string
    phone?: string
    code?: string
    codeStdin?: boolean
    password?: string
    passwordStdin?: boolean
    interactive?: boolean
    json?: boolean
}

type TelegramIdentity = {
    id: string
    firstName?: string
    lastName?: string
    username?: string
    phone?: string
}

export function formatTwoFactorPrompt(hint?: string) {
    return hint ? `Telegram 2FA password (Hint: ${hint})` : "Telegram 2FA password"
}

function normalizeApiId(raw: string): number {
    const parsed = Number(raw.trim())
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliError("invalid_api_id", "Telegram API ID must be a positive integer.", EXIT_CODES.GENERAL_ERROR)
    }
    return parsed
}

async function resolveRequiredValue(
    label: string,
    values: Array<string | undefined>,
    promptFn: () => Promise<string>,
    interactive = isInteractiveSession(),
): Promise<string> {
    for (const value of values) {
        if (typeof value === "string" && value.trim() !== "") {
            return value.trim()
        }
    }

    if (!interactive) {
        throw new CliError(
            "interactive_required",
            `${label} is required. Provide it with a flag, environment variable, or stdin.`,
            EXIT_CODES.INTERACTIVE_REQUIRED,
        )
    }

    return promptFn()
}

function summarizeMe(me: Awaited<ReturnType<TelegramClient["getMe"]>>): TelegramIdentity {
    return {
        id: String(me.id),
        firstName: me.firstName,
        lastName: me.lastName,
        username: me.username,
        phone: me.phone,
    }
}

export async function connectAuthorizedClient() {
    const config = await loadConfig()
    if (!config) {
        throw new CliError(
            "missing_auth",
            "No persisted TGLFS config found. Run `tglfs login` first.",
            EXIT_CODES.MISSING_AUTH,
        )
    }

    const sessionString = await loadSessionString()
    if (!sessionString) {
        throw new CliError(
            "missing_auth",
            "No persisted Telegram session found. Run `tglfs login` first.",
            EXIT_CODES.MISSING_AUTH,
        )
    }

    const session = createStringSession(sessionString)
    const client = createQuietTelegramClient(session, config.apiId, config.apiHash)
    await client.connect()
    const authorized = await client.checkAuthorization()
    if (!authorized) {
        await client.disconnect().catch(() => {})
        throw new CliError(
            "missing_auth",
            "The saved Telegram session is not authorized. Run `tglfs login` again.",
            EXIT_CODES.MISSING_AUTH,
        )
    }

    return { client, config, session }
}

export async function persistAndDisconnectClient(client: TelegramClient, session: StringSession) {
    const sessionString = session.save()
    if (sessionString.trim() !== "") {
        await saveSessionString(sessionString)
    }
    await client.destroy()
}

export async function login(options: LoginOptions) {
    if (options.codeStdin && options.passwordStdin) {
        throw new CliError(
            "invalid_input",
            "Use only one stdin-backed secret per login command.",
            EXIT_CODES.GENERAL_ERROR,
        )
    }

    const interactive = options.interactive !== false && !options.json && isInteractiveSession()
    const existingConfig = await loadConfig()

    const apiId = normalizeApiId(
        [options.apiId, process.env.TGLFS_API_ID, existingConfig?.apiId?.toString(), String(BUNDLED_TELEGRAM_API_ID)].find(
            (value) => typeof value === "string" && value.trim() !== "",
        ) ?? String(BUNDLED_TELEGRAM_API_ID),
    )
    const apiHash =
        [options.apiHash, process.env.TGLFS_API_HASH, existingConfig?.apiHash, BUNDLED_TELEGRAM_API_HASH].find(
            (value) => typeof value === "string" && value.trim() !== "",
        ) ?? BUNDLED_TELEGRAM_API_HASH
    const phone = await resolveRequiredValue(
        "Telegram phone number",
        [options.phone, process.env.TGLFS_PHONE, existingConfig?.phone],
        async () => promptText("Telegram phone number", existingConfig?.phone),
        interactive,
    )

    const storedSession = (await loadSessionString()) ?? ""
    const session = createStringSession(storedSession)
    const client = createQuietTelegramClient(session, apiId, apiHash)

    let sharedStdinValue: string | undefined
    const getSharedStdin = async (label: string) => {
        if (sharedStdinValue !== undefined) {
            return sharedStdinValue
        }
        sharedStdinValue = await readTrimmedStdin(label)
        return sharedStdinValue
    }

    try {
        await client.start({
            phoneNumber: phone,
            phoneCode: async (isCodeViaApp?: boolean) => {
                if (options.code?.trim()) {
                    return options.code.trim()
                }
                if (process.env.TGLFS_LOGIN_CODE?.trim()) {
                    return process.env.TGLFS_LOGIN_CODE.trim()
                }
                if (options.codeStdin) {
                    return getSharedStdin("Telegram login code is required on stdin.")
                }
                if (!interactive) {
                    throw new CliError(
                        "interactive_required",
                        "Telegram login code is required. Provide `--code`, `TGLFS_LOGIN_CODE`, or `--code-stdin`.",
                        EXIT_CODES.INTERACTIVE_REQUIRED,
                    )
                }
                return promptText(
                    isCodeViaApp
                        ? "Telegram login code (sent in-app)"
                        : "Telegram login code (sent by Telegram)",
                )
            },
            password: async (hint?: string) => {
                if (options.password !== undefined) {
                    return options.password
                }
                if (process.env.TGLFS_2FA_PASSWORD !== undefined) {
                    return process.env.TGLFS_2FA_PASSWORD
                }
                if (options.passwordStdin) {
                    return getSharedStdin("Telegram 2FA password is required on stdin.")
                }
                if (!interactive) {
                    throw new CliError(
                        "interactive_required",
                        "Telegram 2FA password is required. Provide `--password`, `TGLFS_2FA_PASSWORD`, or `--password-stdin`.",
                        EXIT_CODES.INTERACTIVE_REQUIRED,
                    )
                }
                return promptPassword(formatTwoFactorPrompt(hint))
            },
            onError: async (error: Error) => {
                if (error instanceof CliError) {
                    throw error
                }
                return !interactive
            },
        })

        const config: PersistedConfig = {
            apiId,
            apiHash,
            phone,
            chunkSize: existingConfig?.chunkSize ?? BUNDLED_CHUNK_SIZE,
        }
        const me = await client.getMe()
        await saveConfig(config)
        await saveSessionString(session.save())

        return {
            config,
            me: summarizeMe(me),
            paths: storePaths,
        }
    } finally {
        await client.destroy().catch(() => {})
    }
}

export async function status() {
    const config = await loadConfig()
    const hasSession = await sessionExists()

    const result: {
        configured: boolean
        sessionPresent: boolean
        authorized: boolean
        identity?: TelegramIdentity
        paths: typeof storePaths
        phone?: string
        error?: string
    } = {
        configured: Boolean(config),
        sessionPresent: hasSession,
        authorized: false,
        paths: storePaths,
        phone: config?.phone,
    }

    if (!config || !hasSession) {
        return result
    }

    const sessionString = await loadSessionString()
    if (!sessionString) {
        return result
    }

    const session = createStringSession(sessionString)
    const client = createQuietTelegramClient(session, config.apiId, config.apiHash)

    try {
        await client.connect()
        result.authorized = await client.checkAuthorization()
        if (result.authorized) {
            const me = await client.getMe()
            result.identity = summarizeMe(me)
            await saveSessionString(session.save())
        }
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
    } finally {
        await client.destroy().catch(() => {})
    }

    return result
}

export async function logout(removeConfig = false) {
    await clearPersistedState(removeConfig)
    return {
        removedConfig: removeConfig,
        paths: storePaths,
    }
}
