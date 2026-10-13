// Timeline panel and banner for the folder time-machine view. DOM only; the data comes from folderHistory.ts.
import { escapeHtml } from "./dialogs"
import { icon } from "./icons"
import type { FolderHistory, HistoryChange, HistoryPoint } from "./folderHistory"

export function formatHistoryTime(ms: number) {
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    })
}

export function formatHistoryDay(ms: number, withYear = true) {
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleDateString(undefined, withYear
        ? { day: "numeric", month: "short", year: "numeric" }
        : { day: "numeric", month: "short" })
}

function pointTone(point: HistoryPoint) {
    if (point.isNow) return "is-now"
    const types = new Set(point.changes.map((change) => change.type))
    if (types.has("added") && types.has("removed")) return "is-mixed"
    if (types.has("removed")) return "is-removed"
    if (types.has("added")) return "is-added"
    if (types.has("created")) return "is-created"
    return "is-changed"
}

const CHANGE_SYMBOL: Record<HistoryChange["type"], string> = {
    created: "＊",
    added: "+",
    removed: "−",
    changed: "~",
}

function changeChip(change: HistoryChange) {
    const type = change.type === "created" ? "created" : change.type
    const detail = change.approximate ? `${change.detail} (by then)` : change.detail
    return `<button type="button" class="fx-hchip is-${type}" ${change.itemKey ? `data-item-key="${escapeHtml(change.itemKey)}"` : "disabled"}
        title="${escapeHtml(`${change.name} — ${detail}`)}">
        <span class="fx-hchip-sym" aria-hidden="true">${CHANGE_SYMBOL[change.type]}</span>
        <span class="fx-hchip-name">${escapeHtml(change.name)}</span>
        <span class="fx-hchip-detail">${escapeHtml(detail)}</span>
    </button>`
}

function nowHint() {
    const touch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches
    return touch ? "Current contents. Drag the timeline to look back." : "Current contents. Drag the timeline or press ← to look back."
}

export type HistoryPanelHandlers = {
    onSelect: (index: number) => void
    onClose: () => void
    onChangeClick: (itemKey: string) => void
}

export class HistoryPanel {
    private history: FolderHistory | null = null
    private index = 0
    private viewAt: number | null = null
    private dragging = false

    constructor(private readonly root: HTMLElement, private readonly handlers: HistoryPanelHandlers) {
        root.addEventListener("click", (event) => {
            const target = event.target as HTMLElement
            if (target.closest("[data-history-close]")) {
                handlers.onClose()
                return
            }
            if (target.closest("[data-history-about]")) {
                this.toggleAbout()
                return
            }
            if (target.closest("[data-history-prev]")) {
                this.step(-1)
                return
            }
            if (target.closest("[data-history-next]")) {
                this.step(1)
                return
            }
            if (target.closest("[data-history-now]")) {
                if (this.history) handlers.onSelect(this.history.points.length - 1)
                return
            }
            const chip = target.closest<HTMLElement>("[data-item-key]")
            if (chip?.dataset.itemKey) handlers.onChangeClick(chip.dataset.itemKey)
        })
    }

    get isOpen() {
        return !this.root.hasAttribute("hidden")
    }

    showLoading(title: string) {
        this.history = null
        this.root.removeAttribute("hidden")
        this.root.classList.add("is-loading")
        this.root.innerHTML = `
            ${this.headerHtml(title, "Reading folder records…")}
            <div class="fx-history-scrub" aria-hidden="true">
                <span class="fx-skel fx-history-skel"></span>
            </div>`
    }

    showError(title: string, message: string) {
        this.history = null
        this.root.removeAttribute("hidden")
        this.root.classList.remove("is-loading")
        this.root.innerHTML = `${this.headerHtml(title, message)}`
    }

    hide() {
        this.history = null
        this.root.setAttribute("hidden", "")
        this.root.innerHTML = ""
    }

