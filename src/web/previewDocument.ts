/**
 * Document views for the preview modal: line-numbered text/code viewer, rendered Markdown, CSV tables, PDF, and
 * the "too large" / "not text" fallbacks. Pure rendering lives in `textRender.ts`; this module builds the DOM.
 */
import { icon } from "./icons"
import { escapeHtml } from "./dialogs"
import {
    CSV_PREVIEW_MAX_ROWS,
    MARKDOWN_RENDER_MAX_BYTES,
    previewFormatLabel,
    type PreviewFileType,
} from "./previewTypes"
import {
    decodeTextBytes,
    detectDelimiter,
    parseDelimited,
    prettyJson,
    renderMarkdown,
    splitLines,
} from "./textRender"

const LINES_PER_BLOCK = 400
const VIEW_STORAGE_KEY = "tglfs.preview.docView"

function formatBytes(size: number) {
    if (!Number.isFinite(size) || size <= 0) return "0 B"
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
    const value = size / Math.pow(1024, index)
    return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1).replace(/\.0$/, "")}\u00a0${units[index]}`
}

function readViewPreference(type: string): string | null {
    try {
        return localStorage.getItem(`${VIEW_STORAGE_KEY}.${type}`)
    } catch {
        return null
    }
}

function writeViewPreference(type: string, value: string) {
    try {
        localStorage.setItem(`${VIEW_STORAGE_KEY}.${type}`, value)
    } catch {}
}

/** Keeps horizontal swipes inside horizontally scrollable content (wide tables) from flipping to the next file. */
function containHorizontalSwipes(element: HTMLElement) {
    const stop = (event: TouchEvent) => {
        const scrollable = (event.target as HTMLElement).closest<HTMLElement>(".preview-doc-table, .md-table-wrap, .md-code")
        if (scrollable && scrollable.scrollWidth > scrollable.clientWidth + 2) event.stopPropagation()
    }
    element.addEventListener("touchstart", stop, { passive: true })
    element.addEventListener("touchend", stop, { passive: true })
}

function codeViewHtml(text: string) {
    const lines = splitLines(text)
    const gutter = Math.max(2, String(lines.length).length)
    const blocks: string[] = []
    for (let start = 0; start < lines.length; start += LINES_PER_BLOCK) {
        const slice = lines.slice(start, start + LINES_PER_BLOCK)
        const html = slice
            .map((line, offset) => `<div class="fx-code-line" data-ln="${start + offset + 1}">${escapeHtml(line)}</div>`)
            .join("")
        blocks.push(`<div class="fx-code-block" style="contain-intrinsic-size: auto ${slice.length * 21}px">${html}</div>`)
    }
    return { html: `<div class="fx-code" style="--gutter:${gutter + 1}ch">${blocks.join("")}</div>`, lines: lines.length }
}

function csvTableHtml(text: string, name: string) {
    const delimiter = detectDelimiter(text, name)
    const table = parseDelimited(text, delimiter, CSV_PREVIEW_MAX_ROWS + 1)
    const [header = [], ...rows] = table.rows
    const columns = Math.max(table.columns, header.length)
    const cells = (row: string[], tag: "th" | "td") =>
        Array.from({ length: columns }, (_, column) => `<${tag}>${escapeHtml(row[column] ?? "")}</${tag}>`).join("")
    const body = rows
        .map((row, index) => `<tr><th class="preview-doc-rownum" scope="row">${index + 1}</th>${cells(row, "td")}</tr>`)
        .join("")
    const dataRows = Math.max(0, table.totalRows - 1)
    const note = table.truncated
        ? `Showing first ${rows.length.toLocaleString()} of ${dataRows.toLocaleString()} rows`
        : `${dataRows.toLocaleString()} ${dataRows === 1 ? "row" : "rows"} · ${columns} ${columns === 1 ? "column" : "columns"}`
    return {
        html: `<div class="preview-doc-table"><table><thead><tr><th class="preview-doc-rownum"></th>${cells(header, "th")}</tr></thead><tbody>${body}</tbody></table></div>`,
        note,
    }
}

type ViewOption = { key: string; label: string; render: () => { html: string; note: string; className: string } }

export type DocumentPreviewOptions = {
    name: string
    type: PreviewFileType
    bytes: Uint8Array
    onDownload: () => void
}

/** Renders a decrypted text-like file into `host`. */
export function renderTextDocument(host: HTMLElement, options: DocumentPreviewOptions) {
    const decoded = decodeTextBytes(options.bytes)
    if (decoded.binary) {
        renderNotice(host, {
            icon: "file",
            title: "This file doesn't look like text",
            message: `${options.name} contains binary data, so it can't be shown here. Download it to open it with another app.`,
            actionLabel: "Download",
            onAction: options.onDownload,
        })
        return
    }
    const text = decoded.text
    const lines = () => codeViewHtml(text)
    const source = (): ReturnType<ViewOption["render"]> => {
        const view = lines()
        return { html: view.html, note: `${view.lines.toLocaleString()} ${view.lines === 1 ? "line" : "lines"} · ${decoded.encoding}`, className: "is-code" }
    }
    const views: ViewOption[] = []
    if (options.type === "markdown") {
        if (options.bytes.length <= MARKDOWN_RENDER_MAX_BYTES) {
            views.push({
                key: "rendered",
                label: "Preview",
                render: () => {
                    const words = text.split(/\s+/).filter(Boolean).length
                    return {
                        html: `<article class="md-body">${renderMarkdown(text)}</article>`,
                        note: `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`,
                        className: "is-markdown",
                    }
                },
            })
        }
        views.push({ key: "source", label: "Source", render: source })
    } else if (options.type === "csv") {
        views.push({
            key: "table",
            label: "Table",
            render: () => {
                const table = csvTableHtml(text, options.name)
                return { html: table.html, note: table.note, className: "is-table" }
            },
        })
        views.push({ key: "source", label: "Source", render: source })
    } else if (options.type === "json") {
        const pretty = text.length <= 2 * 1024 * 1024 ? prettyJson(text) : null
        if (pretty !== null && pretty !== text) {
            views.push({
                key: "formatted",
                label: "Formatted",
                render: () => {
                    const view = codeViewHtml(pretty)
                    return { html: view.html, note: `Formatted · ${view.lines.toLocaleString()} lines`, className: "is-code" }
                },
            })
        }
        views.push({ key: "source", label: pretty !== null && pretty !== text ? "Raw" : "Source", render: source })
    } else {
        views.push({ key: "source", label: "Source", render: source })
    }

    const preferred = readViewPreference(options.type)
    let current = views.find((view) => view.key === preferred) ?? views[0]

    host.innerHTML = `
        <div class="preview-doc" data-doc-type="${escapeHtml(options.type)}">
            <div class="preview-doc-bar">
                <span class="preview-doc-chip">${escapeHtml(previewFormatLabel(options.name, options.type))}</span>
                <span class="preview-doc-note"></span>
                ${views.length > 1 ? `<div class="preview-doc-toggle" role="group" aria-label="View">${views
                    .map((view) => `<button type="button" data-doc-view="${view.key}">${escapeHtml(view.label)}</button>`)
                    .join("")}</div>` : ""}
            </div>
            <div class="preview-doc-body" tabindex="0" aria-label="${escapeHtml(options.name)}"></div>
        </div>`
    const body = host.querySelector<HTMLElement>(".preview-doc-body")!
    const note = host.querySelector<HTMLElement>(".preview-doc-note")!
    const show = (view: ViewOption) => {
        current = view
        const rendered = view.render()
        body.className = `preview-doc-body ${rendered.className}`
        body.innerHTML = rendered.html
        body.scrollTop = 0
        note.textContent = rendered.note
        host.querySelectorAll<HTMLButtonElement>("[data-doc-view]").forEach((button) => {
            const active = button.dataset.docView === view.key
            button.classList.toggle("is-active", active)
            button.setAttribute("aria-pressed", String(active))
        })
    }
    host.querySelector(".preview-doc-toggle")?.addEventListener("click", (event) => {
        const key = (event.target as HTMLElement).closest<HTMLElement>("[data-doc-view]")?.dataset.docView
        const view = views.find((candidate) => candidate.key === key)
        if (!view || view === current) return
        writeViewPreference(options.type, view.key)
        show(view)
    })
    containHorizontalSwipes(body)
    show(current)
    body.focus({ preventScroll: true })
}

