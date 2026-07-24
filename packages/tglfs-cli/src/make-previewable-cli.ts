import process from "node:process"
import { Command } from "commander"

import { connectAuthorizedClient, persistAndDisconnectClient } from "./auth.js"
import { CliError, EXIT_CODES, toCliError } from "./errors.js"
import { isInteractiveSession } from "./interactive.js"
import { printJson, printJsonError } from "./json.js"
import { makeMp4Previewable } from "./make-previewable.js"
import { createByteProgressReporter } from "./progress.js"
import { getFileCardByUfid } from "./protocol.js"
import { resolveOptionalPassword } from "./secrets.js"

export const MAKE_PREVIEWABLE_COMMAND_SUMMARY = "  make-previewable [options] <ufid>  Create a new streamable MP4 copy."

type Options = {
    sourcePassword?: string
    sourcePasswordEnv?: string | boolean
    sourcePasswordStdin?: boolean
    password?: string
    passwordEnv?: string | boolean
    passwordStdin?: boolean
    name?: string
    ffmpeg?: string
    ffprobe?: string
    legacy?: boolean
    json?: boolean
    interactive?: boolean
}

function fail(json: boolean | undefined, error: CliError) {
    if (json) printJsonError({ ok: false, error: { code: error.code, message: error.message, details: error.details } })
    else process.stderr.write(`Error: ${error.message}\n`)
    process.exitCode = error.exitCode
}

function createProgram() {
    const program = new Command()
    program
        .name("tglfs make-previewable")
        .description("Create a new streamable/previewable MP4 copy without changing the original.")
        .argument("<ufid>", "UFID of an owned MP4 in Saved Messages")
        .option("--source-password <password>", "Source MP4 decryption password")
        .option("--source-password-env [name]", "Read the source password from an environment variable")
        .option("--source-password-stdin", "Read the source password from stdin")
        .option("--password <password>", "Encryption password for the new MP4")
        .option("--password-env [name]", "Read the new MP4 password from an environment variable")
        .option("--password-stdin", "Read the new MP4 password from stdin")
        .option("--name <name>", "Name for the new file")
        .option("--ffmpeg <path>", "FFmpeg executable", process.env.TGLFS_FFMPEG || "ffmpeg")
        .option("--ffprobe <path>", "ffprobe executable", process.env.TGLFS_FFPROBE)
        .option("--legacy", "Use the legacy source decryption/counter pipeline")
        .option("--no-interactive", "Disable prompts")
        .option("--json", "Output machine-readable JSON")
        .addHelpText("after", [
            "",
            "Front-loaded MP4s stream through FFmpeg directly into the encrypted Telegram upload.",
            "MP4s whose moov metadata follows mdat use a temporary source file for FFmpeg random access.",
            "The original file card and chunks remain unchanged.",
            "",
            "Environment: TGLFS_MAKE_PREVIEWABLE_SOURCE_PASSWORD, TGLFS_MAKE_PREVIEWABLE_PASSWORD,",
            "             TGLFS_FFMPEG, TGLFS_FFPROBE",
            "",
            "FFmpeg must be installed separately.",
        ].join("\n") + "\n")
        .showHelpAfterError()
        .showSuggestionAfterError()

    program.action(async (ufid: string, options: Options) => {
        if (options.sourcePasswordStdin && options.passwordStdin) {
            fail(options.json, new CliError(
                "invalid_argument",
                "--source-password-stdin and --password-stdin cannot be used together; use an environment variable for one password.",
                EXIT_CODES.GENERAL_ERROR,
            ))
            return
        }
        const interactive = options.interactive !== false && !options.json && isInteractiveSession()
        let progress: ReturnType<typeof createByteProgressReporter> | undefined
        let state: Awaited<ReturnType<typeof connectAuthorizedClient>> | undefined
        try {
            const sourcePassword = (await resolveOptionalPassword({
                password: options.sourcePassword,
                passwordEnv: options.sourcePasswordEnv,
                passwordStdin: options.sourcePasswordStdin,
                defaultEnv: "TGLFS_MAKE_PREVIEWABLE_SOURCE_PASSWORD",
                promptMessage: "Source MP4 decryption password (leave empty if none)",
                stdinMessage: "The source MP4 password is required on stdin.",
                fallbackValue: "",
                promptOnInteractive: interactive,
            })) ?? ""
            const uploadPassword = (await resolveOptionalPassword({
                password: options.password,
                passwordEnv: options.passwordEnv,
                passwordStdin: options.passwordStdin,
                defaultEnv: "TGLFS_MAKE_PREVIEWABLE_PASSWORD",
                promptMessage: "New MP4 encryption password (leave empty if none)",
                stdinMessage: "The new MP4 password is required on stdin.",
                fallbackValue: "",
                promptOnInteractive: false,
            })) ?? ""

            state = await connectAuthorizedClient()
            const record = await getFileCardByUfid(state.client, ufid)
            if (!options.json) {
                progress = createByteProgressReporter({ label: "Reading source MP4", totalBytes: record.data.size })
                progress.update(0)
            }
            const result = await makeMp4Previewable(state.client, record, {
                sourcePassword,
                uploadPassword,
                chunkSize: state.config.chunkSize,
                outputName: options.name,
                ffmpegPath: options.ffmpeg,
                ffprobePath: options.ffprobe,
                mode: options.legacy ? "legacy" : "current",
                onProgress: (event) => {
                    if (options.json) return
                    if (event.phase === "convert-upload") {
                        progress?.complete()
                        progress = undefined
                    } else progress?.update(Math.min(record.data.size, event.bytesProcessed))
                },
            })
            progress?.complete()
            await persistAndDisconnectClient(state.client, state.session)
            state = undefined
            if (options.json) printJson({ ok: true, ...result, messageId: result.msgId })
            else process.stdout.write(
                `Created ${result.name} as UFID ${result.ufid} using ${result.stagedSource ? "temporary source staging" : "storage-free source streaming"}; video=${result.videoMode}, audio=${result.audioMode}.\n`,
            )
        } catch (error) {
            progress?.abort()
            if (state) await persistAndDisconnectClient(state.client, state.session).catch(() => {})
            fail(options.json, toCliError(error))
        }
    })
    return program
}

export async function runMakePreviewableCli(args: string[]) {
    await createProgram().parseAsync(args, { from: "user" })
}
