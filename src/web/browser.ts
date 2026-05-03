import * as Config from "../config"
import {
    formatFileCardDate,
    formatFileCardSize,
} from "../../packages/tglfs-cli/src/shared/file-cards"
import {
    downloadFileCard,
    getFileCardByUfid,
    getFolderManifest,
    getFolderRecord,
    listFileCards,
    listFolderRecords,
    renameFileCard,
    deleteFileCard,
    sendFileCard,
    writeFolderManifest,
    writeFolderRecord,
} from "../telegram"
import type { FileCardData } from "../types/models"
import {
    createTglfsFolder,
    createTglfsFolderManifest,
    TGLFS_FOLDER_TYPE,
    TGLFS_FOLDER_VERSION,
} from "../../packages/tglfs-cli/src/folders"
import type { TglfsFolder, TglfsFolderManifest, TglfsFolderManifestEntry, TglfsFolderManifestRecord, TglfsFolderRecord } from "../../packages/tglfs-cli/src/folders"
import { PreviewModal, type PreviewEntry } from "./preview"

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"])
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"])
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"])
const DOC_EXTS = new Set(["pdf", "doc", "docx", "txt", "rtf", "md"])
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz"])
const CODE_EXTS = new Set(["js", "ts", "py", "go", "rs", "c", "cpp", "h"])

type SortMode = "date_desc" | "date_asc" | "name_asc" | "name_desc" | "size_desc" | "size_asc"

type FileBrowserEntry = {
    kind: "file"
    id: string
    msgId: number
    date: number
    data: FileCardData
}

type FolderBrowserEntry = {
    kind: "folder"
    id: string
    msgId: number
    date: number
    data: TglfsFolder
}

type MissingFileBrowserEntry = {
    kind: "missing-file"
    id: string
    date: number
    name: string
    path: string
    ufid: string
    size: number
}

type BrowserEntry = FileBrowserEntry | FolderBrowserEntry | MissingFileBrowserEntry

type BrowserState = {
    initialized: boolean
    query: string
    sort: SortMode
    viewMode: "list" | "grid"
    pageSize: number
    currentPage: number
    pages: BrowserEntry[][]
    lastOffsetId: number | undefined
    selected: Map<string, BrowserEntry>
    lastClickedIndex: number | null
    hasMore: boolean
    currentFolder: FolderBrowserEntry | null
    currentFolderTrail: FolderBrowserEntry[]
}

const state: BrowserState = {
    initialized: false,
    query: "",
    sort: "date_desc",
    viewMode: "list",
    pageSize: 50,
    currentPage: 0,
    pages: [],
    lastOffsetId: undefined,
    selected: new Map(),
    lastClickedIndex: null,
    hasMore: true,
    currentFolder: null,
    currentFolderTrail: [],
}

let previewModal: PreviewModal | null = null
let ufidToastTimer: number | undefined
let activeBrowserClient: any = null
let refreshBrowser: (() => Promise<void>) | null = null

type BrowserDialogOptions = {
    title: string
    message?: string
    label?: string
    initialValue?: string
    confirmLabel?: string
    cancelLabel?: string
    inputType?: string
    allowEmpty?: boolean
    danger?: boolean
}

type BrowserChoiceOption = {
    value: string
    label: string
    detail?: string
}

type MoveDestination =
    | { kind: "folder"; record: TglfsFolderRecord; label: string }
    | { kind: "root"; label: string }

const ROOT_MOVE_DESTINATION = "__tglfs-root__"

function getExtension(name: string): string {
    const parts = name.toLowerCase().split(".")
    if (parts.length < 2) return ""
    return parts.pop() ?? ""
}

function getFileTypeIcon(name: string): string {
    const ext = getExtension(name)
    if (IMAGE_EXTS.has(ext)) return "🖼️"
    if (VIDEO_EXTS.has(ext)) return "🎬"
    if (AUDIO_EXTS.has(ext)) return "🎵"
    if (DOC_EXTS.has(ext)) return "📄"
    if (ARCHIVE_EXTS.has(ext)) return "📦"
    if (CODE_EXTS.has(ext)) return "💻"
    return "📄"
}

function isPreviewableName(name: string): boolean {
    const ext = getExtension(name)
    return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (char) => {
        switch (char) {
            case "&":
                return "&amp;"
            case "<":
                return "&lt;"
            case ">":
                return "&gt;"
            case "\"":
                return "&quot;"
            default:
                return "&#39;"
        }
    })
}

function showUfidToast(message: string) {
    const toast = document.getElementById("ufidToast")
    if (!toast) return
    toast.textContent = message
    toast.setAttribute("aria-hidden", "false")
    toast.classList.remove("is-visible")
    void toast.offsetWidth
    toast.classList.add("is-visible")
    if (ufidToastTimer !== undefined) {
        window.clearTimeout(ufidToastTimer)
    }
    ufidToastTimer = window.setTimeout(() => {
        toast.classList.remove("is-visible")
        toast.setAttribute("aria-hidden", "true")
    }, 1200)
}

function closeBrowserDialog(dialog: HTMLElement) {
    dialog.remove()
}

function requestBrowserText(options: BrowserDialogOptions): Promise<string | null> {
    return new Promise((resolve) => {
        const dialog = document.createElement("div")
        dialog.className = "browser-dialog-backdrop"
        dialog.innerHTML = `
            <div class="browser-dialog" role="dialog" aria-modal="true" aria-labelledby="browserDialogTitle">
                <h2 id="browserDialogTitle">${escapeHtml(options.title)}</h2>
                ${options.message ? `<p>${escapeHtml(options.message)}</p>` : ""}
                <label class="form-label" for="browserDialogInput">${escapeHtml(options.label ?? "Value")}</label>
                <input id="browserDialogInput" class="form-control" type="${escapeHtml(options.inputType ?? "text")}" value="${escapeHtml(options.initialValue ?? "")}" />
                <div class="browser-dialog-actions">
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-dialog-cancel>${escapeHtml(options.cancelLabel ?? "Cancel")}</button>
                    <button type="button" class="btn btn-sm btn-primary" data-dialog-confirm>${escapeHtml(options.confirmLabel ?? "Save")}</button>
                </div>
            </div>`
        document.body.appendChild(dialog)
        const input = dialog.querySelector<HTMLInputElement>("#browserDialogInput")
        const confirmButton = dialog.querySelector<HTMLButtonElement>("[data-dialog-confirm]")
        const cancelButton = dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")

        const finish = (value: string | null) => {
            closeBrowserDialog(dialog)
            resolve(value)
        }
        const submit = () => {
            const value = input?.value ?? ""
            if (!options.allowEmpty && value.trim() === "") {
                input?.focus()
                return
            }
            finish(value)
        }

        confirmButton?.addEventListener("click", submit)
        cancelButton?.addEventListener("click", () => finish(null))
        dialog.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault()
                finish(null)
            }
            if (event.key === "Enter") {
                event.preventDefault()
                submit()
            }
        })
        window.setTimeout(() => {
            input?.focus()
            input?.select()
        }, 0)
    })
}

function requestBrowserConfirm(options: BrowserDialogOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const dialog = document.createElement("div")
        dialog.className = "browser-dialog-backdrop"
        dialog.innerHTML = `
            <div class="browser-dialog" role="dialog" aria-modal="true" aria-labelledby="browserDialogTitle">
                <h2 id="browserDialogTitle">${escapeHtml(options.title)}</h2>
                ${options.message ? `<p>${escapeHtml(options.message)}</p>` : ""}
                <div class="browser-dialog-actions">
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-dialog-cancel>${escapeHtml(options.cancelLabel ?? "Cancel")}</button>
                    <button type="button" class="btn btn-sm ${options.danger ? "btn-danger" : "btn-primary"}" data-dialog-confirm>${escapeHtml(options.confirmLabel ?? "Confirm")}</button>
                </div>
            </div>`
        document.body.appendChild(dialog)
        const confirmButton = dialog.querySelector<HTMLButtonElement>("[data-dialog-confirm]")
        const cancelButton = dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")
        const finish = (value: boolean) => {
            closeBrowserDialog(dialog)
            resolve(value)
        }
        confirmButton?.addEventListener("click", () => finish(true))
        cancelButton?.addEventListener("click", () => finish(false))
        dialog.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault()
                finish(false)
            }
            if (event.key === "Enter") {
                event.preventDefault()
                finish(true)
            }
        })
        window.setTimeout(() => confirmButton?.focus(), 0)
    })
}

