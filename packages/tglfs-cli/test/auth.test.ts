import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { BUNDLED_TELEGRAM_API_HASH, BUNDLED_TELEGRAM_API_ID, formatTwoFactorPrompt } from "../src/auth.js"

test("CLI bundled Telegram app credentials match the web app defaults", async () => {
    const webAppSource = await readFile(new URL("../../../src/web/app.ts", import.meta.url), "utf8")

    assert.match(webAppSource, new RegExp(`const apiIdFromEnv = ${BUNDLED_TELEGRAM_API_ID}`))
    assert.match(webAppSource, new RegExp(`const apiHashFromEnv = "${BUNDLED_TELEGRAM_API_HASH}"`))
})

test("2FA prompt labels the hint clearly", () => {
    assert.equal(formatTwoFactorPrompt("The usual"), "Telegram 2FA password (Hint: The usual)")
    assert.equal(formatTwoFactorPrompt(undefined), "Telegram 2FA password")
})
