import process from "node:process"
import { Command } from "commander"
import { connectAuthorizedClient, persistAndDisconnectClient } from "./auth.js"
import { convertWebm } from "./convert-webm.js"
import { toCliError } from "./errors.js"
import { isInteractiveSession } from "./interactive.js"
import { printJson, printJsonError } from "./json.js"
import { getFileCardByUfid } from "./protocol.js"
import { resolveOptionalPassword } from "./secrets.js"

export function createConvertWebmCommand() {
    const program = new Command()
        .name("convert-webm")
        .description("Create a separate VP9/Opus WebM copy with the source password and sampled quality checks, without temporary video files.")
        .argument("<ufid>", "Owned MP4, MOV, M4V, MKV or WebM UFID")
        .option("--source-password <password>", "Source and new copy encryption password")
        .option("--source-password-env [name]", "Read the password from an environment variable")
        .option("--source-password-stdin", "Read the password from stdin")
        .option("--name <name>", "New file name ending in .webm")
        .option("--ffmpeg <path>", "FFmpeg 8+ executable with libvpx-vp9, libopus, SSIM and loopback decoders", process.env.TGLFS_FFMPEG || "ffmpeg")
        .option("--ffprobe <path>", "Matching ffprobe executable", process.env.TGLFS_FFPROBE)
        .option("--no-interactive", "Disable password prompts")
        .option("--json", "Print the result and per-clip quality report as JSON")
        .addHelpText("after", "\nThe original is kept. The new copy uses the same password (including an empty password), with fresh encryption randomness.\nMP4/MOV metadata must precede media data. Seeking, HDR, high bit depth, alpha, interlacing, rotation, extra tracks, and unsupported audio are refused.\nA bounded metadata prefix is inspected first, then the source is streamed from the start for conversion and complete UFID verification. No video is staged on disk.\nBeginning, middle and end clips of the actual encoded output are decoded and compared at full resolution. Every clip requires luma SSIM >= 0.98 before publication. This is sampled evidence, not a guarantee for every frame or audio quality.\nResolution and frame timing are kept. Audio becomes mono/stereo Opus at 48 kHz. Streaming WebM duration/seeking may be limited.\nEnvironment: TGLFS_WEBM_PASSWORD, TGLFS_FFMPEG, TGLFS_FFPROBE.\n")
        .showHelpAfterError()
    program.action(async (ufid, options) => {
        let state: Awaited<ReturnType<typeof connectAuthorizedClient>> | undefined
        const abort = new AbortController()
        const cancel = () => abort.abort(new Error("WebM conversion cancelled."))
        process.once("SIGINT", cancel)
        process.once("SIGTERM", cancel)
        try {
            const password = await resolveOptionalPassword({
                password: options.sourcePassword, passwordEnv: options.sourcePasswordEnv, passwordStdin: options.sourcePasswordStdin,
                defaultEnv: "TGLFS_WEBM_PASSWORD", promptMessage: "Video password (leave empty if none)",
                stdinMessage: "A password is required on stdin.", fallbackValue: "",
                promptOnInteractive: options.interactive !== false && program.parent?.opts().interactive !== false && !options.json && isInteractiveSession(),
            }) ?? ""
            state = await connectAuthorizedClient()
            const record = await getFileCardByUfid(state.client, ufid)
            let lastPhase = ""
            const result = await convertWebm(state.client, record, {
                sourcePassword: password, chunkSize: state.config.chunkSize, outputName: options.name,
                ffmpegPath: options.ffmpeg, ffprobePath: options.ffprobe, signal: abort.signal,
                onProgress(phase) {
                    if (options.json || phase === lastPhase) return
                    lastPhase = phase
                    process.stderr.write(`${phase}…\n`)
                },
            })
            if (options.json) printJson({ ok: true, ...result })
            else process.stdout.write(`Created ${result.data.name} as UFID ${result.data.ufid}. Original kept; password preserved. Sampled clip SSIM: ${result.quality.clips.map(c => c.ssim.toFixed(4)).join(", ")}.\n${result.quality.scope}\n`)
        } catch (error) {
            const failure = toCliError(error)
            if (options.json) printJsonError({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } })
            else process.stderr.write(`Error: ${failure.message}\n`)
            process.exitCode = failure.exitCode
        } finally {
            if (state) await persistAndDisconnectClient(state.client, state.session)
            process.removeListener("SIGINT", cancel)
            process.removeListener("SIGTERM", cancel)
        }
    })
    return program
}