function requestBrowserChoice(options: BrowserDialogOptions & { choices: BrowserChoiceOption[] }): Promise<string | null> {
    return new Promise((resolve) => {
        const dialog = document.createElement("div")
        dialog.className = "browser-dialog-backdrop"
        const choices = options.choices.map((choice) => `
            <option value="${escapeHtml(choice.value)}">${escapeHtml(choice.detail ? `${choice.label} - ${choice.detail}` : choice.label)}</option>
        `).join("")
        dialog.innerHTML = `
            <div class="browser-dialog" role="dialog" aria-modal="true" aria-labelledby="browserDialogTitle">
                <h2 id="browserDialogTitle">${escapeHtml(options.title)}</h2>
                ${options.message ? `<p>${escapeHtml(options.message)}</p>` : ""}
                <label class="form-label" for="browserDialogSelect">${escapeHtml(options.label ?? "Destination")}</label>
                <select id="browserDialogSelect" class="form-select">${choices}</select>
                <div class="browser-dialog-actions">
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-dialog-cancel>${escapeHtml(options.cancelLabel ?? "Cancel")}</button>
                    <button type="button" class="btn btn-sm btn-primary" data-dialog-confirm>${escapeHtml(options.confirmLabel ?? "Choose")}</button>
                </div>
            </div>`
        document.body.appendChild(dialog)
        const select = dialog.querySelector<HTMLSelectElement>("#browserDialogSelect")
        const confirmButton = dialog.querySelector<HTMLButtonElement>("[data-dialog-confirm]")
        const cancelButton = dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")
        const finish = (value: string | null) => {
            closeBrowserDialog(dialog)
            resolve(value)
        }
        confirmButton?.addEventListener("click", () => finish(select?.value ?? null))
        cancelButton?.addEventListener("click", () => finish(null))
        dialog.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault()
                finish(null)
            }
            if (event.key === "Enter") {
                event.preventDefault()
                finish(select?.value ?? null)
            }
        })
        window.setTimeout(() => select?.focus(), 0)
    })
}

function clearViews() {
    const tbody = document.querySelector<HTMLTableSectionElement>("#browserTable tbody")
    if (tbody) tbody.innerHTML = ""
    const grid = document.getElementById("browserGrid")
    if (grid) grid.innerHTML = ""
}

function getVisibleItems() {
    return state.pages[state.currentPage] ?? []
}

function getVisiblePreviewEntries(): PreviewEntry[] {
    return getVisibleItems().filter(isFileEntry).map((entry) => ({
        msgId: entry.msgId,
        date: entry.date,
        data: entry.data,
    }))
}

function isFileEntry(entry: BrowserEntry): entry is FileBrowserEntry {
    return entry.kind === "file"
}

function isFolderEntry(entry: BrowserEntry): entry is FolderBrowserEntry {
    return entry.kind === "folder"
}

function getEntryName(entry: BrowserEntry) {
    if (entry.kind === "file") return entry.data.name
    if (entry.kind === "folder") return entry.data.name
    return entry.name
}

function getEntrySize(entry: BrowserEntry) {
    if (entry.kind === "file") return entry.data.size
    if (entry.kind === "missing-file") return entry.size
    return 0
}

function getEntryDate(entry: BrowserEntry) {
    return entry.date
}

function getEntryPath(entry: BrowserEntry) {
    if (entry.kind === "folder") return entry.data.path
    if (entry.kind === "missing-file") return entry.path
    return ""
}

function getEntryIcon(entry: BrowserEntry) {
    if (entry.kind === "folder") return "📁"
    return getFileTypeIcon(getEntryName(entry))
}

function getEntrySizeText(entry: BrowserEntry) {
    if (entry.kind === "folder") return "Folder"
    return formatFileCardSize(getEntrySize(entry))
}

function getEntryStatus(entry: BrowserEntry) {
    if (entry.kind === "folder") return { label: "Folder", className: "folder" }
    if (entry.kind === "missing-file") return { label: "Missing", className: "missing" }
    return {
        label: entry.data.uploadComplete ? "Complete" : "Incomplete",
        className: entry.data.uploadComplete ? "complete" : "incomplete",
    }
}

function getCopyId(entry: BrowserEntry) {
    if (entry.kind === "file") return { label: "UFID", value: entry.data.ufid }
    if (entry.kind === "folder") return { label: "Folder ID", value: entry.data.folderId }
    return { label: "UFID", value: entry.ufid }
}

function applySort(items: BrowserEntry[]) {
    items.sort((a, b) => {
        switch (state.sort) {
            case "date_desc":
                return getEntryDate(b) - getEntryDate(a)
            case "date_asc":
                return getEntryDate(a) - getEntryDate(b)
            case "name_asc":
                return getEntryName(a).localeCompare(getEntryName(b))
            case "name_desc":
                return getEntryName(b).localeCompare(getEntryName(a))
            case "size_desc":
                return getEntrySize(b) - getEntrySize(a)
            case "size_asc":
                return getEntrySize(a) - getEntrySize(b)
        }
    })
}

function applyGridMarquee(item: HTMLElement) {
    const nameEl = item.querySelector<HTMLElement>(".file-name")
    const textEl = item.querySelector<HTMLElement>(".file-name-text")
    const scrollEl = item.querySelector<HTMLElement>(".file-name-scroll")
    if (!nameEl || !textEl || !scrollEl) return
    requestAnimationFrame(() => {
        nameEl.classList.remove("is-marquee")
        nameEl.style.removeProperty("--marquee-distance")
        nameEl.style.removeProperty("--marquee-duration")
        const overflow = scrollEl.scrollWidth - textEl.clientWidth
        if (overflow > 8) {
            const gap = 24
            const distance = overflow + gap
            const duration = Math.max(6, distance / 24)
            nameEl.classList.add("is-marquee")
            nameEl.style.setProperty("--marquee-distance", `${distance}px`)
            nameEl.style.setProperty("--marquee-duration", `${duration}s`)
            nameEl.style.setProperty("--marquee-gap", `${gap}px`)
        }
    })
}

async function openFolder(entry: FolderBrowserEntry) {
    const trail = await buildFolderTrail(entry)
    state.currentFolderTrail = trail.length ? trail : [entry]
    state.currentFolder = state.currentFolderTrail[state.currentFolderTrail.length - 1] ?? entry
    state.query = ""
    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement | null
    if (searchInput) searchInput.value = ""
    await refreshBrowser?.()
}

async function buildFolderTrail(entry: FolderBrowserEntry): Promise<FolderBrowserEntry[]> {
    const client = activeBrowserClient
    if (!client) return [entry]

    const records: TglfsFolderRecord[] = []
    let current: TglfsFolderRecord | null = await resolveFolderRecordForMutation(client, entry)
    if (!current) {
        current = {
            msgId: entry.msgId,
            date: entry.date,
            data: entry.data,
        }
    }

    const seen = new Set<string>()
    while (current && !seen.has(current.data.folderId)) {
        records.unshift(current)
        seen.add(current.data.folderId)
        current = current.data.parentFolderId ? await getFolderRecord(client, current.data.parentFolderId) : null
    }

    return records.map(folderEntryFromRecord)
}

async function openBreadcrumbFolder(index: number) {
    const entry = state.currentFolderTrail[index]
    if (!entry) return
    state.currentFolderTrail = state.currentFolderTrail.slice(0, index + 1)
    state.currentFolder = entry
    state.query = ""
    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement | null
    if (searchInput) searchInput.value = ""
    await refreshBrowser?.()
}

async function openGlobalView() {
    state.currentFolder = null
    state.currentFolderTrail = []
    state.query = ""
    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement | null
    if (searchInput) searchInput.value = ""
    await refreshBrowser?.()
}

function createRecordId(prefix: string) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID()
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function validateFolderName(value: string | null): string | null {
    const name = value?.trim() ?? ""
    if (!name) return null
    if (name === "." || name === ".." || /[\\/]/.test(name) || /[\u0000-\u001f]/.test(name)) {
        showUfidToast("Invalid folder name")
        return null
    }
    return name
}

function joinFolderPath(parentPath: string, name: string) {
    return parentPath ? `${parentPath}/${name}` : name
}

function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string) {
    if (!oldPrefix) return path
    if (path === oldPrefix) return newPrefix
    if (path.startsWith(`${oldPrefix}/`)) {
        return `${newPrefix}${path.slice(oldPrefix.length)}`
    }
    return path
}

function activeManifestEntryNames(manifest: TglfsFolderManifest) {
    return new Set(
        Object.values(manifest.entries)
            .filter((entry) => !entry.deleted)
            .map((entry) => entry.name.toLowerCase()),
    )
}

function assertFolderNameAvailable(name: string, entries: Iterable<string>) {
    const lower = name.toLowerCase()
    for (const entry of entries) {
        if (entry.toLowerCase() === lower) {
            showUfidToast(`"${name}" already exists here`)
            return false
        }
    }
    return true
}

