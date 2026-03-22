import { createRequire } from "node:module"

import type { TelegramClient } from "telegram/client/TelegramClient.js"
import type { StringSession } from "telegram/sessions/StringSession.js"

const require = createRequire(import.meta.url)

type StorageShim = {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem: (key: string) => void
    clear: () => void
    key: (index: number) => string | null
    readonly length: number
}

type GramJsModules = {
    TelegramClient: typeof import("telegram")["TelegramClient"]
    Api: typeof import("telegram")["Api"]
    StringSession: typeof import("telegram/sessions/StringSession.js")["StringSession"]
    getFileInfo: typeof import("telegram/Utils.js")["getFileInfo"]
    Logger: typeof import("telegram/extensions/Logger.js")["Logger"]
    LogLevel: typeof import("telegram/extensions/Logger.js")["LogLevel"]
}

let gramJsModules: GramJsModules | null = null

function installLocalStorageShim() {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    if (!descriptor?.configurable || !descriptor.get) {
        return
    }

    const storage = new Map<string, string>()
    const shim: StorageShim = {
        getItem(key) {
            return storage.has(key) ? storage.get(key)! : null
        },
        setItem(key, value) {
            storage.set(String(key), String(value))
        },
        removeItem(key) {
            storage.delete(String(key))
        },
        clear() {
            storage.clear()
        },
        key(index) {
            return Array.from(storage.keys())[index] ?? null
        },
        get length() {
            return storage.size
        },
    }

    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: true,
        value: shim,
    })
}

function loadGramJsModules(): GramJsModules {
    installLocalStorageShim()

    const telegram = require("telegram") as typeof import("telegram")
    const stringSessionModule = require("telegram/sessions/StringSession.js") as typeof import("telegram/sessions/StringSession.js")
    const utilsModule = require("telegram/Utils.js") as typeof import("telegram/Utils.js")
    const loggerModule = require("telegram/extensions/Logger.js") as typeof import("telegram/extensions/Logger.js")

    return {
        TelegramClient: telegram.TelegramClient,
        Api: telegram.Api,
        StringSession: stringSessionModule.StringSession,
        getFileInfo: utilsModule.getFileInfo,
        Logger: loggerModule.Logger,
        LogLevel: loggerModule.LogLevel,
    }
}

export function getGramJs() {
    if (!gramJsModules) {
        gramJsModules = loadGramJsModules()
    }
    return gramJsModules
}

export function createQuietTelegramClient(session: StringSession, apiId: number, apiHash: string): TelegramClient {
    const { TelegramClient, Logger, LogLevel } = getGramJs()
    const logger = new Logger(LogLevel.NONE)
    return new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        baseLogger: logger,
    })
}

export function createStringSession(value: string): StringSession {
    const { StringSession } = getGramJs()
    return new StringSession(value)
}
