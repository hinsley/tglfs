import assert from "node:assert/strict"
import test from "node:test"

import { CliError } from "../src/errors.js"
import { promptText } from "../src/interactive.js"
import { CLI_PROMPTS_OVERRIDE_SYMBOL } from "../src/test-hooks.js"

function withFakeTty<T>(callback: () => Promise<T>) {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true })

    return callback().finally(() => {
        if (stdinDescriptor) {
            Object.defineProperty(process.stdin, "isTTY", stdinDescriptor)
        }
        if (stdoutDescriptor) {
            Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor)
        }
    })
}

test("promptText rejects unanswered prompts instead of silently continuing", async () => {
    ;(globalThis as Record<PropertyKey, unknown>)[CLI_PROMPTS_OVERRIDE_SYMBOL] = async () => ({})

    await assert.rejects(
        () => withFakeTty(() => promptText("Hidden prompt")),
        (error: unknown) => error instanceof CliError && error.code === "cancelled",
    )

    delete (globalThis as Record<PropertyKey, unknown>)[CLI_PROMPTS_OVERRIDE_SYMBOL]
})