function attachSelectionHandlers(root: HTMLElement, entry: BrowserEntry, index: number) {
    root.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null
        if (target?.closest("button, a, code")) return
        toggleSelection(entry, index)
    })
    root.addEventListener("dblclick", async (e) => {
        const target = e.target as HTMLElement | null
        if (target?.closest("button, a, code")) return
        if (isFolderEntry(entry)) {
            e.preventDefault()
            await openFolder(entry)
        }
    })
}

async function attachCopyHandler(root: HTMLElement, entry: BrowserEntry) {
    const idEl = root.querySelector<HTMLElement>("[data-copy-id]")
    if (!idEl) return
    idEl.addEventListener("click", async () => {
        const copy = getCopyId(entry)
        try {
            await navigator.clipboard.writeText(copy.value)
            showUfidToast(`${copy.label} copied to clipboard`)
        } catch {
            showUfidToast(`Unable to copy ${copy.label.toLowerCase()}`)
        }
    })
}

function renderList(items: BrowserEntry[]) {
    const tbody = document.querySelector<HTMLTableSectionElement>("#browserTable tbody")
    for (const [index, entry] of items.entries()) {
        const icon = getEntryIcon(entry)
        const name = escapeHtml(getEntryName(entry))
        const path = getEntryPath(entry)
        const pathHtml = path ? `<div class="entry-subtitle">${escapeHtml(path)}</div>` : ""
        const date = formatFileCardDate(getEntryDate(entry))
        const status = getEntryStatus(entry)
        const copy = getCopyId(entry)
        const copyTitle = `Click to copy ${copy.label}`

        if (tbody) {
            const tr = document.createElement("tr")
            tr.dataset.browserId = entry.id
            if (isFileEntry(entry)) tr.dataset.msgid = String(entry.msgId)
            tr.innerHTML = `
                <td class="name"><span class="entry-name-cell"><span class="file-type-icon">${icon}</span><span><span>${name}</span>${pathHtml}</span></span></td>
                <td class="size">${getEntrySizeText(entry)}</td>
                <td class="ufid"><code title="${copyTitle}" data-copy-id>${escapeHtml(copy.value)}</code></td>
                <td class="date">${date}</td>
                <td class="status"><span class="pill ${status.className}">${status.label}</span></td>`
            tbody.appendChild(tr)
            attachSelectionHandlers(tr, entry, index)
            void attachCopyHandler(tr, entry)
        }
    }
}

function renderGrid(items: BrowserEntry[]) {
    const grid = document.getElementById("browserGrid")
    if (!grid) return
    for (const [index, entry] of items.entries()) {
        const icon = getEntryIcon(entry)
        const item = document.createElement("div")
        item.className = "file-grid-item fade-in"
        item.dataset.browserId = entry.id
        if (isFileEntry(entry)) item.dataset.msgid = String(entry.msgId)
        const name = escapeHtml(getEntryName(entry))
        const date = formatFileCardDate(getEntryDate(entry)).split(" ")[0]
        item.innerHTML = `
            <div class="file-icon">${icon}</div>
            <div class="file-info">
                <div class="file-name" title="${name}">
                    <span class="file-name-text"><span class="file-name-scroll">${name}</span></span>
                </div>
                <div class="file-meta">
                    <span>${getEntrySizeText(entry)}</span>
                    <span class="dot-separator">•</span>
                    <span>${date}</span>
                </div>
            </div>`
        grid.appendChild(item)
        attachSelectionHandlers(item, entry, index)
        applyGridMarquee(item)
    }
}

function updateFolderLocation() {
    const breadcrumb = document.getElementById("browserBreadcrumb")
    const pathEl = document.getElementById("browserPathCrumbs")
    if (!breadcrumb || !pathEl) return
    breadcrumb.removeAttribute("hidden")
    pathEl.textContent = ""
    if (!state.currentFolder) {
        return
    }

    const trail = state.currentFolderTrail.length ? state.currentFolderTrail : [state.currentFolder]
    for (const [index, folder] of trail.entries()) {
        const separator = document.createElement("span")
        separator.className = "fx-breadcrumb-separator"
        separator.textContent = "/"
        pathEl.appendChild(separator)

        const isCurrent = index === trail.length - 1
        if (isCurrent) {
            const current = document.createElement("span")
            current.className = "fx-breadcrumb-current"
            current.textContent = folder.data.name
            pathEl.appendChild(current)
            continue
        }

        const button = document.createElement("button")
        button.type = "button"
        button.className = "btn btn-sm btn-link fx-breadcrumb-segment"
        button.textContent = folder.data.name
        button.addEventListener("click", () => {
            void openBreadcrumbFolder(index)
        })
        pathEl.appendChild(button)
    }
}

function renderBrowser(items: BrowserEntry[]) {
    clearViews()
    applySort(items)
    renderList(items)
    renderGrid(items)
    updateFolderLocation()
    const pageInfo = document.getElementById("browserPageInfo")
    if (pageInfo) {
        const k = state.currentPage + 1
        const n = state.hasMore ? "…" : String(Math.max(1, state.pages.length))
        pageInfo.textContent = `Page ${k}/${n}`
    }
    const prevButton = document.getElementById("browserPrevPage") as HTMLButtonElement | null
    const nextButton = document.getElementById("browserNextPage") as HTMLButtonElement | null
    if (prevButton) prevButton.disabled = state.currentPage === 0
    if (nextButton) nextButton.disabled = state.currentPage >= state.pages.length - 1 && !state.hasMore
    applyViewMode()
    updateSelectionDisplay()
}

function applyViewMode() {
    const listView = document.getElementById("browserList")
    const gridView = document.getElementById("browserGrid")
    const listButton = document.getElementById("viewList")
    const gridButton = document.getElementById("viewGrid")
    if (state.viewMode === "grid") {
        listView?.setAttribute("hidden", "")
        gridView?.removeAttribute("hidden")
        listButton?.classList.remove("active")
        gridButton?.classList.add("active")
        requestAnimationFrame(() => {
            document.querySelectorAll<HTMLElement>(".file-grid-item").forEach((item) => {
                applyGridMarquee(item)
            })
        })
    } else {
        gridView?.setAttribute("hidden", "")
        listView?.removeAttribute("hidden")
        gridButton?.classList.remove("active")
        listButton?.classList.add("active")
    }
}

function toggleSelection(entry: BrowserEntry, index: number) {
    if (state.selected.has(entry.id)) {
        state.selected.delete(entry.id)
    } else {
        state.selected.set(entry.id, entry)
    }
    state.lastClickedIndex = index
    updateSelectionDisplay()
}

function clearSelection() {
    state.selected.clear()
    state.lastClickedIndex = null
    updateSelectionDisplay()
}

function updateSelectionDisplay() {
    const selectedIds = new Set(state.selected.keys())
    document.querySelectorAll<HTMLElement>("[data-browser-id]").forEach((node) => {
        const id = node.dataset.browserId
        node.classList.toggle("selected", !!id && selectedIds.has(id))
    })
    updateActionStates()
}

