import assert from "node:assert/strict"
import test from "node:test"

import { dispatchInteractiveCommand, splitCommaSeparatedInput } from "../src/menu.js"

test("dispatchInteractiveCommand passes only user args to commander", async () => {
    const calls: Array<{ args: string[]; options: unknown }> = []
    const program = {
        async parseAsync(args: string[], options: unknown) {
            calls.push({ args, options })
        },
    }

    await dispatchInteractiveCommand(program as any, ["status"])
    await dispatchInteractiveCommand(program as any, ["send", "ufid-1", "--to", "@mygroup"])

    assert.deepEqual(calls, [
        { args: ["status"], options: { from: "user" } },
        { args: ["send", "ufid-1", "--to", "@mygroup"], options: { from: "user" } },
    ])
})

test("splitCommaSeparatedInput trims and drops empty values", () => {
    assert.deepEqual(splitCommaSeparatedInput(" ufid-1, ,ufid-2 ,, ufid-3 "), ["ufid-1", "ufid-2", "ufid-3"])
})
