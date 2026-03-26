#!/usr/bin/env node

import { realpathSync } from "node:fs"
import { access } from "node:fs/promises"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { Command, Option } from "commander"

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
import {
    deleteResolvedFiles,
    formatDeleteConfirmation,
    inspectFileCard,
    receiveFiles,
    renameFile,
    resolveFileCardRecords,
    sendFiles,
    unsendFiles,
} from "./file-ops.js"
import {
    isInteractiveSession,
    promptConfirm,
    promptOptionalText,
    promptSelect,
    promptText,
} from "./interactive.js"
import { printJson, printJsonError } from "./json.js"
import { dispatchInteractiveCommand, splitCommaSeparatedInput } from "./menu.js"
import { createByteProgressReporter } from "./progress.js"
import { getFileCardByUfid } from "./protocol.js"
import { resolveOptionalPassword } from "./secrets.js"
import { FILE_CARD_SEARCH_SORT_VALUES, formatSearchResultsTable, searchFileCards } from "./search.js"
import { formatFileCardDate, formatFileCardSize } from "./shared/file-cards.js"
import { storePaths } from "./store.js"
import { CLI_RUNTIME_OVERRIDE_SYMBOL } from "./test-hooks.js"
import { uploadPaths } from "./upload.js"

type JsonFlag = {
    json?: boolean
}

type InteractiveFlag = JsonFlag & {
    interactive?: boolean
}

type JsonResult = Record<string, unknown>

type CliRuntime = {
    connectAuthorizedClient: typeof connectAuthorizedClient
    login: typeof login
    logout: typeof logout
    persistAndDisconnectClient: typeof persistAndDisconnectClient
    status: typeof status
    defaultOutputPath: typeof defaultOutputPath
    downloadFileCard: typeof downloadFileCard
    deleteResolvedFiles: typeof deleteResolvedFiles
    inspectFileCard: typeof inspectFileCard
    receiveFiles: typeof receiveFiles
    renameFile: typeof renameFile
    resolveFileCardRecords: typeof resolveFileCardRecords
    sendFiles: typeof sendFiles
    unsendFiles: typeof unsendFiles
    createByteProgressReporter: typeof createByteProgressReporter
    getFileCardByUfid: typeof getFileCardByUfid
    resolveOptionalPassword: typeof resolveOptionalPassword
    searchFileCards: typeof searchFileCards
    uploadPaths: typeof uploadPaths
}

const DEFAULT_RUNTIME: CliRuntime = {
    connectAuthorizedClient,
    login,
    logout,
    persistAndDisconnectClient,
    status,
    defaultOutputPath,
    downloadFileCard,
    deleteResolvedFiles,
    inspectFileCard,
    receiveFiles,
    renameFile,
    resolveFileCardRecords,
    sendFiles,
    unsendFiles,
    createByteProgressReporter,
    getFileCardByUfid,
    resolveOptionalPassword,
    searchFileCards,
    uploadPaths,
}

function getCliRuntime(): CliRuntime {
    const override = ((globalThis as Record<PropertyKey, unknown>)[CLI_RUNTIME_OVERRIDE_SYMBOL] as
        | Partial<CliRuntime>
        | undefined) ?? { }
    return { ...DEFAULT_RUNTIME, ...override }
}

function isJsonMode(options: JsonFlag | undefined) {
    return Boolean(options?.json)
}

function isInteractiveModeEnabled(options: InteractiveFlag | undefined) {
    return options?.interactive !== false
}

function canPrompt(options: InteractiveFlag | undefined) {
    return isInteractiveModeEnabled(options) && !isJsonMode(options) && isInteractiveSession()
}

function addInteractiveOption(command: Command) {
    return command.option("--no-interactive", "Disable interactive prompts and fail instead of prompting")
}

function emitSuccess<T extends JsonResult>(json: boolean | undefined, text: string, data: T) {
    if (json) {
        printJson({ ok: true, ...data })
        return
    }
    process.stdout.write(text + "\n")
}

