/**
 * Transfer queue: the single source of truth for long-running uploads, downloads and background tasks.
 *
 * This module is DOM-free so it can be imported by `src/telegram.ts` (which Node tests import). The tray UI in
 * `transferTray.ts` is just one subscriber; other features (wake lock, notifications, resumable uploads) can
 * subscribe to the same lifecycle events.
 *
 * Usage:
 *
 *     // Queued work (uploads/downloads): runs one at a time, in order. Ask for passwords/confirmations BEFORE
 *     // calling `enqueue` so the queue never waits on a dialog.
 *     await Transfers.enqueue({ direction: "upload", name, size }, async (t) => {
 *         t.setPhase("Preparing", { span: [0, 0.05], total: size })
 *         ...
 *         t.setPhase(null, { span: [0.05, 1], total: size })
 *         for (...) { t.throwIfCancelled(); ...; t.update({ bytes }) }
 *         t.complete({ ufid })
 *     })
 *
 *     // Background tasks that must not block the queue (e.g. the folder-index migration):
 *     const t = Transfers.begin({ direction: "task", name: "Migrating folder index", queue: false })
 *     t.update({ bytes: done, total, detail: "…" }); t.complete({ message: "…" }) / t.fail(error)
 *
 * Lifecycle events (see `subscribe`): "added", "started", "progress", "finished", "removed", "busy".
 */

export type TransferDirection = "upload" | "download" | "task"
export type TransferStatus = "queued" | "active" | "done" | "failed" | "cancelled"
export type TransferUnit = "bytes" | "items" | "percent"
export type TransferTone = "success" | "warning"

export type TransferSnapshot = {
    readonly id: string
    readonly direction: TransferDirection
    readonly name: string
    readonly status: TransferStatus
    /** True when the transfer occupies the one-at-a-time queue lane. */
    readonly queued: boolean
    /** Lane batch number: a new batch starts whenever a lane transfer is added while the lane is idle. */
    readonly batch: number
    /** Size of the whole item in bytes (for "Queued · 700 MiB" / "Done · 700 MiB"); 0 when unknown. */
    readonly size: number
    /** Label of the current phase; `null` means the primary transfer phase (shown as "x of y · time left"). */
    readonly phase: string | null
    /** Progress within the current phase, in `unit`. */
    readonly bytes: number
    readonly total: number
    readonly unit: TransferUnit
    /** Overall progress across all phases, 0..1. */
    readonly fraction: number
    /** Estimated seconds left in the current phase, when known. */
    readonly etaSeconds: number | null
    /** Extra secondary text (e.g. task counters). */
    readonly detail: string | null
    readonly cancellable: boolean
    readonly cancelRequested: boolean
    readonly createdAt: number
    readonly startedAt: number | null
    readonly finishedAt: number | null
    /** Completion message (done) or error message (failed). */
    readonly message: string | null
    readonly tone: TransferTone | null
    /** UFID of the uploaded/downloaded file, when known (enables "Copy UFID"). */
    readonly ufid: string | null
    /** Free-form metadata captured at enqueue time (e.g. `{ parentFolderId }`). */
    readonly meta: Readonly<Record<string, unknown>>
}

export type TransferEvent =
    | { type: "added" | "started" | "progress" | "finished" | "removed"; transfer: TransferSnapshot }
    | { type: "busy"; busy: boolean }

export type TransferListener = (event: TransferEvent) => void

export type BeginOptions = {
    direction: TransferDirection
    name: string
    /** Size of the whole item in bytes, if known. Also the default phase total. */
    size?: number
    /** Whether the user may cancel it. Default: true. */
    cancellable?: boolean
    /** Participate in the one-at-a-time queue lane. Default: true for uploads/downloads, false for tasks. */
    queue?: boolean
    phase?: string | null
    unit?: TransferUnit
    meta?: Record<string, unknown>
}

export type PhaseOptions = {
    /** Portion of the overall progress bar this phase covers, e.g. [0, 0.05]. Default: [0, 1]. */
    span?: [number, number]
    /** Phase total (default: the item size). */
    total?: number
    unit?: TransferUnit
}

export type UpdateOptions = {
    bytes?: number
    total?: number
    unit?: TransferUnit
    phase?: string | null
    name?: string
    size?: number
    detail?: string | null
    cancellable?: boolean
    ufid?: string
}

export type CompleteOptions = {
    message?: string
    tone?: TransferTone
    ufid?: string
}

