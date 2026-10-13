// Keeps the user's attention on long transfers without blocking them:
// - holds a Screen Wake Lock while the transfer queue is busy (phones otherwise suspend the tab when the screen locks),
// - shows a system notification when transfers finish/fail while TGLFS is hidden or unfocused,
// - mirrors the pending count on the installed app's badge,
// - asks for notification permission only at a moment of intent (inline tray prompt / sidebar toggle).
// A subscriber of `transfers.ts`; it never starts or changes transfers itself.
import { showToast } from "./dialogs"
import { icon } from "./icons"
import {
    buildTransferNotification,
    isLongRunningBatch,
    NOTIFY_PREF_KEY,
    NOTIFY_PROMPT_DISMISSED_KEY,
    notificationsEnabled,
    parseNotifyPreference,
    parseTimestamp,
    shouldOfferNotificationPrompt,
    TRANSFER_NOTIFICATION_TAG,
    WAKE_HINT_SEEN_KEY,
    type NotifyPermission,
    type NotifyPreference,
    type TransferNotificationContent,
} from "./transferAttentionCore"
import { expandTransferTray, getTransferTraySlots } from "./transferTray"
import { getTransfers, hasPendingTransfers, subscribe, type TransferSnapshot } from "./transfers"

/** Message the service worker posts to the page after a transfer notification is clicked. */
export const SHOW_TRANSFERS_MESSAGE = "TGLFS_SHOW_TRANSFERS"
/** `data.source` of our notifications, so the service worker only handles its own. */
const NOTIFICATION_SOURCE = "tglfs-transfers"
const NOTIFICATION_ICON = "/icons/TGLFS%20logo%20192.png"
/** Coalesces finishes that land together (e.g. last upload + queue drain) into one notification. */
const NOTIFY_DEBOUNCE_MS = 600
/** Delay before re-requesting a wake lock the browser released while we still need it (avoids hot loops). */
const WAKE_RETRY_MS = 500

let mounted = false

/* -------------------------------------------------------------- Storage */

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function writeStorage(key: string, value: string | null) {
    try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
    } catch {}
}

function preference(): NotifyPreference {
    return parseNotifyPreference(readStorage(NOTIFY_PREF_KEY))
}

/* ----------------------------------------------------------- Permission */

type NotificationCtor = typeof Notification

function notificationApi(): NotificationCtor | null {
    return typeof window !== "undefined" && typeof window.Notification === "function" ? window.Notification : null
}

function permission(): NotifyPermission {
    const api = notificationApi()
    if (!api) return "unsupported"
    const value = api.permission
    return value === "granted" || value === "denied" ? value : "default"
}

/** Must be called from a user gesture (button click). Handles both promise and legacy callback forms. */
function requestPermission(): Promise<NotifyPermission> {
    const api = notificationApi()
    if (!api) return Promise.resolve("unsupported")
    return new Promise((resolve) => {
        let settled = false
        const done = () => {
            if (settled) return
            settled = true
            resolve(permission())
        }
        try {
            const result = api.requestPermission(() => done()) as Promise<NotificationPermission> | undefined
            if (result && typeof result.then === "function") result.then(done, done)
        } catch {
            done()
        }
    })
}

/** Asks the browser (gesture required) and records the user's choice. Returns the resulting permission. */
async function enableNotifications(): Promise<NotifyPermission> {
    let result = permission()
    if (result === "default") result = await requestPermission()
    if (result === "granted") writeStorage(NOTIFY_PREF_KEY, "on")
    promptVisible = false
    refresh()
    return result
}

function watchPermission() {
    const permissions = (navigator as Navigator & { permissions?: Permissions }).permissions
    if (!permissions?.query) return
    permissions
        .query({ name: "notifications" as PermissionName })
        .then((status) => {
            status.addEventListener?.("change", () => refresh())
        })
        .catch(() => {})
}

/* ------------------------------------------------------------ Wake lock */

type WakeLockSentinelLike = EventTarget & { readonly released?: boolean; release(): Promise<void> }
type WakeLockLike = { request(type: "screen"): Promise<WakeLockSentinelLike> }

let wakeSentinel: WakeLockSentinelLike | null = null
let wakeRequesting = false
let wakeWanted = false
/** Last request was refused (e.g. battery saver) or the API is missing. */
let wakeUnavailable = false
let wakeRetryTimer: number | undefined

function wakeLockApi(): WakeLockLike | null {
    const api = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
    return api && typeof api.request === "function" ? api : null
}

