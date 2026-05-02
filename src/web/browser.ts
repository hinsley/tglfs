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
} from "../telegram"
import type { FileCardData } from "../types/models"
import {
    TGLFS_FOLDER_TYPE,
    TGLFS_FOLDER_VERSION,
} from "../../packages/tglfs-cli/src/folders"
import type { TglfsFolder, TglfsFolderManifestEntry } from "../../packages/tglfs-cli/src/folders"
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
}

let previewModal: PreviewModal | null = null
let ufidToastTimer: number | undefined
let activeBrowserClient: any = null
let refreshBrowser: (() => Promise<void>) | null = null

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
    state.currentFolder = entry
    state.query = ""
    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement | null
    if (searchInput) searchInput.value = ""
    await refreshBrowser?.()
}

async function openGlobalView() {
    state.currentFolder = null
    state.query = ""
    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement | null
    if (searchInput) searchInput.value = ""
    await refreshBrowser?.()
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
    if (!state.currentFolder) {
        pathEl.textContent = ""
        return
    }
    const path = state.currentFolder.data.path || state.currentFolder.data.name
    pathEl.textContent = path ? `/ ${path}` : `/ ${state.currentFolder.data.name}`
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
    const allSelectedFiles = selectedFiles.length === selectedEntries.length
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
    setButtonVisible("browserActionRename", hasSingle && isFileEntry(selectedEntry as BrowserEntry))
    setButtonVisible("browserActionDownload", hasSingle && isFileEntry(selectedEntry as BrowserEntry))
    setButtonVisible("browserActionDelete", hasAny && allSelectedFiles)
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
    setDropdownVisible("actionRenameItem", hasSingle && isFileEntry(selectedEntry as BrowserEntry))
    setDropdownVisible("actionDownloadItem", hasSingle && isFileEntry(selectedEntry as BrowserEntry))
    setDropdownVisible("actionDeleteItem", hasAny && allSelectedFiles)
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
    if (state.query) return true
    return !entry.data.parentFolderId && entry.data.path === ""
}

function chunkEntries(items: BrowserEntry[]) {
    const pages: BrowserEntry[][] = []
    for (let index = 0; index < items.length; index += state.pageSize) {
        pages.push(items.slice(index, index + state.pageSize))
    }
    return pages.length ? pages : [[]]
}