export interface TransferHandle {
    readonly id: string
    /** Aborted when the user cancels this transfer. */
    readonly signal: AbortSignal
    /** Resolves when this transfer may start (immediately for non-queued transfers). Rejects if cancelled first. */
    readonly ready: Promise<void>
    snapshot(): TransferSnapshot
    update(options: UpdateOptions): void
    setPhase(phase: string | null, options?: PhaseOptions): void
    /** Throws an `AbortError` DOMException when cancellation was requested. Call between parts/chunks. */
    throwIfCancelled(): void
    complete(options?: CompleteOptions): void
    fail(error: unknown): void
    /** Marks the transfer as cancelled (normally done automatically when the job throws after a cancel). */
    markCancelled(): void
}

const MAX_FINISHED = 50
const ETA_MIN_ELAPSED_MS = 1500

type Entry = {
    id: string
    direction: TransferDirection
    name: string
    status: TransferStatus
    queued: boolean
    batch: number
    size: number
    phase: string | null
    span: [number, number]
    bytes: number
    total: number
    unit: TransferUnit
    phaseStartedAt: number
    phaseStartBytes: number
    detail: string | null
    cancellable: boolean
    controller: AbortController
    createdAt: number
    startedAt: number | null
    finishedAt: number | null
    message: string | null
    tone: TransferTone | null
    ufid: string | null
    meta: Record<string, unknown>
    startResolve: () => void
    startReject: (reason: unknown) => void
    snapshot: TransferSnapshot | null
}

const entries: Entry[] = []
const listeners = new Set<TransferListener>()
let idCounter = 0
let lastBusy = false
let batchCounter = 0
let now: () => number = () => Date.now()

