// Sidebar storage summary: "1.2 GiB stored · 3,402 files" with a stacked bar by file kind.
//
// The total size needs every file card, so it is computed lazily in the background: sequential pages with a
// pause between them (Telegram rate limits), capped at MAX_SCANNED_CARDS — beyond that the sizes are
// extrapolated from the sample and shown with "≈". The result is cached in sessionStorage and recomputed
// (debounced) after uploads and deletes. Read-only: nothing here writes to Telegram.
import { countFileCards, listFileCards } from "../telegram"
import type { BrowserHooks } from "./browserHooks"
import { escapeHtml } from "./dialogs"
import { icon } from "./icons"
import {
    createStorageAccumulator,
    finalizeStorageSummary,
    formatFileCount,
    formatShare,
    formatStorageBytes,
    formatStorageHeadline,
    clearStorageSummaryCache,
    parseCachedStorageSummary,
    STORAGE_SUMMARY_CACHE_KEY,
    storageSegments,
    type StorageSummary,
} from "./storageStats"

const CACHE_FRESH_MS = 10 * 60 * 1000
const PAGE_SIZE = 100
const PAGE_DELAY_MS = 350
const MAX_SCANNED_CARDS = 5000
const START_DELAY_MS = 1200
const REFRESH_DEBOUNCE_MS = 4000
export const STORAGE_CHANGED_EVENT = "tglfs:storage-changed"

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

function readCache(): StorageSummary | null {
    try {
        return parseCachedStorageSummary(sessionStorage.getItem(STORAGE_SUMMARY_CACHE_KEY), Date.now(), CACHE_FRESH_MS)
    } catch {
        return null
    }
}

function writeCache(summary: StorageSummary) {
    try {
        sessionStorage.setItem(STORAGE_SUMMARY_CACHE_KEY, JSON.stringify(summary))
    } catch {}
}