    setData(title: string, history: FolderHistory, index: number, viewAt: number | null = null) {
        this.history = history
        this.root.removeAttribute("hidden")
        this.root.classList.remove("is-loading")
        const recorded = history.points.reduce((count, point) => count + point.changes.filter((change) => change.type !== "created").length, 0)
        const first = history.points[0]
        const subtitle = recorded === 0
            ? "No recorded changes"
            : `${recorded} recorded ${recorded === 1 ? "change" : "changes"} since ${formatHistoryDay(first.at)}`
        const last = history.points.length - 1
        const ticks = history.points.map((point, pointIndex) => `
            <span class="fx-history-tick ${pointTone(point)}" style="left:${this.position(pointIndex)}%" data-index="${pointIndex}"
                title="${escapeHtml(point.isNow ? "Now" : formatHistoryTime(point.at))}"></span>`).join("")
        this.root.innerHTML = `
            ${this.headerHtml(title, subtitle)}
            <div class="fx-history-about" hidden>
                <p>History is reconstructed from timestamps TGLFS already stores; Telegram edits overwrite records, so there are no true snapshots.</p>
                <ul>
                    <li><strong>Exact:</strong> uploads, folder creation, folder deletion, and moves into a folder made with Move.</li>
                    <li><strong>Not recorded:</strong> deleted files (their cards are removed), old names, moves out of a folder, and folder moves (folders are assumed to have been created where they are now).</li>
                    <li>Items marked <em>Maybe</em> were here at some point, but the data can't say exactly when.</li>
                </ul>
            </div>
            <div class="fx-history-scrub">
                <button type="button" class="fx-icon-btn fx-history-step" data-history-prev aria-label="Earlier change" title="Earlier change (←)">${icon("chevronLeft")}</button>
                <div class="fx-history-track" role="slider" tabindex="0" aria-label="Point in time"
                    aria-valuemin="0" aria-valuemax="${last}">
                    <span class="fx-history-rail"></span>
                    <span class="fx-history-fill"></span>
                    ${ticks}
                    <span class="fx-history-thumb"></span>
                </div>
                <button type="button" class="fx-icon-btn fx-history-step" data-history-next aria-label="Later change" title="Later change (→)">${icon("chevronRight")}</button>
            </div>
            <div class="fx-history-axis" aria-hidden="true">
                <span>${escapeHtml(history.points.length > 1 ? formatHistoryDay(first.at) : "")}</span>
                <span>Now</span>
            </div>
            <div class="fx-history-detail"></div>`
        this.wireTrack()
        this.setIndex(index, viewAt)
    }

    /** Shows timeline point `index`; `viewAt` is the exact time viewed when it falls between points. */
    setIndex(index: number, viewAt: number | null = null) {
        if (!this.history) return
        const last = this.history.points.length - 1
        this.index = Math.max(0, Math.min(last, index))
        const point = this.history.points[this.index]
        this.viewAt = viewAt !== null && !point.isNow && viewAt !== point.at ? viewAt : null
        const track = this.root.querySelector<HTMLElement>(".fx-history-track")
        const position = `${this.position(this.index)}%`
        this.root.querySelector<HTMLElement>(".fx-history-thumb")?.style.setProperty("left", position)
        this.root.querySelector<HTMLElement>(".fx-history-fill")?.style.setProperty("width", position)
        this.root.querySelectorAll<HTMLElement>(".fx-history-tick").forEach((tick) => {
            const tickIndex = Number(tick.dataset.index)
            tick.classList.toggle("is-active", tickIndex === this.index)
            tick.classList.toggle("is-past", tickIndex <= this.index)
        })
        if (track) {
            track.setAttribute("aria-valuenow", String(this.index))
            track.setAttribute("aria-valuetext", point.isNow ? "Now" : formatHistoryTime(point.at))
        }
        const prev = this.root.querySelector<HTMLButtonElement>("[data-history-prev]")
        const next = this.root.querySelector<HTMLButtonElement>("[data-history-next]")
        if (prev) prev.disabled = this.index === 0 && !(this.viewAt !== null && this.viewAt > point.at)
        if (next) next.disabled = this.index === last

        const detail = this.root.querySelector<HTMLElement>(".fx-history-detail")
        if (!detail) return
        const offPoint = this.viewAt
        const when = offPoint !== null ? formatHistoryTime(offPoint) : point.isNow ? "Now" : formatHistoryTime(point.at)
        const changes = offPoint !== null
            ? `<span class="fx-history-hint">${offPoint < point.at
                ? "Before the first recorded change."
                : `No change recorded at this exact time; the last one before it was ${escapeHtml(formatHistoryTime(point.at))}.`}</span>`
            : point.changes.length
                ? point.changes.map(changeChip).join("")
                : `<span class="fx-history-hint">${point.isNow ? nowHint() : "No recorded change at this point."}</span>`
        detail.innerHTML = `
            <div class="fx-history-when">
                <span class="fx-history-when-label">${escapeHtml(when)}</span>
                ${point.isNow && offPoint === null ? "" : `<button type="button" class="fx-btn fx-btn-secondary fx-history-now" data-history-now>${icon("history")}Back to now</button>`}
            </div>
            <div class="fx-history-changes">${changes}</div>`
    }

