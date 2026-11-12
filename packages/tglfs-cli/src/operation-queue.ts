import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

import { installTelegramOperationQueue } from "./shared/telegram-operation-queue.js"
import { storePaths } from "./store.js"

const FORMAT = "tglfs:operation-cooldown"
const VERSION = 1

export function accountQueueKey(account: string) {
    return createHash("sha256").update(account.trim().toLowerCase()).digest("hex").slice(0, 32)
}

async function processIdentity(pid: number): Promise<string | null> {
    try {
        const value = await readFile(`/proc/${pid}/stat`, "utf8")
        return value.slice(value.lastIndexOf(")") + 2).split(" ")[19] ?? null
    } catch {
        return null
    }
}

function processExists(pid: number) {
    try { process.kill(pid, 0); return true } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

export function createAccountQueueStore(directory: string, account: string) {
    const key = accountQueueKey(account)
    const statePath = join(directory, `${key}.json`)
    const lockPath = join(directory, `${key}.lock`)
    const token = randomUUID()
    const ready = mkdir(directory, { recursive: true, mode: 0o700 })

    async function loadState() {
        await ready
        try {
            const parsed = JSON.parse(await readFile(statePath, "utf8"))
            if (parsed.type !== FORMAT || parsed.version !== VERSION) {
                throw new Error("Unsupported operation cooldown record; queue stopped.")
            }
            if (!parsed.state || typeof parsed.state !== "object") throw new Error("Invalid operation cooldown record; queue stopped.")
            return parsed.state
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw error
        }
    }
    async function saveState(state: unknown) {
        await ready
        const tmp = `${statePath}.${process.pid}.${token}.tmp`
        await writeFile(tmp, JSON.stringify({ type: FORMAT, version: VERSION, state }) + "\n", { mode: 0o600 })
        await rename(tmp, statePath)
    }
    async function exclusive<T>(run: () => Promise<T>): Promise<T> {
        await ready
        for (;;) {
            try {
                await mkdir(lockPath, { mode: 0o700 })
                await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, identity: await processIdentity(process.pid), token }), { mode: 0o600 })
                break
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                try {
                    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))
                    const identity = Number.isInteger(owner.pid) && owner.pid > 0 ? await processIdentity(owner.pid) : null
                    const dead = Number.isInteger(owner.pid) && owner.pid > 0 && (!processExists(owner.pid) || (owner.identity && identity && owner.identity !== identity))
                    if (dead) {
                        // Do not delete a lock based on a racy stale-owner observation.
                        throw new Error("Interrupted operation lock; verify the previous operation before removing the stale lock.")
                    }
                } catch (readError) {
                    if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
                        // The winning process may still be writing owner.json. Never take its lock.
                        const age = Date.now() - (await stat(lockPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs
                        if (age > 30_000) throw new Error("Incomplete operation lock; inspect it before retrying.")
                    } else throw readError
                }
                await delay(250)
            }
        }
        try { return await run() } finally {
            const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))
            if (owner.token === token) await rm(lockPath, { recursive: true, force: true })
        }
    }
    return { loadState, saveState, exclusive, statePath, lockPath }
}

export function formatQueueProgress(snapshot: {
    pending: number; running: boolean; waitUntil: number; paused: boolean; completed: number; failed: number; activeLabel?: string | null
}, now = Date.now()) {
    const remaining = Math.max(0, Math.ceil((snapshot.waitUntil - now) / 1000))
    const state = snapshot.paused ? "Paused" : remaining ? `Waiting ${remaining}s` : snapshot.running ? "Running" : "Queued"
    return `${state} · ${snapshot.completed} done · ${snapshot.pending} pending${snapshot.failed ? ` · ${snapshot.failed} failed` : ""}${snapshot.activeLabel ? ` · ${snapshot.activeLabel}` : ""}`
}

const disposers = new WeakMap<object, () => void>()

export function installCliOperationQueue(client: any, account: string, directory = join(storePaths.dataDir, "operation-queue")) {
    const store = createAccountQueueStore(directory, account)
    let last = ""
    const queue = installTelegramOperationQueue(client, {
        loadState: store.loadState,
        saveState: store.saveState,
        exclusive: store.exclusive,
    })
    const render = () => {
        if (!process.stderr.isTTY) return
        const snapshot = queue.snapshot()
        if (!snapshot.pending && !snapshot.running && !snapshot.paused) return
        const text = formatQueueProgress(snapshot)
        if (text !== last) {
            // New lines avoid corrupting simultaneous byte-progress displays.
            process.stderr.write(`${text}\n`)
            last = text
        }
    }
    const unsubscribe = queue.subscribe(render)
    const timer = setInterval(render, 1000)
    timer.unref()
    disposers.set(client, () => { clearInterval(timer); unsubscribe(); })
    return queue
}

export function disposeCliOperationQueue(client: object) {
    disposers.get(client)?.()
    disposers.delete(client)
}


export async function acquireCliSessionLock(account: string, directory = join(storePaths.dataDir, "session-locks")) {
    const store = createAccountQueueStore(directory, account)
    let ready!: () => void
    let failed!: (error: unknown) => void
    let release!: () => void
    const entered = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    const released = new Promise<void>(resolve => { release = resolve })
    const held = store.exclusive(async () => { ready(); await released })
    held.catch(failed)
    await entered
    return async () => { release(); await held }
}
