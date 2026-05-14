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

test("extractTelegramFloodWaitSeconds ignores unrelated errors", () => {
    assert.equal(extractTelegramFloodWaitSeconds(new Error("MESSAGE_TOO_LONG")), null)
})