function syncWakeLock() {
    wakeWanted = hasPendingTransfers()
    if (wakeWanted) {
        void acquireWakeLock()
    } else {
        releaseWakeLock()
    }
}

async function acquireWakeLock() {
    const api = wakeLockApi()
    if (!api) {
        wakeUnavailable = true
        return
    }
    if (wakeSentinel?.released) wakeSentinel = null
    if (wakeSentinel || wakeRequesting || !wakeWanted || document.visibilityState !== "visible") return
    wakeRequesting = true
    try {
        const sentinel = await api.request("screen")
        if (!wakeWanted) {
            sentinel.release().catch(() => {})
            return
        }
        wakeSentinel = sentinel
        wakeUnavailable = false
        sentinel.addEventListener("release", () => {
            if (wakeSentinel !== sentinel) return
            wakeSentinel = null
            refresh()
            // The browser dropped the lock while we still need it; hidden tabs re-acquire on visibilitychange.
            if (wakeWanted && document.visibilityState === "visible") scheduleWakeRetry()
        })
    } catch (error) {
        // NotAllowedError (power saver, no user activation on some browsers, permissions policy) — not fatal.
        wakeUnavailable = true
        console.info("Screen wake lock unavailable:", error instanceof Error ? error.message : error)
        considerNotices()
    } finally {
        wakeRequesting = false
        refresh()
    }
}

function scheduleWakeRetry() {
    if (wakeRetryTimer !== undefined) return
    wakeRetryTimer = window.setTimeout(() => {
        wakeRetryTimer = undefined
        void acquireWakeLock()
    }, WAKE_RETRY_MS)
}

function releaseWakeLock() {
    if (wakeRetryTimer !== undefined) {
        window.clearTimeout(wakeRetryTimer)
        wakeRetryTimer = undefined
    }
    const sentinel = wakeSentinel
    wakeSentinel = null
    if (sentinel && !sentinel.released) sentinel.release().catch(() => {})
    refresh()
}

/* ------------------------------------------------------------ App badge */

let lastBadge = -1

function pendingCount(transfers: readonly TransferSnapshot[] = getTransfers()) {
    return transfers.filter((transfer) => transfer.status === "queued" || transfer.status === "active").length
}

function syncAppBadge() {
    const nav = navigator as Navigator & {
        setAppBadge?: (count?: number) => Promise<void>
        clearAppBadge?: () => Promise<void>
    }
    if (typeof nav.setAppBadge !== "function") return
    const count = pendingCount()
    if (count === lastBadge) return
    lastBadge = count
    try {
        const result = count > 0
            ? nav.setAppBadge(count)
            : typeof nav.clearAppBadge === "function" ? nav.clearAppBadge() : nav.setAppBadge(0)
        result?.catch?.(() => {})
    } catch {}
}

/* -------------------------------------------------------- Notifications */

/** Transfers that finished while the user was away, keyed by id (latest snapshot wins). */
const unseen = new Map<string, TransferSnapshot>()
let notifyTimer: number | undefined
let fallbackNotification: Notification | null = null

function userIsAway() {
    if (document.visibilityState === "hidden") return true
    return typeof document.hasFocus === "function" && !document.hasFocus()
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (!("serviceWorker" in navigator)) return null
    try {
        const registration = await navigator.serviceWorker.getRegistration()
        return registration?.active && typeof registration.showNotification === "function" ? registration : null
    } catch {
        return null
    }
}

function onTransferFinished(transfer: TransferSnapshot) {
    if (transfer.status !== "done" && transfer.status !== "failed") return
    if (!notificationsEnabled(permission(), preference()) || !userIsAway()) return
    unseen.set(transfer.id, transfer)
    scheduleNotify()
}

function scheduleNotify() {
    if (notifyTimer !== undefined) window.clearTimeout(notifyTimer)
    notifyTimer = window.setTimeout(() => {
        notifyTimer = undefined
        void flushNotification()
    }, NOTIFY_DEBOUNCE_MS)
}

async function flushNotification() {
    if (!userIsAway() || !notificationsEnabled(permission(), preference())) {
        unseen.clear()
        return
    }
    const content = buildTransferNotification(Array.from(unseen.values()), { pending: pendingCount() })
    if (content) await showSystemNotification(content)
}

