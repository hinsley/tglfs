import assert from "node:assert/strict"
import test from "node:test"

import {
    TELEGRAM_WEB_DC_ENDPOINTS,
    createTelegramWebDcFallbackSocket,
    getTelegramWebDcEndpoint,
    getTelegramWebDcFallbackHosts,
    isTelegramWebDcConnectionError,
} from "../src/shared/telegram-web-dc.js"

test("Telegram web DC fallback hosts use normal endpoints only", () => {
    assert.deepEqual(
        TELEGRAM_WEB_DC_ENDPOINTS.map((endpoint) => endpoint.host),
        [
            "pluto.web.telegram.org",
            "venus.web.telegram.org",
            "aurora.web.telegram.org",
            "vesta.web.telegram.org",
            "flora.web.telegram.org",
        ],
    )
    assert.equal(TELEGRAM_WEB_DC_ENDPOINTS.some((endpoint) => endpoint.host.includes("-1.")), false)
})

test("Telegram web DC fallback starts with the requested host", () => {
    assert.deepEqual(
        getTelegramWebDcFallbackHosts("wss://pluto.web.telegram.org/apiws"),
        [
            "pluto.web.telegram.org",
            "venus.web.telegram.org",
            "aurora.web.telegram.org",
            "vesta.web.telegram.org",
            "flora.web.telegram.org",
        ],
    )
    assert.deepEqual(
        getTelegramWebDcFallbackHosts("vesta.web.telegram.org"),
        [
            "vesta.web.telegram.org",
            "pluto.web.telegram.org",
            "venus.web.telegram.org",
            "aurora.web.telegram.org",
            "flora.web.telegram.org",
        ],
    )
})

test("Telegram web DC endpoint lookup accepts hosts and websocket URLs", () => {
    assert.deepEqual(getTelegramWebDcEndpoint("pluto.web.telegram.org"), TELEGRAM_WEB_DC_ENDPOINTS[0])
    assert.deepEqual(getTelegramWebDcEndpoint("wss://venus.web.telegram.org/apiws"), TELEGRAM_WEB_DC_ENDPOINTS[1])
    assert.equal(getTelegramWebDcEndpoint("149.154.167.91"), undefined)
})

test("Telegram web DC connection error detection covers early handshake closes", () => {
    assert.equal(isTelegramWebDcConnectionError(new Error("Not connected")), true)
    assert.equal(isTelegramWebDcConnectionError(new Error("Connection closed while receiving data")), true)
    assert.equal(isTelegramWebDcConnectionError(new Error("Timed out starting Telegram web DC pluto.web.telegram.org")), true)
    assert.equal(isTelegramWebDcConnectionError(new Error("PHONE_CODE_INVALID")), false)
})

test("Telegram web DC fallback socket retries the next normal host", async () => {
    const attempts: string[] = []
    class FakeSocket {
        async connect(_port: number, ip: string) {
            attempts.push(ip)
            if (ip === "pluto.web.telegram.org") {
                throw new Error("pluto down")
            }
            return this
        }
        async readExactly() {
            return Buffer.alloc(0)
        }
        async read() {
            return Buffer.alloc(0)
        }
        async readAll() {
            return Buffer.alloc(0)
        }
        write() {}
        async close() {}
        toString() {
            return "fake"
        }
    }
    const FallbackSocket = createTelegramWebDcFallbackSocket(FakeSocket)
    const socket = new FallbackSocket()

    await socket.connect(443, "pluto.web.telegram.org")

    assert.deepEqual(attempts, ["pluto.web.telegram.org", "venus.web.telegram.org"])
})

test("Telegram web DC fallback socket leaves non-web hosts alone", async () => {
    const attempts: string[] = []
    class FakeSocket {
        async connect(_port: number, ip: string) {
            attempts.push(ip)
            return this
        }
        async readExactly() {
            return Buffer.alloc(0)
        }
        async read() {
            return Buffer.alloc(0)
        }
        async readAll() {
            return Buffer.alloc(0)
        }
        write() {}
        async close() {}
        toString() {
            return "fake"
        }
    }
    const FallbackSocket = createTelegramWebDcFallbackSocket(FakeSocket)
    const socket = new FallbackSocket()

    await socket.connect(443, "149.154.167.91")

    assert.deepEqual(attempts, ["149.154.167.91"])
})
