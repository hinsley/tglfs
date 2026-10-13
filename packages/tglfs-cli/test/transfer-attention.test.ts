import assert from "node:assert/strict"
import test from "node:test"

import {
    buildTransferNotification,
    isLongRunningBatch,
    notificationsEnabled,
    NOTIFY_PROMPT_SNOOZE_MS,
    parseNotifyPreference,
    parseTimestamp,
    shouldOfferNotificationPrompt,
    TRANSFER_NOTIFICATION_TAG,
} from "../../../src/web/transferAttentionCore.ts"
import type { TransferSnapshot } from "../../../src/web/transfers.ts"

const MiB = 1024 * 1024
let counter = 0

function snap(overrides: Partial<TransferSnapshot>): TransferSnapshot {
    counter++
    return {
        id: `t${counter}`,
        direction: "upload",
        name: `file-${counter}.bin`,
        status: "done",
        queued: true,
        batch: 1,
        size: 0,
        phase: null,
        bytes: 0,
        total: 0,
        unit: "bytes",
        fraction: 1,
        etaSeconds: null,
        detail: null,
        cancellable: false,
        cancelRequested: false,
        createdAt: 0,
        startedAt: 0,
        finishedAt: 0,
        message: null,
        tone: "success",
        ufid: null,
        meta: {},
        ...overrides,
    }
}

/* ------------------------------------------------------------ Prompt rule */

test("long-running batch: one big upload, or two or more pending uploads/downloads", () => {
    assert.equal(isLongRunningBatch([]), false)
    assert.equal(isLongRunningBatch([snap({ status: "active", size: 10 * MiB })]), false)
    assert.equal(isLongRunningBatch([snap({ status: "active", size: 50 * MiB })]), false)
    assert.equal(isLongRunningBatch([snap({ status: "queued", size: 50 * MiB + 1 })]), true)
    assert.equal(isLongRunningBatch([snap({ status: "active", size: 1 }), snap({ status: "queued", direction: "download", size: 1 })]), true)
    // Finished items and background tasks don't count.
    assert.equal(isLongRunningBatch([snap({ status: "done", size: 1 }), snap({ status: "active", size: 1 })]), false)
    assert.equal(isLongRunningBatch([snap({ status: "active", direction: "task" }), snap({ status: "active", size: 1 })]), false)
    assert.equal(isLongRunningBatch([snap({ status: "done", size: 900 * MiB })]), false)
})

test("notification prompt only when permission is undecided, not opted out, not snoozed, and the batch is long", () => {
    const big = [snap({ status: "active", size: 700 * MiB })]
    const now = 1_800_000_000_000
    const base = { permission: "default" as const, preference: null, dismissedAt: null, now, transfers: big }
    assert.equal(shouldOfferNotificationPrompt(base), true)
    assert.equal(shouldOfferNotificationPrompt({ ...base, transfers: [snap({ status: "active", size: MiB })] }), false)
    assert.equal(shouldOfferNotificationPrompt({ ...base, permission: "granted" }), false)
    assert.equal(shouldOfferNotificationPrompt({ ...base, permission: "denied" }), false)
    assert.equal(shouldOfferNotificationPrompt({ ...base, permission: "unsupported" }), false)
    assert.equal(shouldOfferNotificationPrompt({ ...base, preference: "off" }), false)
    assert.equal(shouldOfferNotificationPrompt({ ...base, preference: "on" }), true)
    // "Not now" snoozes for 30 days.
    assert.equal(shouldOfferNotificationPrompt({ ...base, dismissedAt: now - 1000 }), false)
    assert.equal(shouldOfferNotificationPrompt({ ...base, dismissedAt: now - NOTIFY_PROMPT_SNOOZE_MS + 1 }), false)
    assert.equal(shouldOfferNotificationPrompt({ ...base, dismissedAt: now - NOTIFY_PROMPT_SNOOZE_MS }), true)
    // A dismissal timestamp from the future (clock skew) does not silence the prompt forever.
    assert.equal(shouldOfferNotificationPrompt({ ...base, dismissedAt: now + 60_000 }), true)
})

