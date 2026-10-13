// Dev-only stand-in for Telegram.initWithQrCode, reachable only on localhost via
// `?mock=qr-login`. It emits random fake tokens (not valid Telegram tokens) so the
// QR sign-in states can be previewed without a Telegram connection:
//   qr-state=ready (default) | loading | expired | scanned | password | error
import type { QrLoginHandlers } from "../telegram"

const MOCK_TOKEN_LIFETIME_MS = 30_000

function fakeToken() {
    const token = new Uint8Array(32)
    crypto.getRandomValues(token)
    return token
}

export function createMockQrLoginDriver(scenario: string | null) {
    return (_config: unknown, handlers: QrLoginHandlers) =>
        new Promise<never>((_resolve, reject) => {
            const timers: number[] = []
            const later = (ms: number, fn: () => void) => {
                timers.push(window.setTimeout(fn, ms))
            }
            const emit = (lifetimeMs = MOCK_TOKEN_LIFETIME_MS) =>
                handlers.onQrCode({ token: fakeToken(), expiresAt: Date.now() + lifetimeMs })

            handlers.signal?.addEventListener(
                "abort",
                () => {
                    timers.forEach((timer) => window.clearTimeout(timer))
                    reject(new Error("LOGIN_CANCELLED"))
                },
                { once: true },
            )

            switch (scenario) {
                case "loading":
                    return
                case "expired":
                    later(300, () => emit(1_500))
                    return
                case "scanned":
                    later(300, () => {
                        emit()
                        later(700, () => handlers.onScanned?.())
                    })
                    return
                case "password":
                    later(300, () => {
                        emit()
                        later(700, async () => {
                            handlers.onScanned?.()
                            try {
                                // Behave like GramJS: every submitted password is "wrong" and re-asked.
                                for (;;) {
                                    await handlers.getPassword("the usual")
                                    handlers.onError?.(Object.assign(new Error("PASSWORD_HASH_INVALID"), {
                                        errorMessage: "PASSWORD_HASH_INVALID",
                                    }))
                                }
                            } catch (error) {
                                reject(error)
                            }
                        })
                    })
                    return
                case "error":
                    later(600, () => reject(new Error("Network error: Timed out starting Telegram web DC")))
                    return
                default: {
                    const rotate = () => {
                        emit()
                        later(MOCK_TOKEN_LIFETIME_MS + 600, rotate)
                    }
                    later(400, rotate)
                }
            }
        })
}