function updateActionStates() {
    const selectedEntries = Array.from(state.selected.values())
    const selectedCount = selectedEntries.length
    const hasAny = selectedCount > 0
    const hasSingle = selectedCount === 1
    const selectedEntry = hasSingle ? selectedEntries[0] : null
    const selectedFiles = selectedEntries.filter(isFileEntry)
    const selectedFolders = selectedEntries.filter(isFolderEntry)
    const allSelectedFiles = selectedFiles.length === selectedEntries.length
    const allSelectedFilesOrFolders = selectedFiles.length + selectedFolders.length === selectedEntries.length
    const previewEnabled = !!selectedEntry && (
        isFolderEntry(selectedEntry) ||
        (isFileEntry(selectedEntry) && isPreviewableName(selectedEntry.data.name))
    )

    const setButtonVisible = (id: string, visible: boolean) => {
        const btn = document.getElementById(id) as HTMLButtonElement | null
        if (btn) {
            btn.classList.toggle("action-hidden", !visible)
            btn.disabled = !visible
        }
    }
    setButtonVisible("browserActionPreview", previewEnabled)
    setButtonVisible("browserActionRename", hasSingle && (isFileEntry(selectedEntry as BrowserEntry) || isFolderEntry(selectedEntry as BrowserEntry)))
    setButtonVisible("browserActionDownload", hasSingle && isFileEntry(selectedEntry as BrowserEntry))
    setButtonVisible("browserActionMove", hasAny && allSelectedFilesOrFolders)
    setButtonVisible("browserActionDelete", hasAny && allSelectedFilesOrFolders)
    setButtonVisible("browserActionSend", hasAny && allSelectedFiles)

    const previewBtn = document.getElementById("browserActionPreview") as HTMLButtonElement | null
    if (previewBtn) previewBtn.textContent = selectedEntry && isFolderEntry(selectedEntry) ? "Open" : "Preview"

    const actionsBtn = document.getElementById("browserActionsBtn") as HTMLButtonElement | null
    if (actionsBtn) actionsBtn.disabled = !hasAny

    const setDropdownVisible = (id: string, visible: boolean) => {
        const item = document.getElementById(id) as HTMLAnchorElement | null
        if (!item) return
        const li = item.closest("li")
        if (li) li.classList.toggle("d-none", !visible)
    }
    setDropdownVisible("actionPreviewItem", previewEnabled)
    setDropdownVisible("actionRenameItem", hasSingle && (isFileEntry(selectedEntry as BrowserEntry) || isFolderEntry(selectedEntry as BrowserEntry)))
    setDropdownVisible("actionDownloadItem", hasSingle && isFileEntry(selectedEntry as BrowserEntry))
    setDropdownVisible("actionMoveItem", hasAny && allSelectedFilesOrFolders)
    setDropdownVisible("actionDeleteItem", hasAny && allSelectedFilesOrFolders)
    setDropdownVisible("actionSendItem", hasAny && allSelectedFiles)
    const previewItem = document.getElementById("actionPreviewItem")
    if (previewItem) previewItem.textContent = selectedEntry && isFolderEntry(selectedEntry) ? "Open" : "Preview"

    const fileActionsBar = document.getElementById("fileActionsBar")
    const fileActionsDropdown = document.getElementById("fileActionsDropdown")
    const browserDiv = document.getElementById("fileBrowser")
    const browserVisible = !!browserDiv && !browserDiv.hasAttribute("hidden")

    if (fileActionsBar) {
        if (browserVisible && selectedCount > 0) {
            fileActionsBar.removeAttribute("hidden")
        } else {
            fileActionsBar.setAttribute("hidden", "")
        }
    }
    if (fileActionsDropdown) {
        if (browserVisible && selectedCount > 0) {
            fileActionsDropdown.removeAttribute("hidden")
        } else {
            fileActionsDropdown.setAttribute("hidden", "")
        }
    }

    const selectionInfoEl = document.getElementById("selectionInfo")
    if (selectionInfoEl) {
        selectionInfoEl.textContent = selectedCount > 0 ? `${selectedCount} selected` : ""
    }

    const deselectAllBtn = document.getElementById("deselectAllBtn") as HTMLButtonElement | null
    if (deselectAllBtn) {
        deselectAllBtn.classList.toggle("action-hidden", selectedCount === 0)
    }
    const deselectAllBtnMobile = document.getElementById("selectAllBtnMobile") as HTMLButtonElement | null
    if (deselectAllBtnMobile) {
        deselectAllBtnMobile.classList.toggle("action-hidden", selectedCount === 0)
    }
}

function fileEntryFromRecord(record: { msgId: number; date: number; data: FileCardData }): FileBrowserEntry {
    return {
        kind: "file",
        id: `file:${record.msgId}`,
        msgId: record.msgId,
        date: record.date,
        data: record.data,
    }
}

function folderEntryFromRecord(record: { msgId: number; date: number; data: TglfsFolder }): FolderBrowserEntry {
    return {
        kind: "folder",
        id: `folder:${record.data.folderId}`,
        msgId: record.msgId,
        date: record.date,
        data: record.data,
    }
}

function epochFromIso(value: string) {
    const date = Date.parse(value)
    return Number.isNaN(date) ? Math.floor(Date.now() / 1000) : Math.floor(date / 1000)
}

function syntheticFolderFromEntry(entry: TglfsFolderManifestEntry, manifestRootId?: string): FolderBrowserEntry | null {
    if (entry.kind !== "folder" || !entry.folderId) return null
    const folder: TglfsFolder = {
        type: TGLFS_FOLDER_TYPE,
        version: TGLFS_FOLDER_VERSION,
        folderId: entry.folderId,
        parentFolderId: state.currentFolder?.data.folderId,
        rootId: manifestRootId,
        name: entry.name,
        path: entry.path,
        createdAt: entry.updatedAt,
        updatedAt: entry.updatedAt,
        deleted: false,
    }
    return {
        kind: "folder",
        id: `folder:${folder.folderId}`,
        msgId: 0,
        date: epochFromIso(entry.updatedAt),
        data: folder,
    }
}

function missingFileFromEntry(entry: TglfsFolderManifestEntry): MissingFileBrowserEntry | null {
    if (entry.kind !== "file" || !entry.ufid) return null
    return {
        kind: "missing-file",
        id: `missing:${entry.ufid}`,
        date: epochFromIso(entry.updatedAt),
        name: entry.name,
        path: entry.path,
        ufid: entry.ufid,
        size: entry.size ?? 0,
    }
}

function entryMatchesQuery(entry: BrowserEntry, query: string) {
    if (!query) return true
    const needle = query.toLowerCase()
    const haystack = [
        getEntryName(entry),
        getEntryPath(entry),
        entry.kind === "file" ? entry.data.ufid : "",
        entry.kind === "folder" ? entry.data.folderId : "",
        entry.kind === "missing-file" ? entry.ufid : "",
    ].join(" ").toLowerCase()
    return haystack.includes(needle)
}

function folderRecordBelongsInGlobalView(entry: FolderBrowserEntry) {
    return !entry.data.parentFolderId && entry.data.path === ""
}

async function collectFolderFileUfids(client: any, folderRecords: TglfsFolderRecord[]) {
    const ufids = new Set<string>()
    const manifests = await Promise.all(
        folderRecords.map((record) => getFolderManifest(client, record.data.folderId).catch(() => null)),
    )
    for (const manifest of manifests) {
        if (!manifest) continue
        for (const entry of Object.values(manifest.data.entries)) {
            if (!entry.deleted && entry.kind === "file" && entry.ufid) {
                ufids.add(entry.ufid)
            }
        }
    }
    return ufids
}

function chunkEntries(items: BrowserEntry[]) {
    const pages: BrowserEntry[][] = []
    for (let index = 0; index < items.length; index += state.pageSize) {
        pages.push(items.slice(index, index + state.pageSize))
    }
    return pages.length ? pages : [[]]
}

async function loadRootPage(client: any, options: { offsetId?: number; includeFolders: boolean }) {
    const [fileRecords, allFolderRecords] = await Promise.all([
        listFileCards(client, { query: state.query, limit: state.pageSize, offsetId: options.offsetId }),
        listFolderRecords(client, { limit: 500 }),
    ])
    const folderFileUfids = await collectFolderFileUfids(client, allFolderRecords)
    const folderEntries = options.includeFolders
        ? allFolderRecords
            .map(folderEntryFromRecord)
            .filter(folderRecordBelongsInGlobalView)
            .filter((entry) => entryMatchesQuery(entry, state.query))
        : []
    const topLevelFiles = fileRecords
        .filter((record) => !folderFileUfids.has(record.data.ufid))
        .map(fileEntryFromRecord)
    const items: BrowserEntry[] = [
        ...folderEntries,
        ...topLevelFiles,
    ]
    applySort(items)
    return {
        items,
        lastOffsetId: fileRecords.length > 0 ? fileRecords[fileRecords.length - 1].msgId : options.offsetId,
        hasMore: fileRecords.length === state.pageSize,
    }
}

async function resolveFolderManifestEntry(client: any, entry: TglfsFolderManifestEntry, manifestRootId?: string): Promise<BrowserEntry | null> {
    if (entry.deleted) return null
    if (entry.kind === "folder" && entry.folderId) {
        const record = await getFolderRecord(client, entry.folderId)
        return record ? folderEntryFromRecord(record) : syntheticFolderFromEntry(entry, manifestRootId)
    }
    if (entry.kind === "file" && entry.ufid) {
        const record = await getFileCardByUfid(client, entry.ufid)
        return record ? fileEntryFromRecord(record) : missingFileFromEntry(entry)
    }
    return null
}

async function loadFolderPages(client: any) {
    const current = state.currentFolder
    if (!current) {
        return [[]]
    }
    const manifest = await getFolderManifest(client, current.data.folderId)
    if (!manifest) {
        return [[]]
    }
    const resolved = await Promise.all(
        Object.values(manifest.data.entries).map((entry) => resolveFolderManifestEntry(client, entry, manifest.data.rootId)),
    )
    const items = resolved.filter((entry): entry is BrowserEntry => !!entry).filter((entry) => entryMatchesQuery(entry, state.query))
    applySort(items)
    return chunkEntries(items)
}

async function loadFirstPage(client: any) {
    state.pages = []
    state.currentPage = 0
    state.lastOffsetId = undefined
    state.selected.clear()
    state.lastClickedIndex = null
    if (state.currentFolder) {
        state.pages = await loadFolderPages(client)
        state.hasMore = state.pages.length > 1
        return state.pages[0] ?? []
    }
    const page = await loadRootPage(client, { includeFolders: true })
    state.lastOffsetId = page.lastOffsetId
    state.pages.push(page.items)
    state.hasMore = page.hasMore
    return page.items
}

