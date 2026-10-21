import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises"
import { Command } from "commander"
import { HelperStore } from "./store.js"
import { runHelperDaemon } from "./daemon.js"
import { HELPER_DEFAULT_PORT, helperPairingCode, helperRequest } from "../shared/helper-wire.js"
import { parseHelperProcess } from "./protocol.js"
import type { HelperConfig } from "./protocol.js"

export function createHelperCommand() {
    const command = new Command("helper").description("Run local transfers independently of the browser tab.")
    command
        .command("start")
        .description("Start the local helper; pair it in the app's Background transfers panel.")
        .option(
            "--upload-root <directory>",
            "Grant read access to one upload folder (repeatable)",
            (value, all: string[]) => [...all, value],
            [],
        )
        .option("--download-dir <directory>", "Save completed downloads under this folder")
        .option(
            "--origin <origin>",
            "Allow a web app origin (repeatable; default https://tglfs.vercel.app)",
            (value, all: string[]) => [...all, value],
            [],
        )
        .option("--port <port>", "Loopback port")
        .option("--foreground", "Run in this terminal instead of detaching")
        .action(async (options) => {
            const store = new HelperStore()
            const prior = await store.config()
            if (prior) {
                try {
                    await helperRequest(prior, "/v1/status", undefined, { signal: AbortSignal.timeout(1000) })
                    throw new Error(
                        "The helper is already running. Stop it before changing permissions; use tglfs helper pair to reconnect.",
                    )
                } catch (error) {
                    if (error instanceof Error && error.message.startsWith("The helper is already")) throw error
                }
            }
            try {
                const record = parseHelperProcess(
                    JSON.parse(await readFile(join(store.directory, "process.json"), "utf8")),
                )
                try {
                    process.kill(record.pid, 0)
                    throw new Error("The helper process is still running. Stop it before changing its configuration.")
                } catch (error: any) {
                    if (error.code !== "ESRCH") throw error
                }
            } catch (error: any) {
                if (error.code !== "ENOENT") throw error
            }
            const roots = options.uploadRoot.length
                ? await Promise.all(options.uploadRoot.map((p: string) => realpath(resolve(p))))
                : prior?.uploadRoots ?? []
            for (const root of roots)
                if (!(await stat(root)).isDirectory()) throw new Error("Each upload root must be a directory.")
            const downloads = resolve(
                options.downloadDir ?? prior?.downloadDir ?? join(homedir(), "Downloads", "TGLFS"),
            )
            await mkdir(downloads, { recursive: true, mode: 0o700 })
            const config: HelperConfig = {
                type: "tglfs:helper-config",
                version: 1,
                port: options.port ? Number(options.port) : prior?.port ?? HELPER_DEFAULT_PORT,
                token: randomBytes(32).toString("base64url"),
                origins: options.origin.length ? options.origin : prior?.origins ?? ["https://tglfs.vercel.app"],
                uploadRoots: [...new Set(roots)] as string[],
                downloadDir: await realpath(downloads),
            }
            await store.saveConfig(config)
            if (options.foreground) {
                process.stdout.write(`Pairing code: ${helperPairingCode(config)}\n`)
                await runHelperDaemon()
                return
            }
            const { helperIdentity } = await import("./executor.js")
            await helperIdentity()
            const log = await open(join(store.directory, "helper.log"), "a", 0o600)
            const entry = fileURLToPath(new URL("../cli.js", import.meta.url))
            const child = spawn(process.execPath, [entry, "helper", "run"], {
                detached: true,
                windowsHide: true,
                stdio: ["ignore", log.fd, log.fd],
            })
            child.unref()
            await log.close()
            let ready = false
            for (let attempt = 0; attempt < 40; attempt++) {
                try {
                    await helperRequest(config, "/v1/status", undefined, { signal: AbortSignal.timeout(500) })
                    ready = true
                    break
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 250))
            }
            if (!ready)
                throw new Error(
                    `The helper did not start. Check ${join(store.directory, "helper.log")} and run tglfs login if needed.`,
                )
            process.stdout.write(`Background helper started. Pair in TGLFS using:\n${helperPairingCode(config)}\n`)
        })
    command.command("run", { hidden: true }).action(async () => {
        try {
            await runHelperDaemon()
        } catch {
            process.stderr.write(
                "The helper could not run. Check Telegram login, granted folders, helper version, and whether another helper is running.\n",
            )
            process.exitCode = 1
        }
    })
    command
        .command("pair")
        .description("Show the pairing code for the running helper.")
        .action(async () => {
            const config = await new HelperStore().config()
            if (!config) throw new Error("Start the helper first.")
            await helperRequest(config, "/v1/status", undefined, { signal: AbortSignal.timeout(2000) })
            process.stdout.write(`${helperPairingCode(config)}\n`)
        })
    command
        .command("status")
        .description("Show helper transfers; no file passwords are stored.")
        .option("--json", "Print JSON")
        .action(async (options) => {
            const config = await new HelperStore().config()
            if (!config) throw new Error("Start the helper first.")
            const status = await helperRequest(config, "/v1/status", undefined, { signal: AbortSignal.timeout(2000) })
            process.stdout.write(
                options.json
                    ? `${JSON.stringify(status)}\n`
                    : `Helper running; ${status.jobs.length} recent transfers.\n${status.jobs.map((j: any) => `${j.id}  ${j.status}  ${j.name}`).join("\n")}\n`,
            )
        })
    command
        .command("stop")
        .description("Stop the helper, preserving resumable checkpoints and clearing in-memory passwords.")
        .action(async () => {
            const config = await new HelperStore().config()
            if (!config) throw new Error("No helper is configured.")
            const state = await helperRequest(config, "/v1/status", undefined, { signal: AbortSignal.timeout(2000) })
            await helperRequest(
                config,
                "/v1/stop",
                { type: "tglfs:helper-request", version: 1, accountId: state.accountId },
                { signal: AbortSignal.timeout(2000) },
            )
            process.stdout.write("Helper stopping. Interrupted transfers can be unlocked and resumed after restart.\n")
        })
    command.addHelpText(
        "after",
        "\nRun tglfs login once before starting. Upload roots are explicit read grants; no upload folders are exposed by default. The helper uses existing file protocols, never remembers file passwords, and keeps running after disconnecting or closing the web app. File selection and download destinations belong to this computer. The computer and helper must remain running.\n",
    )
    return command
}
