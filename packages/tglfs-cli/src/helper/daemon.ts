import { open, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { HelperStore } from "./store.js"
import type { JobExecutor } from "./queue.js"
import type { HelperConfig } from "./protocol.js"
import { HelperQueue } from "./queue.js"
import { createJobExecutor, helperIdentity } from "./executor.js"
import { parseHelperProcess } from "./protocol.js"
import { createHelperServer } from "./server.js"

export async function runHelperDaemon(
    directory?: string,
    dependencies: { identity?: () => Promise<string>; executor?: (config: HelperConfig) => JobExecutor } = {},
) {
    const store = new HelperStore(directory)
    await store.initialize()
    const config = await store.config()
    if (!config) throw new Error("Configure the helper first with tglfs helper start.")
    const lockPath = join(store.directory, "process.json")
    let lock: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 2 && !lock; attempt++) {
        try {
            lock = await open(lockPath, "wx", 0o600)
            await lock.writeFile(JSON.stringify({ type: "tglfs:helper-process", version: 1, pid: process.pid }))
        } catch (e: any) {
            if (e.code !== "EEXIST" || attempt) throw e
            const prior = parseHelperProcess(JSON.parse(await readFile(lockPath, "utf8")))
            if (
                prior.type !== "tglfs:helper-process" ||
                prior.version !== 1 ||
                !Number.isSafeInteger(prior.pid) ||
                prior.pid <= 0
            )
                throw new Error("Unsupported helper process record. It was preserved.")
            try {
                process.kill(prior.pid, 0)
                throw new Error("The helper is already running.")
            } catch (err: any) {
                if (err.code !== "ESRCH") throw err
            }
            await rm(lockPath)
        }
    }
    if (!lock) throw new Error("The helper process could not be locked.")
    let queue: HelperQueue | undefined, server: ReturnType<typeof createHelperServer> | undefined
    let finish!: () => void
    const closing = new Promise<void>((resolve) => {
        finish = resolve
    })
    let stopping = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
        if (stopping) return
        stopping = true
        deadline = setTimeout(() => process.exit(0), 10000)
        deadline.unref()
        server?.close()
        finish()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    try {
        const accountId = await (dependencies.identity ?? helperIdentity)()
        queue = new HelperQueue(store, accountId, (dependencies.executor ?? createJobExecutor)(config))
        await queue.initialize()
        if (stopping) return
        server = createHelperServer(config, queue, { stop })
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(config.port, "127.0.0.1", resolve)
        })
        await closing
    } finally {
        process.removeListener("SIGINT", stop)
        process.removeListener("SIGTERM", stop)
        server?.close()
        await queue?.stop()
        clearTimeout(deadline)
        await lock.close()
        await rm(lockPath, { force: true })
    }
}
