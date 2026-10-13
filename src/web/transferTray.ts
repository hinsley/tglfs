// Non-blocking transfer tray (desktop: docked card bottom-right; phone: pill that expands into a bottom sheet).
// Pure view over the queue in `transfers.ts`: it never starts or runs transfers itself.
import { isCompactViewport, showToast } from "./dialogs"
import { fileKindForName, fileKindIcon, icon } from "./icons"
import {
    cancel,
    clearFinished,
    getTransfers,
    hasPendingTransfers,
    subscribe,
    summarize,
    type TransferSnapshot,
    type TransferSummary,
} from "./transfers"

const RING_RADIUS = 15
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

type TrayElements = {
    root: HTMLElement
    panel: HTMLElement
    summary: HTMLButtonElement
    ring: HTMLElement
    ringArc: SVGCircleElement
    ringIcon: HTMLElement
    title: HTMLElement
    sub: HTMLElement
    toggle: HTMLButtonElement
    close: HTMLButtonElement
    meterFill: HTMLElement
    list: HTMLElement
    foot: HTMLElement
    footInfo: HTMLElement
    clear: HTMLButtonElement
    live: HTMLElement
    scrim: HTMLElement
}

let elements: TrayElements | null = null
let expanded: boolean | null = null
let renderQueued = false
let savedTitle: string | null = null
let lastRingIcon = ""
const rows = new Map<string, HTMLElement>()
const expandedErrors = new Set<string>()

/* ------------------------------------------------------------ Formatting */

export function formatTransferBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    let value = bytes
    let index = 0
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index++
    }
    const digits = index === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0
    return `${value.toFixed(digits)} ${units[index]}`
}

export function formatTransferEta(seconds: number): string {
    if (seconds < 10) return "a few seconds left"
    if (seconds < 60) return `${Math.ceil(seconds / 5) * 5} sec left`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} min left`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours} hr ${rest} min left` : `${hours} hr left`
}

function percent(fraction: number) {
    return `${Math.floor(Math.max(0, Math.min(1, fraction)) * 100)}%`
}

function verbFor(direction: TransferSnapshot["direction"]) {
    return direction === "upload" ? "Uploading" : direction === "download" ? "Downloading" : "Working"
}

function nounFor(transfers: TransferSnapshot[], count: number) {
    const directions = new Set(transfers.map((transfer) => transfer.direction))
    const base = directions.size === 1 && directions.has("upload")
        ? "upload"
        : directions.size === 1 && directions.has("download")
            ? "download"
            : directions.size === 1 && directions.has("task")
                ? "task"
                : "transfer"
    return count === 1 ? base : `${base}s`
}

export function describeTransferStatus(transfer: TransferSnapshot): string {
    switch (transfer.status) {
        case "queued":
            return transfer.size > 0 ? `Queued · ${formatTransferBytes(transfer.size)}` : "Queued"
        case "active": {
            if (transfer.cancelRequested) return "Cancelling…"
            if (transfer.phase !== null) {
                if (transfer.total <= 0) return transfer.phase
                if (transfer.unit === "items") return `${transfer.phase} · ${transfer.bytes} of ${transfer.total}`
                return `${transfer.phase} · ${percent(transfer.bytes / transfer.total)}`
            }
            if (transfer.total <= 0) return "Starting…"
            const amount = transfer.unit === "bytes"
                ? `${formatTransferBytes(transfer.bytes)} of ${formatTransferBytes(transfer.total)}`
                : transfer.unit === "items"
                    ? `${transfer.bytes} of ${transfer.total}`
                    : percent(transfer.bytes / transfer.total)
            return transfer.etaSeconds !== null ? `${amount} · ${formatTransferEta(transfer.etaSeconds)}` : amount
        }
        case "done":
            if (transfer.message) return transfer.message
            return transfer.size > 0 ? `Done · ${formatTransferBytes(transfer.size)}` : "Done"
        case "failed":
            return `Failed — ${transfer.message ?? "Unknown error"}`
        case "cancelled":
            return "Cancelled"
    }
}