async function showSystemNotification(content: TransferNotificationContent) {
    const options: NotificationOptions & { renotify?: boolean } = {
        body: content.body,
        tag: content.tag,
        renotify: content.renotify,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_ICON,
        data: { source: NOTIFICATION_SOURCE, url: window.location.href },
    }
    // Android Chrome only supports notifications shown through the service worker.
    const registration = await serviceWorkerRegistration()
    if (registration) {
        try {
            await registration.showNotification(content.title, options)
            return
        } catch (error) {
            console.warn("Service worker notification failed; falling back:", error)
        }
    }
    const api = notificationApi()
    if (!api) return
    try {
        const notification = new api(content.title, options)
        notification.onclick = (event) => {
            event.preventDefault?.()
            try {
                window.focus()
            } catch {}
            expandTransferTray()
            notification.close()
        }
        fallbackNotification = notification
    } catch (error) {
        console.warn("Unable to show notification:", error)
    }
}

/** The user is back: everything is visible in the tray, so drop pending and showing notifications. */
function onUserReturned() {
    if (userIsAway()) return
    if (notifyTimer !== undefined) {
        window.clearTimeout(notifyTimer)
        notifyTimer = undefined
    }
    if (unseen.size === 0 && !fallbackNotification) return
    unseen.clear()
    fallbackNotification?.close()
    fallbackNotification = null
    void serviceWorkerRegistration().then(async (registration) => {
        if (!registration?.getNotifications) return
        try {
            const shown = await registration.getNotifications({ tag: TRANSFER_NOTIFICATION_TAG })
            shown.forEach((notification) => notification.close())
        } catch {}
    })
}

/* ------------------------------------------------- Tray notices / extras */

let promptVisible = false
/** The prompt is offered at most once per page session (re-offered after reload unless snoozed). */
let promptOffered = false
let hintVisible = false
let renderedNoticesKey = ""
let renderedExtrasKey = ""

function isTouchDevice() {
    return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches
}

function considerNotices() {
    const transfers = getTransfers()
    if (!promptOffered) {
        const offer = shouldOfferNotificationPrompt({
            permission: permission(),
            preference: preference(),
            dismissedAt: parseTimestamp(readStorage(NOTIFY_PROMPT_DISMISSED_KEY)),
            now: Date.now(),
            transfers,
        })
        if (offer) {
            promptOffered = true
            promptVisible = true
        }
    }
    if (!hintVisible && (!wakeLockApi() || wakeUnavailable) && isTouchDevice()
        && readStorage(WAKE_HINT_SEEN_KEY) === null && isLongRunningBatch(transfers)) {
        hintVisible = true
        writeStorage(WAKE_HINT_SEEN_KEY, String(Date.now()))
    }
}

function renderNotices(notices: HTMLElement) {
    if (promptVisible && permission() !== "default") promptVisible = false
    const key = `${promptVisible ? "p" : ""}${hintVisible ? "h" : ""}`
    if (key === renderedNoticesKey) return
    renderedNoticesKey = key
    const parts: string[] = []
    if (promptVisible) {
        parts.push(`
            <div class="fx-tray-notice" data-notice="notify" role="group" aria-label="Transfer notifications">
                <span class="fx-tray-notice-icon">${icon("bell")}</span>
                <span class="fx-tray-notice-text">Get notified when transfers finish?</span>
                <span class="fx-tray-notice-actions">
                    <button type="button" class="fx-btn fx-btn-ghost" data-notice-act="later">Not now</button>
                    <button type="button" class="fx-btn fx-btn-primary" data-notice-act="enable">Enable</button>
                </span>
            </div>`)
    }
    if (hintVisible) {
        parts.push(`
            <div class="fx-tray-notice" data-notice="wake" role="note">
                <span class="fx-tray-notice-icon">${icon("screenOn")}</span>
                <span class="fx-tray-notice-text">Keep TGLFS open — your phone may pause transfers when the screen locks.</span>
                <span class="fx-tray-notice-actions">
                    <button type="button" class="fx-link" data-notice-act="hint-ok">Got it</button>
                </span>
            </div>`)
    }
    notices.innerHTML = parts.join("")
}

function renderExtras(extras: HTMLElement) {
    const locked = !!wakeSentinel && !wakeSentinel.released
    const key = locked ? "wake" : ""
    if (key === renderedExtrasKey) return
    renderedExtrasKey = key
    extras.innerHTML = locked
        ? `<span class="fx-tray-wake" role="img" aria-label="Screen stays on while transfers run" title="Screen stays on while transfers run">${icon("screenOn")}</span>`
        : ""
}

/* -------------------------------------------------------- Sidebar toggle */