export function mountStorageSummary(hooks: BrowserHooks) {
    const root = document.getElementById("storageSummary")
    if (!root) return { start() {}, reset() {}, refresh() {} }

    let generation = 0
    let summary: StorageSummary | null = null
    let pendingCount: number | null = null
    let refreshTimer: number | undefined
    let startTimer: number | undefined

    root.innerHTML = `
        <button type="button" class="fx-storage-card" aria-expanded="false" aria-controls="storageLegend" aria-describedby="storageLegend">
            <span class="fx-storage-head">
                <span class="fx-storage-icon" aria-hidden="true">${icon("database")}</span>
                <span class="fx-storage-size"></span>
                <span class="fx-storage-count"></span>
            </span>
            <span class="fx-storage-bar" aria-hidden="true"></span>
            <span class="fx-storage-help">Free, unlimited Telegram storage</span>
        </button>
        <div id="storageLegend" class="fx-storage-legend" role="tooltip"></div>`
    const card = root.querySelector<HTMLButtonElement>(".fx-storage-card")!
    const sizeEl = root.querySelector<HTMLElement>(".fx-storage-size")!
    const countEl = root.querySelector<HTMLElement>(".fx-storage-count")!
    const barEl = root.querySelector<HTMLElement>(".fx-storage-bar")!
    const legendEl = root.querySelector<HTMLElement>(".fx-storage-legend")!

    const setOpen = (open: boolean) => {
        root.classList.toggle("is-open", open)
        card.setAttribute("aria-expanded", String(open))
    }
    card.addEventListener("click", () => setOpen(!root.classList.contains("is-open")))
    document.addEventListener("pointerdown", (event) => {
        if (!root.contains(event.target as Node)) setOpen(false)
    }, { capture: true, passive: true })
    root.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && root.classList.contains("is-open")) {
            event.stopPropagation()
            setOpen(false)
        }
    })

    const render = () => {
        root.removeAttribute("hidden")
        if (!summary) {
            root.classList.add("is-loading")
            sizeEl.innerHTML = `<span class="fx-skel fx-skel-line"></span>`
            countEl.textContent = pendingCount !== null ? formatFileCount(pendingCount) : ""
            barEl.innerHTML = `<span class="fx-storage-shimmer fx-skel"></span>`
            legendEl.innerHTML = `<div class="fx-storage-legend-note">Adding up your files…</div>`
            card.setAttribute("aria-label", "Storage summary, calculating")
            return
        }
        root.classList.remove("is-loading")
        const headline = formatStorageHeadline(summary)
        const segments = storageSegments(summary)
        if (summary.files === 0) {
            sizeEl.textContent = "Nothing stored yet"
            countEl.textContent = ""
        } else {
            sizeEl.textContent = headline.size
            countEl.textContent = headline.files
        }
        barEl.innerHTML = segments.map((segment) =>
            `<span class="fx-storage-seg fx-ficon--${segment.kind}" style="flex-grow:${segment.fraction.toFixed(5)}"></span>`,
        ).join("")
        legendEl.innerHTML = segments.length
            ? `${segments.map((segment) => `
                <div class="fx-storage-legend-row">
                    <span class="fx-storage-dot fx-ficon--${segment.kind}"></span>
                    <span class="fx-storage-legend-label">${escapeHtml(segment.label)}</span>
                    <span class="fx-storage-legend-size">${escapeHtml(formatStorageBytes(segment.bytes))}</span>
                    <span class="fx-storage-legend-share">${escapeHtml(formatShare(segment.fraction))}</span>
                </div>`).join("")}
                ${summary.approximate ? `<div class="fx-storage-legend-note">Estimated from your ${MAX_SCANNED_CARDS.toLocaleString("en-US")} newest files</div>` : ""}`
            : `<div class="fx-storage-legend-note">Upload something to see it here.</div>`
        const parts = segments.map((segment) => `${segment.label} ${formatShare(segment.fraction)}`).join(", ")
        card.setAttribute("aria-label", `${headline.size}, ${headline.files}${parts ? `. ${parts}` : ""}`)
    }

    const compute = async () => {
        const run = ++generation
        const client = hooks.getClient()
        if (!client) return
        const countPromise = countFileCards(client).catch(() => null)
        void countPromise.then((count) => {
            if (run !== generation || summary) return
            pendingCount = count
            render()
        })
        const accumulator = createStorageAccumulator()
        let offsetId: number | undefined
        let exhausted = false
        try {
            while (accumulator.scanned < MAX_SCANNED_CARDS) {
                const page = await listFileCards(client, { limit: PAGE_SIZE, offsetId })
                if (run !== generation) return
                accumulator.add(page)
                if (page.length < PAGE_SIZE) {
                    exhausted = true
                    break
                }
                const nextOffset = page[page.length - 1].msgId
                if (nextOffset === offsetId) {
                    exhausted = true
                    break
                }
                offsetId = nextOffset
                await sleep(PAGE_DELAY_MS)
                if (run !== generation) return
            }
        } catch (error) {
            console.warn("Storage summary stopped early", error)
            if (run !== generation) return
            if (accumulator.scanned === 0) {
                if (!summary) root.setAttribute("hidden", "")
                return
            }
        }
        const serverCount = await countPromise
        if (run !== generation) return
        summary = finalizeStorageSummary(accumulator.totals(), { exhausted, serverCount })
        writeCache(summary)
        render()
    }

    const start = (delayMs: number) => {
        window.clearTimeout(startTimer)
        startTimer = window.setTimeout(() => {
            const idle = (window as any).requestIdleCallback as ((cb: () => void, opts?: { timeout: number }) => void) | undefined
            if (idle) idle(() => void compute(), { timeout: 2000 })
            else void compute()
        }, delayMs)
    }

    const scheduleRefresh = () => {
        window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => {
            if (!hooks.isBrowserVisible()) return
            start(0)
        }, REFRESH_DEBOUNCE_MS)
    }
    window.addEventListener("tglfs:refresh-browser", scheduleRefresh)
    window.addEventListener(STORAGE_CHANGED_EVENT, scheduleRefresh)

    let started = false
    const begin = () => {
        summary = readCache()
        pendingCount = null
        render()
    }
    begin()

    return {
        /** Starts the background scan (once), unless a fresh cached summary exists. */
        start() {
            if (started) return
            started = true
            if (!summary) start(START_DELAY_MS)
        },
        /** A different account signed in: forget everything and recompute. */
        reset() {
            generation++
            clearStorageSummaryCache()
            begin()
            started = true
            start(START_DELAY_MS)
        },
        refresh: scheduleRefresh,
    }
}
