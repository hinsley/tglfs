import assert from "node:assert/strict"
import test from "node:test"

import {
    TELEGRAM_WEB_DC_ENDPOINTS,
    createTelegramWebDcFallbackSocket,
    getTelegramWebDcFallbackHosts,
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
