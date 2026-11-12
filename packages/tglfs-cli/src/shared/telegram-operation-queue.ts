
/** Only an explicit Telegram wait rejection makes replay safe. Generic timeouts do not. */
function explicitTelegramWaitSeconds(error: unknown): number | null {
    if (!error || typeof error !== "object") return null
    const value = error as { errorMessage?: unknown; name?: unknown; seconds?: unknown }
    const code = typeof value.errorMessage === "string" ? value.errorMessage : ""
    const encoded = /^(?:FLOOD(?:_PREMIUM|_TEST_PHONE)?_WAIT|SLOWMODE_WAIT)_(\d+)$/.exec(code)
    if (encoded) {
        const seconds = Number(encoded[1])
        return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null
    }
    const knownCode = /^(?:FLOOD(?:_PREMIUM|_TEST_PHONE)?_WAIT|SLOWMODE_WAIT)$/.test(code)
    const knownName = /^(?:FloodWaitError|FloodPremiumWaitError|FloodTestPhoneWaitError|SlowModeWaitError)$/.test(String(value.name ?? ""))
    return (knownCode || knownName) && typeof value.seconds === "number" && Number.isSafeInteger(value.seconds) && value.seconds >= 0
        ? value.seconds : null
}

/** Local pacing state only. Never contains credentials, file bytes, or replayable mutations. */
export type PersistedState = {
    type: "tglfs:operation-pacing"
    version: 1
    waitUntil: number
    nextMutationAt: number
    adaptiveIntervalMs: number
}
export type QueueSnapshot = {
    pending: number
    running: boolean
    waitUntil: number
    paused: boolean
    completed: number
    failed: number
    activeLabel: string | null
}
export type QueueOptions = {
    loadState?: () => Promise<PersistedState | null>
    saveState?: (state: PersistedState) => Promise<void>
    exclusive?: <T>(run: () => Promise<T>) => Promise<T>
    onChange?: (snapshot: QueueSnapshot) => void
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    intervalMs?: number
    uploadIntervalMs?: number
    floodPaddingMs?: number
    maxFloodRetries?: number
}
export class QueueCancelledError extends Error {
    constructor() { super("Queued operation cancelled"); this.name = "QueueCancelledError" }
}
type Item = { run: () => Promise<any>; label: string; upload: boolean; resolve: (value: any) => void; reject: (error: unknown) => void }

export class TelegramOperationQueue {
    private items: Item[] = []
    private listeners = new Set<(state: QueueSnapshot) => void>()
    private running = false
    private paused = false
    private halted: unknown = null
    private completed = 0
    private failed = 0
    private activeLabel: string | null = null
    private state: PersistedState
    private clock: () => number
    private delay: (ms: number) => Promise<void>
    private interval: number
    constructor(private options: QueueOptions = {}) {
        this.clock = options.now ?? Date.now
        this.delay = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
        this.interval = options.intervalMs ?? 1500
        this.state = { type: "tglfs:operation-pacing", version: 1, waitUntil: 0, nextMutationAt: 0, adaptiveIntervalMs: this.interval }
    }
    snapshot(): QueueSnapshot {
        return { pending: this.items.length, running: this.running, waitUntil: Math.max(this.state.waitUntil, this.state.nextMutationAt), paused: this.paused, completed: this.completed, failed: this.failed, activeLabel: this.activeLabel }
    }
    subscribe(listener: (state: QueueSnapshot) => void): () => void {
        this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener) }
    }
    private emit() {
        const snapshot = this.snapshot()
        for (const listener of this.listeners) { try { listener(snapshot) } catch { /* UI must not alter execution */ } }
        try { this.options.onChange?.(snapshot) } catch { /* reporting must not alter execution */ }
    }
    pause() { this.paused = true; this.emit() }
    resume() { this.halted = null; this.paused = false; this.emit(); void this.drain() }
    cancelPending() {
        for (const item of this.items.splice(0)) item.reject(new QueueCancelledError())
        this.emit()
    }
    enqueue<T>(run: () => Promise<T>, label = "Working", upload = false): Promise<T> {
        if (this.halted) return Promise.reject(new Error("Queue stopped; review the failed operation before resuming"))
        return new Promise<T>((resolve, reject) => { this.items.push({run, label, upload, resolve, reject}); this.emit(); void this.drain() })
    }
    private async restore() {
        const saved = await this.options.loadState?.()
        if (!saved) return
        if (saved.type !== "tglfs:operation-pacing" || saved.version !== 1 || ![saved.waitUntil, saved.nextMutationAt, saved.adaptiveIntervalMs].every(Number.isFinite)) throw new Error("Unsupported operation pacing state")
        this.state.waitUntil = Math.max(this.state.waitUntil, saved.waitUntil)
        this.state.nextMutationAt = Math.max(this.state.nextMutationAt, saved.nextMutationAt)
        this.state.adaptiveIntervalMs = Math.max(this.interval, this.state.adaptiveIntervalMs, saved.adaptiveIntervalMs)
    }
    private async persist() { await this.options.saveState?.({...this.state}) }
    private async waitReady() {
        for (;;) {
            const remaining = Math.max(this.state.waitUntil, this.state.nextMutationAt) - this.clock()
            if (!this.paused && remaining <= 0) return
            this.emit()
            await this.delay(this.paused ? 200 : Math.min(remaining, 500))
        }
    }
    private async execute(item: Item) {
        await this.restore()
        let floods = 0
        for (;;) {
            await this.waitReady()
            // Reserve spacing before dispatch, so a crash never loses the cooldown.
            const interval = item.upload ? Math.max(this.options.uploadIntervalMs ?? 100, this.state.adaptiveIntervalMs / 15) : this.state.adaptiveIntervalMs
            this.state.nextMutationAt = this.clock() + interval
            await this.persist()
            try { return await item.run() }
            catch (error) {
                const seconds = explicitTelegramWaitSeconds(error)
                if (seconds !== null) {
                    this.state.waitUntil = Math.max(this.state.waitUntil, this.clock() + seconds * 1000 + (this.options.floodPaddingMs ?? 1000))
                    this.state.adaptiveIntervalMs = Math.min(60_000, Math.max(this.interval, this.state.adaptiveIntervalMs * 2))
                    await this.persist(); this.emit()
                    if (++floods <= (this.options.maxFloodRetries ?? 5)) continue
                    throw new Error("Telegram wait retry limit reached; queue stopped")
                }
                // No replay on transport/server/permission failures: mutation may have executed.
                this.paused = true
                throw error
            }
        }
    }
    private async drain() {
        if (this.running || this.paused) return
        this.running = true
        try {
            while (this.items.length && !this.paused) {
                const item = this.items.shift()!
                this.activeLabel = item.label; this.emit()
                try {
                    const result = await (this.options.exclusive ? this.options.exclusive(() => this.execute(item)) : this.execute(item))
                    this.completed++; item.resolve(result)
                } catch (error) {
                    this.failed++; this.paused = true; this.halted = error; item.reject(error)
                    // Fail closed. Higher-level jobs can surface their partial completion.
                    for (const pending of this.items.splice(0)) pending.reject(new Error("Queue stopped; review the failed operation before retrying"))
                }
            }
        } finally { this.running = false; this.activeLabel = null; this.emit() }
    }
}

