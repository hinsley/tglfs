import process from "node:process"
import { Command } from "commander"
import { connectAuthorizedClient, persistAndDisconnectClient } from "./auth.js"
import { upgradeMediaPreview } from "./media-upgrade.js"
import { getFileCardByUfid } from "./protocol.js"
import { isInteractiveSession } from "./interactive.js"
import { resolveOptionalPassword } from "./secrets.js"
import { toCliError } from "./errors.js"
import { printJson, printJsonError } from "./json.js"

export function createUpgradeMediaPreviewCommand() {
    const command = new Command("upgrade-media-preview")
        .description("Create an indexed preview copy of stored MP4/WebM media, keeping the original and its password.")
        .argument("<ufid>", "Owned MP4/WebM UFID")
        .option("--password <password>", "Source and copy password")
        .option("--password-env [name]", "Read the password from an environment variable")
        .option("--password-stdin", "Read the password from stdin")
        .option("--no-interactive", "Disable password prompts")
        .option("--json", "Print machine-readable JSON")
        .addHelpText(
            "after",
            "\nCopies supported fragmented MP4 or WebM bytes into file-card v5 with media-preview v1 and an encrypted media-index v1. It never changes the original card or chunks, quality, or password. No temporary video files are created. Unindexable layouts are refused; make a new MP4 or WebM preview copy instead.\nEnvironment: TGLFS_MEDIA_PASSWORD.\n",
        )
    command.action(async (ufid, options) => {
        let state: Awaited<ReturnType<typeof connectAuthorizedClient>> | undefined
        const abort = new AbortController()
        const cancel = () => abort.abort(new Error("Media preview upgrade cancelled."))
        process.once("SIGINT", cancel)
        process.once("SIGTERM", cancel)
        try {
            const password =
                (await resolveOptionalPassword({
                    ...options,
                    defaultEnv: "TGLFS_MEDIA_PASSWORD",
                    promptMessage: "Video password (leave empty if none)",
                    stdinMessage: "A password is required on stdin.",
                    fallbackValue: "",
                    promptOnInteractive:
                        options.interactive !== false &&
                        command.parent?.opts().interactive !== false &&
                        !options.json &&
                        isInteractiveSession(),
                })) ?? ""
            state = await connectAuthorizedClient()
            const source = await getFileCardByUfid(state.client, ufid)
            const record = await upgradeMediaPreview(state.client, source, { password, signal: abort.signal })
            if (options.json) printJson({ ok: true, ...record, originalRetained: true, passwordPreserved: true })
            else
                process.stdout.write(
                    `Created ${record.data.name} as UFID ${record.data.ufid}. Original kept; password preserved.\n`,
                )
        } catch (error) {
            const failure = toCliError(error)
            if (options.json)
                printJsonError({
                    ok: false,
                    error: { code: failure.code, message: failure.message, details: failure.details },
                })
            else process.stderr.write(`Error: ${failure.message}\n`)
            process.exitCode = failure.exitCode
        } finally {
            if (state) await persistAndDisconnectClient(state.client, state.session)
            process.removeListener("SIGINT", cancel)
            process.removeListener("SIGTERM", cancel)
        }
    })
    return command
}
