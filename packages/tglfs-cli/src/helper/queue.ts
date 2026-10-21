import { parseHelperJob } from "./protocol.js"
import type { HelperJob } from "./protocol.js"
import type { HelperStore } from "./store.js"
export type JobExecution = {
    password: string
    signal: AbortSignal
    progress(phase: string, bytes: number, total: number): void
    session(id: string): Promise<void>
}
export type JobExecutor = (job: HelperJob, options: JobExecution) => Promise<NonNullable<HelperJob["result"]>>
export class HelperQueue {
    private records = new Map<string, HelperJob>()
    private passwords = new Map<string, string>()
    private active: { id: string; controller: AbortController } | null = null
    private running: Promise<void> | null = null
    private stopping = false
    private changing = Promise.resolve()
    private change<T>(action: () => Promise<T>): Promise<T> {
        const result = this.changing.then(action)
        this.changing = result.then(
            () => {},
            () => {},
        )
        return result
    }
    constructor(
        readonly store: HelperStore,
        readonly accountId: string,
        readonly execute: JobExecutor,
    ) {}
    async initialize() {
        for (const job of await this.store.jobs()) {
            if (job.accountId !== this.accountId)
                throw new Error(
                    "The helper queue belongs to another Telegram account. Use its original account or a separate helper directory.",
                )
            if (["queued", "running"].includes(job.status)) {
                job.status = "needs-password"
                job.phase = "Unlock to resume"
                job.updatedAt = Date.now()
                await this.store.saveJob(job)
            }
            this.records.set(job.id, job)
        }
    }
    list() {
        return [...this.records.values()].map((j) => structuredClone(j)).sort((a, b) => b.createdAt - a.createdAt)
    }
    async add(job: HelperJob, password: string) {
        return this.change(async () => {
            if (this.stopping || job.accountId !== this.accountId)
                throw new Error("The helper is stopping or the Telegram account does not match.")
            const prior = this.records.get(job.id)
            if (prior) {
                const spec = (j: HelperJob) =>
                    JSON.stringify([
                        j.accountId,
                        j.direction,
                        j.name,
                        j.size,
                        j.sources,
                        j.parentFolderId,
                        j.messageId,
                        j.direction === "download" ? j.ufid : undefined,
                        j.fileVersion,
                        j.outputPath,
                    ])
                if (spec(prior) !== spec(job))
                    throw new Error("The helper request identity was already used for another transfer.")
                return structuredClone(prior)
            }
            if (this.list().filter((j) => !["done", "cancelled"].includes(j.status)).length >= 200)
                throw new Error("The helper has 200 unfinished transfers. Finish or cancel some before adding more.")
            parseHelperJob(job)
            await this.store.saveJob(job)
            this.records.set(job.id, job)
            this.passwords.set(job.id, password)
            this.kick()
            return structuredClone(job)
        })
    }
    async unlock(id: string, password: string) {
        return this.change(async () => {
            const job = this.records.get(id)
            if (!job || !["needs-password", "failed"].includes(job.status) || this.stopping)
                throw new Error("This transfer cannot be resumed now.")
            job.status = "queued"
            job.error = undefined
            job.phase = "Queued"
            job.updatedAt = Date.now()
            await this.store.saveJob(job)
            this.passwords.set(id, password)
            this.kick()
            return structuredClone(job)
        })
    }
    async cancel(id: string) {
        return this.change(async () => {
            const job = this.records.get(id)
            if (!job || ["done", "cancelled"].includes(job.status)) return
            if (this.active?.id === id) this.active.controller.abort(new Error("Transfer cancelled."))
            else {
                job.status = "cancelled"
                job.phase = "Cancelled"
                this.passwords.delete(id)
                await this.store.saveJob(job)
            }
        })
    }
    private kick() {
        if (this.running || this.stopping) return
        this.running = this.drain()
            .catch(() => {
                // Stop scheduling if a durable queue update fails.
                this.stopping = true
                this.passwords.clear()
                this.active = null
                for (const job of this.records.values())
                    if (!["done", "cancelled"].includes(job.status)) {
                        job.status = "needs-password"
                        job.phase = "Restart helper"
                        job.error =
                            "The helper could not save its queue. Check disk access, restart it, and unlock this transfer."
                    }
            })
            .finally(() => {
                this.running = null
                if (!this.stopping && this.list().some((j) => j.status === "queued")) this.kick()
            })
    }
    private async drain() {
        for (const job of this.records.values()) {
            if (this.stopping) return
            if (job.status !== "queued" || !this.passwords.has(job.id)) continue
            const controller = new AbortController()
            this.active = { id: job.id, controller }
            job.status = "running"
            job.phase = "Connecting"
            job.updatedAt = Date.now()
            await this.store.saveJob(job)
            try {
                const result = await this.execute(job, {
                    password: this.passwords.get(job.id)!,
                    signal: controller.signal,
                    progress: (phase, bytes, total) => {
                        job.phase = phase
                        job.bytes = Math.max(0, Math.floor(bytes))
                        job.total = Math.max(0, Math.floor(total))
                        job.updatedAt = Date.now()
                    },
                    session: async (id) => {
                        job.uploadSessionId = id
                        await this.store.saveJob(job)
                    },
                })
                job.result = result
                job.ufid = result.ufid
                job.status = "done"
                job.phase = "Done"
                job.bytes = job.size
                job.total = job.size
            } catch (error) {
                job.status = this.stopping ? "needs-password" : controller.signal.aborted ? "cancelled" : "failed"
                job.phase = this.stopping ? "Unlock to resume" : controller.signal.aborted ? "Cancelled" : "Interrupted"
                // Library errors may contain request details, so the persisted message is fixed.
                job.error = controller.signal.aborted
                    ? undefined
                    : "Transfer interrupted. Unlock it to retry with its saved checkpoints."
            } finally {
                this.passwords.delete(job.id)
                this.active = null
                job.updatedAt = Date.now()
                await this.store.saveJob(job)
            }
        }
    }
    async idle() {
        await this.running
    }
    async stop() {
        this.stopping = true
        await this.changing
        this.active?.controller.abort(new Error("Helper stopped."))
        await this.running
        for (const job of this.records.values())
            if (job.status === "queued") {
                job.status = "needs-password"
                job.phase = "Unlock to resume"
                await this.store.saveJob(job)
            }
        this.passwords.clear()
    }
}