export function telegramMutationLabel(request: any): string | null {
    const name = String(request?.className ?? request?.constructor?.className ?? "")
    if (/^upload\.Save(?:Big)?FilePart$/.test(name)) return "Uploading"
    if (/^(?:messages|channels)\.(?:Send|Edit|Delete|Forward|Upload|Save|Create|Import|Toggle|Update)/.test(name)) {
        if (name.includes("Delete")) return "Deleting"
        if (name.includes("Edit")) return "Editing"
        if (name.includes("Forward")) return "Moving"
        return "Saving"
    }
    return null
}
const queues = new WeakMap<object, TelegramOperationQueue>()
export function getTelegramOperationQueue(client: object): TelegramOperationQueue | undefined { return queues.get(client) }
export function installTelegramOperationQueue<T extends { invoke: (...args: any[]) => Promise<any>; invokeWithSender?: (...args: any[]) => Promise<any>; floodSleepThreshold?: number; getSender?: (...args: any[]) => Promise<any> }>(client: T, options: QueueOptions = {}): TelegramOperationQueue {
    const existing = queues.get(client)
    if (existing) return existing
    const queue = new TelegramOperationQueue(options)
    // Install only after authentication: login/DC migration needs GramJS retries.
    // Once authenticated, never let GramJS replay an uncertain mutation internally.
    if ("_requestRetries" in client) (client as any)._requestRetries = 1
    client.floodSleepThreshold = 0
    const wrap = (original: (...args: any[]) => Promise<any>) => (...args: any[]) => {
        const label = telegramMutationLabel(args[0])
        return label ? queue.enqueue(() => original(...args), label, label === "Uploading") : original(...args)
    }
    client.invoke = wrap(client.invoke.bind(client))
    if (client.invokeWithSender) client.invokeWithSender = wrap(client.invokeWithSender.bind(client))
    // GramJS uploadFile bypasses invoke and sends media chunks through getSender().
    // Wrap that exact path too, without wrapping sender internals used by invoke.
    if (client.getSender) {
        const getSender = client.getSender.bind(client)
        const senders = new WeakSet<object>()
        client.getSender = async (...args: any[]) => {
            const sender = await getSender(...args)
            if (sender && typeof sender.send === "function" && !senders.has(sender)) {
                const send = sender.send.bind(sender)
                sender.send = (request: any) => telegramMutationLabel(request) === "Uploading"
                    ? queue.enqueue(() => send(request), "Uploading", true) : send(request)
                senders.add(sender)
            }
            return sender
        }
    }
    queues.set(client, queue)
    return queue
}
