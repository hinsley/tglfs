#!/usr/bin/env node

import { access } from "node:fs/promises"
import process from "node:process"

import { Command } from "commander"

import {
    BUNDLED_TELEGRAM_API_HASH,
    BUNDLED_TELEGRAM_API_ID,
    connectAuthorizedClient,
    login,
    logout,
    persistAndDisconnectClient,
    status,
} from "./auth.js"
import { defaultOutputPath, downloadFileCard } from "./download.js"
import { CliError, EXIT_CODES, toCliError } from "./errors.js"
import { isInteractiveSession, promptConfirm, promptPassword, promptSelect, promptText, readTrimmedStdin } from "./interactive.js"
import { printJson } from "./json.js"
import { getFileCardByUfid } from "./protocol.js"
import { storePaths } from "./store.js"

type JsonFlag = {
    json?: boolean
}

function emitSuccess<T>(json: boolean | undefined, text: string, data: T) {
    if (json) {
        printJson({ ok: true, data })
        return
    }
    process.stdout.write(text + "\n")
}

function emitFailure(json: boolean | undefined, error: CliError) {
    if (json) {
        printJson({
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                details: error.details,
            },
        })
        return
    }
    process.stderr.write(`Error: ${error.message}\n`)
}

async function runJsonAware<T extends JsonFlag>(options: T, work: () => Promise<{ text: string; data: unknown }>) {
    try {
        const result = await work()
        emitSuccess(Boolean(options.json), result.text, result.data)
    } catch (error) {
        const cliError = toCliError(error)
        emitFailure(Boolean(options.json), cliError)
        process.exitCode = cliError.exitCode
    }
}