test("preference and timestamp parsing tolerate junk", () => {
    assert.equal(parseNotifyPreference("on"), "on")
    assert.equal(parseNotifyPreference("off"), "off")
    assert.equal(parseNotifyPreference("true"), null)
    assert.equal(parseNotifyPreference(null), null)
    assert.equal(parseTimestamp("1700000000000"), 1700000000000)
    assert.equal(parseTimestamp("nope"), null)
    assert.equal(parseTimestamp("-5"), null)
    assert.equal(parseTimestamp(null), null)
    assert.equal(notificationsEnabled("granted", null), true)
    assert.equal(notificationsEnabled("granted", "on"), true)
    assert.equal(notificationsEnabled("granted", "off"), false)
    assert.equal(notificationsEnabled("default", "on"), false)
    assert.equal(notificationsEnabled("denied", "on"), false)
})

/* ------------------------------------------------------ Notification text */

test("single upload complete names the file and its size", () => {
    const content = buildTransferNotification([snap({ name: "Home movie.mp4", size: 700 * MiB })], { pending: 0 })
    assert.deepEqual(content, {
        title: "Upload complete",
        body: "Home movie.mp4 (700 MiB)",
        tag: TRANSFER_NOTIFICATION_TAG,
        renotify: true,
    })
})

test("single download/failure/warning/task variants", () => {
    assert.equal(buildTransferNotification([snap({ direction: "download", name: "a.pdf", size: 2 * MiB })], { pending: 0 })?.title, "Download complete")
    const failed = buildTransferNotification([snap({ status: "failed", name: "a.zip", size: 5, message: "FLOOD_WAIT_30" })], { pending: 0 })
    assert.equal(failed?.title, "Upload failed")
    assert.equal(failed?.body, "a.zip — FLOOD_WAIT_30")
    const warned = buildTransferNotification([snap({ tone: "warning", name: "b.mp4", message: "Preview unavailable" })], { pending: 0 })
    assert.equal(warned?.title, "Upload finished with warnings")
    assert.equal(warned?.body, "b.mp4 — Preview unavailable")
    const task = buildTransferNotification([snap({ direction: "task", queued: false, name: "Folder index migration", message: "Updated 3 folders" })], { pending: 0 })
    assert.deepEqual([task?.title, task?.body], ["Folder index migration finished", "Updated 3 folders"])
    const taskFailed = buildTransferNotification([snap({ direction: "task", status: "failed", name: "Folder index migration", message: "boom" })], { pending: 0 })
    assert.deepEqual([taskFailed?.title, taskFailed?.body], ["Folder index migration failed", "boom"])
})

test("several finishes coalesce into one summary", () => {
    const five = Array.from({ length: 5 }, (_, i) => snap({ name: `clip-${i + 1}.mp4`, size: 100 * MiB }))
    const content = buildTransferNotification(five, { pending: 0 })
    assert.equal(content?.title, "5 uploads complete")
    assert.equal(content?.body, "clip-1.mp4, clip-2.mp4 and 3 more · 500 MiB")
    assert.equal(content?.renotify, true)

    const mixed = buildTransferNotification(
        [snap({ name: "a.mp4" }), snap({ direction: "download", name: "b.pdf" }), snap({ status: "failed", name: "c.zip", message: "Network error" })],
        { pending: 0 },
    )
    assert.equal(mixed?.title, "2 transfers complete, 1 failed")
    assert.equal(mixed?.body, "Failed: c.zip — Network error\na.mp4, b.pdf")

    const allFailed = buildTransferNotification(
        [snap({ status: "failed", name: "x" }), snap({ status: "failed", name: "y" }), snap({ status: "failed", name: "z" })],
        { pending: 0 },
    )
    assert.equal(allFailed?.title, "3 uploads failed")
    assert.equal(allFailed?.body, "Failed: x, y and 1 more")
})

test("mid-queue updates mention remaining work and replace silently unless something failed", () => {
    const partial = buildTransferNotification([snap({ name: "a.mp4", size: MiB })], { pending: 3 })
    assert.equal(partial?.title, "Upload complete")
    assert.equal(partial?.body, "a.mp4 (1.00 MiB)\n3 more still in progress")
    assert.equal(partial?.renotify, false)
    const failedMidQueue = buildTransferNotification([snap({ status: "failed", name: "a.mp4", message: "x" })], { pending: 2 })
    assert.equal(failedMidQueue?.renotify, true)
})

test("cancelled-only or empty input produces no notification; long errors are truncated", () => {
    assert.equal(buildTransferNotification([], { pending: 0 }), null)
    assert.equal(buildTransferNotification([snap({ status: "cancelled" })], { pending: 0 }), null)
    const long = buildTransferNotification([snap({ status: "failed", name: "a", message: "e".repeat(500) })], { pending: 0 })
    assert.ok(long && long.body.length < 160)
    assert.ok(long?.body.endsWith("…"))
})
