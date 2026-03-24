import prompts from "prompts"

import { CliError, EXIT_CODES } from "./errors.js"
import { CLI_FAIL_ON_PROMPT_SYMBOL, CLI_PROMPTS_OVERRIDE_SYMBOL } from "./test-hooks.js"

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

function getPromptsImplementation() {
    return ((globalThis as Record<PropertyKey, unknown>)[CLI_PROMPTS_OVERRIDE_SYMBOL] as typeof prompts | undefined) ?? prompts
}

function failOnPromptIfRequested() {
    if ((globalThis as Record<PropertyKey, unknown>)[CLI_FAIL_ON_PROMPT_SYMBOL]) {
        throw new CliError("prompt_used", "Interactive prompts are disabled for this execution context.", EXIT_CODES.GENERAL_ERROR)
    }
}

function requirePromptValue<T>(value: T | undefined) {
    if (value === undefined) {
        throw new CliError("cancelled", "Interactive input was cancelled or not answered.", EXIT_CODES.GENERAL_ERROR)
    }
    return value
}

async function ask<T extends object>(questions: prompts.PromptObject<string> | prompts.PromptObject<string>[]) {
    failOnPromptIfRequested()
    if (!isInteractiveSession()) {
        throw new CliError(
            "interactive_required",
            "Interactive input is not available. Supply the required value with flags, environment variables, or stdin.",
            EXIT_CODES.INTERACTIVE_REQUIRED,
        )
    }

    const result = await getPromptsImplementation()(questions, {
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
    return requirePromptValue(response.value)?.trim() ?? ""
}

export async function promptOptionalText(message: string, initial = "") {
    const response = await ask<{ value?: string }>({
        type: "text",
        name: "value",
        message,
        initial,
    })
    return requirePromptValue(response.value)?.trim() ?? ""
}

export async function promptPassword(message: string, initial = "") {
    const response = await ask<{ value?: string }>({
        type: "password",
        name: "value",
        message,
        initial,
    })
    return requirePromptValue(response.value)
}

export async function promptConfirm(message: string, initial = false) {
    const response = await ask<{ value?: boolean }>({
        type: "confirm",
        name: "value",
        message,
        initial,
    })
    return Boolean(requirePromptValue(response.value))
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

    return requirePromptValue(response.value)
}
