export const TELEGRAM_WEB_DC_ENDPOINTS = [
    { dcId: 1, host: "pluto.web.telegram.org", url: "wss://pluto.web.telegram.org/apiws" },
    { dcId: 2, host: "venus.web.telegram.org", url: "wss://venus.web.telegram.org/apiws" },
    { dcId: 3, host: "aurora.web.telegram.org", url: "wss://aurora.web.telegram.org/apiws" },
    { dcId: 4, host: "vesta.web.telegram.org", url: "wss://vesta.web.telegram.org/apiws" },
    { dcId: 5, host: "flora.web.telegram.org", url: "wss://flora.web.telegram.org/apiws" },
] as const

export const TELEGRAM_WEB_DC_FALLBACK_CONNECT_TIMEOUT_MS = 5_000

export type TelegramWebDcEndpoint = (typeof TELEGRAM_WEB_DC_ENDPOINTS)[number]

export type TelegramWebSocketLike = {
    connect(port: number, ip: string, testServers?: boolean): Promise<unknown>
    readExactly(number: number): Promise<Buffer>
    read(number: number): Promise<Buffer>
    readAll(): Promise<Buffer>
    write(data: Buffer): void
    close(): Promise<void>
    toString(): string
}

export type TelegramWebSocketConstructor<T extends TelegramWebSocketLike = TelegramWebSocketLike> = new (
    ...args: unknown[]
) => T

export function normalizeTelegramWebHost(value: string) {
    return value
        .trim()
        .replace(/^wss?:\/\//i, "")
        .replace(/:\d+(?=\/|$)/, "")
        .replace(/\/apiws(?:_test)?\/?$/i, "")
        .replace(/\/$/, "")
        .toLowerCase()
}

export function getTelegramWebDcEndpoint(value: string): TelegramWebDcEndpoint | undefined {
    const host = normalizeTelegramWebHost(value)
    return TELEGRAM_WEB_DC_ENDPOINTS.find((endpoint) => endpoint.host === host)
}

export function getTelegramWebDcFallbackHosts(serverAddress: string): string[] {
    const host = normalizeTelegramWebHost(serverAddress)
    const knownHosts = TELEGRAM_WEB_DC_ENDPOINTS.map((endpoint) => endpoint.host)
    if (!knownHosts.includes(host as (typeof knownHosts)[number])) {
        return [serverAddress]
    }
    return [host, ...knownHosts.filter((candidate) => candidate !== host)]
}

export function isTelegramWebDcConnectionError(error: unknown): boolean {
    const message = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
    return (
        /not connected/i.test(message) ||
        /connection closed/i.test(message) ||
        /websocket/i.test(message) ||
        /timed out/i.test(message) ||
        /did not connect/i.test(message) ||
        /failed to connect/i.test(message) ||
        /network/i.test(message) ||
        /disconnected/i.test(message)
    )
}

async function withConnectTimeout<T>(
    promise: Promise<T>,
    host: string,
    timeoutMs: number,
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`Timed out connecting to ${host}`))
                }, timeoutMs)
            }),
        ])
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout)
        }
    }
}

export function createTelegramWebDcFallbackSocket<T extends TelegramWebSocketLike>(
    BaseSocket: TelegramWebSocketConstructor<T>,
    options: { timeoutMs?: number } = {},
): TelegramWebSocketConstructor<TelegramWebSocketLike> {
    const timeoutMs = options.timeoutMs ?? TELEGRAM_WEB_DC_FALLBACK_CONNECT_TIMEOUT_MS
    return class TelegramWebDcFallbackSocket implements TelegramWebSocketLike {
        private activeSocket?: T
        private readonly args: unknown[]

        constructor(...args: unknown[]) {
            this.args = args
        }

        private createSocket() {
            return new BaseSocket(...this.args)
        }

        private requireSocket() {
            if (!this.activeSocket) {
                throw new Error("Telegram WebSocket is not connected")
            }
            return this.activeSocket
        }

        async connect(port: number, ip: string, testServers = false) {
            const hosts = port === 443 && !testServers
                ? getTelegramWebDcFallbackHosts(ip)
                : [ip]
            let lastError: unknown
            for (const host of hosts) {
                const socket = this.createSocket()
                try {
                    await withConnectTimeout(socket.connect(port, host, testServers), host, timeoutMs)
                    this.activeSocket = socket
                    return this
                } catch (error) {
                    lastError = error
                    await socket.close().catch(() => undefined)
                }
            }
            throw lastError instanceof Error ? lastError : new Error(`Failed to connect to Telegram web DC ${ip}`)
        }

        readExactly(number: number) {
            return this.requireSocket().readExactly(number)
        }

        read(number: number) {
            return this.requireSocket().read(number)
        }

        readAll() {
            return this.requireSocket().readAll()
        }

        write(data: Buffer) {
            this.requireSocket().write(data)
        }

        close() {
            return this.activeSocket?.close() ?? Promise.resolve()
        }

        toString() {
            return this.activeSocket?.toString() ?? "TelegramWebDcFallbackSocket"
        }
    }
}