function describeHeader(summary: TransferSummary, transfers: TransferSnapshot[]) {
    if (summary.active) {
        const mixed = summary.directions.length > 1
        const verb = mixed ? "Transferring" : verbFor(summary.active.direction)
        const count = summary.batchTotal > 1
            ? `${summary.batchPosition} of ${summary.batchTotal}`
            : summary.active.direction === "task" ? "" : "1 file"
        return {
            title: `${[verb, count].filter(Boolean).join(" ")} · ${percent(summary.fraction)}`,
            sub: summary.active.name,
            tone: "busy" as const,
        }
    }
    if (summary.queuedCount > 0) {
        return { title: `${summary.queuedCount} queued`, sub: "Waiting to start", tone: "busy" as const }
    }
    if (summary.tasks.length > 0) {
        const task = summary.tasks[0]
        return {
            title: task.total > 0 ? `${task.name} · ${percent(summary.fraction)}` : task.name,
            sub: task.phase ?? task.detail ?? "Running in the background",
            tone: "busy" as const,
        }
    }
    const { doneCount, failedCount, cancelledCount } = summary
    if (failedCount > 0 && doneCount > 0) {
        return { title: `${doneCount} done · ${failedCount} failed`, sub: "Some transfers didn't finish", tone: "error" as const }
    }
    if (failedCount > 0) {
        const failed = transfers.filter((transfer) => transfer.status === "failed")
        return { title: `${failedCount} ${nounFor(failed, failedCount)} failed`, sub: failed[0]?.message ?? "", tone: "error" as const }
    }
    if (doneCount > 0) {
        const done = transfers.filter((transfer) => transfer.status === "done")
        const warned = done.some((transfer) => transfer.tone === "warning")
        return {
            title: `${doneCount} ${nounFor(done, doneCount)} complete`,
            sub: warned ? "Finished with warnings" : "All done",
            tone: warned ? "warning" as const : "success" as const,
        }
    }
    if (cancelledCount > 0) {
        return { title: cancelledCount === 1 ? "Transfer cancelled" : `${cancelledCount} transfers cancelled`, sub: "", tone: "idle" as const }
    }
    return { title: "Transfers", sub: "", tone: "idle" as const }
}

/* ------------------------------------------------------------------- DOM */

function build(): TrayElements {
    const root = document.createElement("div")
    root.id = "transferTray"
    root.className = "fx-tray"
    root.hidden = true
    root.innerHTML = `
        <div class="fx-tray-scrim" data-tray-scrim></div>
        <section class="fx-tray-panel" role="region" aria-label="Transfers">
            <div class="fx-tray-grip" aria-hidden="true"></div>
            <header class="fx-tray-head">
                <button type="button" class="fx-tray-summary" aria-expanded="false" aria-controls="transferTrayBody">
                    <span class="fx-tray-ring" data-tone="busy">
                        <svg viewBox="0 0 36 36" aria-hidden="true">
                            <circle class="fx-tray-ring-track" cx="18" cy="18" r="${RING_RADIUS}"></circle>
                            <circle class="fx-tray-ring-arc" cx="18" cy="18" r="${RING_RADIUS}"
                                stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${RING_CIRCUMFERENCE.toFixed(2)}"></circle>
                        </svg>
                        <span class="fx-tray-ring-icon"></span>
                    </span>
                    <span class="fx-tray-titles">
                        <span class="fx-tray-title"></span>
                        <span class="fx-tray-sub"></span>
                    </span>
                </button>
                <button type="button" class="fx-icon-btn fx-tray-toggle" aria-controls="transferTrayBody"></button>
                <button type="button" class="fx-icon-btn fx-tray-close" aria-label="Close transfers" title="Close">${icon("close")}</button>
            </header>
            <div class="fx-tray-meter" aria-hidden="true"><div class="fx-tray-meter-fill"></div></div>
            <div class="fx-tray-body" id="transferTrayBody">
                <div class="fx-tray-body-inner">
                    <ul class="fx-tray-list" aria-label="Transfer list"></ul>
                    <footer class="fx-tray-foot">
                        <span class="fx-tray-foot-info"></span>
                        <button type="button" class="fx-link fx-tray-clear">Clear finished</button>
                    </footer>
                </div>
            </div>
        </section>
        <div class="fx-visually-hidden" aria-live="polite" data-tray-live></div>
    `
    document.body.appendChild(root)
    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T
    return {
        root,
        panel: q<HTMLElement>(".fx-tray-panel"),
        summary: q<HTMLButtonElement>(".fx-tray-summary"),
        ring: q<HTMLElement>(".fx-tray-ring"),
        ringArc: q<SVGCircleElement>(".fx-tray-ring-arc"),
        ringIcon: q<HTMLElement>(".fx-tray-ring-icon"),
        title: q<HTMLElement>(".fx-tray-title"),
        sub: q<HTMLElement>(".fx-tray-sub"),
        toggle: q<HTMLButtonElement>(".fx-tray-toggle"),
        close: q<HTMLButtonElement>(".fx-tray-close"),
        meterFill: q<HTMLElement>(".fx-tray-meter-fill"),
        list: q<HTMLElement>(".fx-tray-list"),
        foot: q<HTMLElement>(".fx-tray-foot"),
        footInfo: q<HTMLElement>(".fx-tray-foot-info"),
        clear: q<HTMLButtonElement>(".fx-tray-clear"),
        live: q<HTMLElement>("[data-tray-live]"),
        scrim: q<HTMLElement>("[data-tray-scrim]"),
    }
}