async function loadNextPage(client: any) {
    if (state.currentFolder) {
        const next = state.pages[state.currentPage + 1] ?? []
        state.hasMore = state.currentPage + 1 < state.pages.length - 1
        return next
    }
    const page = await loadRootPage(client, { offsetId: state.lastOffsetId, includeFolders: false })
    state.lastOffsetId = page.lastOffsetId
    state.pages.push(page.items)
    state.hasMore = page.hasMore
    return page.items
}

async function resolveFolderRecordForMutation(client: any, entry: FolderBrowserEntry): Promise<TglfsFolderRecord | null> {
    if (entry.msgId > 0) {
        return {
            msgId: entry.msgId,
            date: entry.date,
            data: entry.data,
        }
    }
    return await getFolderRecord(client, entry.data.folderId)
}

async function topLevelFolderNameExists(client: any, name: string, ignoreFolderId?: string) {
    const records = await listFolderRecords(client, { query: name, limit: 200 })
    return records.some((record) =>
        record.data.folderId !== ignoreFolderId &&
        !record.data.parentFolderId &&
        record.data.path === "" &&
        !record.data.deleted &&
        record.data.name.toLowerCase() === name.toLowerCase(),
    )
}

function currentFolderManifestFallback(now: string): TglfsFolderManifest | null {
    if (!state.currentFolder) return null
    return createTglfsFolderManifest({
        folderId: state.currentFolder.data.folderId,
        rootId: state.currentFolder.data.rootId ?? state.currentFolder.data.folderId,
        path: state.currentFolder.data.path,
        now,
    })
}

function rewritePathForMove(path: string, oldPrefix: string, newPrefix: string) {
    if (!oldPrefix) return path ? joinFolderPath(newPrefix, path) : newPrefix
    if (path === oldPrefix) return newPrefix
    if (path.startsWith(`${oldPrefix}/`)) {
        const suffix = path.slice(oldPrefix.length + 1)
        return newPrefix ? joinFolderPath(newPrefix, suffix) : suffix
    }
    return path
}

function folderDisplayPath(record: TglfsFolderRecord, recordsById: Map<string, TglfsFolderRecord>) {
    const names: string[] = []
    const seen = new Set<string>()
    let current: TglfsFolderRecord | undefined = record
    while (current && !seen.has(current.data.folderId)) {
        seen.add(current.data.folderId)
        names.unshift(current.data.name)
        const parentId = current.data.parentFolderId
        current = parentId ? recordsById.get(parentId) : undefined
    }
    return names.length ? names.join("/") : record.data.name
}

function folderIsSameOrDescendant(
    candidate: TglfsFolderRecord,
    folder: FolderBrowserEntry,
    recordsById: Map<string, TglfsFolderRecord>,
) {
    if (candidate.data.folderId === folder.data.folderId) return true

    const seen = new Set<string>()
    let parentId = candidate.data.parentFolderId
    while (parentId && !seen.has(parentId)) {
        if (parentId === folder.data.folderId) return true
        seen.add(parentId)
        parentId = recordsById.get(parentId)?.data.parentFolderId
    }

    const candidateRootId = candidate.data.rootId ?? candidate.data.folderId
    const folderRootId = folder.data.rootId ?? folder.data.folderId
    if (candidateRootId !== folderRootId) return false
    if (!folder.data.path) return true
    return candidate.data.path === folder.data.path || candidate.data.path.startsWith(`${folder.data.path}/`)
}

async function getFolderManifestForMutation(
    client: any,
    folder: TglfsFolder,
    now: string,
): Promise<{ record: TglfsFolderManifestRecord | null; manifest: TglfsFolderManifest }> {
    const record = await getFolderManifest(client, folder.folderId)
    return {
        record,
        manifest: record?.data ?? createTglfsFolderManifest({
            folderId: folder.folderId,
            rootId: folder.rootId ?? folder.folderId,
            path: folder.path,
            now,
        }),
    }
}

async function createFolderInCurrentLocation(client: any) {
    const name = validateFolderName(await requestBrowserText({
        title: "New Folder",
        label: "Folder name",
        confirmLabel: "Create",
    }))
    if (!name) return

    const now = new Date().toISOString()
    const parent = state.currentFolder
    if (!parent && await topLevelFolderNameExists(client, name)) {
        showUfidToast(`"${name}" already exists here`)
        return
    }

    const parentManifestRecord = parent ? await getFolderManifest(client, parent.data.folderId) : null
    const parentManifest = parent ? (parentManifestRecord?.data ?? currentFolderManifestFallback(now)) : null
    if (parentManifest && !assertFolderNameAvailable(name, activeManifestEntryNames(parentManifest))) {
        return
    }

    const folderId = createRecordId("folder")
    const rootId = parent ? (parent.data.rootId ?? parent.data.folderId) : folderId
    const path = parent ? joinFolderPath(parent.data.path, name) : ""
    const folder = createTglfsFolder({
        folderId,
        parentFolderId: parent?.data.folderId,
        rootId,
        name,
        path,
        now,
    })
    const manifest = createTglfsFolderManifest({
        folderId,
        rootId,
        path,
        now,
    })

    await writeFolderRecord(client, folder)
    await writeFolderManifest(client, manifest)

    if (parentManifest) {
        await writeFolderManifest(client, {
            ...parentManifest,
            updatedAt: now,
            entries: {
                ...parentManifest.entries,
                [name]: {
                    entryId: createRecordId("entry"),
                    name,
                    path,
                    kind: "folder",
                    folderId,
                    deleted: false,
                    updatedAt: now,
                },
            },
        }, parentManifestRecord)
    }

    await refreshBrowser?.()
}

async function updateFolderTreeForRename(
    client: any,
    record: TglfsFolderRecord,
    options: {
        name?: string
        parentFolderId?: string
        rootId?: string
        oldPath: string
        newPath: string
        now: string
        includeEmptyPrefix?: boolean
    },
): Promise<void> {
    const rewritePath = options.includeEmptyPrefix ? rewritePathForMove : replacePathPrefix
    const nextFolder = {
        ...record.data,
        name: options.name ?? record.data.name,
        path: rewritePath(record.data.path, options.oldPath, options.newPath),
        updatedAt: options.now,
    }
    if ("parentFolderId" in options) {
        if (options.parentFolderId) {
            nextFolder.parentFolderId = options.parentFolderId
        } else {
            delete nextFolder.parentFolderId
        }
    }
    if (options.rootId !== undefined) {
        nextFolder.rootId = options.rootId
    }
    await writeFolderRecord(client, nextFolder, record)

    const manifestRecord = await getFolderManifest(client, record.data.folderId)
    if (!manifestRecord) return

    const nextEntries: Record<string, TglfsFolderManifestEntry> = {}
    for (const [key, entry] of Object.entries(manifestRecord.data.entries)) {
        nextEntries[key] = {
            ...entry,
            path: rewritePath(entry.path, options.oldPath, options.newPath),
            updatedAt: entry.deleted ? entry.updatedAt : options.now,
        }
    }
    await writeFolderManifest(client, {
        ...manifestRecord.data,
        rootId: options.rootId ?? manifestRecord.data.rootId,
        path: rewritePath(manifestRecord.data.path, options.oldPath, options.newPath),
        updatedAt: options.now,
        entries: nextEntries,
    }, manifestRecord)

    for (const entry of Object.values(manifestRecord.data.entries)) {
        if (entry.kind !== "folder" || entry.deleted || !entry.folderId) continue
        const childRecord = await getFolderRecord(client, entry.folderId)
        if (childRecord) {
            await updateFolderTreeForRename(client, childRecord, options)
        }
    }
}