function clamp01(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function emit(event: TransferEvent) {
    for (const listener of Array.from(listeners)) {
        try {
            listener(event)
        } catch (error) {
            console.error("Transfer listener failed", error)
        }
    }
}

function computeFraction(entry: Entry) {
    if (entry.status === "done") return 1
    const [from, to] = entry.span
    const phaseFraction = entry.total > 0 ? clamp01(entry.bytes / entry.total) : 0
    return clamp01(from + (to - from) * phaseFraction)
}

function computeEta(entry: Entry): number | null {
    if (entry.status !== "active" || entry.total <= 0) return null
    const elapsedMs = now() - entry.phaseStartedAt
    const progressed = entry.bytes - entry.phaseStartBytes
    if (elapsedMs < ETA_MIN_ELAPSED_MS || progressed <= 0) return null
    const rate = progressed / (elapsedMs / 1000)
    const remaining = Math.max(0, entry.total - entry.bytes)
    return Math.ceil(remaining / rate)
}

function toSnapshot(entry: Entry): TransferSnapshot {
    if (entry.snapshot) return entry.snapshot
    entry.snapshot = Object.freeze({
        id: entry.id,
        direction: entry.direction,
        name: entry.name,
        status: entry.status,
        queued: entry.queued,
        batch: entry.batch,
        size: entry.size,
        phase: entry.phase,
        bytes: entry.bytes,
        total: entry.total,
        unit: entry.unit,
        fraction: computeFraction(entry),
        etaSeconds: computeEta(entry),
        detail: entry.detail,
        cancellable: entry.cancellable && (entry.status === "queued" || entry.status === "active"),
        cancelRequested: entry.controller.signal.aborted,
        createdAt: entry.createdAt,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        message: entry.message,
        tone: entry.tone,
        ufid: entry.ufid,
        meta: Object.freeze({ ...entry.meta }),
    })
    return entry.snapshot
}

function changed(entry: Entry, type: "added" | "started" | "progress" | "finished" | "removed") {
    entry.snapshot = null
    emit({ type, transfer: toSnapshot(entry) })
    syncBusy()
}

function isPending(entry: Entry) {
    return entry.status === "queued" || entry.status === "active"
}

function syncBusy() {
    const busy = entries.some(isPending)
    if (busy !== lastBusy) {
        lastBusy = busy
        emit({ type: "busy", busy })
    }
}

/** Starts the next queued transfer when the lane is free. */
function pump() {
    if (entries.some((entry) => entry.queued && entry.status === "active")) return
    const next = entries.find((entry) => entry.queued && entry.status === "queued")
    if (!next) return
    activate(next)
}

function activate(entry: Entry) {
    entry.status = "active"
    entry.startedAt = now()
    entry.phaseStartedAt = entry.startedAt
    entry.phaseStartBytes = entry.bytes
    changed(entry, "started")
    entry.startResolve()
}

function pruneFinished() {
    const finished = entries.filter((entry) => !isPending(entry))
    let excess = finished.length - MAX_FINISHED
    for (let i = 0; excess > 0 && i < entries.length; ) {
        if (!isPending(entries[i])) {
            const [removed] = entries.splice(i, 1)
            changed(removed, "removed")
            excess--
        } else {
            i++
        }
    }
}

function finish(entry: Entry, status: "done" | "failed" | "cancelled", patch: Partial<Entry> = {}) {
    if (!isPending(entry)) return
    const wasQueuedOnly = entry.status === "queued"
    Object.assign(entry, patch)
    entry.status = status
    entry.finishedAt = now()
    if (wasQueuedOnly) {
        // Never started: unblock nobody, but make `ready` reject so the job is skipped.
        entry.startReject(abortError())
    }
    changed(entry, "finished")
    pruneFinished()
    pump()
}

export function abortError(message = "Transfer cancelled.") {
    if (typeof DOMException === "function") return new DOMException(message, "AbortError")
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

export function isAbortError(error: unknown) {
    return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError"
}

export function errorMessage(error: unknown) {
    if (error instanceof Error) return error.message || error.name
    if (typeof error === "string") return error
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
        return (error as { message: string }).message
    }
    return String(error)
}

/**
 * Registers a transfer. Queued transfers (default for uploads/downloads) wait for `handle.ready`; non-queued ones
 * (tasks) are active immediately. The caller MUST eventually call `complete`, `fail` or `markCancelled`; prefer
 * `enqueue`, which does that automatically.
 */
export function begin(options: BeginOptions): TransferHandle {
    const queued = options.queue ?? options.direction !== "task"
    let startResolve!: () => void
    let startReject!: (reason: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
        startResolve = resolve
        startReject = reject
    })
    // Avoid unhandled rejections when a caller never awaits `ready`.
    ready.catch(() => {})
    const size = Math.max(0, options.size ?? 0)
    if (queued && !entries.some((candidate) => candidate.queued && isPending(candidate))) batchCounter++
    const entry: Entry = {
        id: `t${++idCounter}`,
        direction: options.direction,
        name: options.name,
        status: "queued",
        queued,
        batch: queued ? batchCounter : 0,
        size,
        phase: options.phase ?? null,
        span: [0, 1],
        bytes: 0,
        total: size,
        unit: options.unit ?? "bytes",
        phaseStartedAt: now(),
        phaseStartBytes: 0,
        detail: null,
        cancellable: options.cancellable ?? true,
        controller: new AbortController(),
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        message: null,
        tone: null,
        ufid: null,
        meta: { ...(options.meta ?? {}) },
        startResolve,
        startReject,
        snapshot: null,
    }
    entries.push(entry)
    changed(entry, "added")
    if (queued) {
        pump()
    } else {
        activate(entry)
    }

    const handle: TransferHandle = {
        id: entry.id,
        signal: entry.controller.signal,
        ready,
        snapshot: () => toSnapshot(entry),
        update(update) {
            if (!isPending(entry)) return
            if (update.phase !== undefined && update.phase !== entry.phase) {
                entry.phase = update.phase
                entry.phaseStartedAt = now()
                entry.phaseStartBytes = update.bytes ?? 0
            }
            if (update.total !== undefined) entry.total = Math.max(0, update.total)
            if (update.unit !== undefined) entry.unit = update.unit
            if (update.bytes !== undefined) entry.bytes = Math.max(0, update.bytes)
            if (update.name !== undefined) entry.name = update.name
            if (update.size !== undefined) entry.size = Math.max(0, update.size)
            if (update.detail !== undefined) entry.detail = update.detail
            if (update.cancellable !== undefined) entry.cancellable = update.cancellable
            if (update.ufid !== undefined) entry.ufid = update.ufid
            changed(entry, "progress")
        },
        setPhase(phase, phaseOptions = {}) {
            if (!isPending(entry)) return
            entry.phase = phase
            entry.span = phaseOptions.span ?? [0, 1]
            entry.total = Math.max(0, phaseOptions.total ?? entry.size)
            entry.unit = phaseOptions.unit ?? "bytes"
            entry.bytes = 0
            entry.phaseStartedAt = now()
            entry.phaseStartBytes = 0
            changed(entry, "progress")
        },
        throwIfCancelled() {
            if (entry.controller.signal.aborted) throw abortError()
        },
        complete(completeOptions = {}) {
            finish(entry, "done", {
                message: completeOptions.message ?? null,
                tone: completeOptions.tone ?? "success",
                ufid: completeOptions.ufid ?? entry.ufid,
                bytes: entry.total,
            })
        },
        fail(error) {
            if (isAbortError(error) && entry.controller.signal.aborted) {
                finish(entry, "cancelled")
                return
            }
            finish(entry, "failed", { message: errorMessage(error) })
        },
        markCancelled() {
            finish(entry, "cancelled")
        },
    }
    return handle
}

/**
 * Queues `job` and runs it when the lane is free. The transfer is completed when the job resolves (unless the job
 * already finalized it) and failed/cancelled when it throws. Resolves with the job's result, or `undefined` when the
 * transfer was cancelled; rejects with the job's error otherwise.
 */
