import envPaths from "env-paths"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { CliError, EXIT_CODES } from "./errors.js"
import { BUNDLED_CHUNK_SIZE } from "./shared/constants.js"
import type { PersistedConfig } from "./types.js"

const appPaths = envPaths("tglfs", { suffix: "" })

export const storePaths = {
    configDir: appPaths.config,
    dataDir: appPaths.data,
    configFile: join(appPaths.config, "config.json"),
    sessionFile: join(appPaths.data, "session.txt"),
}

function validateConfig(value: unknown): PersistedConfig {
    if (!value || typeof value !== "object") {
        throw new CliError("invalid_config", "Stored config is invalid.", EXIT_CODES.MISSING_AUTH)
    }

    const record = value as Partial<PersistedConfig>
    if (
        typeof record.apiId !== "number" ||
        !Number.isFinite(record.apiId) ||
        typeof record.apiHash !== "string" ||
        record.apiHash.trim() === "" ||
        (record.chunkSize !== undefined &&
            (typeof record.chunkSize !== "number" || !Number.isFinite(record.chunkSize) || record.chunkSize <= 0)) ||
        typeof record.phone !== "string" ||
        record.phone.trim() === ""
    ) {
        throw new CliError("invalid_config", "Stored config is invalid.", EXIT_CODES.MISSING_AUTH)
    }

    return {
        apiId: record.apiId,
        apiHash: record.apiHash,
        chunkSize: record.chunkSize ?? BUNDLED_CHUNK_SIZE,
        phone: record.phone,
    }
}

async function ensureParentDir(filePath: string) {
    await mkdir(dirname(filePath), { recursive: true })
}

async function writePrivateFile(filePath: string, content: string) {
    await ensureParentDir(filePath)
    await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 })
}

export async function loadConfig(): Promise<PersistedConfig | null> {
    try {
        const raw = await readFile(storePaths.configFile, "utf8")
        return validateConfig(JSON.parse(raw))
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return null
        }
        throw error
    }
}

export async function saveConfig(config: PersistedConfig) {
    await writePrivateFile(storePaths.configFile, JSON.stringify(config, null, 2) + "\n")
}

export async function deleteConfig() {
    await rm(storePaths.configFile, { force: true })
}

export async function loadSessionString(): Promise<string | null> {
    try {
        const raw = await readFile(storePaths.sessionFile, "utf8")
        const session = raw.trim()
        return session === "" ? null : session
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return null
        }
        throw error
    }
}

export async function saveSessionString(session: string) {
    await writePrivateFile(storePaths.sessionFile, session.trim() + "\n")
}

export async function deleteSessionString() {
    await rm(storePaths.sessionFile, { force: true })
}

export async function clearPersistedState(removeConfig = false) {
    await deleteSessionString()
    if (removeConfig) {
        await deleteConfig()
    }
}

export async function sessionExists() {
    try {
        await stat(storePaths.sessionFile)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return false
        }
        throw error
    }
}