function isMobilePlatform() {
    const ua = navigator.userAgent
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return true
    // iPadOS reports itself as a Mac.
    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

/** Inline PDFs use the browser's built-in viewer; phones/tablets (poor inline PDF) get an "Open PDF" button. */
export function renderPdfDocument(host: HTMLElement, options: { name: string; size: number; url: string; onOpenExternally: () => void }) {
    const inline = (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false && !isMobilePlatform()
    if (inline) {
        host.innerHTML = `<div class="preview-doc preview-doc--pdf"><iframe class="preview-pdf-frame" title="${escapeHtml(options.name)}"></iframe></div>`
        // Open with the thumbnail pane collapsed and the page fitted to the width (ignored by viewers without support).
        host.querySelector<HTMLIFrameElement>("iframe")!.src = `${options.url}#navpanes=0&view=FitH`
        return
    }
    renderNotice(host, {
        icon: "fileText",
        title: options.name,
        message: `PDF · ${formatBytes(options.size)}`,
        actionLabel: "Open PDF",
        actionIcon: "open",
        onAction: () => {
            options.onOpenExternally()
            // An anchor click (inside the user's tap) opens blob URLs reliably on iOS, unlike window.open.
            const link = document.createElement("a")
            link.href = options.url
            link.target = "_blank"
            document.body.appendChild(link)
            link.click()
            link.remove()
        },
        tone: "pdf",
    })
}

export function renderTooLarge(host: HTMLElement, options: { name: string; size: number; limit: number; onDownload: () => void }) {
    renderNotice(host, {
        icon: "fileText",
        title: "Too large to preview",
        message: `Previews are limited to ${formatBytes(options.limit)} and ${options.name} is ${formatBytes(options.size)}. Download it instead.`,
        actionLabel: "Download",
        actionIcon: "download",
        onAction: options.onDownload,
    })
}

function renderNotice(host: HTMLElement, options: {
    icon: "file" | "fileText"
    title: string
    message: string
    actionLabel: string
    actionIcon?: "download" | "open"
    onAction: () => void
    tone?: "pdf"
}) {
    host.innerHTML = `
        <div class="preview-notice${options.tone ? ` preview-notice--${options.tone}` : ""}">
            <span class="preview-notice-art">${icon(options.icon)}</span>
            <h4 class="preview-notice-title">${escapeHtml(options.title)}</h4>
            <p class="preview-notice-text">${escapeHtml(options.message)}</p>
            <button type="button" class="fx-btn fx-btn-primary preview-notice-action">${icon(options.actionIcon ?? "download")}${escapeHtml(options.actionLabel)}</button>
        </div>`
    host.querySelector(".preview-notice-action")?.addEventListener("click", options.onAction)
}