function rowIcon(transfer: TransferSnapshot) {
    const kindIcon = transfer.direction === "task"
        ? `<span class="fx-ficon fx-ficon--file fx-ficon--sm">${icon("wrench")}</span>`
        : fileKindIcon(fileKindForName(transfer.name))
    const badge = transfer.direction === "upload"
        ? `<span class="fx-tray-dir" data-dir="upload">${icon("arrowUp")}</span>`
        : transfer.direction === "download"
            ? `<span class="fx-tray-dir" data-dir="download">${icon("arrowDown")}</span>`
            : ""
    return `${kindIcon}${badge}`
}

function createRow(transfer: TransferSnapshot) {
    const row = document.createElement("li")
    row.className = "fx-tray-row"
    row.dataset.id = transfer.id
    row.innerHTML = `
        <span class="fx-tray-ficon">${rowIcon(transfer)}</span>
        <div class="fx-tray-main">
            <div class="fx-tray-name"></div>
            <div class="fx-tray-bar" aria-hidden="true"><div class="fx-tray-bar-fill"></div></div>
            <div class="fx-tray-status"></div>
            <div class="fx-tray-detail"></div>
            <div class="fx-tray-error"></div>
        </div>
        <div class="fx-tray-actions">
            <button type="button" class="fx-icon-btn fx-tray-act" data-act="copy" aria-label="Copy UFID" title="Copy UFID">${icon("copy")}</button>
            <button type="button" class="fx-icon-btn fx-tray-act" data-act="cancel" aria-label="Cancel" title="Cancel">${icon("close")}</button>
            <span class="fx-tray-state" aria-hidden="true"></span>
        </div>
    `
    return row
}

function setText(element: Element | null, text: string) {
    if (element && element.textContent !== text) element.textContent = text
}

function updateRow(row: HTMLElement, transfer: TransferSnapshot) {
    row.dataset.status = transfer.status
    row.dataset.direction = transfer.direction
    row.dataset.tone = transfer.tone ?? ""
    row.classList.toggle("is-cancelling", transfer.cancelRequested && transfer.status === "active")
    const name = row.querySelector<HTMLElement>(".fx-tray-name")!
    setText(name, transfer.name)
    name.title = transfer.name
    const fill = row.querySelector<HTMLElement>(".fx-tray-bar-fill")!
    fill.style.transform = `scaleX(${transfer.status === "done" ? 1 : transfer.fraction})`
    const statusText = describeTransferStatus(transfer)
    const status = row.querySelector<HTMLElement>(".fx-tray-status")!
    setText(status, statusText)
    status.title = statusText
    const detail = row.querySelector<HTMLElement>(".fx-tray-detail")!
    const detailText = transfer.status === "active" || transfer.status === "done" ? transfer.detail ?? "" : ""
    setText(detail, detailText)
    detail.title = detailText
    const error = row.querySelector<HTMLElement>(".fx-tray-error")!
    setText(error, transfer.status === "failed" ? transfer.message ?? "" : "")
    row.classList.toggle("is-expanded", transfer.status === "failed" && expandedErrors.has(transfer.id))
    if (transfer.status === "failed") {
        row.title = "Show error"
    } else {
        row.removeAttribute("title")
    }
    const copy = row.querySelector<HTMLButtonElement>('[data-act="copy"]')!
    copy.hidden = !transfer.ufid || transfer.status === "active" || transfer.status === "queued"
    const cancelButton = row.querySelector<HTMLButtonElement>('[data-act="cancel"]')!
    cancelButton.hidden = !transfer.cancellable
    cancelButton.disabled = transfer.cancelRequested
    const stateIcon = transfer.status === "done"
        ? transfer.tone === "warning" ? "alert" : "check"
        : transfer.status === "failed"
            ? "alert"
            : transfer.status === "cancelled"
                ? "ban"
                : ""
    const state = row.querySelector<HTMLElement>(".fx-tray-state")!
    if (state.dataset.icon !== stateIcon) {
        state.dataset.icon = stateIcon
        state.innerHTML = stateIcon ? icon(stateIcon) : ""
    }
}

