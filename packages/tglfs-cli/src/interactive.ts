import prompts from "prompts"

import { CliError, EXIT_CODES } from "./errors.js"

export function isInteractiveSession() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export async function readTrimmedStdin(message: string) {
    if (process.stdin.isTTY) {
        throw new CliError("interactive_required", message, EXIT_CODES.INTERACTIVE_REQUIRED)
    }

    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const value = Buffer.concat(chunks).toString("utf8").trim()
    if (value === "") {
        throw new CliError("interactive_required", message, EXIT_CODES.INTERACTIVE_REQUIRED)
    }

    return value
}

async function ask<T extends object>(questions: prompts.PromptObject<string> | prompts.PromptObject<string>[]) {
    const result = await prompts(questions, {
        onCancel: () => {
            throw new CliError("cancelled", "Operation cancelled.", EXIT_CODES.GENERAL_ERROR)
        },
    })
    return result as T
}

export async function promptText(message: string, initial?: string) {
    const response = await ask<{ value?: string }>({
        type: "text",
        name: "value",
        message,
        initial,
        validate: (value) => (value.trim() === "" ? "A value is required." : true),
    })
    return response.value?.trim() ?? ""
}

export async function promptPassword(message: string, initial = "") {
    const response = await ask<{ value?: string }>({
        type: "password",
        name: "value",
        message,
        initial,
    })
    return response.value ?? ""
}

export async function promptConfirm(message: string, initial = false) {
    const response = await ask<{ value?: boolean }>({
        type: "confirm",
        name: "value",
        message,
        initial,
    })
    return Boolean(response.value)
}

export async function promptSelect<T extends string>(
    message: string,
    choices: Array<{ title: string; value: T; description?: string }>,
) {
    const response = await ask<{ value?: T }>({
        type: "select",
        name: "value",
        message,
        choices: choices.map((choice) => ({
            title: choice.title,
            value: choice.value,
            description: choice.description,
        })),
    })

    if (!response.value) {
        throw new CliError("cancelled", "Operation cancelled.", EXIT_CODES.GENERAL_ERROR)
    }
    return response.value
}
