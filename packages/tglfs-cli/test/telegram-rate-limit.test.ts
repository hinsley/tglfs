import assert from "node:assert/strict"
import test from "node:test"

import { extractTelegramFloodWaitSeconds } from "../src/shared/telegram-rate-limit.js"

test("extractTelegramFloodWaitSeconds reads GramJS seconds", () => {
    assert.equal(extractTelegramFloodWaitSeconds({ seconds: 298 }), 298)
})

test("extractTelegramFloodWaitSeconds parses EditMessage wait text", () => {
    assert.equal(
        extractTelegramFloodWaitSeconds(new Error("A wait of 298 seconds is required (caused by messages.EditMessage)")),
        298,
    )
})

test("extractTelegramFloodWaitSeconds parses FLOOD_WAIT errors", () => {
    assert.equal(extractTelegramFloodWaitSeconds({ errorMessage: "FLOOD_WAIT_42" }), 42)
})

test("extractTelegramFloodWaitSeconds parses nested GramJS request errors", () => {
    assert.equal(
        extractTelegramFloodWaitSeconds({
            originalError: {
                errorMessage: "FLOOD_PREMIUM_WAIT_73",
                request: { className: "messages.EditMessage" },
            },
        }),
        73,
    )
})

test("extractTelegramFloodWaitSeconds reads captured seconds when the error text is a wait", () => {
    assert.equal(
        extractTelegramFloodWaitSeconds({
            capture: "91",
            message: "FLOOD_WAIT",
        }),
        91,
    )
})

test("extractTelegramFloodWaitSeconds uses a conservative fallback for unnumbered EditMessage waits", () => {
    assert.equal(
        extractTelegramFloodWaitSeconds({
            message: "A wait is required",
            request: { className: "messages.EditMessage" },
        }),
        300,
    )
})

test("extractTelegramFloodWaitSeconds ignores unrelated errors", () => {
    assert.equal(extractTelegramFloodWaitSeconds(new Error("MESSAGE_TOO_LONG")), null)
    assert.equal(extractTelegramFloodWaitSeconds({ value: 42, message: "MESSAGE_TOO_LONG" }), null)
})