async function renameFolderEntry(client: any, entry: FolderBrowserEntry) {
    const newName = validateFolderName(await requestBrowserText({
        title: "Rename Folder",
        label: "Folder name",
        initialValue: entry.data.name,
        confirmLabel: "Rename",
    }))
    if (!newName || newName === entry.data.name) return

    const record = await resolveFolderRecordForMutation(client, entry)
    if (!record) {
        showUfidToast("Unable to find folder record")
        return
    }

    const now = new Date().toISOString()
    const parentId = record.data.parentFolderId
    const parentManifestRecord = parentId ? await getFolderManifest(client, parentId) : null
    if (parentManifestRecord) {
        const activeNames = [...activeManifestEntryNames(parentManifestRecord.data)].filter((name) => name !== record.data.name.toLowerCase())
        if (!assertFolderNameAvailable(newName, activeNames)) return
    } else if (!parentId && await topLevelFolderNameExists(client, newName, record.data.folderId)) {
        showUfidToast(`"${newName}" already exists here`)
        return
    }

    const parentPath = parentManifestRecord?.data.path ?? ""
    const newPath = parentId ? joinFolderPath(parentPath, newName) : record.data.path

    await updateFolderTreeForRename(client, record, {
        name: newName,
        oldPath: record.data.path,
        newPath,
        now,
    })

    if (parentManifestRecord) {
        const nextEntries = { ...parentManifestRecord.data.entries }
        const currentEntry = Object.values(nextEntries).find((candidate) =>
            candidate.kind === "folder" &&
            candidate.folderId === record.data.folderId &&
            !candidate.deleted,
        )
        if (currentEntry) {
            delete nextEntries[currentEntry.name]
            nextEntries[newName] = {
                ...currentEntry,
                name: newName,
                path: newPath,
                updatedAt: now,
            }
            await writeFolderManifest(client, {
                ...parentManifestRecord.data,
                updatedAt: now,
                entries: nextEntries,
            }, parentManifestRecord)
        }
    }

    await refreshBrowser?.()
}

async function tombstoneFolderTree(client: any, record: TglfsFolderRecord, now: string): Promise<void> {
    const manifestRecord = await getFolderManifest(client, record.data.folderId)
    if (manifestRecord) {
        for (const entry of Object.values(manifestRecord.data.entries)) {
            if (entry.kind !== "folder" || entry.deleted || !entry.folderId) continue
            const childRecord = await getFolderRecord(client, entry.folderId)
            if (childRecord) {
                await tombstoneFolderTree(client, childRecord, now)
            }
        }
        const entries: Record<string, TglfsFolderManifestEntry> = {}
        for (const [key, entry] of Object.entries(manifestRecord.data.entries)) {
            entries[key] = { ...entry, deleted: true, updatedAt: now }
        }
        await writeFolderManifest(client, {
            ...manifestRecord.data,
            updatedAt: now,
            entries,
        }, manifestRecord)
    }
    await writeFolderRecord(client, {
        ...record.data,
        deleted: true,
        updatedAt: now,
    }, record)
}

async function tombstoneFolderInParentManifest(client: any, record: TglfsFolderRecord, now: string) {
    if (!record.data.parentFolderId) return
    const parentManifestRecord = await getFolderManifest(client, record.data.parentFolderId)
    if (!parentManifestRecord) return

    const entries: Record<string, TglfsFolderManifestEntry> = {}
    for (const [key, entry] of Object.entries(parentManifestRecord.data.entries)) {
        entries[key] = entry.kind === "folder" && entry.folderId === record.data.folderId
            ? { ...entry, deleted: true, updatedAt: now }
            : entry
    }
    await writeFolderManifest(client, {
        ...parentManifestRecord.data,
        updatedAt: now,
        entries,
    }, parentManifestRecord)
}

async function tombstoneEntryInFolderManifest(
    client: any,
    folderId: string,
    now: string,
    matches: (entry: TglfsFolderManifestEntry) => boolean,
) {
    const manifestRecord = await getFolderManifest(client, folderId)
    if (!manifestRecord) return

    let changed = false
    const entries: Record<string, TglfsFolderManifestEntry> = {}
    for (const [key, entry] of Object.entries(manifestRecord.data.entries)) {
        if (!entry.deleted && matches(entry)) {
            entries[key] = { ...entry, deleted: true, updatedAt: now }
            changed = true
        } else {
            entries[key] = entry
        }
    }
    if (!changed) return

    await writeFolderManifest(client, {
        ...manifestRecord.data,
        updatedAt: now,
        entries,
    }, manifestRecord)
}

async function requestMoveDestination(client: any, selectedEntries: BrowserEntry[]) {
    const selectedFolders = selectedEntries.filter(isFolderEntry)
    const folderRecords = await listFolderRecords(client, { limit: 200 })
    const recordsById = new Map(folderRecords.map((record) => [record.data.folderId, record]))
    const currentFolderId = state.currentFolder?.data.folderId
    const parentFolder = state.currentFolder?.data.parentFolderId
        ? recordsById.get(state.currentFolder.data.parentFolderId) ?? await getFolderRecord(client, state.currentFolder.data.parentFolderId)
        : null
    const parentDestination: MoveDestination | null = state.currentFolder
        ? parentFolder
            ? { kind: "folder", record: parentFolder, label: `Parent directory: ${parentFolder.data.name}` }
            : { kind: "root", label: "Parent directory: All files" }
        : null
    if (parentFolder) recordsById.set(parentFolder.data.folderId, parentFolder)

    const folderDestinations: MoveDestination[] = folderRecords
        .filter((record) => !record.data.deleted)
        .filter((record) => record.data.folderId !== currentFolderId)
        .filter((record) => record.data.folderId !== parentFolder?.data.folderId)
        .filter((record) => selectedFolders.every((folder) => !folderIsSameOrDescendant(record, folder, recordsById)))
        .sort((a, b) => folderDisplayPath(a, recordsById).localeCompare(folderDisplayPath(b, recordsById)))
        .map((record) => ({ kind: "folder", record, label: folderDisplayPath(record, recordsById) }))
    const destinations = parentDestination ? [parentDestination, ...folderDestinations] : folderDestinations

    if (destinations.length === 0) {
        showUfidToast("No destination folders available")
        return null
    }

    const choice = await requestBrowserChoice({
        title: "Move to Folder",
        message: selectedEntries.length === 1 ? `Move "${getEntryName(selectedEntries[0])}"` : `Move ${selectedEntries.length} items`,
        label: "Destination folder",
        confirmLabel: "Move",
        choices: destinations.map((destination) => ({
            value: destination.kind === "root" ? ROOT_MOVE_DESTINATION : destination.record.data.folderId,
            label: destination.label,
        })),
    })
    if (!choice) return null
    if (choice === ROOT_MOVE_DESTINATION) return parentDestination?.kind === "root" ? parentDestination : null
    const destination = destinations.find((candidate): candidate is MoveDestination & { kind: "folder" } =>
        candidate.kind === "folder" && candidate.record.data.folderId === choice,
    )
    return destination ?? null
}

async function moveFileEntryToRoot(client: any, file: FileBrowserEntry, now: string) {
    if (state.currentFolder) {
        await tombstoneEntryInFolderManifest(client, state.currentFolder.data.folderId, now, (entry) =>
            entry.kind === "file" && entry.ufid === file.data.ufid,
        )
    }
    return true
}

async function moveFileEntryToFolder(client: any, file: FileBrowserEntry, destination: TglfsFolderRecord, now: string) {
    const { record: destinationManifestRecord, manifest: destinationManifest } = await getFolderManifestForMutation(client, destination.data, now)
    if (!assertFolderNameAvailable(file.data.name, activeManifestEntryNames(destinationManifest))) {
        return false
    }

    const path = joinFolderPath(destination.data.path, file.data.name)
    await writeFolderManifest(client, {
        ...destinationManifest,
        rootId: destination.data.rootId ?? destination.data.folderId,
        path: destination.data.path,
        updatedAt: now,
        entries: {
            ...destinationManifest.entries,
            [file.data.name]: {
                entryId: createRecordId("entry"),
                name: file.data.name,
                path,
                kind: "file",
                ufid: file.data.ufid,
                size: file.data.size,
                mtimeMs: Date.parse(now),
                mode: 0o644,
                deleted: false,
                updatedAt: now,
            },
        },
    }, destinationManifestRecord)

    if (state.currentFolder) {
        await tombstoneEntryInFolderManifest(client, state.currentFolder.data.folderId, now, (entry) =>
            entry.kind === "file" && entry.ufid === file.data.ufid,
        )
    }

    return true
}

async function moveFolderEntryToRoot(client: any, folder: FolderBrowserEntry, now: string) {
    const record = await resolveFolderRecordForMutation(client, folder)
    if (!record) {
        showUfidToast("Unable to find folder record")
        return false
    }
    if (await topLevelFolderNameExists(client, record.data.name, record.data.folderId)) {
        showUfidToast(`"${record.data.name}" already exists here`)
        return false
    }

    await updateFolderTreeForRename(client, record, {
        parentFolderId: undefined,
        rootId: record.data.folderId,
        oldPath: record.data.path,
        newPath: "",
        now,
        includeEmptyPrefix: true,
    })

    if (record.data.parentFolderId) {
        await tombstoneEntryInFolderManifest(client, record.data.parentFolderId, now, (entry) =>
            entry.kind === "folder" && entry.folderId === record.data.folderId,
        )
    }

    return true
}