function emitFailure(json: boolean | undefined, error: CliError) {
    if (json) {
        printJsonError({
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

async function runJsonAware<T extends JsonFlag>(options: T, work: () => Promise<{ text: string; data: JsonResult }>) {
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

function parsePositiveInteger(label: string, value: string) {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliError("invalid_argument", `${label} must be a positive integer.`, EXIT_CODES.GENERAL_ERROR)
    }
    return parsed
}

async function confirmDestructiveAction(message: string, options: { force?: boolean } & InteractiveFlag = {}) {
    if (options.force) {
        return
    }
    if (!canPrompt(options)) {
        throw new CliError(
            "interactive_required",
            `${message} Use --yes to confirm when prompts are disabled.`,
            EXIT_CODES.INTERACTIVE_REQUIRED,
        )
    }
    const confirmed = await promptConfirm(message)
    if (!confirmed) {
        throw new CliError("cancelled", "Operation cancelled.", EXIT_CODES.GENERAL_ERROR)
    }
}

function toJsonMessageId(result: { msgId: number }) {
    return {
        ...result,
        messageId: result.msgId,
    }
}

function isDirectEntrypoint() {
    if (!process.argv[1]) {
        return false
    }
    try {
        const invokedPath = realpathSync(process.argv[1])
        const modulePath = realpathSync(fileURLToPath(import.meta.url))
        return invokedPath === modulePath
    } catch {
        return false
    }
}

function createProgram(runtime = getCliRuntime()) {
    const program = new Command()
    const {
        connectAuthorizedClient,
        login,
        logout,
        persistAndDisconnectClient,
        status,
        defaultOutputPath,
        downloadFileCard,
        deleteResolvedFiles,
        inspectFileCard,
        receiveFiles,
        renameFile,
        resolveFileCardRecords,
        sendFiles,
        unsendFiles,
        createByteProgressReporter,
        getFileCardByUfid,
        resolveOptionalPassword,
        searchFileCards,
        uploadPaths,
    } = runtime

    program
        .name("tglfs")
        .description(
            "Authenticate with Telegram, manage TGLFS file cards, transfer files between peers, and download current or legacy TGLFS files by UFID.",
        )
        .option("--no-interactive", "Disable interactive prompts and fail instead of prompting")
        .showHelpAfterError()
        .showSuggestionAfterError()
        .addHelpCommand("help [command]", "display help for command")
        .addHelpText(
            "after",
            `\nStorage paths:\n  config: ${storePaths.configFile}\n  session: ${storePaths.sessionFile}\n`,
        )

    const withGlobalInteractive = <T extends InteractiveFlag>(options: T): T => ({
        ...options,
        interactive: options.interactive ?? (program.opts() as InteractiveFlag).interactive,
    })

    addInteractiveOption(
        program
            .command("upload")
            .description("Upload one file, or archive multiple files, into Telegram Saved Messages.")
            .argument("<paths...>", "File path(s) to upload"),
    )
        .option("--password <password>", "Encryption password")
        .option("--password-env [name]", "Read encryption password from an environment variable")
        .option("--password-stdin", "Read encryption password from stdin")
        .option("--json", "Output machine-readable JSON")
        .addHelpText(
            "after",
            "\nUploading multiple paths produces a tar archive using the same naming convention as the web app.\nIf no password source is supplied, the upload is unencrypted.\nTTY runs show separate UFID and upload progress bars. --json prints exactly one final JSON object to stdout and never prompts.\nEnvironment variable: TGLFS_UPLOAD_PASSWORD\n",
        )
        .action(async (paths: string[], options: InteractiveFlag & { password?: string; passwordEnv?: string | boolean; passwordStdin?: boolean }) => {
            const interactiveOptions = withGlobalInteractive(options)
            await runJsonAware(interactiveOptions, async () => {
                const { client, config, session } = await connectAuthorizedClient()
                let ufidProgress: ReturnType<typeof createByteProgressReporter> | undefined
                let uploadProgress: ReturnType<typeof createByteProgressReporter> | undefined
                try {
                    const password =
                        (await resolveOptionalPassword({
                            ...interactiveOptions,
                            defaultEnv: "TGLFS_UPLOAD_PASSWORD",
                            promptMessage: "File encryption password (leave empty if none)",
                            stdinMessage: "File encryption password is required on stdin.",
                            fallbackValue: "",
                            promptOnInteractive: false,
                        })) ?? ""
                    const result = await uploadPaths(client, {
                        paths,
                        chunkSize: config.chunkSize,
                        password,
                        onUfidProgress: ({ bytesProcessed, totalBytes }) => {
                            if (interactiveOptions.json) {
                                return
                            }
                            ufidProgress ??= createByteProgressReporter({
                                label: "Calculating UFID",
                                totalBytes,
                            })
                            ufidProgress.update(bytesProcessed)
                        },
                        onUploadProgress: ({ bytesProcessed, totalBytes }) => {
                            if (interactiveOptions.json) {
                                return
                            }
                            if (ufidProgress) {
                                ufidProgress.complete()
                                ufidProgress = undefined
                            }
                            uploadProgress ??= createByteProgressReporter({
                                label: "Uploading",
                                totalBytes,
                            })
                            uploadProgress.update(bytesProcessed)
                        },
                    })
                    ufidProgress?.complete()
                    uploadProgress?.complete()
                    await persistAndDisconnectClient(client, session)

                    return {
                        text: result.archived
                            ? `Uploaded archive ${result.name} as UFID ${result.ufid}.`
                            : `Uploaded ${result.name} as UFID ${result.ufid}.`,
                        data: toJsonMessageId(result),
                    }
                } catch (error) {
                    ufidProgress?.abort()
                    uploadProgress?.abort()
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    addInteractiveOption(
        program
            .command("login")
            .description("Authenticate with Telegram and persist the session for future commands."),
    )
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
            `\nDefaults:\n  API ID: ${BUNDLED_TELEGRAM_API_ID}\n  API hash: ${BUNDLED_TELEGRAM_API_HASH}\n\nUse --no-interactive or --json to fail instead of prompting for missing login values.\n\nEnvironment variables:\n  TGLFS_API_ID\n  TGLFS_API_HASH\n  TGLFS_PHONE\n  TGLFS_LOGIN_CODE\n  TGLFS_2FA_PASSWORD\n`,
        )
        .action(async (options: InteractiveFlag) => {
            const interactiveOptions = withGlobalInteractive(options)
            await runJsonAware(interactiveOptions, async () => {
                const result = await login(interactiveOptions)
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
        .action(async (options: JsonFlag) => {
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
        .action(async (options: JsonFlag & { all?: boolean }) => {
            await runJsonAware(options, async () => {
                const result = await logout(Boolean(options.all))
                return {
                    text: options.all ? "Removed saved session and config." : "Removed saved session.",
                    data: result,
                }
            })
        })

    program
        .command("search")
        .description("Search TGLFS file cards in Telegram Saved Messages or another peer mailbox.")
        .argument("[query]", "Search query for filename or UFID")
        .addOption(
            new Option("--sort <sort>", "Sort order for the current result window")
                .choices([...FILE_CARD_SEARCH_SORT_VALUES])
                .default(FILE_CARD_SEARCH_SORT_VALUES[0]),
        )
        .option("--peer <peer>", "Peer to search instead of Saved Messages")
        .option("--limit <n>", "Maximum number of file cards to fetch", (value) => parsePositiveInteger("Limit", value), 50)
        .option("--offset-id <msgId>", "Resume from a Telegram message-id cursor", (value) =>
            parsePositiveInteger("Offset id", value),
        )
        .option("--json", "Output machine-readable JSON")
        .addHelpText(
            "after",
            "\nIf no query is provided, the command lists the first page of all TGLFS file cards in Saved Messages.\nPagination uses Telegram message ids via --offset-id.\n",
        )
        .action(async (query: string | undefined, options: JsonFlag & { peer?: string; limit: number; offsetId?: number; sort: string }) => {
            await runJsonAware(options, async () => {
                const { client, session } = await connectAuthorizedClient()
                try {
                    const result = await searchFileCards(client, {
                        peer: options.peer,
                        query,
                        limit: options.limit,
                        offsetId: options.offsetId,
                        sort: options.sort as any,
                    })
                    await persistAndDisconnectClient(client, session)

                    return {
                        text: formatSearchResultsTable(result),
                        data: result,
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    addInteractiveOption(
        program
            .command("download")
            .description("Download a TGLFS file from Telegram by UFID.")
            .argument("<ufid>", "TGLFS file UFID"),
    )
        .option("-o, --output <path>", "Destination file path")
        .option("-f, --force", "Overwrite the output path if it already exists")
        .option("--legacy", "Use the legacy decryption/counter pipeline")
        .option("--password <password>", "Decryption password")
        .option("--password-env [name]", "Read decryption password from an environment variable")
        .option("--password-stdin", "Read decryption password from stdin")
        .option("--json", "Output machine-readable JSON")
        .addHelpText(
            "after",
            "\nIf the file uses a decryption password, provide it with --password, --password-env, --password-stdin, or interactively on a TTY.\nUse --no-interactive or --json to fail instead of prompting for a password or overwrite confirmation.\nTTY runs show a progress bar. --json prints exactly one final JSON object to stdout and never prompts.\n",
        )
        .action(async (ufid: string, options: InteractiveFlag & { output?: string; force?: boolean; legacy?: boolean; password?: string; passwordEnv?: string | boolean; passwordStdin?: boolean }) => {
            const interactiveOptions = withGlobalInteractive(options)
            await runJsonAware(interactiveOptions, async () => {
                const { client, session } = await connectAuthorizedClient()
                let progress:
                    | ReturnType<typeof createByteProgressReporter>
                    | undefined
                try {
                    const record = await getFileCardByUfid(client, ufid)
                    const outputPath = interactiveOptions.output ? String(interactiveOptions.output) : defaultOutputPath(record.data.name)

                    if ((await pathExists(outputPath)) && !interactiveOptions.force) {
                        if (!canPrompt(interactiveOptions)) {
                            throw new CliError(
                                "output_exists",
                                `Output path already exists: ${outputPath}. Use --force to overwrite it when prompts are disabled.`,
                                EXIT_CODES.GENERAL_ERROR,
                            )
                        }
                        const overwrite = await promptConfirm(`Overwrite existing file at ${outputPath}?`)
                        if (!overwrite) {
                            throw new CliError("cancelled", "Download cancelled.", EXIT_CODES.GENERAL_ERROR)
                        }
                        interactiveOptions.force = true
                    }

                    const password =
                        (await resolveOptionalPassword({
                            ...interactiveOptions,
                            defaultEnv: "TGLFS_DOWNLOAD_PASSWORD",
                            promptMessage: "File decryption password (leave empty if none)",
                            stdinMessage: "File decryption password is required on stdin.",
                            fallbackValue: "",
                            promptOnInteractive: canPrompt(interactiveOptions),
                        })) ?? ""
                    progress = interactiveOptions.json
                        ? undefined
                        : createByteProgressReporter({
                              label: "Downloading",
                              totalBytes: record.data.size,
                          })
                    progress?.update(0)
                    const result = await downloadFileCard(
                        client,
                        record.data,
                        password,
                        outputPath,
                        Boolean(interactiveOptions.force),
                        ({ bytesWritten }) => progress?.update(bytesWritten),
                        interactiveOptions.legacy ? "legacy" : "current",
                    )
                    progress?.complete()
                    await persistAndDisconnectClient(client, session)

                    return {
                        text: `Downloaded ${result.name} to ${result.outputPath}${interactiveOptions.legacy ? " using the legacy pipeline" : ""}.`,
                        data: result,
                    }
                } catch (error) {
                    progress?.abort()
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    program
        .command("rename")
        .description("Rename a TGLFS file card in Saved Messages.")
        .argument("<ufid>", "TGLFS file UFID")
        .argument("<new-name>", "New file name")
        .option("--json", "Output machine-readable JSON")
        .action(async (ufid: string, newName: string, options: JsonFlag) => {
            await runJsonAware(options, async () => {
                const { client, session } = await connectAuthorizedClient()
                try {
                    const result = await renameFile(client, ufid, newName)
                    await persistAndDisconnectClient(client, session)
                    return {
                        text: `Renamed ${result.before.data.ufid} to ${result.after.data.name}.`,
                        data: result,
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    addInteractiveOption(
        program
            .command("delete")
            .description("Delete one or more owned TGLFS files from Saved Messages.")
            .argument("<ufids...>", "UFID(s) to delete"),
    )
        .option("-y, --yes", "Skip the confirmation prompt")
        .option("--json", "Output machine-readable JSON")
        .action(async (ufids: string[], options: InteractiveFlag & { yes?: boolean }) => {
            const interactiveOptions = withGlobalInteractive(options)
            await runJsonAware(interactiveOptions, async () => {
                const { client, session } = await connectAuthorizedClient()
                try {
                    const records = await resolveFileCardRecords(client, ufids, "me")
                    await confirmDestructiveAction(formatDeleteConfirmation(records), {
                        ...interactiveOptions,
                        force: Boolean(interactiveOptions.yes),
                    })
                    const result = await deleteResolvedFiles(client, records)
                    await persistAndDisconnectClient(client, session)
                    return {
                        text: `Deleted ${result.length} file(s) from Saved Messages.`,
                        data: { count: result.length, files: result },
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    program
        .command("send")
        .description("Send one or more owned TGLFS files to another peer.")
        .argument("<ufids...>", "UFID(s) to send")
        .requiredOption("--to <peer>", "Recipient peer/mailbox")
        .addHelpText("after", `\n${TELEGRAM_PEER_HELP}\n`)
        .option("--json", "Output machine-readable JSON")
        .action(async (ufids: string[], options: JsonFlag & { to: string }) => {
            await runJsonAware(options, async () => {
                const { client, session } = await connectAuthorizedClient()
                try {
                    const result = await sendFiles(client, ufids, options.to)
                    await persistAndDisconnectClient(client, session)
                    return {
                        text: `Sent ${result.length} file(s) to ${options.to}.`,
                        data: { recipient: options.to, count: result.length, files: result },
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    program
        .command("receive")
        .description("Receive one or more TGLFS files from another peer into Saved Messages.")
        .argument("<source>", "Source peer/mailbox to search")
        .argument("<ufids...>", "UFID(s) to receive")
        .addHelpText("after", `\n${TELEGRAM_SOURCE_HELP}\n`)
        .option("--json", "Output machine-readable JSON")
        .action(async (source: string, ufids: string[], options: JsonFlag) => {
            await runJsonAware(options, async () => {
                const { client, session } = await connectAuthorizedClient()
                try {
                    const result = await receiveFiles(client, source, ufids)
                    await persistAndDisconnectClient(client, session)
                    return {
                        text: `Received ${result.length} file(s) from ${source}.`,
                        data: { source, count: result.length, files: result },
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    addInteractiveOption(
        program
            .command("unsend")
            .description("Delete one or more received TGLFS files from another peer mailbox.")
            .argument("<source>", "Source peer/mailbox to search")
            .argument("<ufids...>", "UFID(s) to unsend"),
    )
        .addHelpText("after", `\n${TELEGRAM_SOURCE_HELP}\n`)
        .option("-y, --yes", "Skip the confirmation prompt")
        .option("--json", "Output machine-readable JSON")
        .action(async (source: string, ufids: string[], options: InteractiveFlag & { yes?: boolean }) => {
            const interactiveOptions = withGlobalInteractive(options)
            await runJsonAware(interactiveOptions, async () => {
                await confirmDestructiveAction(`Unsend ${ufids.length} file(s) from ${source}?`, {
                    ...interactiveOptions,
                    force: Boolean(interactiveOptions.yes),
                })
                const { client, session } = await connectAuthorizedClient()
                try {
                    const result = await unsendFiles(client, source, ufids)
                    await persistAndDisconnectClient(client, session)
                    return {
                        text: `Unsent ${result.length} file(s) from ${source}.`,
                        data: { source, count: result.length, files: result },
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    addInteractiveOption(
        program
            .command("inspect")
            .description("Inspect a file card and chunk references. Use --probe for a full current-vs-legacy integrity probe.")
            .argument("<ufid>", "TGLFS file UFID"),
    )
        .option("--peer <peer>", "Peer to inspect instead of Saved Messages")
        .option("--probe", "Run the full current-vs-legacy probe. This downloads, decrypts, and validates file data.")
        .option("--password <password>", "Password to use for current-vs-legacy probing")
        .option("--password-env [name]", "Read the probe password from an environment variable")
        .option("--password-stdin", "Read the probe password from stdin")
        .option("--json", "Output machine-readable JSON")
        .action(async (ufid: string, options: InteractiveFlag & { peer?: string; probe?: boolean; password?: string; passwordEnv?: string | boolean; passwordStdin?: boolean }) => {
            const interactiveOptions = withGlobalInteractive(options)
            await runJsonAware(interactiveOptions, async () => {
                const { client, session } = await connectAuthorizedClient()
                try {
                    const shouldProbe = Boolean(
                        interactiveOptions.probe ||
                            interactiveOptions.password !== undefined ||
                            interactiveOptions.passwordEnv ||
                            interactiveOptions.passwordStdin,
                    )
                    const password =
                        shouldProbe
                            ? await resolveOptionalPassword({
                                  ...interactiveOptions,
                                  defaultEnv: "TGLFS_INSPECT_PASSWORD",
                                  promptMessage: "File probe password (leave empty if none)",
                                  stdinMessage: "File probe password is required on stdin.",
                                  fallbackValue: "",
                                  promptOnInteractive: canPrompt(interactiveOptions),
                              })
                            : undefined
                    const result = await inspectFileCard(client, ufid, {
                        peer: interactiveOptions.peer,
                        password,
                        probe: shouldProbe,
                    })
                    await persistAndDisconnectClient(client, session)
                    return {
                        text: formatInspectResult(result),
                        data: result,
                    }
                } catch (error) {
                    await persistAndDisconnectClient(client, session).catch(() => {})
                    throw error
                }
            })
        })

    return program
}

const TELEGRAM_PEER_HELP = [
    "Peer resolution:",
    "  Peer values are passed directly to Telegram/GramJS entity resolution.",
    "  Users, groups, and channels can all work.",
    "  In practice, use a public username (`alice`, `@alice`, `@mygroup`, `@mychannel`), `me` for Saved Messages,",
    "  or a phone number that your Telegram account can already resolve (typically a saved contact).",
    "  Private chats/groups/channels can also work if Telegram can already resolve them for the current account,",
    "  which usually means the account already has access to that dialog/entity.",
    "  If Telegram cannot resolve the value, the command fails.",
].join("\n")

const TELEGRAM_SOURCE_HELP = [
    TELEGRAM_PEER_HELP,
    "",
    "Source mailbox:",
    "  For `receive` and `unsend`, <source> is the chat/mailbox that currently contains",
    "  the TGLFS file card and chunk messages you want to operate on.",
    "  It is not necessarily the original uploader's personal account.",
].join("\n")

function formatInspectResult(result: Awaited<ReturnType<typeof inspectFileCard>>) {
    const lines = [
        `Peer: ${result.peer === "me" ? "Saved Messages" : result.peer}`,
        `Name: ${result.data.name}`,
        `UFID: ${result.data.ufid}`,
        `Size: ${formatFileCardSize(result.data.size)}`,
        `Date: ${formatFileCardDate(result.date)}`,
        `Message ID: ${result.msgId}`,
        `Status: ${result.data.uploadComplete ? "Complete" : "Incomplete"}`,
        `Format: ${result.format}`,
        `Chunks: ${result.chunks.length}`,
        "",
        "Chunk details:",
        ...result.chunks.map((chunk) => {
            if (chunk.status === "ok") {
                return `  ${chunk.msgId}: ok (${formatFileCardSize(chunk.size ?? 0)})`
            }
            return `  ${chunk.msgId}: ${chunk.status}${chunk.className ? ` (${chunk.className})` : ""}`
        }),
    ]

    if (result.probe) {
        lines.push("")
        lines.push(
            `Probe: ${result.probe.mode} (${formatFileCardSize(result.probe.bytesWritten)} -> ${result.probe.computedUfid})`,
        )
    } else if (result.probeError) {
        lines.push("")
        lines.push(`Probe: ${result.probeError}`)
    }

    return lines.join("\n")
}

async function runInteractiveMenu(program: Command) {
    const choice = await promptSelect("TGLFS action", [
        { title: "Upload", value: "upload", description: "Upload one file or an archive of multiple files." },
        { title: "Login", value: "login", description: "Authenticate and persist the Telegram session." },
        { title: "Status", value: "status", description: "Show current config and auth status." },
        { title: "Search", value: "search", description: "Search TGLFS file cards in Saved Messages." },
        { title: "Download", value: "download", description: "Download a TGLFS file by UFID." },
        { title: "Rename", value: "rename", description: "Rename a file card in Saved Messages." },
        { title: "Delete", value: "delete", description: "Delete files from Saved Messages." },
        { title: "Send", value: "send", description: "Send owned files to another peer." },
        { title: "Receive", value: "receive", description: "Receive files from another peer into Saved Messages." },
        { title: "Unsend", value: "unsend", description: "Delete received files from another peer mailbox." },
        { title: "Inspect", value: "inspect", description: "Inspect a file card. Use --probe for a full format check." },
        { title: "Logout", value: "logout", description: "Remove the saved Telegram session." },
        { title: "Help", value: "help", description: "Show general CLI help." },
        { title: "Exit", value: "exit", description: "Quit without doing anything." },
    ])

    switch (choice) {
        case "upload": {
            const rawPaths = await promptText("File path(s) to upload (comma-separated)")
            const paths = splitCommaSeparatedInput(rawPaths)
            await dispatchInteractiveCommand(program, ["upload", ...paths])
            return
        }
        case "login":
            await dispatchInteractiveCommand(program, ["login"])
            return
        case "status":
            await dispatchInteractiveCommand(program, ["status"])
            return
        case "search": {
            const query = await promptOptionalText("Search query (leave blank to list all)")
            await dispatchInteractiveCommand(program, ["search", ...(query === "" ? [] : [query])])
            return
        }
        case "download": {
            const ufid = await promptText("UFID to download")
            await dispatchInteractiveCommand(program, ["download", ufid])
            return
        }
        case "rename": {
            const ufid = await promptText("UFID to rename")
            const newName = await promptText("New file name")
            await dispatchInteractiveCommand(program, ["rename", ufid, newName])
            return
        }
        case "delete": {
            const rawUfids = await promptText("UFID(s) to delete (comma-separated)")
            const ufids = splitCommaSeparatedInput(rawUfids)
            await dispatchInteractiveCommand(program, ["delete", ...ufids])
            return
        }
        case "send": {
            const rawUfids = await promptText("UFID(s) to send (comma-separated)")
            const recipient = await promptText("Recipient peer")
            const ufids = splitCommaSeparatedInput(rawUfids)
            await dispatchInteractiveCommand(program, ["send", ...ufids, "--to", recipient])
            return
        }
        case "receive": {
            const source = await promptText("Source peer")
            const rawUfids = await promptText("UFID(s) to receive (comma-separated)")
            const ufids = splitCommaSeparatedInput(rawUfids)
            await dispatchInteractiveCommand(program, ["receive", source, ...ufids])
            return
        }
        case "unsend": {
            const source = await promptText("Source peer")
            const rawUfids = await promptText("UFID(s) to unsend (comma-separated)")
            const ufids = splitCommaSeparatedInput(rawUfids)
            await dispatchInteractiveCommand(program, ["unsend", source, ...ufids])
            return
        }
        case "inspect": {
            const ufid = await promptText("UFID to inspect")
            await dispatchInteractiveCommand(program, ["inspect", ufid])
            return
        }
        case "logout":
            await dispatchInteractiveCommand(program, ["logout"])
            return
        case "help":
            program.outputHelp()
            return
        case "exit":
            return
    }
}

export async function main(argv: string[]) {
    const program = createProgram()

    if (argv.length <= 2 && isInteractiveSession()) {
        await runInteractiveMenu(program)
        return
    }

    await program.parseAsync(argv)

    const suppliedArgs = argv.slice(2)
    if (
        suppliedArgs.length > 0 &&
        suppliedArgs.every((arg) => arg.startsWith("-")) &&
        !suppliedArgs.includes("--help") &&
        !suppliedArgs.includes("-h")
    ) {
        program.outputHelp()
    }
}

export async function runEntrypoint(argv: string[]) {
    try {
        await main(argv)
    } catch (error) {
        const cliError = toCliError(error)
        emitFailure(false, cliError)
        process.exit(cliError.exitCode)
    }
}

if (isDirectEntrypoint()) {
    await runEntrypoint(process.argv)
}