async function loadRootPage(client: any, options: { offsetId?: number; includeFolders: boolean }) {
    const [fileRecords, folderRecords] = await Promise.all([
        listFileCards(client, { query: state.query, limit: state.pageSize, offsetId: options.offsetId }),
        options.includeFolders ? listFolderRecords(client, { query: state.query, limit: 200 }) : Promise.resolve([]),
    ])
    const items: BrowserEntry[] = [
        ...folderRecords.map(folderEntryFromRecord).filter(folderRecordBelongsInGlobalView),
        ...fileRecords.map(fileEntryFromRecord),
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
    const actionDelete = document.getElementById("browserActionDelete") as HTMLButtonElement
    const actionSend = document.getElementById("browserActionSend") as HTMLButtonElement
    const actionUpload = document.getElementById("browserActionUpload") as HTMLButtonElement
    const actionReceive = document.getElementById("browserActionReceive") as HTMLButtonElement
    const actionUploadItem = document.getElementById("browserActionUploadItem") as HTMLAnchorElement | null
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
    actionReceive.addEventListener("click", async () => {
        await (await import("../telegram")).fileReceive(client, config)
    })
    actionUploadItem?.addEventListener("click", (e) => {
        e.preventDefault()
        const uploadInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
        if (uploadInput) uploadInput.click()
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
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    actionRename.addEventListener("click", async () => {
        const selected = getSingleSelection()
        if (!selected || !isFileEntry(selected)) return
        const newName = prompt(`Rename file:\n\n${selected.data.name}\n\nEnter new name:`)
        if (!newName || newName.trim() === "") return
        await renameFileCard(client, selected.msgId, "me", selected.data, newName.trim())
        selected.data.name = newName.trim()
        renderBrowser(state.pages[state.currentPage])
    })
    actionDelete.addEventListener("click", async () => {
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        if (entries.length === 1) {
            const selected = entries[0]
            const ok = confirm(`Delete file "${selected.data.name}"?`)
            if (!ok) return
            await deleteFileCard(client, selected.msgId, selected.data)
            removeFileEntriesFromPage(new Set([selected.msgId]))
        } else {
            const names = entries.slice(0, 5).map((entry) => entry.data.name).join(", ")
            const more = entries.length > 5 ? ` and ${entries.length - 5} more` : ""
            const ok = confirm(`Delete ${entries.length} files?\n\n${names}${more}`)
            if (!ok) return
            for (const entry of entries) {
                await deleteFileCard(client, entry.msgId, entry.data)
            }
            removeFileEntriesFromPage(new Set(entries.map((entry) => entry.msgId)))
        }
        clearSelection()
        renderBrowser(state.pages[state.currentPage])
    })
    actionSend.addEventListener("click", async () => {
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        const recipient = prompt("Enter recipient:")
        if (!recipient || recipient.trim() === "") return
        for (const entry of entries) {
            await sendFileCard(client, entry.data, recipient.trim())
        }
        alert(entries.length === 1 ? "File sent." : "Files sent.")
    })

    bulkDownload?.addEventListener("click", async () => {
        const selected = getSingleSelection()
        if (!selected || !isFileEntry(selected)) return
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    bulkDelete?.addEventListener("click", async () => {
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        const names = entries.slice(0, 5).map((entry) => entry.data.name).join(", ")
        const more = entries.length > 5 ? ` and ${entries.length - 5} more` : ""
        const ok = confirm(`Delete ${entries.length} file${entries.length === 1 ? "" : "s"}?\n\n${names}${more}`)
        if (!ok) return
        for (const entry of entries) {
            await deleteFileCard(client, entry.msgId, entry.data)
        }
        removeFileEntriesFromPage(new Set(entries.map((entry) => entry.msgId)))
        clearSelection()
        renderBrowser(state.pages[state.currentPage])
    })
    bulkSend?.addEventListener("click", async () => {
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        const recipient = prompt("Enter recipient:")
        if (!recipient || recipient.trim() === "") return
        for (const entry of entries) {
            await sendFileCard(client, entry.data, recipient.trim())
        }
        alert("Files sent.")
    })

    actionPreviewItem.addEventListener("click", async (e) => {
        e.preventDefault()
        await runSingleOpenAction(getSingleSelection())
    })
    actionDownloadItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const selected = getSingleSelection()
        if (!selected || !isFileEntry(selected)) return
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    actionRenameItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const selected = getSingleSelection()
        if (!selected || !isFileEntry(selected)) return
        const newName = prompt(`Rename file:\n\n${selected.data.name}\n\nEnter new name:`)
        if (!newName || newName.trim() === "") return
        await renameFileCard(client, selected.msgId, "me", selected.data, newName.trim())
        selected.data.name = newName.trim()
        renderBrowser(state.pages[state.currentPage])
    })
    actionDeleteItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        if (entries.length === 1) {
            const selected = entries[0]
            const ok = confirm(`Delete file "${selected.data.name}"?`)
            if (!ok) return
            await deleteFileCard(client, selected.msgId, selected.data)
            removeFileEntriesFromPage(new Set([selected.msgId]))
        } else {
            const names = entries.slice(0, 5).map((entry) => entry.data.name).join(", ")
            const more = entries.length > 5 ? ` and ${entries.length - 5} more` : ""
            const ok = confirm(`Delete ${entries.length} files?\n\n${names}${more}`)
            if (!ok) return
            for (const entry of entries) {
                await deleteFileCard(client, entry.msgId, entry.data)
            }
            removeFileEntriesFromPage(new Set(entries.map((entry) => entry.msgId)))
        }
        clearSelection()
        renderBrowser(state.pages[state.currentPage])
    })
    actionSendItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const entries = getSelectedFileEntries()
        if (entries.length === 0) return
        const recipient = prompt("Enter recipient:")
        if (!recipient || recipient.trim() === "") return
        for (const entry of entries) {
            await sendFileCard(client, entry.data, recipient.trim())
        }
        alert(entries.length === 1 ? "File sent." : "Files sent.")
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
            const files = getSelectedFileEntries()
            if (files.length === state.selected.size) {
                e.preventDefault()
                bulkDelete?.click()
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