export async function enqueue<T>(
    options: BeginOptions,
    job: (transfer: TransferHandle) => Promise<T>,
): Promise<T | undefined> {
    const transfer = begin(options)
    try {
        await transfer.ready
    } catch {
        return undefined
    }
    try {
        const result = await job(transfer)
        transfer.complete()
        return result
    } catch (error) {
        transfer.fail(error)
        if (isAbortError(error) && transfer.signal.aborted) return undefined
        throw error
    }
}

/**
 * Cancels a transfer. Queued transfers are removed outright; active ones get their AbortSignal aborted and finish
 * as "cancelled" once the job stops at its next checkpoint.
 */
export function cancel(id: string): boolean {
    const index = entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    const entry = entries[index]
    if (!entry.cancellable || !isPending(entry)) return false
    if (entry.status === "queued") {
        entry.controller.abort(abortError())
        entry.status = "cancelled"
        entry.finishedAt = now()
        entry.startReject(abortError())
        entries.splice(index, 1)
        changed(entry, "removed")
        pump()
        return true
    }
    if (!entry.controller.signal.aborted) {
        entry.controller.abort(abortError())
        changed(entry, "progress")
    }
    return true
}

/** Removes finished (done/failed/cancelled) transfers. */
export function clearFinished() {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (!isPending(entries[i])) {
            const [removed] = entries.splice(i, 1)
            changed(removed, "removed")
        }
    }
}

export function getTransfers(): TransferSnapshot[] {
    return entries.map(toSnapshot)
}

export function getTransfer(id: string): TransferSnapshot | null {
    const entry = entries.find((candidate) => candidate.id === id)
    return entry ? toSnapshot(entry) : null
}

/** True while any transfer is queued or active. */
export function hasPendingTransfers() {
    return entries.some(isPending)
}

/** Subscribes to lifecycle events. Returns an unsubscribe function. */
export function subscribe(listener: TransferListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export type TransferSummary = {
    /** Transfer currently running in the queue lane, if any. */
    active: TransferSnapshot | null
    /** Running background tasks (not in the lane). */
    tasks: TransferSnapshot[]
    queuedCount: number
    /** Lane items in the latest batch (not cancelled), for "Uploading 2 of 5". */
    batchTotal: number
    /** 1-based position of the active lane item in the batch. */
    batchPosition: number
    /** Distinct directions in the batch (e.g. ["upload", "download"]). */
    directions: TransferSnapshot["direction"][]
    doneCount: number
    failedCount: number
    cancelledCount: number
    /** Size-weighted overall progress across the batch and running tasks, 0..1. */
    fraction: number
    busy: boolean
}

export function summarize(transfers: readonly TransferSnapshot[] = getTransfers()): TransferSummary {
    const latestBatch = transfers.reduce((max, transfer) => (transfer.queued ? Math.max(max, transfer.batch) : max), 0)
    const lane = transfers.filter((transfer) => transfer.queued && transfer.batch === latestBatch)
    const active = lane.find((transfer) => transfer.status === "active") ?? null
    const tasks = transfers.filter((transfer) => !transfer.queued && transfer.status === "active")
    const queuedCount = lane.filter((transfer) => transfer.status === "queued").length
    const doneCount = transfers.filter((transfer) => transfer.status === "done").length
    const failedCount = transfers.filter((transfer) => transfer.status === "failed").length
    const cancelledCount = transfers.filter((transfer) => transfer.status === "cancelled").length
    const batch = lane.filter((transfer) => transfer.status !== "cancelled")
    const finishedInBatch = batch.filter((transfer) => transfer.status === "done" || transfer.status === "failed").length
    let weighted = 0
    let weights = 0
    const weighed = active || queuedCount > 0 ? batch.filter((transfer) => transfer.status !== "failed") : tasks
    for (const transfer of weighed) {
        const weight = transfer.size > 0 ? transfer.size : 1
        weighted += weight * transfer.fraction
        weights += weight
    }
    return {
        active,
        tasks,
        queuedCount,
        batchTotal: batch.length,
        batchPosition: active ? finishedInBatch + 1 : finishedInBatch,
        directions: Array.from(new Set(batch.map((transfer) => transfer.direction))),
        doneCount,
        failedCount,
        cancelledCount,
        fraction: weights > 0 ? weighted / weights : 0,
        busy: !!active || queuedCount > 0 || tasks.length > 0,
    }
}

/** Test hook: resets all state and optionally swaps the clock. */
export function __resetTransfersForTests(clock?: () => number) {
    entries.length = 0
    listeners.clear()
    idCounter = 0
    batchCounter = 0
    lastBusy = false
    now = clock ?? (() => Date.now())
}