async function moveFolderEntryToFolder(client: any, folder: FolderBrowserEntry, destination: TglfsFolderRecord, now: string) {
    const record = await resolveFolderRecordForMutation(client, folder)
    if (!record) {
        showUfidToast("Unable to find folder record")
        return false
    }

    const { record: destinationManifestRecord, manifest: destinationManifest } = await getFolderManifestForMutation(client, destination.data, now)
    if (!assertFolderNameAvailable(record.data.name, activeManifestEntryNames(destinationManifest))) {
        return false
    }

    const rootId = destination.data.rootId ?? destination.data.folderId
    const oldPath = record.data.path
    const newPath = joinFolderPath(destination.data.path, record.data.name)
    await writeFolderManifest(client, {
        ...destinationManifest,
        rootId,
        path: destination.data.path,
        updatedAt: now,
        entries: {
            ...destinationManifest.entries,
            [record.data.name]: {
                entryId: createRecordId("entry"),
                name: record.data.name,
                path: newPath,
                kind: "folder",
                folderId: record.data.folderId,
                deleted: false,
                updatedAt: now,
            },
        },
    }, destinationManifestRecord)

    await updateFolderTreeForRename(client, record, {
        parentFolderId: destination.data.folderId,
        rootId,
        oldPath,
        newPath,
        now,
        includeEmptyPrefix: true,
    })

    if (record.data.parentFolderId) {
        await tombstoneEntryInFolderManifest(client, record.data.parentFolderId, now, (entry) =>
            entry.kind === "folder" && entry.folderId === record.data.folderId,
        )
    }

    return true
}

async function moveSelectedEntries(client: any) {
    const selectedEntries = Array.from(state.selected.values())
    const movableEntries = selectedEntries.filter((entry) => isFileEntry(entry) || isFolderEntry(entry))
    if (selectedEntries.length === 0 || movableEntries.length !== selectedEntries.length) return

    const destination = await requestMoveDestination(client, selectedEntries)
    if (!destination) return

    const now = new Date().toISOString()
    let moved = 0
    for (const entry of movableEntries) {
        if (isFileEntry(entry)) {
            if (destination.kind === "root") {
                if (await moveFileEntryToRoot(client, entry, now)) moved++
            } else if (await moveFileEntryToFolder(client, entry, destination.record, now)) {
                moved++
            }
            continue
        }
        if (destination.kind === "root") {
            if (await moveFolderEntryToRoot(client, entry, now)) moved++
        } else if (await moveFolderEntryToFolder(client, entry, destination.record, now)) {
            moved++
        }
    }

    clearSelection()
    await refreshBrowser?.()
    if (moved > 0) {
        showUfidToast(moved === 1 ? "Moved 1 item" : `Moved ${moved} items`)
    }
}

async function runSingleOpenAction(selected: BrowserEntry | null) {
    if (!selected) return
    if (isFolderEntry(selected)) {
        await openFolder(selected)
        return
    }
    if (isFileEntry(selected)) {
        await previewModal?.open(selected, getVisiblePreviewEntries())
    }
}