/* ---------------------------------------------------------------- Render */

function isPhone() {
    return isCompactViewport()
}

function setExpanded(next: boolean) {
    expanded = next
    scheduleRender()
}

function scheduleRender() {
    if (renderQueued) return
    renderQueued = true
    const run = () => {
        renderQueued = false
        render()
    }
    if (typeof requestAnimationFrame === "function" && document.visibilityState !== "hidden") {
        requestAnimationFrame(run)
    } else {
        setTimeout(run, 50)
    }
}

function render() {
    const ui = elements
    if (!ui) return
    const transfers = getTransfers()
    const summary = summarize(transfers)
    const visible = transfers.length > 0
    ui.root.hidden = !visible
    document.body.classList.toggle("fx-tray-visible", visible)
    if (!visible) {
        expanded = null
        document.body.classList.remove("fx-tray-open")
        syncDocumentTitle(summary)
        return
    }
    if (expanded === null) expanded = !isPhone()
    const phone = isPhone()
    ui.root.dataset.layout = phone ? "sheet" : "card"
    ui.root.dataset.state = expanded ? "expanded" : "collapsed"
    document.body.classList.toggle("fx-tray-open", phone && expanded)
    ui.summary.setAttribute("aria-expanded", String(expanded))
    ui.toggle.setAttribute("aria-expanded", String(expanded))
    const toggleLabel = expanded ? "Collapse transfers" : "Expand transfers"
    ui.toggle.setAttribute("aria-label", toggleLabel)
    ui.toggle.title = expanded ? "Collapse" : "Expand"
    const toggleIcon = expanded ? "chevronDown" : "chevronUp"
    if (ui.toggle.dataset.icon !== toggleIcon) {
        ui.toggle.dataset.icon = toggleIcon
        ui.toggle.innerHTML = icon(toggleIcon)
    }

    // Header.
    const header = describeHeader(summary, transfers)
    setText(ui.title, header.title)
    setText(ui.sub, header.sub)
    ui.sub.hidden = !header.sub
    ui.root.dataset.tone = header.tone
    ui.ring.dataset.tone = header.tone
    const ringFraction = header.tone === "busy" ? summary.fraction : 1
    ui.ringArc.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ringFraction))
    const ringIcon = header.tone === "busy"
        ? summary.active?.direction === "download" ? "arrowDown" : summary.active?.direction === "upload" ? "arrowUp" : summary.tasks.length ? "wrench" : "arrowUp"
        : header.tone === "error" || header.tone === "warning" ? "alert" : header.tone === "success" ? "check" : "ban"
    if (ringIcon !== lastRingIcon) {
        lastRingIcon = ringIcon
        ui.ringIcon.innerHTML = icon(ringIcon)
    }
    ui.meterFill.style.transform = `scaleX(${header.tone === "busy" ? summary.fraction : 1})`
    ui.close.hidden = summary.busy

    // Rows (keyed patching keeps focus/hover stable while progress streams in).
    const seen = new Set<string>()
    let previous: HTMLElement | null = null
    for (const transfer of transfers) {
        seen.add(transfer.id)
        let row = rows.get(transfer.id)
        if (!row) {
            row = createRow(transfer)
            rows.set(transfer.id, row)
        }
        updateRow(row, transfer)
        const expectedNext: ChildNode | null = previous ? previous.nextSibling : ui.list.firstChild
        if (expectedNext !== row) ui.list.insertBefore(row, expectedNext)
        previous = row
    }
    for (const [id, row] of rows) {
        if (!seen.has(id)) {
            row.remove()
            rows.delete(id)
            expandedErrors.delete(id)
        }
    }

    const finished = transfers.filter((transfer) => transfer.status !== "active" && transfer.status !== "queued").length
    ui.clear.hidden = finished === 0
    const footBits: string[] = []
    if (summary.queuedCount > 0) footBits.push(`${summary.queuedCount} queued`)
    if (summary.tasks.length > 0 && summary.active) footBits.push(`${summary.tasks.length} background ${summary.tasks.length === 1 ? "task" : "tasks"}`)
    setText(ui.footInfo, footBits.join(" · "))
    ui.foot.hidden = finished === 0 && footBits.length === 0
    syncDocumentTitle(summary)
}