function renderToggle() {
    const button = document.getElementById("notifyToggle") as HTMLButtonElement | null
    if (!button) return
    const state = permission()
    button.hidden = state === "unsupported"
    if (state === "unsupported") return
    const on = notificationsEnabled(state, preference())
    const label = state === "denied" ? "Blocked in browser settings" : on ? "On" : "Off"
    const key = `${state}:${on}`
    if (button.dataset.state === key) return
    button.dataset.state = key
    button.setAttribute("role", "switch")
    button.setAttribute("aria-checked", String(on))
    button.innerHTML = `${icon(on ? "bell" : "bellOff")}<span class="fx-nav-text"><span class="fx-nav-label">Transfer notifications</span><span class="fx-nav-state" data-tone="${state === "denied" ? "blocked" : on ? "on" : "off"}">${label}</span></span>`
    if (state === "denied") {
        button.title = "Blocked in browser settings — allow notifications for this site to turn them on"
        button.setAttribute("aria-label", "Transfer notifications: blocked in browser settings")
    } else {
        button.title = on ? "Notify me when transfers finish while TGLFS is in the background" : "Turn on transfer notifications"
        button.setAttribute("aria-label", `Transfer notifications: ${on ? "on" : "off"}`)
    }
}

async function onToggleClick() {
    const state = permission()
    if (state === "unsupported") return
    if (state === "denied") {
        showToast("Notifications are blocked in your browser settings for this site.", { tone: "error", durationMs: 4200 })
        return
    }
    if (state === "granted") {
        const next = notificationsEnabled(state, preference()) ? "off" : "on"
        writeStorage(NOTIFY_PREF_KEY, next)
        refresh()
        showToast(next === "on" ? "Transfer notifications on" : "Transfer notifications off")
        return
    }
    const result = await enableNotifications()
    if (result === "granted") showToast("You'll be notified when transfers finish", { tone: "success" })
    else if (result === "denied") showToast("Notifications are blocked in your browser settings for this site.", { tone: "error", durationMs: 4200 })
}

/* --------------------------------------------------------------- Render */

function refresh() {
    const slots = getTransferTraySlots()
    if (slots) {
        renderNotices(slots.notices)
        renderExtras(slots.extras)
    }
    renderToggle()
}

function onVisibilityOrFocus() {
    if (document.visibilityState === "visible") {
        if (wakeWanted) void acquireWakeLock()
        onUserReturned()
    }
    refresh()
}

/* ---------------------------------------------------------------- Mount */

/** Wires wake lock, notifications, app badge and the sidebar toggle. Call once after `mountTransferTray()`. */
export function mountTransferAttention() {
    if (mounted || typeof document === "undefined") return
    mounted = true

    subscribe((event) => {
        switch (event.type) {
            case "busy":
                syncWakeLock()
                if (!event.busy) {
                    // Queue drained: notify right away (hidden-tab timers can be throttled heavily).
                    if (notifyTimer !== undefined) {
                        window.clearTimeout(notifyTimer)
                        notifyTimer = undefined
                        void flushNotification()
                    }
                    promptVisible = false
                    hintVisible = false
                    promptOffered = false
                }
                break
            case "added":
                considerNotices()
                break
            case "finished":
                onTransferFinished(event.transfer)
                break
            default:
                break
        }
        if (event.type !== "progress") {
            syncAppBadge()
            refresh()
        }
    })

    document.addEventListener("visibilitychange", onVisibilityOrFocus)
    window.addEventListener("focus", onVisibilityOrFocus)

    getTransferTraySlots()?.notices.addEventListener("click", async (event) => {
        const action = (event.target as HTMLElement).closest<HTMLElement>("[data-notice-act]")?.dataset.noticeAct
        if (!action) return
        if (action === "later") {
            writeStorage(NOTIFY_PROMPT_DISMISSED_KEY, String(Date.now()))
            promptVisible = false
            refresh()
        } else if (action === "enable") {
            const result = await enableNotifications()
            if (result === "granted") showToast("You'll be notified when transfers finish", { tone: "success" })
            else if (result === "denied") showToast("Notifications are blocked in your browser settings for this site.", { tone: "error", durationMs: 4200 })
        } else if (action === "hint-ok") {
            hintVisible = false
            refresh()
        }
    })

    document.getElementById("notifyToggle")?.addEventListener("click", () => void onToggleClick())

    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", (event) => {
            if (event.data?.type === SHOW_TRANSFERS_MESSAGE) expandTransferTray()
        })
    }

    watchPermission()
    syncAppBadge()
    syncWakeLock()
    refresh()
}