export async function initFileBrowser(client: any, config: Config.Config) {
    if (state.initialized) return
    state.initialized = true
    activeBrowserClient = client

    previewModal = new PreviewModal(client)

    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement
    const sortSelect = document.getElementById("browserSortSelect") as HTMLSelectElement
    const prevButton = document.getElementById("browserPrevPage") as HTMLButtonElement
    const nextButton = document.getElementById("browserNextPage") as HTMLButtonElement
    const viewList = document.getElementById("viewList") as HTMLButtonElement
    const viewGrid = document.getElementById("viewGrid") as HTMLButtonElement
    const actionPreview = document.getElementById("browserActionPreview") as HTMLButtonElement
    const actionDownload = document.getElementById("browserActionDownload") as HTMLButtonElement
    const actionRename = document.getElementById("browserActionRename") as HTMLButtonElement
    const actionMove = document.getElementById("browserActionMove") as HTMLButtonElement
    const actionDelete = document.getElementById("browserActionDelete") as HTMLButtonElement
    const actionSend = document.getElementById("browserActionSend") as HTMLButtonElement
    const actionUpload = document.getElementById("browserActionUpload") as HTMLButtonElement
    const actionNewFolder = document.getElementById("browserActionNewFolder") as HTMLButtonElement
    const actionReceive = document.getElementById("browserActionReceive") as HTMLButtonElement
    const actionUploadItem = document.getElementById("browserActionUploadItem") as HTMLAnchorElement | null
    const actionNewFolderItem = document.getElementById("browserActionNewFolderItem") as HTMLAnchorElement | null
    const actionReceiveItem = document.getElementById("browserActionReceiveItem") as HTMLAnchorElement | null
    const actionUnsend = document.getElementById("browserActionUnsend") as HTMLButtonElement
    const homeButton = document.getElementById("browserHomeButton") as HTMLButtonElement
    const rootCrumb = document.getElementById("browserRootCrumb") as HTMLButtonElement | null
    const bulkDownload = document.getElementById("bulkDownload") as HTMLButtonElement | null
    const bulkDelete = document.getElementById("bulkDelete") as HTMLButtonElement | null
    const bulkSend = document.getElementById("bulkSend") as HTMLButtonElement | null
    const actionPreviewItem = document.getElementById("actionPreviewItem") as HTMLAnchorElement
    const actionDownloadItem = document.getElementById("actionDownloadItem") as HTMLAnchorElement
    const actionRenameItem = document.getElementById("actionRenameItem") as HTMLAnchorElement
    const actionMoveItem = document.getElementById("actionMoveItem") as HTMLAnchorElement
    const actionDeleteItem = document.getElementById("actionDeleteItem") as HTMLAnchorElement
    const actionSendItem = document.getElementById("actionSendItem") as HTMLAnchorElement
    const actionUnsendItem = document.getElementById("actionUnsendItem") as HTMLAnchorElement | null

    const getSingleSelection = () => {
        if (state.selected.size !== 1) return null
        return Array.from(state.selected.values())[0]
    }
    const getSelectedFileEntries = () => Array.from(state.selected.values()).filter(isFileEntry)
    const removeFileEntriesFromPage = (ids: Set<number>) => {
        const page = state.pages[state.currentPage]
        if (!page) return
        state.pages[state.currentPage] = page.filter((entry) => !isFileEntry(entry) || !ids.has(entry.msgId))
    }
    const deleteSelectedEntries = async () => {
        const selectedEntries = Array.from(state.selected.values())
        const files = selectedEntries.filter(isFileEntry)
        const folders = selectedEntries.filter(isFolderEntry)
        if (selectedEntries.length === 0 || files.length + folders.length !== selectedEntries.length) return

        if (selectedEntries.length === 1) {
            const selected = selectedEntries[0]
            const kind = isFolderEntry(selected) ? "folder" : "file"
            const ok = await requestBrowserConfirm({
                title: `Delete ${kind}`,
                message: `Delete "${getEntryName(selected)}"?`,
                confirmLabel: "Delete",
                danger: true,
            })
            if (!ok) return
        } else {
            const names = selectedEntries.slice(0, 5).map(getEntryName).join(", ")
            const more = selectedEntries.length > 5 ? ` and ${selectedEntries.length - 5} more` : ""
            const ok = await requestBrowserConfirm({
                title: `Delete ${selectedEntries.length} items`,
                message: `${names}${more}`,
                confirmLabel: "Delete",
                danger: true,
            })
            if (!ok) return
        }

        for (const file of files) {
            await deleteFileCard(client, file.msgId, file.data)
        }
        const now = new Date().toISOString()
        for (const folder of folders) {
            const record = await resolveFolderRecordForMutation(client, folder)
            if (!record) continue
            await tombstoneFolderInParentManifest(client, record, now)
            await tombstoneFolderTree(client, record, now)
        }

        if (files.length > 0 && folders.length === 0) {
            removeFileEntriesFromPage(new Set(files.map((entry) => entry.msgId)))
        }
        clearSelection()
        await refreshBrowser?.()
    }

    const doRefresh = async () => {
        if (activeBrowserClient !== client) activeBrowserClient = client
        const items = await loadFirstPage(client)
        renderBrowser(items)
    }
    refreshBrowser = doRefresh

    window.addEventListener("tglfs:refresh-browser", async () => {
        const browserDiv = document.getElementById("fileBrowser")
        if (browserDiv && !browserDiv.hasAttribute("hidden")) {
            await doRefresh()
        }
    })

    let searchTimer: number | undefined
    const scheduleSearch = (immediate: boolean) => {
        const nextQuery = (searchInput.value || "").trim()
        if (!immediate && nextQuery === state.query) return
        if (searchTimer !== undefined) {
            window.clearTimeout(searchTimer)
            searchTimer = undefined
        }
        const run = async () => {
            state.query = nextQuery
            await doRefresh()
        }
        if (immediate) {
            void run()
            return
        }
        searchTimer = window.setTimeout(() => {
            void run()
        }, 250)
    }

    searchInput.addEventListener("input", () => {
        scheduleSearch(false)
    })
    searchInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
            scheduleSearch(true)
        }
    })

    sortSelect.addEventListener("change", () => {
        state.sort = sortSelect.value as SortMode
        if (state.pages[state.currentPage]) {
            renderBrowser(state.pages[state.currentPage])
        }
    })

    prevButton.addEventListener("click", () => {
        if (state.currentPage > 0) {
            state.currentPage--
            clearSelection()
            state.hasMore = state.currentFolder ? state.currentPage < state.pages.length - 1 : state.hasMore
            renderBrowser(state.pages[state.currentPage])
        }
    })

    nextButton.addEventListener("click", async () => {
        if (state.currentPage < state.pages.length - 1 && state.pages[state.currentPage + 1]?.length) {
            state.currentPage++
            clearSelection()
            state.hasMore = state.currentFolder ? state.currentPage < state.pages.length - 1 : state.hasMore
            renderBrowser(state.pages[state.currentPage])
            return
        }
        const items = await loadNextPage(client)
        if (items.length > 0 || state.currentFolder) {
            state.currentPage++
            clearSelection()
            renderBrowser(items)
        }
    })

    viewList.addEventListener("click", () => {
        state.viewMode = "list"
        applyViewMode()
    })
    viewGrid.addEventListener("click", () => {
        state.viewMode = "grid"
        applyViewMode()
    })

    rootCrumb?.addEventListener("click", () => {
        void openGlobalView()
    })

    const deselectAllBtn = document.getElementById("deselectAllBtn") as HTMLButtonElement | null
    deselectAllBtn?.addEventListener("click", () => {
        clearSelection()
    })
    const deselectAllBtnMobile = document.getElementById("selectAllBtnMobile") as HTMLButtonElement | null
    deselectAllBtnMobile?.addEventListener("click", () => {
        clearSelection()
    })

    homeButton.addEventListener("click", () => {
        const controlsDiv = document.getElementById("controls")
        const browserDiv = document.getElementById("fileBrowser")
        browserDiv?.setAttribute("hidden", "")
        controlsDiv?.removeAttribute("hidden")
        document.body.classList.remove("file-browser-active")
        clearSelection()
    })
    actionUpload.addEventListener("click", () => {
        const uploadInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
        if (uploadInput) uploadInput.click()
    })
    actionNewFolder.addEventListener("click", async () => {
        await createFolderInCurrentLocation(client)
    })
    actionReceive.addEventListener("click", async () => {
        await (await import("../telegram")).fileReceive(client, config)
    })
    actionUploadItem?.addEventListener("click", (e) => {
        e.preventDefault()
        const uploadInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
        if (uploadInput) uploadInput.click()
    })
    actionNewFolderItem?.addEventListener("click", async (e) => {
        e.preventDefault()
        await createFolderInCurrentLocation(client)
    })
    actionReceiveItem?.addEventListener("click", async (e) => {
        e.preventDefault()
        await (await import("../telegram")).fileReceive(client, config)
    })
    actionUnsend.addEventListener("click", async () => {
        await (await import("../telegram")).fileUnsend(client, config)
    })

    actionPreview.addEventListener("click", async () => {
        await runSingleOpenAction(getSingleSelection())
    })
    actionDownload.addEventListener("click", async () => {
        const selected = getSingleSelection()
        if (!selected || !isFileEntry(selected)) return
        const password = await requestBrowserText({
            title: "Download File",
            label: "Optional decryption password",
            inputType: "password",
            allowEmpty: true,
            confirmLabel: "Download",
        })
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    actionRename.addEventListener("click", async () => {
        const selected = getSingleSelection()
        if (!selected) return
        if (isFolderEntry(selected)) {
            await renameFolderEntry(client, selected)
            return
        }
        if (isFileEntry(selected)) {
            const newName = await requestBrowserText({
                title: "Rename File",
                label: "File name",
                initialValue: selected.data.name,
                confirmLabel: "Rename",
            })
            if (!newName || newName.trim() === "") return
            await renameFileCard(client, selected.msgId, "me", selected.data, newName.trim())
            selected.data.name = newName.trim()
            renderBrowser(state.pages[state.currentPage])
        }
    })
    actionDelete.addEventListener("click", async () => {
        await deleteSelectedEntries()
    })
    actionMove.addEventListener("click", async () => {
        await moveSelectedEntries(client)
    })
    actionSend.addEventListener("click", async () => {
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        const recipient = await requestBrowserText({
            title: "Send Files",
            label: "Recipient",
            confirmLabel: "Send",
        })
        if (!recipient || recipient.trim() === "") return
        for (const entry of entries) {
            await sendFileCard(client, entry.data, recipient.trim())
        }
        showUfidToast(entries.length === 1 ? "File sent" : "Files sent")
    })

    bulkDownload?.addEventListener("click", async () => {
        const selected = getSingleSelection()
        if (!selected || !isFileEntry(selected)) return
        const password = await requestBrowserText({
            title: "Download File",
            label: "Optional decryption password",
            inputType: "password",
            allowEmpty: true,
            confirmLabel: "Download",
        })
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    bulkDelete?.addEventListener("click", async () => {
        await deleteSelectedEntries()
    })
    bulkSend?.addEventListener("click", async () => {
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        const recipient = await requestBrowserText({
            title: "Send Files",
            label: "Recipient",
            confirmLabel: "Send",
        })
        if (!recipient || recipient.trim() === "") return
        for (const entry of entries) {
            await sendFileCard(client, entry.data, recipient.trim())
        }
        showUfidToast("Files sent")
    })

    actionPreviewItem.addEventListener("click", async (e) => {
        e.preventDefault()
        await runSingleOpenAction(getSingleSelection())
    })
    actionDownloadItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const selected = getSingleSelection()
        if (!selected || !isFileEntry(selected)) return
        const password = await requestBrowserText({
            title: "Download File",
            label: "Optional decryption password",
            inputType: "password",
            allowEmpty: true,
            confirmLabel: "Download",
        })
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    actionRenameItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const selected = getSingleSelection()
        if (!selected) return
        if (isFolderEntry(selected)) {
            await renameFolderEntry(client, selected)
            return
        }
        if (isFileEntry(selected)) {
            const newName = await requestBrowserText({
                title: "Rename File",
                label: "File name",
                initialValue: selected.data.name,
                confirmLabel: "Rename",
            })
            if (!newName || newName.trim() === "") return
            await renameFileCard(client, selected.msgId, "me", selected.data, newName.trim())
            selected.data.name = newName.trim()
            renderBrowser(state.pages[state.currentPage])
        }
    })
    actionDeleteItem.addEventListener("click", async (e) => {
        e.preventDefault()
        await deleteSelectedEntries()
    })
    actionMoveItem.addEventListener("click", async (e) => {
        e.preventDefault()
        await moveSelectedEntries(client)
    })
    actionSendItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        const recipient = await requestBrowserText({
            title: "Send Files",
            label: "Recipient",
            confirmLabel: "Send",
        })
        if (!recipient || recipient.trim() === "") return
        for (const entry of entries) {
            await sendFileCard(client, entry.data, recipient.trim())
        }
        showUfidToast(entries.length === 1 ? "File sent" : "Files sent")
    })
    actionUnsendItem?.addEventListener("click", async (e) => {
        e.preventDefault()
        await (await import("../telegram")).fileUnsend(client, config)
    })

    window.addEventListener("keydown", async (e) => {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
            return
        }
        const browserDiv = document.getElementById("fileBrowser")
        if (!browserDiv || browserDiv.hasAttribute("hidden")) return

        if (e.key === "Escape") {
            if (previewModal?.isOpen()) {
                previewModal.close()
            } else if (state.selected.size > 0) {
                clearSelection()
            } else if (state.currentFolder) {
                await openGlobalView()
            }
            return
        }
        if (e.key === "Delete" && state.selected.size > 0) {
            const entries = Array.from(state.selected.values())
            if (entries.every((entry) => isFileEntry(entry) || isFolderEntry(entry))) {
                e.preventDefault()
                await deleteSelectedEntries()
            }
            return
        }
        if (e.key === "Enter") {
            const selected = getSingleSelection()
            if (selected) {
                e.preventDefault()
                await runSingleOpenAction(selected)
            }
            return
        }
        if (previewModal?.isOpen()) {
            if (e.key === "ArrowLeft") {
                e.preventDefault()
                await previewModal.showPrevious()
            } else if (e.key === "ArrowRight") {
                e.preventDefault()
                await previewModal.showNext()
            }
        }
    })

    const items = await loadFirstPage(client)
    renderBrowser(items)
}