async function pathExists(path: string) {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function resolveDownloadPassword(options: {
    password?: string
    passwordEnv?: string | boolean
    passwordStdin?: boolean
}) {
    if (options.password !== undefined) {
        return options.password
    }

    const envName =
        typeof options.passwordEnv === "string" && options.passwordEnv.trim() !== ""
            ? options.passwordEnv.trim()
            : options.passwordEnv
              ? "TGLFS_DOWNLOAD_PASSWORD"
              : undefined
    if (envName && process.env[envName] !== undefined) {
        return process.env[envName] ?? ""
    }
    if (process.env.TGLFS_DOWNLOAD_PASSWORD !== undefined) {
        return process.env.TGLFS_DOWNLOAD_PASSWORD
    }
    if (options.passwordStdin) {
        return readTrimmedStdin("File decryption password is required on stdin.")
    }
    if (!isInteractiveSession()) {
        return ""
    }
    return promptPassword("File decryption password (leave empty if none)")
}

async function runInteractiveMenu(program: Command) {
    const choice = await promptSelect("TGLFS action", [
        { title: "Login", value: "login", description: "Authenticate and persist the Telegram session." },
        { title: "Status", value: "status", description: "Show current config and auth status." },
        { title: "Download", value: "download", description: "Download a TGLFS file by UFID." },
        { title: "Logout", value: "logout", description: "Remove the saved Telegram session." },
        { title: "Help", value: "help", description: "Show general CLI help." },
        { title: "Exit", value: "exit", description: "Quit without doing anything." },
    ])

    switch (choice) {
        case "login":
            await program.parseAsync(["node", "tglfs", "login"], { from: "user" })
            return
        case "status":
            await program.parseAsync(["node", "tglfs", "status"], { from: "user" })
            return
        case "download": {
            const ufid = await promptText("UFID to download")
            await program.parseAsync(["node", "tglfs", "download", ufid], { from: "user" })
            return
        }
        case "logout":
            await program.parseAsync(["node", "tglfs", "logout"], { from: "user" })
            return
        case "help":
            program.outputHelp()
            return
        case "exit":
            return
    }
}

async function main(argv: string[]) {
    const program = new Command()

    program
        .name("tglfs")
        .description("Authenticate with Telegram and download current-format TGLFS files by UFID.")
        .showHelpAfterError()
        .showSuggestionAfterError()
        .addHelpCommand("help [command]", "display help for command")
        .addHelpText(
            "after",
            `\nStorage paths:\n  config: ${storePaths.configFile}\n  session: ${storePaths.sessionFile}\n`,
        )

    program
        .command("login")
        .description("Authenticate with Telegram and persist the session for future commands.")
        .option("--api-id <id>", "Telegram API ID")
        .option("--api-hash <hash>", "Telegram API hash")
        .option("--phone <phone>", "Telegram phone number")
        .option("--code <code>", "Telegram login code")
        .option("--code-stdin", "Read the Telegram login code from stdin")
        .option("--password <password>", "Telegram 2FA password")
        .option("--password-stdin", "Read the Telegram 2FA password from stdin")
        .option("--json", "Output machine-readable JSON")
        .addHelpText(
            "after",
            `\nDefaults:\n  API ID: ${BUNDLED_TELEGRAM_API_ID}\n  API hash: ${BUNDLED_TELEGRAM_API_HASH}\n\nEnvironment variables:\n  TGLFS_API_ID\n  TGLFS_API_HASH\n  TGLFS_PHONE\n  TGLFS_LOGIN_CODE\n  TGLFS_2FA_PASSWORD\n`,
        )
        .action(async (options) => {
            await runJsonAware(options, async () => {
                const result = await login(options)
                return {
                    text: `Logged in as ${result.me.firstName ?? result.me.username ?? result.me.id}. Session saved to ${result.paths.sessionFile}.`,
                    data: result,
                }
            })
        })

    program
        .command("status")
        .description("Show persisted config and Telegram authorization status.")
        .option("--json", "Output machine-readable JSON")
        .action(async (options) => {
            await runJsonAware(options, async () => {
                const result = await status()
                const summary = result.authorized
                    ? `Authorized as ${result.identity?.firstName ?? result.identity?.username ?? result.identity?.id}.`
                    : result.configured
                      ? "Configured, but not currently authorized."
                      : "Not configured."
                return {
                    text: summary,
                    data: result,
                }
            })
        })

    program
        .command("logout")
        .description("Remove the saved Telegram session. Use --all to also remove config.")
        .option("--all", "Also delete persisted config")
        .option("--json", "Output machine-readable JSON")
        .action(async (options) => {
            await runJsonAware(options, async () => {
                const result = await logout(Boolean(options.all))
                return {
                    text: options.all ? "Removed saved session and config." : "Removed saved session.",
                    data: result,
                }
            })
        })

    program
        .command("download")
        .description("Download a current-format TGLFS file from Telegram by UFID.")
        .argument("<ufid>", "TGLFS file UFID")
        .option("-o, --output <path>", "Destination file path")
        .option("-f, --force", "Overwrite the output path if it already exists")
        .option("--password <password>", "Decryption password")
        .option("--password-env [name]", "Read decryption password from an environment variable")
        .option("--password-stdin", "Read decryption password from stdin")
        .option("--json", "Output machine-readable JSON")
        .addHelpText(
            "after",
            "\nIf the file uses a decryption password, provide it with --password, --password-env, --password-stdin, or interactively on a TTY.\n",
        )
        .action(async (ufid: string, options) => {
            await runJsonAware(options, async () => {
                const { client, session } = await connectAuthorizedClient()
                try {
                    const record = await getFileCardByUfid(client, ufid)
                    const outputPath = options.output ? String(options.output) : defaultOutputPath(record.data.name)

                    if ((await pathExists(outputPath)) && !options.force) {
                        if (!isInteractiveSession()) {
                            throw new CliError(
                                "output_exists",
                                `Output path already exists: ${outputPath}. Use --force to overwrite it.`,
                                EXIT_CODES.GENERAL_ERROR,
                            )
                        }
                        const overwrite = await promptConfirm(`Overwrite existing file at ${outputPath}?`)
                        if (!overwrite) {
                            throw new CliError("cancelled", "Download cancelled.", EXIT_CODES.GENERAL_ERROR)
                        }
                        options.force = true
                    }

                    const password = await resolveDownloadPassword(options)
                    const result = await downloadFileCard(
                        client,
                        record.data,
                        password,
                        outputPath,
                        Boolean(options.force),
                    )
                    await persistAndDisconnectClient(client, session)

                    return {
                        text: `Downloaded ${result.name} to ${result.outputPath}.`,
                        data: result,
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    if (argv.length <= 2 && isInteractiveSession()) {
        await runInteractiveMenu(program)
        return
    }

    await program.parseAsync(argv)
}

main(process.argv).catch((error) => {
    const cliError = toCliError(error)
    emitFailure(false, cliError)
    process.exit(cliError.exitCode)
})