    step(delta: number) {
        if (!this.history) return
        if (this.viewAt !== null && delta < 0 && this.viewAt > this.history.points[this.index].at) {
            // Between points: stepping back lands on the change just before the viewed time.
            this.handlers.onSelect(this.index)
            return
        }
        const next = Math.max(0, Math.min(this.history.points.length - 1, this.index + delta))
        if (next !== this.index) this.handlers.onSelect(next)
    }

    private toggleAbout() {
        const about = this.root.querySelector<HTMLElement>(".fx-history-about")
        if (!about) return
        about.toggleAttribute("hidden")
        this.root.querySelector("[data-history-about]")?.setAttribute("aria-expanded", String(!about.hasAttribute("hidden")))
    }

    private headerHtml(title: string, subtitle: string) {
        return `
            <div class="fx-history-head">
                <span class="fx-history-badge" aria-hidden="true">${icon("history")}</span>
                <div class="fx-history-titles">
                    <div class="fx-history-title">${escapeHtml(title)}</div>
                    <div class="fx-history-sub">${escapeHtml(subtitle)}</div>
                </div>
                <div class="fx-history-legend" aria-hidden="true">
                    <span class="is-added">+ added</span><span class="is-removed">− removed</span><span class="is-changed">~ changed</span>
                </div>
                <button type="button" class="fx-icon-btn" data-history-about aria-expanded="false" aria-label="What history is available" title="What history is available">${icon("info")}</button>
                <button type="button" class="fx-icon-btn" data-history-close aria-label="Close history" title="Close history (Esc)">${icon("close")}</button>
            </div>`
    }

    private position(index: number) {
        const count = this.history?.points.length ?? 1
        return count <= 1 ? 100 : (index / (count - 1)) * 100
    }

    private wireTrack() {
        const track = this.root.querySelector<HTMLElement>(".fx-history-track")
        if (!track || !this.history) return
        const indexFromEvent = (event: PointerEvent) => {
            const rect = track.getBoundingClientRect()
            const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 1
            const count = this.history?.points.length ?? 1
            return Math.round(Math.max(0, Math.min(1, ratio)) * (count - 1))
        }
        track.addEventListener("pointerdown", (event) => {
            this.dragging = true
            track.setPointerCapture(event.pointerId)
            track.classList.add("is-dragging")
            const next = indexFromEvent(event)
            if (next !== this.index) this.handlers.onSelect(next)
        })
        track.addEventListener("pointermove", (event) => {
            if (!this.dragging) return
            const next = indexFromEvent(event)
            if (next !== this.index) this.handlers.onSelect(next)
        })
        const end = () => {
            this.dragging = false
            track.classList.remove("is-dragging")
        }
        track.addEventListener("pointerup", end)
        track.addEventListener("pointercancel", end)
        track.addEventListener("keydown", (event) => {
            if (!this.history) return
            const last = this.history.points.length - 1
            const targets: Record<string, number> = {
                ArrowLeft: this.index - 1,
                ArrowDown: this.index - 1,
                ArrowRight: this.index + 1,
                ArrowUp: this.index + 1,
                Home: 0,
                End: last,
                PageDown: this.index - 5,
                PageUp: this.index + 5,
            }
            if (!(event.key in targets)) return
            event.preventDefault()
            event.stopPropagation()
            const next = Math.max(0, Math.min(last, targets[event.key]))
            if (next !== this.index) this.handlers.onSelect(next)
        })
    }
}

export function renderHistoryBanner(banner: HTMLElement, options: { folderName: string; at: number | null; onBack: () => void }) {
    if (options.at === null) {
        banner.setAttribute("hidden", "")
        banner.innerHTML = ""
        return
    }
    banner.innerHTML = `
        <span class="fx-history-banner-icon" aria-hidden="true">${icon("history")}</span>
        <span class="fx-history-banner-text">Viewing <strong>${escapeHtml(options.folderName)}</strong> as of ${escapeHtml(formatHistoryTime(options.at))}</span>
        <span class="fx-history-banner-sep" aria-hidden="true">·</span>
        <button type="button" class="fx-link fx-history-banner-back">Back to now</button>`
    banner.removeAttribute("hidden")
    banner.querySelector(".fx-history-banner-back")?.addEventListener("click", options.onBack)
}
