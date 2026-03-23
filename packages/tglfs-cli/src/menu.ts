import type { Command } from "commander"

export function splitCommaSeparatedInput(raw: string) {
    return raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
}

export async function dispatchInteractiveCommand(program: Command, args: string[]) {
    await program.parseAsync(args, { from: "user" })
}
