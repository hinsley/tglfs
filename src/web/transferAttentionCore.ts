// Pure (DOM-free) rules behind `transferAttention.ts`: when to offer the notification prompt, and what a
// coalesced "transfers finished" system notification says. Kept separate so Node tests can cover them.
import { formatTransferBytes } from "./transferTray"
import type { TransferSnapshot } from "./transfers"

/** A single upload/download at least this large counts as "will take a while". */
export const NOTIFY_PROMPT_MIN_BYTES = 50 * 1024 * 1024
/** ...as do this many uploads/downloads pending at once. */
export const NOTIFY_PROMPT_MIN_ITEMS = 2
/** "Not now" silences the inline prompt for this long. */
export const NOTIFY_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000
/** All transfer notifications share one tag so newer ones replace older ones instead of stacking up. */
export const TRANSFER_NOTIFICATION_TAG = "tglfs-transfers"

/** localStorage keys (UI preferences only; not a durable protocol surface). */
export const NOTIFY_PREF_KEY = "tglfs.notifications.enabled"
export const NOTIFY_PROMPT_DISMISSED_KEY = "tglfs.notifications.promptDismissedAt"
export const WAKE_HINT_SEEN_KEY = "tglfs.wakeLock.hintSeen"

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported"
/** Explicit user choice from the sidebar toggle; `null` when never set. */
export type NotifyPreference = "on" | "off" | null

export function parseNotifyPreference(value: string | null | undefined): NotifyPreference {
    return value === "on" || value === "off" ? value : null
}

/** Notifications fire only with browser permission and unless the user switched them off in TGLFS. */
export function notificationsEnabled(permission: NotifyPermission, preference: NotifyPreference) {
    return permission === "granted" && preference !== "off"
}

function isPending(transfer: TransferSnapshot) {
    return transfer.status === "queued" || transfer.status === "active"
}

/** True when the pending uploads/downloads look like they will take a while (big file, or several files). */
export function isLongRunningBatch(transfers: readonly TransferSnapshot[]) {
    const pending = transfers.filter((transfer) => isPending(transfer) && transfer.direction !== "task")
    if (pending.length >= NOTIFY_PROMPT_MIN_ITEMS) return true
    return pending.some((transfer) => transfer.size > NOTIFY_PROMPT_MIN_BYTES)
}

export type PromptInput = {
    permission: NotifyPermission
    preference: NotifyPreference
    /** Epoch ms of the last "Not now", or null. */
    dismissedAt: number | null
    now: number
    transfers: readonly TransferSnapshot[]
}

/**
 * Whether to show the inline "Get notified when transfers finish?" prompt. Only while the browser has not been
 * asked yet, the user hasn't opted out or snoozed it, and the current work will take a while.
 */
export function shouldOfferNotificationPrompt(input: PromptInput) {
    if (input.permission !== "default") return false
    if (input.preference === "off") return false
    if (input.dismissedAt !== null && Number.isFinite(input.dismissedAt)) {
        const elapsed = input.now - input.dismissedAt
        if (elapsed >= 0 && elapsed < NOTIFY_PROMPT_SNOOZE_MS) return false
    }
    return isLongRunningBatch(input.transfers)
}

export function parseTimestamp(value: string | null | undefined): number | null {
    if (!value) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/* ------------------------------------------------------------ Notification text */

export type TransferNotificationContent = {
    title: string
    body: string
    tag: string
    /** Re-alert (sound/vibration) even though it replaces an existing notification with the same tag. */
    renotify: boolean
}

const MAX_MESSAGE_LENGTH = 140
const MAX_LISTED_NAMES = 2

function truncate(text: string, max = MAX_MESSAGE_LENGTH) {
    const clean = text.replace(/\s+/g, " ").trim()
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function directionLabel(direction: TransferSnapshot["direction"]) {
    return direction === "upload" ? "Upload" : direction === "download" ? "Download" : "Task"
}

function nounFor(transfers: readonly TransferSnapshot[], count: number) {
    const directions = new Set(transfers.map((transfer) => transfer.direction))
    const base = directions.size === 1 ? directionLabel(transfers[0].direction).toLowerCase() : "transfer"
    return count === 1 ? base : `${base}s`
}

function withSize(transfer: TransferSnapshot) {
    return transfer.size > 0 ? `${transfer.name} (${formatTransferBytes(transfer.size)})` : transfer.name
}

function listNames(transfers: readonly TransferSnapshot[]) {
    const names = transfers.slice(0, MAX_LISTED_NAMES).map((transfer) => transfer.name)
    const rest = transfers.length - names.length
    return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ")
}

function pendingLine(pending: number) {
    return pending > 0 ? `${pending} more still in progress` : ""
}

function singleContent(transfer: TransferSnapshot): { title: string; body: string } {
    const message = transfer.message ? truncate(transfer.message) : ""
    if (transfer.direction === "task") {
        if (transfer.status === "failed") return { title: `${transfer.name} failed`, body: message || "Unknown error" }
        return { title: `${transfer.name} finished`, body: message }
    }
    const label = directionLabel(transfer.direction)
    if (transfer.status === "failed") {
        return { title: `${label} failed`, body: `${transfer.name} — ${message || "Unknown error"}` }
    }
    if (transfer.tone === "warning") {
        return { title: `${label} finished with warnings`, body: message ? `${transfer.name} — ${message}` : withSize(transfer) }
    }
    return { title: `${label} complete`, body: withSize(transfer) }
}

/**
 * Builds one summary notification for every transfer that finished (done or failed) since the user last looked.
 * Cancelled transfers are ignored (the user did that themselves). Returns null when there is nothing to say.
 *
 * `pending` is the number of transfers still queued/running; when it is 0 the queue drained, which (like any
 * failure) re-alerts even if an earlier notification with the same tag is still showing.
 */
export function buildTransferNotification(
    finished: readonly TransferSnapshot[],
    options: { pending: number },
): TransferNotificationContent | null {
    const items = finished.filter((transfer) => transfer.status === "done" || transfer.status === "failed")
    if (items.length === 0) return null
    const done = items.filter((transfer) => transfer.status === "done")
    const failed = items.filter((transfer) => transfer.status === "failed")
    const pending = Math.max(0, options.pending)
    const renotify = failed.length > 0 || pending === 0

    let title: string
    let lines: string[]
    if (items.length === 1) {
        const single = singleContent(items[0])
        title = single.title
        lines = [single.body]
    } else {
        if (failed.length === 0) {
            title = `${done.length} ${nounFor(done, done.length)} complete`
        } else if (done.length === 0) {
            title = `${failed.length} ${nounFor(failed, failed.length)} failed`
        } else {
            title = `${done.length} ${nounFor(done, done.length)} complete, ${failed.length} failed`
        }
        lines = []
        if (failed.length > 0) {
            lines.push(failed.length === 1 && failed[0].message
                ? `Failed: ${failed[0].name} — ${truncate(failed[0].message, 80)}`
                : `Failed: ${listNames(failed)}`)
        }
        if (done.length > 0) {
            const bytes = done.reduce((sum, transfer) => sum + Math.max(0, transfer.size), 0)
            lines.push(bytes > 0 ? `${listNames(done)} · ${formatTransferBytes(bytes)}` : listNames(done))
        }
    }
    lines.push(pendingLine(pending))
    return {
        title,
        body: lines.filter(Boolean).join("\n"),
        tag: TRANSFER_NOTIFICATION_TAG,
        renotify,
    }
}