function syncDocumentTitle(summary: TransferSummary) {
    if (summary.busy) {
        if (savedTitle === null) savedTitle = document.title
        const verb = summary.active ? verbFor(summary.active.direction) : summary.queuedCount > 0 ? "Queued" : "Working"
        const next = `${percent(summary.fraction)} · ${verb} — ${savedTitle}`
        if (document.title !== next) document.title = next
    } else if (savedTitle !== null) {
        document.title = savedTitle
        savedTitle = null
    }
}

function announce(text: string) {
    if (!elements) return
    elements.live.textContent = text
}

/* ----------------------------------------------------------------- Mount */

/** Mounts the tray once. Safe to call repeatedly; no-op outside the browser. */
export function mountTransferTray() {
    if (elements || typeof document === "undefined") return
    const ui = build()
    elements = ui

    ui.summary.addEventListener("click", () => setExpanded(!expanded))
    ui.toggle.addEventListener("click", () => setExpanded(!expanded))
    ui.scrim.addEventListener("click", () => setExpanded(false))
    ui.close.addEventListener("click", () => {
        if (hasPendingTransfers()) {
            setExpanded(false)
            return
        }
        clearFinished()
    })
    ui.clear.addEventListener("click", () => clearFinished())
    ui.list.addEventListener("click", async (event) => {
        const target = event.target as HTMLElement
        const row = target.closest<HTMLElement>(".fx-tray-row")
        const id = row?.dataset.id
        if (!row || !id) return
        const action = target.closest<HTMLElement>("[data-act]")?.dataset.act
        if (action === "cancel") {
            event.stopPropagation()
            cancel(id)
            return
        }
        if (action === "copy") {
            event.stopPropagation()
            const ufid = getTransfers().find((transfer) => transfer.id === id)?.ufid
            if (!ufid) return
            try {
                await navigator.clipboard.writeText(ufid)
                showToast("UFID copied to clipboard")
            } catch {
                showToast("Unable to copy UFID", { tone: "error" })
            }
            return
        }
        if (row.dataset.status === "failed") {
            if (expandedErrors.has(id)) expandedErrors.delete(id)
            else expandedErrors.add(id)
            scheduleRender()
        }
    })
    window.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !expanded || !isPhone() || ui.root.hidden) return
        if (document.querySelector(".fx-dialog-backdrop")) return
        event.preventDefault()
        event.stopImmediatePropagation()
        setExpanded(false)
    }, true)
    // Crossing the phone breakpoint switches between the docked card (open) and the pill (closed).
    window.matchMedia("(max-width: 640px)").addEventListener?.("change", () => setExpanded(!isPhone()))
    window.addEventListener("beforeunload", (event) => {
        if (!hasPendingTransfers()) return
        event.preventDefault()
        event.returnValue = ""
    })

    subscribe((event) => {
        if (event.type === "added" && getTransfers().length === 1 && expanded === null) {
            expanded = !isPhone()
        }
        if (event.type === "started") {
            announce(`${verbFor(event.transfer.direction)} ${event.transfer.name}`)
        } else if (event.type === "finished") {
            const status = event.transfer.status
            announce(`${event.transfer.name}: ${status === "done" ? "done" : status === "failed" ? `failed. ${event.transfer.message ?? ""}` : "cancelled"}`)
        }
        scheduleRender()
    })
    render()
}
