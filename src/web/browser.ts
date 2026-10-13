import * as Config from "../config"
import {
    formatFileCardDate,
    formatFileCardSize,
} from "../../packages/tglfs-cli/src/shared/file-cards"
import {
    countDirectoryEntries,
    downloadFileCard,
    getFileCardByUfid,
    getFolderManifest,
    getFolderRecord,
    listFileCards,
    listFolderManifestMessages,
    listFolderRecordMessages,
    listFolderRecords,
    renameFileCard,
    deleteFileCard,
    sendFileCard,
    updateFileCardParent,
    writeFolderManifest,
    writeFolderRecord,
} from "../telegram"
import type { FileCardData } from "../types/models"
import {
    createTglfsFolder,
    createTglfsFolderManifest,
    parseTglfsFolderManifestMessage,
    parseTglfsFolderMessage,
} from "../../packages/tglfs-cli/src/folders"
import type { TglfsFolder, TglfsFolderManifest, TglfsFolderManifestEntry, TglfsFolderManifestRecord, TglfsFolderRecord } from "../../packages/tglfs-cli/src/folders"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import { PreviewModal, type PreviewEntry } from "./preview"
import { fileKindForName, fileKindIcon, icon, type FileKind, type IconName } from "./icons"
import {
    closeActionToast,
    closeMenu,
    escapeHtml,
    hideToast,
    isCompactViewport,
    isMenuOpen,
    openMenu,
    requestChoice,
    requestConfirm,
    requestText,
    showActionToast,
    showToast,
    triggerActionToast,
    type ActionToastHandle,
    type MenuItem,
} from "./dialogs"
import {
    BROWSER_ACTIONS_CHANGED_EVENT,
    getExtraBrowserActions,
    type BrowserSelectionItem,
} from "./browserActions"
import { classifyUndoCandidate, createMutationQueue } from "./undoSupport"
import {
    buildFolderHistory,
    folderRecordTextHasOnlyKnownFields,
    folderSnapshotAt,
    historyPointIndexAt,
    type FolderHistory,
    type FolderHistoryInput,
    type HistoryAnnotation,
    type HistoryItem,
    type HistoryManifestInput,
    type HistoryMessageInput,
} from "./folderHistory"
import { HistoryPanel, formatHistoryDay, formatHistoryTime, renderHistoryBanner } from "./folderHistoryView"

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"])
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"])
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"])

const VIEW_STORAGE_KEY = "tglfs.browser.view"
const SORT_STORAGE_KEY = "tglfs.browser.sort"
const LONG_PRESS_MS = 420

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
    lastFolderOffsetId: number | undefined
    selected: Map<string, BrowserEntry>
    lastClickedIndex: number | null
    focusIndex: number | null
    hasMore: boolean
    totalPages: number | null
    totalItems: number | null
    currentFolder: FolderBrowserEntry | null
    currentFolderTrail: FolderBrowserEntry[]
}

type BrowserRefreshOptions = {
    showLoading?: boolean
    loadingMessage?: string
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
    lastFolderOffsetId: undefined,
    selected: new Map(),
    lastClickedIndex: null,
    focusIndex: null,
    hasMore: true,
    totalPages: null,
    totalItems: null,
    currentFolder: null,
    currentFolderTrail: [],
}

let previewModal: PreviewModal | null = null
let activeBrowserClient: any = null
let refreshBrowser: ((options?: BrowserRefreshOptions) => Promise<void>) | null = null
let browserRefreshSequence = 0

type MoveDestination =
    | { kind: "folder"; record: TglfsFolderRecord; label: string }
    | { kind: "root"; label: string }

const ROOT_MOVE_DESTINATION = "__tglfs-root__"

type MoveResult = {
    files: number
    folders: number
}

type MoveTombstoneBatch = {
    fileUfids: Set<string>
    folderIds: Set<string>
}

type PreparedFolderMove = {
    record: TglfsFolderRecord
    parentFolderId?: string
    rootId: string
    oldPath: string
    newPath: string
}

type SelectionAction = {
    key: string
    id: string
    menuId: string
    label: string
    shortLabel?: string
    icon: IconName
    hint?: string
    danger?: boolean
    disabled?: boolean
    menuOnly?: boolean
    run: () => void | Promise<void>
}

let activeBrowserConfig: Config.Config | null = null
let lastPointerType: string =
    typeof window !== "undefined" && window.matchMedia("(hover: none)").matches ? "touch" : "mouse"
let suppressNextClick = false
let keyboardNavigation = false
let currentBarActions = new Map<string, SelectionAction>()
const folderCache = new Map<string, FolderBrowserEntry>()

/* ------------------------------------------------------------- Helpers */

function getExtension(name: string): string {
    const parts = name.toLowerCase().split(".")
    if (parts.length < 2) return ""
    return parts.pop() ?? ""
}

function isPreviewableName(name: string): boolean {
    const ext = getExtension(name)
    return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)
}

function showUfidToast(message: string, options?: { durationMs?: number | null; tone?: "default" | "success" | "error" }) {
    showToast(message, options)
}

const requestBrowserText = requestText
const requestBrowserConfirm = requestConfirm
const requestBrowserChoice = requestChoice

function readPreference(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function writePreference(key: string, value: string) {
    try {
        localStorage.setItem(key, value)
    } catch {
        // Preferences are best-effort.
    }
}

function isTouchInteraction() {
    return lastPointerType !== "mouse"
}

function formatSize(size: number) {
    if (!Number.isFinite(size) || size <= 0) return formatFileCardSize(size)
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
    const value = size / Math.pow(1024, unitIndex)
    const digits = unitIndex === 0 || value >= 10 ? 0 : 1
    return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unitIndex]}`
}

function formatEntryDate(epochSec: number) {
    const date = new Date(epochSec * 1000)
    if (Number.isNaN(date.getTime())) return ""
    const now = new Date()
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    }
    if (date.getFullYear() === now.getFullYear()) {
        return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    }
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`
}

/* ------------------------------------------------------- Listing state */

function clearViews() {
    const rows = document.getElementById("browserRows")
    if (rows) rows.innerHTML = ""
    const grid = document.getElementById("browserGrid")
    if (grid) grid.innerHTML = ""
}

function resetBrowserListingState() {
    state.pages = []
    state.currentPage = 0
    state.lastOffsetId = undefined
    state.lastFolderOffsetId = undefined
    state.selected.clear()
    state.lastClickedIndex = null
    state.focusIndex = null
    state.hasMore = false
    state.totalPages = null
    state.totalItems = null
}

function renderBrowserLoading(message = "Loading files...") {
    resetBrowserListingState()
    renderListingSkeleton()

    updateFolderLocation()
    const pageInfo = document.getElementById("browserPageInfo")
    if (pageInfo) pageInfo.textContent = message
    const prevButton = document.getElementById("browserPrevPage") as HTMLButtonElement | null
    const nextButton = document.getElementById("browserNextPage") as HTMLButtonElement | null
    if (prevButton) prevButton.disabled = true
    if (nextButton) nextButton.disabled = true
    document.getElementById("browserPager")?.classList.add("is-single")
    applyViewMode()
    updateSelectionDisplay()
}

function renderListingSkeleton() {
    clearViews()
    const content = document.getElementById("browserContent")
    content?.setAttribute("aria-busy", "true")
    document.getElementById("browserEmpty")?.setAttribute("hidden", "")

    const rows = document.getElementById("browserRows")
    if (rows) {
        const widths = [62, 44, 71, 38, 55, 66, 48, 59]
        rows.innerHTML = widths.map((width) => `
            <div class="fx-row fx-skeleton" aria-hidden="true">
                <div class="fx-cell fx-cell-check"></div>
                <div class="fx-cell fx-name-cell"><span class="fx-skel fx-skel-icon"></span><span class="fx-skel fx-skel-line" style="width:${width}%"></span></div>
                <div class="fx-cell fx-cell-size"><span class="fx-skel fx-skel-line" style="width:48px"></span></div>
                <div class="fx-cell fx-cell-date"><span class="fx-skel fx-skel-line" style="width:72px"></span></div>
                <div class="fx-cell fx-cell-more"></div>
            </div>`).join("")
    }
    const grid = document.getElementById("browserGrid")
    if (grid) {
        grid.innerHTML = Array.from({ length: 8 }, () => `
            <div class="fx-tile fx-skeleton" aria-hidden="true">
                <div class="fx-tile-art"><span class="fx-skel"></span></div>
                <div class="fx-tile-body"><span class="fx-skel fx-skel-line" style="width:80%"></span><span class="fx-skel fx-skel-line" style="width:45%;margin-top:8px"></span></div>
            </div>`).join("")
    }
}

function beginBrowserNavigationLoading(message: string) {
    browserRefreshSequence++
    renderBrowserLoading(message)
}

function getVisibleItems() {
    return state.pages[state.currentPage] ?? []
}

function visibleTotalPages() {
    return Math.max(
        1,
        state.currentPage + 1,
        state.pages.length,
        state.totalPages ?? (state.pages.length + (state.hasMore ? 1 : 0)),
    )
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

function getEntryKind(entry: BrowserEntry): FileKind {
    if (entry.kind === "folder") return "folder"
    return fileKindForName(getEntryName(entry))
}

function getEntrySizeText(entry: BrowserEntry) {
    if (entry.kind === "folder") return "Folder"
    return formatSize(getEntrySize(entry))
}

function getEntryMetaText(entry: BrowserEntry) {
    const date = formatEntryDate(getEntryDate(entry))
    return [getEntrySizeText(entry), date].filter(Boolean).join(" · ")
}

function getEntryBadge(entry: BrowserEntry) {
    if (entry.kind === "missing-file") return `<span class="fx-badge fx-badge--missing">Missing</span>`
    if (entry.kind === "file" && !entry.data.uploadComplete) return `<span class="fx-badge fx-badge--incomplete">Incomplete</span>`
    return ""
}

function getCopyId(entry: BrowserEntry) {
    if (entry.kind === "file") return { label: "UFID", value: entry.data.ufid }
    if (entry.kind === "folder") return { label: "Folder ID", value: entry.data.folderId }
    return { label: "UFID", value: entry.ufid }
}

function applySort(items: BrowserEntry[]) {
    items.sort((a, b) => {
        // Folders always come first, like every desktop file manager.
        if (isFolderEntry(a) !== isFolderEntry(b)) return isFolderEntry(a) ? -1 : 1
        switch (state.sort) {
            case "date_desc":
                return getEntryDate(b) - getEntryDate(a)
            case "date_asc":
                return getEntryDate(a) - getEntryDate(b)
            case "name_asc":
                return getEntryName(a).localeCompare(getEntryName(b), undefined, { numeric: true, sensitivity: "base" })
            case "name_desc":
                return getEntryName(b).localeCompare(getEntryName(a), undefined, { numeric: true, sensitivity: "base" })
            case "size_desc":
                return getEntrySize(b) - getEntrySize(a)
            case "size_asc":
                return getEntrySize(a) - getEntrySize(b)
        }
    })
}

/* ---------------------------------------------------------- Navigation */

type BrowserHistoryState = {
    tglfs: true
    trail: string[]
    preview?: boolean
}

function rememberFolder(entry: FolderBrowserEntry) {
    folderCache.set(entry.data.folderId, entry)
}

function currentTrailIds() {
    if (!state.currentFolder) return []
    const trail = state.currentFolderTrail.length ? state.currentFolderTrail : [state.currentFolder]
    return trail.map((folder) => folder.data.folderId)
}

function historyUrlFor(trailIds: string[]) {
    const base = `${window.location.pathname}${window.location.search}`
    const last = trailIds[trailIds.length - 1]
    return last ? `${base}#/f/${encodeURIComponent(last)}` : base
}

function writeHistory(mode: "push" | "replace") {
    const ids = currentTrailIds()
    const historyState: BrowserHistoryState = { tglfs: true, trail: ids }
    try {
        if (mode === "push") {
            window.history.pushState(historyState, "", historyUrlFor(ids))
        } else {
            window.history.replaceState(historyState, "", historyUrlFor(ids))
        }
    } catch (error) {
        console.warn("Unable to update browser history", error)
    }
}

function resetSearchInput() {
    state.query = ""
    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement | null
    if (searchInput) searchInput.value = ""
    document.getElementById("browserSearchClear")?.setAttribute("hidden", "")
}

async function navigateTo(
    target: FolderBrowserEntry | null,
    options: { push?: boolean; trail?: FolderBrowserEntry[] } = {},
) {
    // The time machine stays open while navigating: the next folder is shown as of the same time.
    const keepHistoryAt = historyMode ? historyMode.at : undefined
    if (historyMode) exitHistoryState()
    await navigateToFolder(target, options)
    if (keepHistoryAt !== undefined) await openHistory(keepHistoryAt)
}

async function navigateToFolder(
    target: FolderBrowserEntry | null,
    options: { push?: boolean; trail?: FolderBrowserEntry[] } = {},
) {
    closeMenu()
    closeSidebar()
    resetSearchInput()
    const previousFolder = state.currentFolder
    if (!target) {
        state.currentFolder = null
        state.currentFolderTrail = []
        if (options.push !== false) writeHistory("push")
        await refreshBrowser?.({ showLoading: true, loadingMessage: "Loading files..." })
        return
    }

    rememberFolder(target)
    const knownTrail = options.trail
    state.currentFolderTrail = knownTrail ?? (previousFolder
        ? [...(state.currentFolderTrail.length ? state.currentFolderTrail : [previousFolder]), target]
        : [target])
    state.currentFolder = target
    if (options.push !== false) writeHistory("push")
    const loadingMessage = `Loading ${target.data.name}...`
    if (knownTrail) {
        await refreshBrowser?.({ showLoading: true, loadingMessage })
        return
    }

    beginBrowserNavigationLoading(loadingMessage)
    const navigationSequence = browserRefreshSequence
    let trail: FolderBrowserEntry[] = [target]
    try {
        trail = await buildFolderTrail(target)
    } catch (error) {
        console.warn("Unable to resolve folder trail", error)
    }
    if (navigationSequence !== browserRefreshSequence) return
    state.currentFolderTrail = trail.length ? trail : [target]
    state.currentFolder = state.currentFolderTrail[state.currentFolderTrail.length - 1] ?? target
    state.currentFolderTrail.forEach(rememberFolder)
    writeHistory("replace")
    await refreshBrowser?.({ showLoading: true, loadingMessage })
}

async function goUp() {
    const folder = state.currentFolder
    if (!folder) return
    const trail = state.currentFolderTrail.length ? state.currentFolderTrail : [folder]
    if (trail.length >= 2) {
        await navigateTo(trail[trail.length - 2], { trail: trail.slice(0, -1) })
        return
    }
    const parentId = folder.data.parentFolderId
    if (parentId && parentId !== TGLFS_ROOT_PARENT_ID && activeBrowserClient) {
        const parent = await getFolderRecord(activeBrowserClient, parentId)
        if (parent) {
            await navigateTo(folderEntryFromRecord(parent))
            return
        }
    }
    await navigateTo(null)
}

async function restoreHistoryTrail(ids: string[]) {
    const current = currentTrailIds()
    if (current.length === ids.length && current.every((id, index) => id === ids[index])) return
    if (ids.length === 0) {
        await navigateTo(null, { push: false })
        return
    }
    const cached = ids.map((id) => folderCache.get(id))
    if (cached.every((entry): entry is FolderBrowserEntry => !!entry)) {
        await navigateTo(cached[cached.length - 1], { push: false, trail: cached })
        return
    }
    const lastId = ids[ids.length - 1]
    let last = folderCache.get(lastId) ?? null
    if (!last && activeBrowserClient) {
        const record = await getFolderRecord(activeBrowserClient, lastId).catch(() => null)
        last = record ? folderEntryFromRecord(record) : null
    }
    await navigateTo(last, { push: false })
}

function updateFolderLocation() {
    const breadcrumb = document.getElementById("browserBreadcrumb")
    if (!breadcrumb) return
    breadcrumb.textContent = ""
    const trail = state.currentFolder
        ? (state.currentFolderTrail.length ? state.currentFolderTrail : [state.currentFolder])
        : []

    const addSeparator = () => {
        const separator = document.createElement("span")
        separator.className = "fx-crumb-sep"
        separator.innerHTML = icon("chevronRight")
        breadcrumb.appendChild(separator)
    }
    const addCrumb = (label: string, isCurrent: boolean, onClick?: () => void) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `fx-crumb${isCurrent ? " is-current" : ""}`
        button.textContent = label
        button.title = label
        if (isCurrent) {
            button.setAttribute("aria-current", "page")
        } else if (onClick) {
            button.addEventListener("click", onClick)
        }
        breadcrumb.appendChild(button)
    }

    addCrumb("All files", trail.length === 0, () => void navigateTo(null))
    for (const [index, folder] of trail.entries()) {
        addSeparator()
        const isCurrent = index === trail.length - 1
        addCrumb(folder.data.name, isCurrent, () => void navigateTo(folder, { trail: trail.slice(0, index + 1) }))
    }
    requestAnimationFrame(() => {
        breadcrumb.scrollLeft = breadcrumb.scrollWidth
    })

    const upButton = document.getElementById("browserUpButton")
    upButton?.toggleAttribute("hidden", !state.currentFolder)
    document.getElementById("navAllFiles")?.classList.toggle("is-active", !state.currentFolder)
    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement | null
    if (searchInput) {
        searchInput.placeholder = state.currentFolder ? `Search in ${state.currentFolder.data.name}` : "Search files"
    }
    const dropTarget = document.getElementById("dropTarget")
    if (dropTarget) {
        dropTarget.textContent = state.currentFolder ? `into ${state.currentFolder.data.name}` : "into All files"
    }
}

/* ----------------------------------------------------------- Rendering */

function checkboxHtml(label: string) {
    return `<button type="button" class="fx-check" role="checkbox" aria-checked="false" tabindex="-1" aria-label="Select ${escapeHtml(label)}">${icon("check")}</button>`
}

function moreButtonHtml(label: string) {
    return `<button type="button" class="fx-icon-btn fx-more" tabindex="-1" aria-haspopup="menu" aria-label="More actions for ${escapeHtml(label)}">${icon("more")}</button>`
}

function applyEntryDataset(element: HTMLElement, entry: BrowserEntry, index: number) {
    element.dataset.browserId = entry.id
    element.dataset.kind = entry.kind
    element.dataset.index = String(index)
    element.dataset.name = getEntryName(entry)
    if (isFileEntry(entry)) element.dataset.msgid = String(entry.msgId)
}

function renderList(items: BrowserEntry[]) {
    const rows = document.getElementById("browserRows")
    if (!rows) return
    const fragment = document.createDocumentFragment()
    for (const [index, entry] of items.entries()) {
        const name = getEntryName(entry)
        const safeName = escapeHtml(name)
        const path = entry.kind === "missing-file" ? getEntryPath(entry) : ""
        const sub = path ? escapeHtml(path) : escapeHtml(getEntryMetaText(entry))
        const row = document.createElement("div")
        row.className = "fx-row"
        row.setAttribute("role", "row")
        row.tabIndex = -1
        applyEntryDataset(row, entry, index)
        row.innerHTML = `
            <div class="fx-cell fx-cell-check">${checkboxHtml(name)}</div>
            <div class="fx-cell fx-name-cell">
                ${fileKindIcon(getEntryKind(entry))}
                <div class="fx-name-wrap">
                    <div class="fx-name-line"><span class="fx-name" title="${safeName}">${safeName}</span>${getEntryBadge(entry)}</div>
                    <div class="fx-sub${path ? " is-path" : ""}">${sub}</div>
                </div>
            </div>
            <div class="fx-cell fx-cell-size">${entry.kind === "folder" ? "—" : escapeHtml(getEntrySizeText(entry))}</div>
            <div class="fx-cell fx-cell-date" title="${escapeHtml(formatFileCardDate(getEntryDate(entry)))}">${escapeHtml(formatEntryDate(getEntryDate(entry)))}</div>
            <div class="fx-cell fx-cell-more">${moreButtonHtml(name)}</div>`
        attachEntryHandlers(row, entry, index)
        fragment.appendChild(row)
    }
    rows.appendChild(fragment)
}

function renderGrid(items: BrowserEntry[]) {
    const grid = document.getElementById("browserGrid")
    if (!grid) return
    const fragment = document.createDocumentFragment()
    for (const [index, entry] of items.entries()) {
        const name = getEntryName(entry)
        const safeName = escapeHtml(name)
        const tile = document.createElement("div")
        tile.className = "fx-tile"
        tile.setAttribute("role", "gridcell")
        tile.tabIndex = -1
        applyEntryDataset(tile, entry, index)
        tile.innerHTML = `
            <div class="fx-tile-art">${fileKindIcon(getEntryKind(entry), "lg")}${getEntryBadge(entry)}</div>
            ${checkboxHtml(name)}
            ${moreButtonHtml(name)}
            <div class="fx-tile-body">
                <div class="fx-tile-name" title="${safeName}">${safeName}</div>
                <div class="fx-tile-meta">${escapeHtml(getEntryMetaText(entry))}</div>
            </div>`
        attachEntryHandlers(tile, entry, index)
        fragment.appendChild(tile)
    }
    grid.appendChild(fragment)
}

function renderEmptyState(visible: boolean) {
    const empty = document.getElementById("browserEmpty")
    if (!empty) return
    if (!visible) {
        empty.setAttribute("hidden", "")
        return
    }
    const searching = state.query.length > 0
    const title = searching
        ? `No results for “${state.query}”`
        : state.currentFolder ? "This folder is empty" : "No files yet"
    const text = searching
        ? "Try a different name, or search for a UFID."
        : "Upload files or drop them here. Everything is encrypted in your browser before it reaches Telegram."
    empty.innerHTML = `
        <span class="fx-empty-art">${icon(searching ? "search" : "cloudUp")}</span>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(text)}</p>
        <div class="fx-empty-actions">
            ${searching
                ? `<button type="button" class="fx-btn fx-btn-secondary" data-empty-action="clear">${icon("close")}Clear search</button>`
                : `<button type="button" class="fx-btn fx-btn-primary" data-empty-action="upload">${icon("upload")}Upload files</button>
                   <button type="button" class="fx-btn fx-btn-secondary" data-empty-action="folder">${icon("folderPlus")}New folder</button>`}
        </div>`
    empty.removeAttribute("hidden")
}

function updatePager(items: BrowserEntry[]) {
    const pager = document.getElementById("browserPager")
    const pageInfo = document.getElementById("browserPageInfo")
    const prevButton = document.getElementById("browserPrevPage") as HTMLButtonElement | null
    const nextButton = document.getElementById("browserNextPage") as HTMLButtonElement | null
    const hasPrev = state.currentPage > 0
    const hasNext = !(state.currentPage >= state.pages.length - 1 && !state.hasMore)
    if (prevButton) prevButton.disabled = !hasPrev
    if (nextButton) nextButton.disabled = !hasNext
    const single = !hasPrev && !hasNext
    pager?.classList.toggle("is-single", single)
    pager?.toggleAttribute("hidden", items.length === 0)
    if (!pageInfo) return
    if (single) {
        pageInfo.textContent = pluralize(items.length, "item")
        return
    }
    const start = state.currentPage * state.pageSize + 1
    const end = start + items.length - 1
    pageInfo.textContent = state.totalItems !== null
        ? `${start}–${end} of ${state.totalItems}`
        : `${start}–${end} · Page ${state.currentPage + 1} of ${visibleTotalPages()}`
}

function renderBrowser(items: BrowserEntry[]) {
    const content = document.getElementById("browserContent")
    content?.setAttribute("aria-busy", "false")
    clearViews()
    applySort(items)
    for (const entry of items) {
        if (isFolderEntry(entry)) rememberFolder(entry)
    }
    if (state.focusIndex !== null && state.focusIndex >= items.length) state.focusIndex = null
    renderList(items)
    renderGrid(items)
    renderEmptyState(items.length === 0)
    updateFolderLocation()
    updatePager(items)
    applyViewMode()
    updateSelectionDisplay()
}

function applyViewMode() {
    const listView = document.getElementById("browserList")
    const gridView = document.getElementById("browserGrid")
    const listButton = document.getElementById("viewList")
    const gridButton = document.getElementById("viewGrid")
    const empty = !document.getElementById("browserEmpty")?.hasAttribute("hidden")
    listView?.toggleAttribute("hidden", state.viewMode !== "list" || empty)
    gridView?.toggleAttribute("hidden", state.viewMode !== "grid" || empty)
    listButton?.classList.toggle("is-active", state.viewMode === "list")
    gridButton?.classList.toggle("is-active", state.viewMode === "grid")
    listButton?.setAttribute("aria-pressed", String(state.viewMode === "list"))
    gridButton?.setAttribute("aria-pressed", String(state.viewMode === "grid"))
}

function setViewMode(mode: "list" | "grid") {
    state.viewMode = mode
    writePreference(VIEW_STORAGE_KEY, mode)
    applyViewMode()
    applyFocusDisplay()
}

/* ----------------------------------------------------------- Selection */

function toggleSelection(entry: BrowserEntry, index: number) {
    if (state.selected.has(entry.id)) {
        state.selected.delete(entry.id)
    } else {
        state.selected.set(entry.id, entry)
    }
    state.lastClickedIndex = index
    state.focusIndex = index
    updateSelectionDisplay()
}

function selectOnly(entry: BrowserEntry, index: number) {
    state.selected.clear()
    state.selected.set(entry.id, entry)
    state.lastClickedIndex = index
    state.focusIndex = index
    updateSelectionDisplay()
}

function selectRange(fromIndex: number, toIndex: number, additive: boolean) {
    const items = getVisibleItems()
    if (!additive) state.selected.clear()
    const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
    for (let i = start; i <= end; i++) {
        const entry = items[i]
        if (entry) state.selected.set(entry.id, entry)
    }
    state.focusIndex = toIndex
    updateSelectionDisplay()
}

function selectAllVisible() {
    if (historyMode) return
    const items = getVisibleItems()
    const allSelected = items.length > 0 && items.every((entry) => state.selected.has(entry.id))
    if (allSelected) {
        clearSelection()
        return
    }
    for (const entry of items) state.selected.set(entry.id, entry)
    updateSelectionDisplay()
}

function clearSelection() {
    state.selected.clear()
    state.lastClickedIndex = null
    updateSelectionDisplay()
}

function applyFocusDisplay(scroll = false) {
    document.querySelectorAll<HTMLElement>("[data-browser-id].is-focused").forEach((node) => node.classList.remove("is-focused"))
    if (state.focusIndex === null || !keyboardNavigation) return
    const container = state.viewMode === "grid" ? "#browserGrid" : "#browserRows"
    const node = document.querySelector<HTMLElement>(`${container} [data-index="${state.focusIndex}"]`)
    if (!node) return
    node.classList.add("is-focused")
    if (scroll) node.scrollIntoView({ block: "nearest" })
}

function updateSelectionDisplay() {
    const selectedIds = new Set(state.selected.keys())
    document.querySelectorAll<HTMLElement>("[data-browser-id]").forEach((node) => {
        const id = node.dataset.browserId
        const selected = !!id && selectedIds.has(id)
        node.classList.toggle("selected", selected)
        node.setAttribute("aria-selected", String(selected))
        node.querySelector(".fx-check")?.setAttribute("aria-checked", String(selected))
    })
    const items = getVisibleItems()
    const selectedVisible = items.filter((entry) => selectedIds.has(entry.id)).length
    const headCheck = document.getElementById("browserSelectAllCheck")
    headCheck?.setAttribute(
        "aria-checked",
        selectedVisible === 0 ? "false" : selectedVisible === items.length ? "true" : "mixed",
    )
    applyFocusDisplay()
    updateActionStates()
}

function toSelectionItems(entries: BrowserEntry[]): BrowserSelectionItem[] {
    return entries.map((entry) => ({
        kind: entry.kind,
        id: entry.id,
        name: getEntryName(entry),
        msgId: isFileEntry(entry) ? entry.msgId : undefined,
    }))
}

/** Actions that never change anything in Telegram; the only ones offered while viewing history. */
const READ_ONLY_ACTION_KEYS = new Set(["open", "download", "copy", "history"])

function getSelectionActions(entries: BrowserEntry[]): SelectionAction[] {
    const actions = getAllSelectionActions(entries)
    return historyMode ? actions.filter((action) => READ_ONLY_ACTION_KEYS.has(action.key)) : actions
}

function getAllSelectionActions(entries: BrowserEntry[]): SelectionAction[] {
    const client = activeBrowserClient
    const single = entries.length === 1 ? entries[0] : null
    const files = entries.filter(isFileEntry)
    const folders = entries.filter(isFolderEntry)
    const allFilesOrFolders = entries.length > 0 && files.length + folders.length === entries.length
    const actions: SelectionAction[] = []

    if (single && isFolderEntry(single)) {
        actions.push({ key: "open", id: "browserActionPreview", menuId: "actionPreviewItem", label: "Open", icon: "open", hint: "↵", run: () => runSingleOpenAction(single) })
        actions.push({ key: "history", id: "browserActionHistory", menuId: "actionHistoryItem", label: "History", icon: "history", hint: "H", menuOnly: true, run: () => openFolderHistory(single) })
    } else if (single && isFileEntry(single) && isPreviewableName(single.data.name)) {
        actions.push({ key: "open", id: "browserActionPreview", menuId: "actionPreviewItem", label: "Preview", icon: "eye", hint: "↵", run: () => runSingleOpenAction(single) })
    }
    if (single && isFileEntry(single)) {
        actions.push({ key: "download", id: "browserActionDownload", menuId: "actionDownloadItem", label: "Download", icon: "download", run: () => downloadEntry(single) })
    }
    const selectionItems = toSelectionItems(entries)
    for (const extra of getExtraBrowserActions()) {
        if (!extra.isVisible(selectionItems)) continue
        actions.push({
            key: `extra:${extra.id}`,
            id: extra.id,
            menuId: extra.menuId,
            label: extra.label,
            shortLabel: extra.shortLabel,
            icon: extra.icon,
            disabled: extra.isBusy?.() ?? false,
            run: () => extra.run(selectionItems),
        })
    }
    if (single && (isFileEntry(single) || isFolderEntry(single))) {
        actions.push({ key: "rename", id: "browserActionRename", menuId: "actionRenameItem", label: "Rename", icon: "pencil", hint: "F2", run: () => renameEntry(single) })
    }
    if (allFilesOrFolders && client) {
        actions.push({ key: "move", id: "browserActionMove", menuId: "actionMoveItem", label: "Move", icon: "move", run: () => moveSelectedEntries(client) })
    }
    if (entries.length > 0 && files.length === entries.length) {
        actions.push({ key: "send", id: "browserActionSend", menuId: "actionSendItem", label: "Send", icon: "send", run: () => sendEntries(files) })
    }
    if (single) {
        const copy = getCopyId(single)
        actions.push({ key: "copy", id: "browserActionCopyId", menuId: "actionCopyIdItem", label: `Copy ${copy.label}`, icon: "copy", menuOnly: true, run: () => copyEntryId(single) })
    }
    if (allFilesOrFolders) {
        actions.push({ key: "delete", id: "browserActionDelete", menuId: "actionDeleteItem", label: "Delete", icon: "trash", danger: true, hint: "Del", run: () => deleteSelectedEntries() })
    }
    return actions
}

function updateActionStates() {
    const selectedEntries = Array.from(state.selected.values())
    const selectedCount = selectedEntries.length
    const browserDiv = document.getElementById("fileBrowser")
    const browserVisible = !!browserDiv && !browserDiv.hasAttribute("hidden")
    const active = browserVisible && selectedCount > 0
    document.body.classList.toggle("fx-selecting", active)
    browserDiv?.classList.toggle("fx-selecting", active)

    const bar = document.getElementById("fileActionsBar")
    bar?.toggleAttribute("hidden", !active)
    const info = document.getElementById("selectionInfo")
    if (info) info.textContent = selectedCount > 0 ? `${selectedCount} selected` : ""
    const selectAllButton = document.getElementById("selectAllBtn")
    if (selectAllButton) {
        const items = getVisibleItems()
        const allSelected = items.length > 0 && items.every((entry) => state.selected.has(entry.id))
        selectAllButton.textContent = allSelected ? "Deselect all" : "Select all"
    }

    const container = document.getElementById("fileActionsButtons")
    if (!container) return
    currentBarActions = new Map()
    if (!active) {
        container.innerHTML = ""
        return
    }
    const actions = getSelectionActions(selectedEntries).filter((action) => !action.menuOnly)
    const compact = isCompactViewport()
    const max = compact ? 5 : 8
    const visible = actions.length > max ? actions.slice(0, max - 1) : actions
    const overflow = actions.length > max ? actions.slice(max - 1) : []
    const buttonHtml = (action: SelectionAction) => `
        <button type="button" id="${escapeHtml(action.id)}" class="fx-sel-action${action.danger ? " is-danger" : ""}"
            data-action-key="${escapeHtml(action.key)}" title="${escapeHtml(action.hint ? `${action.label} (${action.hint})` : action.label)}"
            ${action.disabled ? "disabled" : ""}>
            ${icon(action.icon)}<span>${escapeHtml(compact ? action.shortLabel ?? action.label : action.label)}</span>
        </button>`
    container.innerHTML = visible.map(buttonHtml).join("") + (overflow.length
        ? `<button type="button" class="fx-sel-action" data-action-key="__more" title="More actions">${icon("more")}<span>More</span></button>`
        : "")
    for (const action of actions) currentBarActions.set(action.key, action)
    currentBarActions.set("__more", {
        key: "__more",
        id: "",
        menuId: "",
        label: "More",
        icon: "more",
        run: () => {
            const anchor = container.querySelector<HTMLElement>('[data-action-key="__more"]') ?? undefined
            openMenu({ anchor, items: overflow.map(actionToMenuItem) })
        },
    })
}

function actionToMenuItem(action: SelectionAction): MenuItem {
    return {
        id: action.menuId,
        label: action.label,
        icon: action.icon,
        hint: action.hint,
        danger: action.danger,
        disabled: action.disabled,
        onSelect: action.run,
    }
}

function openEntryMenu(entry: BrowserEntry, index: number, anchor?: HTMLElement | { x: number; y: number }) {
    // On touch, opening one item's sheet must not leave the browser in selection mode afterwards.
    const transient = !state.selected.has(entry.id) && (isTouchInteraction() || isCompactViewport())
    const restoreSelection = () => {
        if (!transient) return
        if (state.selected.size === 1 && state.selected.has(entry.id)) clearSelection()
    }
    if (!state.selected.has(entry.id)) selectOnly(entry, index)
    const entries = Array.from(state.selected.values())
    const actions = getSelectionActions(entries)
    const items: MenuItem[] = []
    for (const action of actions) {
        if (action.danger && items.length) items.push({ divider: true })
        const item = actionToMenuItem(action)
        if ("onSelect" in item) {
            item.onSelect = async () => {
                try {
                    await action.run()
                } finally {
                    restoreSelection()
                }
            }
        }
        items.push(item)
    }
    const onClose = (chosen: boolean) => {
        if (!chosen) restoreSelection()
    }
    if (entries.length === 1) {
        openMenu({
            anchor,
            headerHtml: fileKindIcon(getEntryKind(entry)),
            title: getEntryName(entry),
            subtitle: entry.kind === "missing-file" ? `Missing file · ${getEntryPath(entry)}` : getEntryMetaText(entry),
            items,
            onClose,
        })
    } else {
        openMenu({ anchor, title: `${entries.length} items selected`, items, onClose })
    }
}

/* -------------------------------------------------------- Interaction */

function attachEntryHandlers(element: HTMLElement, entry: BrowserEntry, index: number) {
    let pressTimer: number | undefined
    let pressStart: { x: number; y: number } | null = null
    const cancelPress = () => {
        if (pressTimer !== undefined) window.clearTimeout(pressTimer)
        pressTimer = undefined
        pressStart = null
    }

    element.addEventListener("pointerdown", (event) => {
        lastPointerType = event.pointerType || "mouse"
        if (event.pointerType === "mouse") return
        if ((event.target as HTMLElement).closest(".fx-more")) return
        pressStart = { x: event.clientX, y: event.clientY }
        pressTimer = window.setTimeout(() => {
            pressTimer = undefined
            suppressNextClick = true
            if (!state.selected.has(entry.id)) {
                state.selected.set(entry.id, entry)
                state.lastClickedIndex = index
                updateSelectionDisplay()
            }
            navigator.vibrate?.(10)
        }, LONG_PRESS_MS)
    })
    element.addEventListener("pointermove", (event) => {
        if (!pressStart) return
        if (Math.abs(event.clientX - pressStart.x) > 8 || Math.abs(event.clientY - pressStart.y) > 8) cancelPress()
    })
    element.addEventListener("pointerup", cancelPress)
    element.addEventListener("pointercancel", cancelPress)

    element.addEventListener("click", (event) => {
        if (suppressNextClick) {
            suppressNextClick = false
            return
        }
        const target = event.target as HTMLElement
        if (target.closest(".fx-check")) {
            if (event.shiftKey && state.lastClickedIndex !== null) {
                selectRange(state.lastClickedIndex, index, true)
            } else {
                toggleSelection(entry, index)
            }
            return
        }
        const moreButton = target.closest<HTMLElement>(".fx-more")
        if (moreButton) {
            openEntryMenu(entry, index, moreButton)
            return
        }
        if (event.shiftKey && state.lastClickedIndex !== null) {
            selectRange(state.lastClickedIndex, index, event.metaKey || event.ctrlKey)
            return
        }
        if (event.metaKey || event.ctrlKey) {
            toggleSelection(entry, index)
            return
        }
        if (isTouchInteraction()) {
            if (state.selected.size > 0) {
                toggleSelection(entry, index)
            } else {
                state.focusIndex = index
                void openEntry(entry, index)
            }
            return
        }
        selectOnly(entry, index)
    })
    element.addEventListener("dblclick", (event) => {
        const target = event.target as HTMLElement
        if (target.closest(".fx-check, .fx-more") || isTouchInteraction()) return
        event.preventDefault()
        void openEntry(entry, index)
    })
    element.addEventListener("contextmenu", (event) => {
        if (lastPointerType !== "mouse") {
            // Long-press on touch devices selects instead of opening the system menu.
            event.preventDefault()
            return
        }
        event.preventDefault()
        openEntryMenu(entry, index, { x: event.clientX, y: event.clientY })
    })
}

async function openEntry(entry: BrowserEntry, index: number) {
    if (isFolderEntry(entry)) {
        await navigateTo(entry)
        return
    }
    if (isFileEntry(entry) && isPreviewableName(entry.data.name)) {
        await runSingleOpenAction(entry)
        return
    }
    if (entry.kind === "missing-file") {
        showUfidToast("This file card could not be found in Telegram", { tone: "error" })
        return
    }
    const node = document.querySelector<HTMLElement>(
        `${state.viewMode === "grid" ? "#browserGrid" : "#browserRows"} [data-index="${index}"] .fx-more`,
    )
    openEntryMenu(entry, index, isCompactViewport() ? undefined : node ?? undefined)
}

/* ------------------------------------------------------------ Sidebar */

function openSidebar() {
    document.getElementById("fxSidebar")?.classList.add("is-open")
    document.getElementById("fxScrim")?.removeAttribute("hidden")
}

function closeSidebar() {
    document.getElementById("fxSidebar")?.classList.remove("is-open")
    document.getElementById("fxScrim")?.setAttribute("hidden", "")
}

function isSidebarOpen() {
    return !!document.getElementById("fxSidebar")?.classList.contains("is-open")
}

function currentDirectoryParentId() {
    return state.currentFolder?.data.folderId ?? TGLFS_ROOT_PARENT_ID
}

function setNextUploadParentFromBrowserState() {
    ;(window as any).__tglfsUploadParentFolderId = currentDirectoryParentId()
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
        const parentFolderId = current.data.parentFolderId
        current = parentFolderId && parentFolderId !== TGLFS_ROOT_PARENT_ID
            ? await getFolderRecord(client, parentFolderId)
            : null
    }

    return records.map(folderEntryFromRecord)
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

function activeManifestFileUfids(manifest: TglfsFolderManifest) {
    return new Set(
        Object.values(manifest.entries)
            .filter((entry) => !entry.deleted && entry.kind === "file" && !!entry.ufid)
            .map((entry) => entry.ufid as string),
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

function getOrCreateMoveTombstoneBatch(batches: Map<string, MoveTombstoneBatch>, folderId: string) {
    const existing = batches.get(folderId)
    if (existing) return existing
    const batch = { fileUfids: new Set<string>(), folderIds: new Set<string>() }
    batches.set(folderId, batch)
    return batch
}

function addFileTombstone(batches: Map<string, MoveTombstoneBatch>, folderId: string, ufid: string) {
    getOrCreateMoveTombstoneBatch(batches, folderId).fileUfids.add(ufid)
}

function addFolderTombstone(batches: Map<string, MoveTombstoneBatch>, folderId: string, childFolderId: string) {
    getOrCreateMoveTombstoneBatch(batches, folderId).folderIds.add(childFolderId)
}

function countMoveEntries(entries: BrowserEntry[]): MoveResult {
    return {
        files: entries.filter(isFileEntry).length,
        folders: entries.filter(isFolderEntry).length,
    }
}

function formatMoveCount(result: MoveResult) {
    const total = result.files + result.folders
    if (result.files > 0 && result.folders === 0) {
        return result.files === 1 ? "1 file" : `${result.files} files`
    }
    if (result.folders > 0 && result.files === 0) {
        return result.folders === 1 ? "1 folder" : `${result.folders} folders`
    }
    return total === 1 ? "1 item" : `${total} items`
}

function totalMoved(result: MoveResult) {
    return result.files + result.folders
}

function waitForNextFrame() {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function writeMoveTombstones(client: any, batches: Map<string, MoveTombstoneBatch>, now: string) {
    for (const [folderId, batch] of batches) {
        if (batch.fileUfids.size === 0 && batch.folderIds.size === 0) continue
        await tombstoneEntryInFolderManifest(client, folderId, now, (entry) =>
            (entry.kind === "file" && !!entry.ufid && batch.fileUfids.has(entry.ufid)) ||
            (entry.kind === "folder" && !!entry.folderId && batch.folderIds.has(entry.folderId)),
        )
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

async function loadDirectoryPage(
    client: any,
    parentFolderId: string,
    options: { folderOffsetId?: number; fileOffsetId?: number } = {},
) {
    const items: BrowserEntry[] = []
    let nextFolderOffsetId = options.folderOffsetId
    let folderHasMore = false

    const folderRecords = await listFolderRecords(client, {
        parentFolderId,
        query: state.query,
        limit: state.pageSize + 1,
        offsetId: options.folderOffsetId,
    })
    for (const record of folderRecords) {
        if (items.length >= state.pageSize) {
            folderHasMore = true
            break
        }
        items.push(folderEntryFromRecord(record))
        nextFolderOffsetId = record.msgId
    }

    if (folderHasMore) {
        applySort(items)
        return {
            items,
            lastFolderOffsetId: nextFolderOffsetId,
            lastOffsetId: options.fileOffsetId,
            hasMore: true,
        }
    }

    let fileOffsetId = options.fileOffsetId
    let nextFileOffsetId = options.fileOffsetId
    let fileHasMore = false
    while (items.length < state.pageSize) {
        const fileRecords = await listFileCards(client, {
            parentFolderId,
            query: state.query,
            limit: state.pageSize + 1,
            offsetId: fileOffsetId,
        })
        if (fileRecords.length === 0) {
            fileHasMore = false
            break
        }

        let processedAny = false
        for (const [index, record] of fileRecords.entries()) {
            if (items.length >= state.pageSize) {
                fileHasMore = true
                processedAny = true
                break
            }

            items.push(fileEntryFromRecord(record))
            nextFileOffsetId = record.msgId
            processedAny = true

            const recordsRemainInBatch = index < fileRecords.length - 1
            if (items.length >= state.pageSize && (recordsRemainInBatch || fileRecords.length > state.pageSize)) {
                fileHasMore = true
                break
            }
        }

        if (fileHasMore) {
            break
        }

        if (!processedAny || nextFileOffsetId === fileOffsetId) {
            fileHasMore = false
            break
        }

        if (fileRecords.length <= state.pageSize) {
            const probe = await listFileCards(client, {
                parentFolderId,
                query: state.query,
                limit: 1,
                offsetId: nextFileOffsetId,
            })
            if (probe.length === 0) {
                break
            }
            if (items.length > 0) {
                fileHasMore = true
                break
            }
            fileOffsetId = nextFileOffsetId
            continue
        }

        if (items.length > 0) {
            fileHasMore = true
            break
        }

        fileOffsetId = nextFileOffsetId
    }

    applySort(items)
    return {
        items,
        lastFolderOffsetId: nextFolderOffsetId,
        lastOffsetId: nextFileOffsetId,
        hasMore: fileHasMore,
    }
}

async function loadFirstPage(client: any, refreshSequence = browserRefreshSequence): Promise<BrowserEntry[] | null> {
    state.pages = []
    state.currentPage = 0
    state.lastOffsetId = undefined
    state.lastFolderOffsetId = undefined
    state.selected.clear()
    state.lastClickedIndex = null
    state.totalPages = null
    state.totalItems = null
    const parentFolderId = currentDirectoryParentId()
    const countPromise = countDirectoryEntries(client, {
        parentFolderId,
        query: state.query,
    }).catch((error) => {
        console.warn("Failed to load folder browser page count", error)
        return null
    })
    const page = await loadDirectoryPage(client, parentFolderId)
    if (refreshSequence !== browserRefreshSequence) return null
    page.items = withoutHiddenEntries(page.items)
    countPromise
        .then((counts) => {
            if (!counts) return
            if (refreshSequence !== browserRefreshSequence) return
            state.totalPages = Math.max(1, Math.ceil(counts.total / state.pageSize))
            state.totalItems = counts.total
            renderBrowser(state.pages[state.currentPage] ?? page.items)
        })
    state.lastOffsetId = page.lastOffsetId
    state.lastFolderOffsetId = page.lastFolderOffsetId
    state.pages.push(page.items)
    state.hasMore = page.hasMore
    return page.items
}

async function loadNextPage(client: any) {
    const page = await loadDirectoryPage(client, currentDirectoryParentId(), {
        folderOffsetId: state.lastFolderOffsetId,
        fileOffsetId: state.lastOffsetId,
    })
    page.items = withoutHiddenEntries(page.items)
    state.lastOffsetId = page.lastOffsetId
    state.lastFolderOffsetId = page.lastFolderOffsetId
    state.hasMore = page.hasMore
    if (page.items.length > 0) {
        state.pages.push(page.items)
    }
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
    const records = await listFolderRecords(client, { parentFolderId: TGLFS_ROOT_PARENT_ID, query: name, limit: 200 })
    return records.some((record) =>
        record.data.folderId !== ignoreFolderId &&
        record.data.parentFolderId === TGLFS_ROOT_PARENT_ID &&
        record.data.path === "" &&
        !record.data.deleted &&
        record.data.name.toLowerCase() === name.toLowerCase(),
    )
}

async function fileNameExistsInParent(client: any, parentFolderId: string, name: string, ignoreMsgId?: number) {
    const records = await listFileCards(client, { parentFolderId, query: name, limit: 200 })
    return records.some((record) =>
        record.msgId !== ignoreMsgId &&
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
        title: "New folder",
        label: "Folder name",
        placeholder: "Untitled folder",
        confirmLabel: "Create",
        icon: "folderPlus",
    }))
    if (!name) return
    void flushPendingDelete()
    await runExclusiveMutation(() => createFolderNamed(client, name))
}

async function createFolderNamed(client: any, name: string) {
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
        parentFolderId: parent?.data.folderId ?? TGLFS_ROOT_PARENT_ID,
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

    await writeFolderManifest(client, manifest, null, folder)

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

async function renameFolderEntry(entry: FolderBrowserEntry) {
    const newName = validateFolderName(await requestBrowserText({
        title: "Rename folder",
        label: "Folder name",
        initialValue: entry.data.name,
        confirmLabel: "Rename",
        icon: "pencil",
    }))
    if (!newName || newName === entry.data.name) return
    await renameEntryTo(entry, newName)
}

/** Renames a folder (and rewrites its subtree paths). Returns false when nothing was written. */
async function renameFolderTo(client: any, entry: FolderBrowserEntry, newName: string): Promise<boolean> {
    const record = await resolveFolderRecordForMutation(client, entry)
    if (!record) {
        showUfidToast("Unable to find folder record")
        return false
    }

    const now = new Date().toISOString()
    const parentId = record.data.parentFolderId
    const actualParentId = parentId && parentId !== TGLFS_ROOT_PARENT_ID ? parentId : undefined
    const parentManifestRecord = actualParentId ? await getFolderManifest(client, actualParentId) : null
    if (parentManifestRecord) {
        const activeNames = [...activeManifestEntryNames(parentManifestRecord.data)].filter((name) => name !== record.data.name.toLowerCase())
        if (!assertFolderNameAvailable(newName, activeNames)) return false
    } else if (!actualParentId && await topLevelFolderNameExists(client, newName, record.data.folderId)) {
        showUfidToast(`"${newName}" already exists here`)
        return false
    }

    const parentPath = parentManifestRecord?.data.path ?? ""
    const newPath = actualParentId ? joinFolderPath(parentPath, newName) : record.data.path

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
    return true
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
    if (!record.data.parentFolderId || record.data.parentFolderId === TGLFS_ROOT_PARENT_ID) return
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
    const parentFolderId = state.currentFolder?.data.parentFolderId
    const parentFolder = parentFolderId && parentFolderId !== TGLFS_ROOT_PARENT_ID
        ? recordsById.get(parentFolderId) ?? await getFolderRecord(client, parentFolderId)
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
        title: "Move to folder",
        message: selectedEntries.length === 1 ? `Move "${getEntryName(selectedEntries[0])}"` : `Move ${selectedEntries.length} items`,
        label: "Destination folder",
        confirmLabel: "Move",
        icon: "move",
        choices: destinations.map((destination) => ({
            value: destination.kind === "root" ? ROOT_MOVE_DESTINATION : destination.record.data.folderId,
            label: destination.label,
            icon: destination.kind === "root" ? "home" : "folder",
        })),
    })
    if (!choice) return null
    if (choice === ROOT_MOVE_DESTINATION) return parentDestination?.kind === "root" ? parentDestination : null
    const destination = destinations.find((candidate): candidate is MoveDestination & { kind: "folder" } =>
        candidate.kind === "folder" && candidate.record.data.folderId === choice,
    )
    return destination ?? null
}

type MovePassOptions = {
    /**
     * Folder whose manifest currently lists the moved files (tombstoned after the move). Defaults to the
     * folder being viewed, which is where browser selections come from; undo passes it explicitly.
     */
    fileSourceFolderId?: string | null
}

function resolveFileSourceFolderId(options: MovePassOptions) {
    const folderId = options.fileSourceFolderId !== undefined ? options.fileSourceFolderId : state.currentFolder?.data.folderId
    return folderId && folderId !== TGLFS_ROOT_PARENT_ID ? folderId : null
}

async function moveEntriesToFolderInSinglePass(
    client: any,
    entries: BrowserEntry[],
    destination: TglfsFolderRecord,
    now: string,
    options: MovePassOptions = {},
) {
    const fileSourceFolderId = resolveFileSourceFolderId(options)
    const { record: destinationManifestRecord, manifest: destinationManifest } =
        await getFolderManifestForMutation(client, destination.data, now)
    const destinationEntries = { ...destinationManifest.entries }
    const destinationNames = activeManifestEntryNames(destinationManifest)
    const destinationFileUfids = activeManifestFileUfids(destinationManifest)
    const sourceTombstones = new Map<string, MoveTombstoneBatch>()
    const movedFileEntries: FileBrowserEntry[] = []
    const preparedFolderMoves: PreparedFolderMove[] = []

    for (const entry of entries) {
        if (isFileEntry(entry)) {
            const lowerName = entry.data.name.toLowerCase()
            const fileNameExists = await fileNameExistsInParent(client, destination.data.folderId, entry.data.name, entry.msgId)
            if (destinationNames.has(lowerName) || destinationFileUfids.has(entry.data.ufid) || fileNameExists) {
                showUfidToast(`"${entry.data.name}" already exists here`)
                continue
            }
            destinationNames.add(lowerName)
            destinationFileUfids.add(entry.data.ufid)
            const path = joinFolderPath(destination.data.path, entry.data.name)
            destinationEntries[entry.data.name] = {
                entryId: createRecordId("entry"),
                name: entry.data.name,
                path,
                kind: "file",
                ufid: entry.data.ufid,
                size: entry.data.size,
                mtimeMs: Date.parse(now),
                mode: 0o644,
                deleted: false,
                updatedAt: now,
            }
            movedFileEntries.push(entry)
            if (fileSourceFolderId) {
                addFileTombstone(sourceTombstones, fileSourceFolderId, entry.data.ufid)
            }
            continue
        }

        if (!isFolderEntry(entry)) continue
        const record = await resolveFolderRecordForMutation(client, entry)
        if (!record) {
            showUfidToast("Unable to find folder record")
            continue
        }
        const lowerName = record.data.name.toLowerCase()
        if (destinationNames.has(lowerName)) {
            showUfidToast(`"${record.data.name}" already exists here`)
            continue
        }

        destinationNames.add(lowerName)
        const rootId = destination.data.rootId ?? destination.data.folderId
        const oldPath = record.data.path
        const newPath = joinFolderPath(destination.data.path, record.data.name)
        destinationEntries[record.data.name] = {
            entryId: createRecordId("entry"),
            name: record.data.name,
            path: newPath,
            kind: "folder",
            folderId: record.data.folderId,
            deleted: false,
            updatedAt: now,
        }
        preparedFolderMoves.push({
            record,
            parentFolderId: destination.data.folderId,
            rootId,
            oldPath,
            newPath,
        })
        if (record.data.parentFolderId) {
            addFolderTombstone(sourceTombstones, record.data.parentFolderId, record.data.folderId)
        }
    }

    const moved = movedFileEntries.length + preparedFolderMoves.length
    if (moved === 0) return { files: 0, folders: 0 }

    await writeFolderManifest(client, {
        ...destinationManifest,
        rootId: destination.data.rootId ?? destination.data.folderId,
        path: destination.data.path,
        updatedAt: now,
        entries: destinationEntries,
    }, destinationManifestRecord)

    for (const folderMove of preparedFolderMoves) {
        await updateFolderTreeForRename(client, folderMove.record, {
            parentFolderId: folderMove.parentFolderId,
            rootId: folderMove.rootId,
            oldPath: folderMove.oldPath,
            newPath: folderMove.newPath,
            now,
            includeEmptyPrefix: true,
        })
    }
    for (const entry of movedFileEntries) {
        entry.data = await updateFileCardParent(client, entry.msgId, "me", entry.data, destination.data.folderId)
    }
    await writeMoveTombstones(client, sourceTombstones, now)
    return { files: movedFileEntries.length, folders: preparedFolderMoves.length }
}

async function moveEntriesToRootInSinglePass(client: any, entries: BrowserEntry[], now: string, options: MovePassOptions = {}) {
    const fileSourceFolderId = resolveFileSourceFolderId(options)
    const sourceTombstones = new Map<string, MoveTombstoneBatch>()
    const movedFileEntries: FileBrowserEntry[] = []
    const preparedFolderMoves: PreparedFolderMove[] = []
    const topLevelFolderRecords = await listFolderRecords(client, { limit: 500 })
    const topLevelNames = new Set(
        topLevelFolderRecords
            .filter((record) => record.data.parentFolderId === TGLFS_ROOT_PARENT_ID && record.data.path === "" && !record.data.deleted)
            .map((record) => record.data.name.toLowerCase()),
    )

    for (const entry of entries) {
        if (isFileEntry(entry)) {
            if (await fileNameExistsInParent(client, TGLFS_ROOT_PARENT_ID, entry.data.name, entry.msgId)) {
                showUfidToast(`"${entry.data.name}" already exists here`)
                continue
            }
            movedFileEntries.push(entry)
            if (fileSourceFolderId) {
                addFileTombstone(sourceTombstones, fileSourceFolderId, entry.data.ufid)
            }
            continue
        }

        if (!isFolderEntry(entry)) continue
        const record = await resolveFolderRecordForMutation(client, entry)
        if (!record) {
            showUfidToast("Unable to find folder record")
            continue
        }
        const lowerName = record.data.name.toLowerCase()
        if (topLevelNames.has(lowerName)) {
            showUfidToast(`"${record.data.name}" already exists here`)
            continue
        }
        topLevelNames.add(lowerName)
        preparedFolderMoves.push({
            record,
            rootId: record.data.folderId,
            oldPath: record.data.path,
            newPath: "",
        })
        if (record.data.parentFolderId) {
            addFolderTombstone(sourceTombstones, record.data.parentFolderId, record.data.folderId)
        }
    }

    const moved = movedFileEntries.length + preparedFolderMoves.length
    if (moved === 0) return { files: 0, folders: 0 }

    for (const folderMove of preparedFolderMoves) {
        await updateFolderTreeForRename(client, folderMove.record, {
            parentFolderId: TGLFS_ROOT_PARENT_ID,
            rootId: folderMove.rootId,
            oldPath: folderMove.oldPath,
            newPath: folderMove.newPath,
            now,
            includeEmptyPrefix: true,
        })
    }
    for (const entry of movedFileEntries) {
        entry.data = await updateFileCardParent(client, entry.msgId, "me", entry.data, TGLFS_ROOT_PARENT_ID)
    }
    await writeMoveTombstones(client, sourceTombstones, now)
    return { files: movedFileEntries.length, folders: preparedFolderMoves.length }
}

async function moveSelectedEntries(client: any) {
    if (blockedByHistory()) return
    const selectedEntries = Array.from(state.selected.values())
    const movableEntries = selectedEntries.filter((entry) => isFileEntry(entry) || isFolderEntry(entry))
    if (selectedEntries.length === 0 || movableEntries.length !== selectedEntries.length) return

    // A pending delete must land first so folders being deleted never show up as destinations.
    await flushPendingDelete()
    const destination = await requestMoveDestination(client, selectedEntries)
    if (!destination) return
    await moveEntriesWithUndo(movableEntries, destination)
}

/* ---------------------------------------------------------------- Undo */
/*
 * Gmail-style undo for delete, move and rename.
 *
 * - Deletes are deferred. The items disappear from the view immediately and an "Undo" toast counts down
 *   UNDO_WINDOW_MS; the real deletion (deleteFileCard / folder tombstones) runs only once that toast goes away
 *   for any reason other than Undo: timeout, the × button, a newer toast replacing it, or another mutation
 *   starting (`flushPendingDelete`). Undo before then performs no Telegram writes at all. The pending delete is
 *   independent of the view, so navigating keeps the countdown running. Closing or reloading the page during
 *   the window cancels the delete (nothing was written yet); `beforeunload` warns about that.
 * - Moves and renames run immediately. Their Undo performs the inverse operation through the same mutation
 *   code paths, after re-reading the affected records. Anything that changed since (moved or renamed again,
 *   deleted, renamed elsewhere) is left alone, so an undo never overwrites a newer change.
 * - Only the most recent toast's Undo is reachable (its button, or Ctrl/Cmd+Z while it is visible).
 * - Browser-initiated writes run through `runExclusiveMutation`, so read-modify-write cycles on folder
 *   manifests (e.g. a deferred delete committing while a move runs) never interleave.
 *
 * Reusable hooks for other browser features: `offerUndo`, `moveEntriesWithUndo`, `renameEntryTo`,
 * `deleteEntriesWithUndo`, `flushPendingDelete`, `runExclusiveMutation`.
 */

const UNDO_WINDOW_MS = 6000
const IS_APPLE_PLATFORM = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

const browserMutations = createMutationQueue()

/** Serializes Telegram mutations started from the browser. Never nest calls (that would deadlock). */
function runExclusiveMutation<T>(task: () => Promise<T>): Promise<T> {
    return browserMutations.run(task)
}

type UndoOffer = {
    message: string
    undo: () => void | Promise<void>
    /** Runs when the offer goes away without Undo being used (timeout, dismissed or replaced). */
    onExpire?: () => void
    durationMs?: number
}

/** Shows "<message> · Undo" with a draining countdown. Ctrl/Cmd+Z triggers it while it is visible. */
function offerUndo(offer: UndoOffer): ActionToastHandle {
    hideToast()
    return showActionToast({
        message: offer.message,
        actionLabel: "Undo",
        actionShortcut: "Control+Z Meta+Z",
        actionHint: IS_APPLE_PLATFORM ? "⌘Z" : "Ctrl+Z",
        countdown: true,
        durationMs: offer.durationMs ?? UNDO_WINDOW_MS,
        onAction: () => {
            void (async () => {
                try {
                    await offer.undo()
                } catch (error) {
                    console.error(error)
                    showUndoResult("Undo failed", "error")
                }
            })()
        },
        onClose: (reason) => {
            if (reason !== "action") offer.onExpire?.()
        },
    })
}

function showUndoProgress(message: string) {
    hideToast()
    return showActionToast({ message, busy: true, durationMs: null })
}

function showUndoResult(message: string, tone: "default" | "success" | "error" = "success") {
    showActionToast({ message, tone, durationMs: tone === "error" ? 6000 : 3200 })
}

function errorText(error: unknown) {
    return error instanceof Error && error.message ? error.message : String(error)
}

function quoteName(name: string) {
    return `“${name}”`
}

function describeEntries(entries: BrowserEntry[]) {
    return entries.length === 1 ? quoteName(getEntryName(entries[0])) : formatMoveCount(countMoveEntries(entries))
}

function normalizeParentId(parentFolderId: string | undefined | null) {
    return parentFolderId ? parentFolderId : TGLFS_ROOT_PARENT_ID
}

function fileCardParentId(data: FileCardData) {
    return normalizeParentId("parentFolderId" in data ? data.parentFolderId : undefined)
}

function flashRestoredEntries(ids: Iterable<string>) {
    for (const id of ids) {
        document.querySelectorAll<HTMLElement>(`[data-browser-id="${CSS.escape(id)}"]`).forEach((node) => {
            node.classList.remove("is-restored")
            void node.offsetWidth
            node.classList.add("is-restored")
            node.addEventListener("animationend", () => node.classList.remove("is-restored"), { once: true })
        })
    }
}

/* Deferred delete */

type PendingDelete = {
    client: any
    entries: BrowserEntry[]
    entryIds: Set<string>
    parentFolderId: string
    query: string
    toast: ActionToastHandle | null
    commit: Promise<void> | null
}

let pendingDelete: PendingDelete | null = null
/**
 * Entries hidden from listings because their delete is pending or has been committed. Ids are message ids /
 * folder UUIDs, which are never reused, so committed ids can stay; an undo or a failed commit removes them.
 */
const hiddenEntryIds = new Set<string>()

function withoutHiddenEntries(items: BrowserEntry[]) {
    return hiddenEntryIds.size === 0 ? items : items.filter((entry) => !hiddenEntryIds.has(entry.id))
}

function adjustTotalItems(delta: number) {
    if (state.totalItems === null) return
    state.totalItems = Math.max(0, state.totalItems + delta)
    state.totalPages = Math.max(1, Math.ceil(state.totalItems / state.pageSize))
}

function removeEntriesFromView(ids: Set<string>) {
    const current = state.pages[state.currentPage] ?? []
    const removed = current.filter((entry) => ids.has(entry.id)).length
    state.pages = state.pages.map((page) => page.filter((entry) => !ids.has(entry.id)))
    for (const id of ids) state.selected.delete(id)
    state.lastClickedIndex = null
    adjustTotalItems(-removed)
    const page = state.pages[state.currentPage] ?? []
    if (page.length === 0 && (state.hasMore || state.pages.length > 1)) {
        void refreshBrowser?.()
        return
    }
    renderBrowser(page)
}

function restoreEntriesToView(pending: PendingDelete) {
    if (currentDirectoryParentId() !== pending.parentFolderId) return
    const page = state.pages[state.currentPage]
    if (!page || state.query !== pending.query) {
        void refreshBrowser?.()
        return
    }
    const present = new Set(page.map((entry) => entry.id))
    const restored = pending.entries.filter((entry) => !present.has(entry.id))
    page.push(...restored)
    adjustTotalItems(restored.length)
    renderBrowser(page)
    flashRestoredEntries(restored.map((entry) => entry.id))
}

/** Hides the entries now and deletes them for real once the undo window closes. */
function deleteEntriesWithUndo(entries: BrowserEntry[]) {
    const client = activeBrowserClient
    const deletable = entries.filter((entry) => isFileEntry(entry) || isFolderEntry(entry))
    if (blockedByHistory()) return
    if (!client || deletable.length === 0 || deletable.length !== entries.length) return
    void flushPendingDelete()

    const pending: PendingDelete = {
        client,
        entries: deletable,
        entryIds: new Set(deletable.map((entry) => entry.id)),
        parentFolderId: currentDirectoryParentId(),
        query: state.query,
        toast: null,
        commit: null,
    }
    for (const id of pending.entryIds) hiddenEntryIds.add(id)
    pendingDelete = pending
    removeEntriesFromView(pending.entryIds)
    pending.toast = offerUndo({
        message: `Deleted ${describeEntries(deletable)}`,
        undo: () => undoPendingDelete(pending),
        onExpire: () => void commitPendingDelete(pending),
    })
}

function undoPendingDelete(pending: PendingDelete) {
    if (pending.commit) return
    if (pendingDelete === pending) pendingDelete = null
    for (const id of pending.entryIds) hiddenEntryIds.delete(id)
    restoreEntriesToView(pending)
    showUndoResult(`Restored ${describeEntries(pending.entries)}`)
}

function commitPendingDelete(pending: PendingDelete): Promise<void> {
    if (pending.commit) return pending.commit
    if (pendingDelete === pending) pendingDelete = null
    const files = pending.entries.filter(isFileEntry)
    const folders = pending.entries.filter(isFolderEntry)
    pending.commit = runExclusiveMutation(async () => {
        const client = pending.client
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
    }).catch(async (error) => {
        console.error("Deferred delete failed", error)
        for (const id of pending.entryIds) hiddenEntryIds.delete(id)
        showUfidToast(`Couldn't delete ${describeEntries(pending.entries)}: ${errorText(error)}`, { tone: "error", durationMs: 7000 })
        await refreshBrowser?.()
    })
    return pending.commit
}

/** Commits a pending delete right away (its undo is no longer offered). Resolves once it is written. */
function flushPendingDelete(): Promise<void> {
    const pending = pendingDelete
    if (!pending) return Promise.resolve()
    pending.toast?.close("dismissed")
    return commitPendingDelete(pending)
}

function hasUnsavedBrowserWork() {
    return pendingDelete !== null || browserMutations.inFlight() > 0
}

/** Commits a pending delete and waits for queued browser writes (used before signing out). */
export async function settleBrowserMutations() {
    await flushPendingDelete()
    await runExclusiveMutation(async () => undefined)
    closeActionToast("dismissed")
}

/* Move with undo */

type MoveUndoRecord = {
    files: Array<{ msgId: number; ufid: string; name: string }>
    folders: Array<{ folderId: string; name: string }>
    fromFolderId: string
    fromLabel: string
    toFolderId: string
}

function moveDestinationName(destination: MoveDestination) {
    return destination.kind === "root" ? "All files" : destination.record.data.name
}

/**
 * Moves entries of the current view to `destination` through the existing single-pass move code and offers
 * Undo. Reusable by drag-to-move. Returns null when nothing ran (or it failed).
 */
async function moveEntriesWithUndo(entries: BrowserEntry[], destination: MoveDestination): Promise<MoveResult | null> {
    const client = activeBrowserClient
    const movableEntries = entries.filter((entry) => isFileEntry(entry) || isFolderEntry(entry))
    if (!client || movableEntries.length === 0 || blockedByHistory()) return null
    void flushPendingDelete()

    const destinationName = moveDestinationName(destination)
    const destinationFolderId = destination.kind === "root" ? TGLFS_ROOT_PARENT_ID : destination.record.data.folderId
    const fromFolderId = currentDirectoryParentId()
    const fromLabel = state.currentFolder?.data.name ?? "All files"
    const now = new Date().toISOString()
    showUfidToast(`Moving ${formatMoveCount(countMoveEntries(movableEntries))} to ${destinationName}...`, { durationMs: null })
    await waitForNextFrame()

    let moved: MoveResult
    try {
        moved = await runExclusiveMutation(() => destination.kind === "root"
            ? moveEntriesToRootInSinglePass(client, movableEntries, now)
            : moveEntriesToFolderInSinglePass(client, movableEntries, destination.record, now))
    } catch (error) {
        console.error(error)
        showUfidToast(`Move to ${destinationName} failed`, { tone: "error", durationMs: 5000 })
        await refreshBrowser?.()
        return null
    }

    clearSelection()
    await refreshBrowser?.()
    if (totalMoved(moved) === 0) return moved
    const record: MoveUndoRecord = {
        // updateFileCardParent replaced `data` on exactly the file entries that moved.
        files: movableEntries.filter(isFileEntry)
            .filter((entry) => fileCardParentId(entry.data) === destinationFolderId)
            .map((entry) => ({ msgId: entry.msgId, ufid: entry.data.ufid, name: entry.data.name })),
        folders: movableEntries.filter(isFolderEntry).map((entry) => ({ folderId: entry.data.folderId, name: entry.data.name })),
        fromFolderId,
        fromLabel,
        toFolderId: destinationFolderId,
    }
    offerUndo({
        message: `Moved ${formatMoveCount(moved)} to ${destinationName}`,
        undo: () => undoMove(record),
    })
    return moved
}

async function findFileCardRecord(
    client: any,
    ref: { msgId: number; ufid: string; name: string },
    parentFolderId?: string,
) {
    const byUfid = await getFileCardByUfid(client, ref.ufid).catch(() => null)
    if (byUfid?.msgId === ref.msgId) return byUfid
    if (!parentFolderId) return null
    const records = await listFileCards(client, { parentFolderId, query: ref.name, limit: 200 })
    return records.find((record) => record.msgId === ref.msgId) ?? null
}

async function undoMove(record: MoveUndoRecord) {
    const client = activeBrowserClient
    if (!client) return
    showUndoProgress(`Moving back to ${record.fromLabel}…`)
    let outcome: { moved: MoveResult; changed: number }
    try {
        outcome = await runExclusiveMutation(async () => {
            const entries: BrowserEntry[] = []
            let changed = 0
            const expectation = (name: string) => ({
                expectedParentId: record.toFolderId,
                expectedName: name,
                originParentId: record.fromFolderId,
            })
            for (const file of record.files) {
                const fresh = await findFileCardRecord(client, file, record.toFolderId)
                const verdict = classifyUndoCandidate(
                    { parentId: fresh ? fileCardParentId(fresh.data) : null, name: fresh?.data.name ?? null },
                    expectation(file.name),
                )
                if (fresh && verdict === "revert") entries.push(fileEntryFromRecord(fresh))
                if (verdict === "changed") changed++
            }
            for (const folder of record.folders) {
                const fresh = await getFolderRecord(client, folder.folderId)
                const verdict = classifyUndoCandidate(
                    { parentId: fresh ? normalizeParentId(fresh.data.parentFolderId) : null, name: fresh?.data.name ?? null },
                    expectation(folder.name),
                )
                // Folders that never moved (name conflict) come back "unchanged" and need nothing.
                if (fresh && verdict === "revert") entries.push(folderEntryFromRecord(fresh))
                if (verdict === "changed") changed++
            }
            if (entries.length === 0) return { moved: { files: 0, folders: 0 }, changed }
            const now = new Date().toISOString()
            const options = { fileSourceFolderId: record.toFolderId }
            if (record.fromFolderId === TGLFS_ROOT_PARENT_ID) {
                return { moved: await moveEntriesToRootInSinglePass(client, entries, now, options), changed }
            }
            const origin = await getFolderRecord(client, record.fromFolderId)
            if (!origin || origin.data.deleted) throw new Error(`${quoteName(record.fromLabel)} no longer exists`)
            return { moved: await moveEntriesToFolderInSinglePass(client, entries, origin, now, options), changed }
        })
    } catch (error) {
        console.error(error)
        showUndoResult(`Couldn't move back: ${errorText(error)}`, "error")
        await refreshBrowser?.()
        return
    }
    clearSelection()
    await refreshBrowser?.()
    const count = totalMoved(outcome.moved)
    if (count === 0) {
        showUndoResult("Nothing moved back — the items changed since", "default")
    } else if (outcome.changed > 0) {
        showUndoResult(`Moved ${formatMoveCount(outcome.moved)} back to ${record.fromLabel} · ${outcome.changed} changed since and stayed`, "default")
    } else {
        showUndoResult(`Moved ${formatMoveCount(outcome.moved)} back to ${record.fromLabel}`)
    }
}

/* Rename with undo */

type RenameUndoRecord =
    | { kind: "file"; msgId: number; ufid: string; parentFolderId: string; oldName: string; newName: string }
    | { kind: "folder"; folderId: string; oldName: string; newName: string }

/**
 * Renames a file or folder through the existing rename code paths and offers Undo. Reusable by inline rename.
 * Returns true when the rename was written.
 */
async function renameEntryTo(entry: BrowserEntry, requestedName: string, options: { undoable?: boolean } = {}): Promise<boolean> {
    const client = activeBrowserClient
    if (!client || blockedByHistory()) return false
    const undoable = options.undoable ?? true
    if (isFolderEntry(entry)) {
        const newName = validateFolderName(requestedName)
        const oldName = entry.data.name
        if (!newName || newName === oldName) return false
        void flushPendingDelete()
        let renamed = false
        try {
            renamed = await runExclusiveMutation(() => renameFolderTo(client, entry, newName))
        } catch (error) {
            console.error(error)
            showUfidToast(`Rename failed: ${errorText(error)}`, { tone: "error", durationMs: 5000 })
        }
        await refreshBrowser?.()
        if (renamed && undoable) {
            const record: RenameUndoRecord = { kind: "folder", folderId: entry.data.folderId, oldName, newName }
            offerUndo({ message: `Renamed to ${quoteName(newName)}`, undo: () => undoRename(record) })
        }
        return renamed
    }
    if (!isFileEntry(entry)) return false
    const newName = requestedName.trim()
    const oldName = entry.data.name
    if (!newName || newName === oldName) return false
    void flushPendingDelete()
    try {
        await runExclusiveMutation(() => renameFileCard(client, entry.msgId, "me", entry.data, newName))
    } catch (error) {
        console.error(error)
        showUfidToast(`Rename failed: ${errorText(error)}`, { tone: "error", durationMs: 5000 })
        return false
    }
    entry.data.name = newName
    renderBrowser(state.pages[state.currentPage] ?? [])
    if (undoable) {
        const record: RenameUndoRecord = {
            kind: "file",
            msgId: entry.msgId,
            ufid: entry.data.ufid,
            parentFolderId: fileCardParentId(entry.data),
            oldName,
            newName,
        }
        offerUndo({ message: `Renamed to ${quoteName(newName)}`, undo: () => undoRename(record) })
    } else {
        showUfidToast("Renamed", { tone: "success" })
    }
    return true
}

async function undoRename(record: RenameUndoRecord) {
    const client = activeBrowserClient
    if (!client) return
    showUndoProgress(`Renaming back to ${quoteName(record.oldName)}…`)
    let result: "done" | "changed" | "refused"
    try {
        result = await runExclusiveMutation(async () => {
            if (record.kind === "file") {
                const fresh = await findFileCardRecord(
                    client,
                    { msgId: record.msgId, ufid: record.ufid, name: record.newName },
                    record.parentFolderId,
                )
                if (!fresh || fresh.data.name !== record.newName) return "changed"
                await renameFileCard(client, fresh.msgId, "me", fresh.data, record.oldName)
                for (const page of state.pages) {
                    for (const entry of page) {
                        if (isFileEntry(entry) && entry.msgId === record.msgId) entry.data.name = record.oldName
                    }
                }
                return "done"
            }
            const fresh = await getFolderRecord(client, record.folderId)
            if (!fresh || fresh.data.deleted || fresh.data.name !== record.newName) return "changed"
            return await renameFolderTo(client, folderEntryFromRecord(fresh), record.oldName) ? "done" : "refused"
        })
    } catch (error) {
        console.error(error)
        showUndoResult(`Couldn't rename back: ${errorText(error)}`, "error")
        await refreshBrowser?.()
        return
    }
    if (record.kind === "file") {
        renderBrowser(state.pages[state.currentPage] ?? [])
        flashRestoredEntries([`file:${record.msgId}`])
    } else {
        await refreshBrowser?.()
        flashRestoredEntries([`folder:${record.folderId}`])
    }
    if (result === "done") {
        showUndoResult(`Renamed back to ${quoteName(record.oldName)}`)
    } else if (result === "changed") {
        showUndoResult(`Nothing to undo — ${quoteName(record.newName)} changed since`, "default")
    } else {
        // renameFolderTo already showed why (e.g. the old name is taken now).
        showUndoResult(`Couldn't rename back to ${quoteName(record.oldName)}`, "error")
    }
}

/* ------------------------------------------------------------- Actions */

async function runSingleOpenAction(selected: BrowserEntry | null) {
    if (!selected) return
    if (isFolderEntry(selected)) {
        await navigateTo(selected)
        return
    }
    if (isFileEntry(selected)) {
        await previewModal?.open(selected, getVisiblePreviewEntries())
    }
}

async function downloadEntry(entry: FileBrowserEntry) {
    const client = activeBrowserClient
    const config = activeBrowserConfig
    if (!client || !config) return
    const password = await requestBrowserText({
        title: "Download file",
        message: entry.data.name,
        label: "Decryption password (optional)",
        inputType: "password",
        allowEmpty: true,
        confirmLabel: "Download",
        icon: "download",
    })
    if (password === null) return
    await downloadFileCard(client, config, entry.data, password)
}

async function renameEntry(entry: BrowserEntry) {
    if (!activeBrowserClient || blockedByHistory()) return
    if (isFolderEntry(entry)) {
        await renameFolderEntry(entry)
        return
    }
    if (!isFileEntry(entry)) return
    const newName = await requestBrowserText({
        title: "Rename file",
        label: "File name",
        initialValue: entry.data.name,
        confirmLabel: "Rename",
        icon: "pencil",
        selectStem: true,
    })
    if (!newName || newName.trim() === "" || newName.trim() === entry.data.name) return
    await renameEntryTo(entry, newName)
}

async function sendEntries(entries: FileBrowserEntry[]) {
    const client = activeBrowserClient
    if (!client || entries.length === 0) return
    const recipient = await requestBrowserText({
        title: entries.length === 1 ? "Send file" : `Send ${entries.length} files`,
        message: entries.length === 1 ? entries[0].data.name : undefined,
        label: "Recipient (username, phone, or chat)",
        placeholder: "@username",
        confirmLabel: "Send",
        icon: "send",
    })
    if (!recipient || recipient.trim() === "") return
    showUfidToast(`Sending ${pluralize(entries.length, "file")}...`, { durationMs: null })
    for (const entry of entries) {
        await sendFileCard(client, entry.data, recipient.trim())
    }
    showUfidToast(entries.length === 1 ? "File sent" : "Files sent", { tone: "success" })
}

async function copyEntryId(entry: BrowserEntry) {
    const copy = getCopyId(entry)
    try {
        await navigator.clipboard.writeText(copy.value)
        showUfidToast(`${copy.label} copied to clipboard`)
    } catch {
        showUfidToast(`Unable to copy ${copy.label.toLowerCase()}`, { tone: "error" })
    }
}

/**
 * Delete flow: files go straight to a deferred delete with Undo. Folders whose deletion would cascade
 * (non-empty, or too many to check) ask once first, then still get the Undo window afterwards.
 */
async function deleteSelectedEntries() {
    const client = activeBrowserClient
    if (!client || blockedByHistory()) return
    const selectedEntries = Array.from(state.selected.values())
    const files = selectedEntries.filter(isFileEntry)
    const folders = selectedEntries.filter(isFolderEntry)
    if (selectedEntries.length === 0 || files.length + folders.length !== selectedEntries.length) return

    if (folders.length > 0 && !await confirmCascadingFolderDelete(client, selectedEntries, folders)) return
    deleteEntriesWithUndo(selectedEntries)
}

const MAX_FOLDERS_TO_PROBE = 8

async function confirmCascadingFolderDelete(client: any, entries: BrowserEntry[], folders: FolderBrowserEntry[]) {
    let nonEmpty = folders
    if (folders.length <= MAX_FOLDERS_TO_PROBE) {
        const totals = await Promise.all(folders.map((folder) =>
            countDirectoryEntries(client, { parentFolderId: folder.data.folderId })
                .then((counts) => counts.total)
                .catch(() => 1),
        ))
        nonEmpty = folders.filter((_, index) => totals[index] > 0)
    }
    if (nonEmpty.length === 0) return true

    const single = entries.length === 1
    const message = single
        ? `${quoteName(getEntryName(entries[0]))} and everything inside it will be deleted. You can undo for a few seconds afterwards.`
        : `${nonEmpty.length === 1 ? `The folder ${quoteName(nonEmpty[0].data.name)} is` : `${nonEmpty.length} of the folders are`} not empty — everything inside will be deleted too. You can undo for a few seconds afterwards.`
    return await requestBrowserConfirm({
        title: single ? "Delete folder and its contents?" : `Delete ${entries.length} items?`,
        message,
        confirmLabel: "Delete",
        danger: true,
        icon: "trash",
    })
}

function uploadFiles(files?: File[]) {
    const config = activeBrowserConfig
    const client = activeBrowserClient
    if (!client || !config || blockedByHistory()) return
    setNextUploadParentFromBrowserState()
    if (files && files.length > 0) {
        void import("../telegram").then((Telegram) => Telegram.fileUpload(client, config, files))
        return
    }
    const uploadInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
    uploadInput?.click()
}

async function createFolderHere() {
    if (!activeBrowserClient || blockedByHistory()) return
    await createFolderInCurrentLocation(activeBrowserClient)
}

async function receiveFile() {
    if (!activeBrowserClient || !activeBrowserConfig || blockedByHistory()) return
    await (await import("../telegram")).fileReceive(activeBrowserClient, activeBrowserConfig)
}

function openNewMenu(anchor?: HTMLElement) {
    closeSidebar()
    if (blockedByHistory()) return
    openMenu({
        anchor,
        sheet: !anchor,
        title: anchor ? undefined : "Create",
        items: [
            { id: "browserActionUploadItem", label: "Upload files", icon: "upload", onSelect: () => uploadFiles() },
            { id: "browserActionNewFolderItem", label: "New folder", icon: "folderPlus", onSelect: () => createFolderHere() },
            { divider: true },
            { id: "browserActionReceiveItem", label: "Receive file", icon: "inbox", onSelect: () => receiveFile() },
        ],
    })
}

/* ------------------------------------------------ History (time machine) */

type HistoryRow = {
    item: HistoryItem
    state: "present" | "uncertain"
    annotations: HistoryAnnotation[]
    /** Change of this item at exactly the selected timeline point (diff markers). */
    diff: "added" | "removed" | "changed" | null
    ghost: boolean
}

type HistoryModeState = {
    scope: FolderBrowserEntry | null
    /** The exact time being viewed (epoch ms), or null for now. */
    at: number | null
    history: FolderHistory | null
    cards: Map<number, FileBrowserEntry>
    folders: Map<string, HistoryFolderRecord>
    rows: HistoryRow[]
    focusKey: string | null
    /** Set after a restore or background refresh: the normal listing must be reloaded on exit. */
    dirty: boolean
}

type HistoryFolderRecord = TglfsFolderRecord & { text: string }

let historyMode: HistoryModeState | null = null
let historyPanel: HistoryPanel | null = null
let historyLoadSequence = 0

const HISTORY_FILE_LIMIT = 2000
const HISTORY_FOLDER_LIMIT = 1000
const HISTORY_LOOKUP_LIMIT = 100

function blockedByHistory() {
    if (!historyMode) return false
    showUfidToast("You're viewing history. Go back to now to make changes.")
    return true
}

function historyScopeName(scope = historyMode?.scope ?? null) {
    return scope?.data.name ?? "All files"
}

function setHistoryChrome(active: boolean) {
    document.body.classList.toggle("fx-history-active", active)
    const button = document.getElementById("browserHistoryButton")
    button?.setAttribute("aria-pressed", String(active))
    button?.classList.toggle("is-active", active)
    const dateHead = document.querySelector(".fx-list-head .fx-cell-date")
    if (dateHead) dateHead.textContent = active ? "Added" : "Modified"
}

function exitHistoryState() {
    historyLoadSequence++
    historyMode = null
    historyPanel?.hide()
    const banner = document.getElementById("historyBanner")
    if (banner) renderHistoryBanner(banner, { folderName: "", at: null, onBack: () => {} })
    setHistoryChrome(false)
}

function closeHistory() {
    if (!historyMode) return
    const dirty = historyMode.dirty
    exitHistoryState()
    closeMenu()
    if (dirty) {
        void refreshBrowser?.({ showLoading: true, loadingMessage: "Loading files..." })
    } else {
        renderBrowser(state.pages[state.currentPage] ?? [])
    }
}

async function toggleHistory() {
    if (historyMode) {
        closeHistory()
        return
    }
    await openHistory(null)
}

async function openFolderHistory(folder: FolderBrowserEntry) {
    const at = historyMode?.at ?? null
    if (historyMode) exitHistoryState()
    if (state.currentFolder?.data.folderId !== folder.data.folderId) {
        await navigateToFolder(folder)
    }
    await openHistory(at)
}

function parseHistoryFolderMessages(messages: Array<{ msgId: number; date: number; text: string }>) {
    const records: HistoryFolderRecord[] = []
    for (const message of messages) {
        const data = parseTglfsFolderMessage(message.text)
        if (data) records.push({ msgId: message.msgId, date: message.date, data, text: message.text })
    }
    return records
}

/** The record readers use for a folder id: the newest live record, else the newest record (like getFolderRecord). */
function canonicalHistoryFolder(records: HistoryFolderRecord[], folderId: string): HistoryFolderRecord | null {
    const versions = records.filter((record) => record.data.folderId === folderId).sort((a, b) => b.msgId - a.msgId)
    return versions.find((record) => !record.data.deleted) ?? versions[0] ?? null
}

async function loadHistoryData(client: any, scope: FolderBrowserEntry | null) {
    const scopeId = scope?.data.folderId ?? TGLFS_ROOT_PARENT_ID
    const [childMessages, fileRecords, manifestRecord, legacyManifests] = await Promise.all([
        listFolderRecordMessages(client, { parentFolderId: scopeId, limit: HISTORY_FOLDER_LIMIT }),
        listFileCards(client, { parentFolderId: scopeId, limit: HISTORY_FILE_LIMIT }),
        scope ? getFolderManifest(client, scope.data.folderId).catch((error) => {
            console.warn("Unable to read folder entries for history", error)
            return null
        }) : Promise.resolve(null),
        scope ? listFolderManifestMessages(client, scope.data.folderId).catch(() => []) : Promise.resolve([]),
    ])

    const manifests: HistoryManifestInput[] = []
    const manifestObjects: TglfsFolderManifest[] = []
    if (manifestRecord) {
        manifests.push({ data: manifestRecord.data, msgId: manifestRecord.msgId })
        manifestObjects.push(manifestRecord.data)
    }
    for (const message of legacyManifests) {
        // The current manifest may itself be one of the legacy messages.
        if (message.msgId === manifestRecord?.msgId) continue
        manifests.push({ text: message.text, msgId: message.msgId })
        const parsed = parseTglfsFolderManifestMessage(message.text)
        if (parsed) manifestObjects.push(parsed)
    }

    // Look up records that tell where removed entries went (or whether they still exist at all).
    const folderMessages = [...childMessages]
    const childRecords = parseHistoryFolderMessages(childMessages)
    const liveHere = new Set(
        childRecords.filter((record) => !record.data.deleted && record.data.parentFolderId === scopeId).map((record) => record.data.folderId),
    )
    const folderLookups = new Set<string>()
    for (const record of childRecords) {
        if (!liveHere.has(record.data.folderId)) folderLookups.add(record.data.folderId)
    }
    const cardUfids = new Set(fileRecords.map((record) => record.data.ufid))
    const ufidLookups = new Set<string>()
    for (const manifest of manifestObjects) {
        for (const entry of Object.values(manifest.entries)) {
            if (entry.kind === "folder" && entry.folderId && !liveHere.has(entry.folderId)) folderLookups.add(entry.folderId)
            if (entry.kind === "file" && entry.ufid && !cardUfids.has(entry.ufid)) ufidLookups.add(entry.ufid)
        }
    }
    const folderIds = [...folderLookups].slice(0, HISTORY_LOOKUP_LIMIT)
    const ufids = [...ufidLookups].slice(0, HISTORY_LOOKUP_LIMIT)
    const [folderLookupResults, cardLookupResults] = await Promise.all([
        Promise.all(folderIds.map((folderId) => listFolderRecordMessages(client, { folderId, limit: 20 }).catch(() => []))),
        Promise.all(ufids.map((ufid) => getFileCardByUfid(client, ufid).catch(() => null))),
    ])
    for (const messages of folderLookupResults) folderMessages.push(...messages)

    const fileInputs: HistoryMessageInput[] = fileRecords.map((record) => ({ msgId: record.msgId, date: record.date, data: record.data }))
    for (const record of cardLookupResults) {
        if (record) fileInputs.push({ msgId: record.msgId, date: record.date, data: record.data })
    }

    const cards = new Map<number, FileBrowserEntry>()
    for (const record of [...fileRecords, ...cardLookupResults]) {
        if (record) cards.set(record.msgId, fileEntryFromRecord(record))
    }
    const allFolderRecords = parseHistoryFolderMessages(folderMessages)
    const folders = new Map<string, HistoryFolderRecord>()
    for (const folderId of new Set(allFolderRecords.map((record) => record.data.folderId))) {
        const canonical = canonicalHistoryFolder(allFolderRecords, folderId)
        if (canonical) folders.set(folderId, canonical)
    }

    const input: FolderHistoryInput = {
        folderId: scope?.data.folderId ?? null,
        folder: scope ? { msgId: scope.msgId, date: scope.date, data: scope.data } : null,
        folderRecords: folderMessages,
        fileCards: fileInputs,
        manifests,
        now: Date.now(),
    }
    const truncated = childMessages.length >= HISTORY_FOLDER_LIMIT || fileRecords.length >= HISTORY_FILE_LIMIT ||
        folderLookups.size > HISTORY_LOOKUP_LIMIT || ufidLookups.size > HISTORY_LOOKUP_LIMIT
    return { input, cards, folders, truncated }
}

function renderHistoryLoading() {
    renderListingSkeleton()
    updateFolderLocation()
    const pageInfo = document.getElementById("browserPageInfo")
    if (pageInfo) pageInfo.textContent = "Reconstructing history..."
    document.getElementById("browserPager")?.classList.add("is-single")
    applyViewMode()
}

async function openHistory(at: number | null) {
    const client = activeBrowserClient
    if (!client) return
    closeMenu()
    closeSidebar()
    state.selected.clear()
    state.lastClickedIndex = null
    updateSelectionDisplay()

    const scope = state.currentFolder
    const sequence = ++historyLoadSequence
    historyMode = {
        scope,
        at,
        history: null,
        cards: new Map(),
        folders: new Map(),
        rows: [],
        focusKey: null,
        dirty: historyMode?.dirty ?? false,
    }
    setHistoryChrome(true)
    const title = `History · ${historyScopeName(scope)}`
    historyPanel?.showLoading(title)
    renderHistoryBannerForState()
    renderHistoryLoading()

    try {
        const loaded = await loadHistoryData(client, scope)
        if (sequence !== historyLoadSequence || !historyMode) return
        const history = buildFolderHistory(loaded.input)
        if (history.warnings.length || history.skipped) {
            console.warn("Folder history skipped unreadable records", { skipped: history.skipped, warnings: history.warnings })
        }
        historyMode.history = history
        historyMode.cards = loaded.cards
        historyMode.folders = loaded.folders
        const index = at === null ? history.points.length - 1 : historyPointIndexAt(history, at)
        historyPanel?.setData(title, history, index, at)
        if (loaded.truncated) showUfidToast("This folder is large; only part of its history was read.")
        renderHistoryListing()
    } catch (error) {
        if (sequence !== historyLoadSequence || !historyMode) return
        console.error(error)
        historyPanel?.showError(title, "Couldn't read this folder's history. Check your connection and try again.")
        renderHistoryListing()
    }
}

function selectHistoryPoint(index: number) {
    const history = historyMode?.history
    if (!historyMode || !history) return
    const clamped = Math.max(0, Math.min(history.points.length - 1, index))
    const point = history.points[clamped]
    historyMode.at = point.isNow ? null : point.at
    historyMode.focusKey = null
    historyPanel?.setIndex(clamped)
    renderHistoryListing()
}

function goToHistoryNow() {
    const history = historyMode?.history
    if (history) {
        selectHistoryPoint(history.points.length - 1)
    } else if (historyMode) {
        historyMode.at = null
        renderHistoryBannerForState()
    }
}

function renderHistoryBannerForState() {
    const banner = document.getElementById("historyBanner")
    if (!banner || !historyMode) return
    renderHistoryBanner(banner, { folderName: historyScopeName(), at: historyMode.at, onBack: () => goToHistoryNow() })
}

function historyItemTime(item: HistoryItem) {
    return item.presentFrom ?? item.absentBefore ?? 0
}

function computeHistoryRows(mode: HistoryModeState): HistoryRow[] {
    const history = mode.history
    if (!history) return []
    const at = mode.at ?? history.now
    const pointIndex = historyPointIndexAt(history, at)
    const point = history.points[pointIndex]
    const exactPoint = mode.at === null ? null : point && point.at === mode.at ? point : null
    const query = state.query.toLowerCase()
    const matches = (item: HistoryItem) => !query ||
        item.name.toLowerCase().includes(query) ||
        item.formerNames.some((name) => name.toLowerCase().includes(query))

    const rows: HistoryRow[] = folderSnapshotAt(history, at)
        .filter((entry) => matches(entry.item))
        .map((entry) => {
            let diff: HistoryRow["diff"] = null
            if (exactPoint) {
                const change = exactPoint.changes.find((candidate) => candidate.itemKey === entry.item.key)
                if (change?.type === "added") diff = "added"
                else if (change?.type === "changed") diff = "changed"
            }
            return { item: entry.item, state: entry.state, annotations: entry.annotations, diff, ghost: false }
        })
    if (exactPoint) {
        // Items removed exactly at this point are shown as struck-through ghosts (the "−" side of the diff).
        for (const change of exactPoint.changes) {
            if (change.type !== "removed" || !change.itemKey) continue
            const item = history.items.find((candidate) => candidate.key === change.itemKey)
            if (!item || !matches(item) || rows.some((row) => row.item.key === item.key)) continue
            rows.push({ item, state: "present", annotations: [], diff: "removed", ghost: true })
        }
    }

    rows.sort((a, b) => {
        if ((a.item.kind === "folder") !== (b.item.kind === "folder")) return a.item.kind === "folder" ? -1 : 1
        switch (state.sort) {
            case "date_desc":
                return historyItemTime(b.item) - historyItemTime(a.item)
            case "date_asc":
                return historyItemTime(a.item) - historyItemTime(b.item)
            case "name_desc":
                return b.item.name.localeCompare(a.item.name, undefined, { numeric: true, sensitivity: "base" })
            case "size_desc":
                return (b.item.size ?? 0) - (a.item.size ?? 0)
            case "size_asc":
                return (a.item.size ?? 0) - (b.item.size ?? 0)
            default:
                return a.item.name.localeCompare(b.item.name, undefined, { numeric: true, sensitivity: "base" })
        }
    })
    return rows
}

function historyArrivalText(item: HistoryItem) {
    if (item.presentFrom === null) return ""
    const day = formatHistoryDay(item.presentFrom)
    switch (item.arrival) {
        case "uploaded":
            return `Uploaded ${day}`
        case "created":
            return `Created ${day}`
        case "moved-in":
            return item.arrivalExact ? `Moved here ${day}` : `Here by ${day}`
        case "returned":
            return `Back by ${day}`
        default:
            return ""
    }
}

/** Primary badges say whether the item stays; secondary ones qualify what is known about it. */
function historyBadges(row: HistoryRow, group: "primary" | "secondary" | "all" = "all") {
    const primary: string[] = []
    const secondary: string[] = []
    const badge = (tone: string, label: string, title: string) =>
        `<span class="fx-badge fx-badge--${tone}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`
    const item = row.item
    if (row.ghost) {
        return group === "secondary" ? "" : badge("deleted", item.status === "moved-out" ? "Moved out here" : "Deleted here", "Removed from this folder at this point")
    }
    for (const annotation of row.annotations) {
        switch (annotation) {
            case "deleted-later":
                primary.push(badge("deleted", "Deleted later", item.removedAt ? `Deleted ${formatHistoryTime(item.removedAt)}` : "Deleted later"))
                break
            case "moved-out-later":
                primary.push(badge("moved", "Moved out later", item.removedAt ? `Moved out ${formatHistoryTime(item.removedAt)}` : "Moved out later"))
                break
            case "removed-unknown":
                primary.push(badge("moved", item.status === "moved-out" ? "Moved out since" : "Deleted since", "Removed from this folder at a time that is not recorded"))
                break
            case "arrival-unknown":
                secondary.push(badge("maybe", "Maybe", "This item was here at some point, but when it arrived is not recorded"))
                break
            case "contents-gone":
                secondary.push(badge("gone", "Not stored", "Its contents are no longer stored in Telegram"))
                break
            case "renamed":
                secondary.push(badge("renamed", "Renamed", `Earlier name: ${item.formerNames.join(", ")}`))
                break
        }
    }
    if (item.kind === "file" && item.uploadComplete === false) secondary.push(`<span class="fx-badge fx-badge--incomplete">Incomplete</span>`)
    if (group === "primary") return primary.join("")
    if (group === "secondary") return secondary.join("")
    return [...primary, ...secondary].join("")
}

function historyMetaText(row: HistoryRow) {
    const item = row.item
    const parts: string[] = []
    if (item.kind === "file") parts.push(formatSize(item.size ?? 0))
    if (row.ghost && item.removedAt !== null) {
        parts.push(`${item.status === "moved-out" ? "Moved out" : "Deleted"} ${formatHistoryDay(item.removedAt)}`)
    } else {
        const arrival = historyArrivalText(item)
        if (arrival) parts.push(arrival)
    }
    return parts.join(" · ")
}

const DIFF_MARKS = { added: "+", removed: "−", changed: "~" } as const

function historyRowClasses(row: HistoryRow, base: string) {
    return [
        base,
        "fx-hrow",
        row.state === "uncertain" ? "is-uncertain" : "",
        row.ghost ? "is-ghost" : "",
        row.diff ? `is-diff-${row.diff}` : "",
        historyMode?.focusKey === row.item.key ? "selected" : "",
    ].filter(Boolean).join(" ")
}

function renderHistoryListing() {
    const mode = historyMode
    if (!mode) return
    renderHistoryBannerForState()
    const content = document.getElementById("browserContent")
    clearViews()
    updateFolderLocation()
    const pageInfo = document.getElementById("browserPageInfo")
    document.getElementById("browserPager")?.classList.add("is-single")
    const prevButton = document.getElementById("browserPrevPage") as HTMLButtonElement | null
    const nextButton = document.getElementById("browserNextPage") as HTMLButtonElement | null
    if (prevButton) prevButton.disabled = true
    if (nextButton) nextButton.disabled = true

    if (!mode.history) {
        content?.setAttribute("aria-busy", "false")
        mode.rows = []
        renderHistoryEmpty("History unavailable", "The folder's records could not be read.")
        applyViewMode()
        return
    }
    content?.setAttribute("aria-busy", "false")
    const rows = computeHistoryRows(mode)
    mode.rows = rows

    const listRows = document.getElementById("browserRows")
    const grid = document.getElementById("browserGrid")
    const listFragment = document.createDocumentFragment()
    const gridFragment = document.createDocumentFragment()
    for (const [index, row] of rows.entries()) {
        const item = row.item
        const safeName = escapeHtml(item.name)
        const kind: FileKind = item.kind === "folder" ? "folder" : fileKindForName(item.name)
        const mark = row.diff ? `<span class="fx-hmark is-${row.diff}" title="${row.diff === "added" ? "Added at this point" : row.diff === "removed" ? "Removed at this point" : "Changed at this point"}">${DIFF_MARKS[row.diff]}</span>` : ""
        // The date column shows when the item arrived here, and only when that is known.
        const time = item.presentFrom
        const dateText = time ? formatHistoryDay(time) : "—"
        const meta = historyMetaText(row)

        const element = document.createElement("div")
        element.className = historyRowClasses(row, "fx-row")
        element.setAttribute("role", "row")
        element.tabIndex = -1
        element.dataset.browserId = `history:${item.key}`
        element.dataset.historyKey = item.key
        element.dataset.kind = item.kind
        element.dataset.index = String(index)
        element.dataset.name = item.name
        element.innerHTML = `
            <div class="fx-cell fx-cell-check">${mark}</div>
            <div class="fx-cell fx-name-cell">
                ${fileKindIcon(kind)}
                <div class="fx-name-wrap">
                    <div class="fx-name-line"><span class="fx-name" title="${safeName}">${safeName}</span>${historyBadges(row, "primary")}<span class="fx-hbadges-secondary">${historyBadges(row, "secondary")}</span></div>
                    <div class="fx-sub fx-hsub"><span class="fx-hbadges-secondary">${historyBadges(row, "secondary")}</span><span class="fx-hsub-text">${escapeHtml(meta)}</span></div>
                </div>
            </div>
            <div class="fx-cell fx-cell-size">${item.kind === "folder" ? "—" : escapeHtml(formatSize(item.size ?? 0))}</div>
            <div class="fx-cell fx-cell-date" title="${escapeHtml(time ? formatHistoryTime(time) : "Unknown")}">${escapeHtml(dateText)}</div>
            <div class="fx-cell fx-cell-more">${moreButtonHtml(item.name)}</div>`
        attachHistoryRowHandlers(element, row)
        listFragment.appendChild(element)

        const tile = document.createElement("div")
        tile.className = historyRowClasses(row, "fx-tile")
        tile.setAttribute("role", "gridcell")
        tile.tabIndex = -1
        tile.dataset.browserId = `history:${item.key}`
        tile.dataset.historyKey = item.key
        tile.dataset.kind = item.kind
        tile.dataset.index = String(index)
        tile.dataset.name = item.name
        tile.innerHTML = `
            <div class="fx-tile-art">${fileKindIcon(kind, "lg")}${mark}</div>
            ${moreButtonHtml(item.name)}
            <div class="fx-tile-body">
                <div class="fx-tile-name" title="${safeName}">${safeName}</div>
                <div class="fx-tile-badges">${historyBadges(row)}</div>
                <div class="fx-tile-meta">${escapeHtml(meta)}</div>
            </div>`
        attachHistoryRowHandlers(tile, row)
        gridFragment.appendChild(tile)
    }
    listRows?.appendChild(listFragment)
    grid?.appendChild(gridFragment)

    if (rows.length === 0) {
        const searching = state.query.length > 0
        renderHistoryEmpty(
            searching ? `No results for “${state.query}”` : "Nothing here at this time",
            searching
                ? "Nothing with that name was here at this point."
                : mode.at !== null && mode.history.createdAt !== null && mode.at < mode.history.createdAt
                    ? "This folder did not exist yet."
                    : "No recorded items were in this folder at this point.",
        )
    } else {
        document.getElementById("browserEmpty")?.setAttribute("hidden", "")
    }
    const present = rows.filter((row) => !row.ghost).length
    if (pageInfo) {
        pageInfo.textContent = `${pluralize(present, "item")} ${mode.at === null ? "now" : `as of ${formatHistoryTime(mode.at)}`}`
    }
    document.getElementById("browserPager")?.toggleAttribute("hidden", rows.length === 0)
    applyViewMode()
}

function renderHistoryEmpty(title: string, text: string) {
    const empty = document.getElementById("browserEmpty")
    if (!empty) return
    empty.innerHTML = `
        <span class="fx-empty-art">${icon("history")}</span>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(text)}</p>`
    empty.removeAttribute("hidden")
}

function attachHistoryRowHandlers(element: HTMLElement, row: HistoryRow) {
    element.addEventListener("pointerdown", (event) => {
        lastPointerType = event.pointerType || "mouse"
    })
    element.addEventListener("click", (event) => {
        const more = (event.target as HTMLElement).closest<HTMLElement>(".fx-more")
        if (more) {
            openHistoryItemMenu(row, more)
            return
        }
        if (isTouchInteraction()) {
            if (canOpenHistoryFolder(row)) {
                void openHistoryRow(row)
            } else {
                openHistoryItemMenu(row)
            }
            return
        }
        focusHistoryRow(row.item.key)
    })
    element.addEventListener("dblclick", (event) => {
        if ((event.target as HTMLElement).closest(".fx-more") || isTouchInteraction()) return
        event.preventDefault()
        void openHistoryRow(row)
    })
    element.addEventListener("contextmenu", (event) => {
        event.preventDefault()
        if (lastPointerType !== "mouse") return
        focusHistoryRow(row.item.key)
        openHistoryItemMenu(row, { x: event.clientX, y: event.clientY })
    })
}

function focusHistoryRow(key: string) {
    if (!historyMode) return
    historyMode.focusKey = key
    document.querySelectorAll<HTMLElement>("[data-history-key]").forEach((node) => {
        node.classList.toggle("selected", node.dataset.historyKey === key)
    })
}

function revealHistoryItem(key: string) {
    const container = state.viewMode === "grid" ? "#browserGrid" : "#browserRows"
    const node = document.querySelector<HTMLElement>(`${container} [data-history-key="${CSS.escape(key)}"]`)
    if (!node) {
        showUfidToast("That item is not shown at this point")
        return
    }
    focusHistoryRow(key)
    node.scrollIntoView({ block: "nearest", behavior: "smooth" })
    node.classList.remove("is-flash")
    void node.offsetWidth
    node.classList.add("is-flash")
}

function historyLiveFile(row: HistoryRow): FileBrowserEntry | null {
    if (row.item.kind !== "file" || row.item.status !== "live" || row.item.msgId === undefined) return null
    return historyMode?.cards.get(row.item.msgId) ?? null
}

function canOpenHistoryFolder(row: HistoryRow) {
    return row.item.kind === "folder" && row.item.status === "live" && !row.ghost && !!row.item.folderId &&
        !!historyMode?.folders.get(row.item.folderId)
}

async function openHistoryRow(row: HistoryRow) {
    if (canOpenHistoryFolder(row)) {
        const record = historyMode?.folders.get(row.item.folderId!)
        if (record) await navigateTo(folderEntryFromRecord(record))
        return
    }
    const file = historyLiveFile(row)
    if (file && isPreviewableName(file.data.name)) {
        const previewable = historyMode?.rows
            .map((candidate) => historyLiveFile(candidate))
            .filter((candidate): candidate is FileBrowserEntry => !!candidate)
            .map((entry) => ({ msgId: entry.msgId, date: entry.date, data: entry.data })) ?? []
        await previewModal?.open(file, previewable)
        return
    }
    openHistoryItemMenu(row)
}

/** One short line for the menu header; details go into informational menu rows. */
function describeHistoryItem(row: HistoryRow) {
    const item = row.item
    if (item.removedAt !== null) {
        return `${item.status === "moved-out" ? "Moved out" : "Deleted"} ${formatHistoryTime(item.removedAt)}`
    }
    if (item.status === "moved-out") return "Moved out since; when is not recorded"
    if (item.status !== "live") return "Removed since; when is not recorded"
    const arrival = historyArrivalText(item)
    const size = item.kind === "file" ? formatSize(item.size ?? 0) : ""
    return [size, arrival || "Arrival time not recorded"].filter(Boolean).join(" · ")
}

function historyInfoItems(row: HistoryRow): MenuItem[] {
    const item = row.item
    const info: string[] = []
    if (item.status !== "live" && item.presentFrom !== null) {
        const arrival = historyArrivalText(item)
        if (arrival) info.push(arrival)
    } else if (item.status !== "live" && row.annotations.includes("arrival-unknown")) {
        info.push("Arrival time not recorded")
    }
    if (item.status !== "live") info.push(item.contentsStored ? "Contents still stored" : "Contents no longer stored")
    if (item.formerNames.length) info.push(`Earlier name: ${item.formerNames.join(", ")}`)
    if (item.restoreBlockedReason) info.push("Can't restore: unknown record fields")
    return info.map((label) => ({
        label,
        icon: label.startsWith("Contents no longer") || label.startsWith("Can't") ? "alert" : "info",
        disabled: true,
        onSelect: () => {},
    }))
}

async function showHistoryItemLocation(item: HistoryItem) {
    const target = item.movedToFolderId
    if (!target || !activeBrowserClient) return
    if (target === TGLFS_ROOT_PARENT_ID) {
        await navigateTo(null)
        return
    }
    const record = historyMode?.folders.get(target) ?? await getFolderRecord(activeBrowserClient, target).catch(() => null)
    if (!record || record.data.deleted) {
        showUfidToast("Its current folder could not be found")
        return
    }
    await navigateTo(folderEntryFromRecord(record))
}

function openHistoryItemMenu(row: HistoryRow, anchor?: HTMLElement | { x: number; y: number }) {
    const item = row.item
    const client = activeBrowserClient
    const scope = historyMode?.scope ?? null
    const items: MenuItem[] = []
    const file = historyLiveFile(row)
    if (canOpenHistoryFolder(row)) {
        items.push({ label: historyMode?.at === null ? "Open" : "Open at this time", icon: "open", onSelect: () => openHistoryRow(row) })
    }
    if (file) {
        if (isPreviewableName(file.data.name)) items.push({ label: "Preview", icon: "eye", onSelect: () => openHistoryRow(row) })
        items.push({ label: "Download", icon: "download", onSelect: () => downloadEntry(file) })
    }
    if (item.status === "moved-out" && item.movedToFolderId) {
        items.push({ label: "Show current location", icon: "locate", onSelect: () => showHistoryItemLocation(item) })
    }
    if (client && item.kind === "folder" && item.status === "deleted") {
        if (item.restorable) {
            items.push({ id: "historyRestoreItem", label: `Restore to ${historyScopeName(scope)}`, icon: "restore", onSelect: () => restoreDeletedFolderFromHistory(client, item) })
        }
    }
    if (client && scope && item.kind === "file" && item.status === "moved-out" && item.contentsStored && item.ufid && item.movedToFolderId) {
        items.push({ id: "historyMoveBackItem", label: `Move back to ${scope.data.name}`, icon: "restore", onSelect: () => moveFileBackFromHistory(client, item, scope) })
    }
    const info = historyInfoItems(row)
    if (info.length) {
        if (items.length) items.push({ divider: true })
        items.push(...info)
    }
    const copyValue = item.kind === "folder" ? item.folderId : item.ufid
    if (copyValue) {
        if (items.length) items.push({ divider: true })
        items.push({
            label: item.kind === "folder" ? "Copy Folder ID" : "Copy UFID",
            icon: "copy",
            onSelect: async () => {
                try {
                    await navigator.clipboard.writeText(copyValue)
                    showUfidToast(`${item.kind === "folder" ? "Folder ID" : "UFID"} copied to clipboard`)
                } catch {
                    showUfidToast("Unable to copy", { tone: "error" })
                }
            },
        })
    }
    const kind: FileKind = item.kind === "folder" ? "folder" : fileKindForName(item.name)
    openMenu({
        anchor,
        headerHtml: fileKindIcon(kind),
        title: item.name,
        subtitle: describeHistoryItem(row),
        items,
    })
}

function handleHistoryKeydown(event: KeyboardEvent, mod: boolean) {
    if (event.key === "Escape") {
        event.preventDefault()
        if (isSidebarOpen()) {
            closeSidebar()
        } else if (historyMode?.focusKey) {
            focusHistoryRow("")
            if (historyMode) historyMode.focusKey = null
        } else {
            closeHistory()
        }
        return
    }
    if (!mod && !event.altKey && event.key.toLowerCase() === "h") {
        event.preventDefault()
        closeHistory()
        return
    }
    if (event.key === "/" || (mod && event.key.toLowerCase() === "k")) {
        event.preventDefault()
        const input = document.getElementById("browserSearchInput") as HTMLInputElement | null
        input?.focus()
        input?.select()
        return
    }
    if (!mod && !event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault()
        historyPanel?.step(event.key === "ArrowLeft" ? -1 : 1)
        return
    }
    if (!mod && event.key === "End") {
        event.preventDefault()
        goToHistoryNow()
        return
    }
    if (!mod && event.key === "Home") {
        event.preventDefault()
        selectHistoryPoint(0)
        return
    }
    if (event.key === "Enter" && historyMode?.focusKey) {
        const row = historyMode.rows.find((candidate) => candidate.item.key === historyMode?.focusKey)
        if (row) {
            event.preventDefault()
            void openHistoryRow(row)
        }
        return
    }
    if ((event.key === "Backspace" && !mod) || (event.altKey && event.key === "ArrowUp")) {
        if (state.currentFolder) {
            event.preventDefault()
            void goUp()
        }
        return
    }
    if (event.key === "Delete" || event.key === "F2" || (mod && ["a", "Backspace"].includes(event.key))) {
        // Mutations are not available while looking at the past.
        event.preventDefault()
    }
}

/* Restore: undo a folder deletion with the existing write paths (no new record fields or versions). */

async function restoreFolderTreeFromHistory(
    client: any,
    record: HistoryFolderRecord,
    options: { deletedAt: string; oldPath: string; newPath: string; rootId: string; now: string },
): Promise<{ folder: TglfsFolder; count: number }> {
    if (!folderRecordTextHasOnlyKnownFields(record.text)) {
        throw new Error(`Folder record ${record.data.folderId} has fields this client does not understand`)
    }
    const folder: TglfsFolder = {
        ...record.data,
        deleted: false,
        updatedAt: options.now,
        path: rewritePathForMove(record.data.path, options.oldPath, options.newPath),
        rootId: options.rootId,
    }
    // The exact inverse of tombstoneFolderTree's final write.
    await writeFolderRecord(client, folder, { msgId: record.msgId, date: record.date, data: record.data })
    let count = 1

    // Subfolders deleted in the same operation share the deletion timestamp.
    const childMessages = await listFolderRecordMessages(client, { parentFolderId: record.data.folderId, limit: HISTORY_FOLDER_LIMIT })
    const childIds = new Set(parseHistoryFolderMessages(childMessages).map((child) => child.data.folderId))
    const restoredChildren: TglfsFolder[] = []
    for (const childId of childIds) {
        const versions = parseHistoryFolderMessages(await listFolderRecordMessages(client, { folderId: childId, limit: 20 }))
        const canonical = canonicalHistoryFolder(versions, childId)
        if (
            !canonical ||
            !canonical.data.deleted ||
            canonical.data.parentFolderId !== record.data.folderId ||
            canonical.data.updatedAt !== options.deletedAt ||
            !folderRecordTextHasOnlyKnownFields(canonical.text)
        ) continue
        const restored = await restoreFolderTreeFromHistory(client, canonical, options)
        restoredChildren.push(restored.folder)
        count += restored.count
    }

    if (restoredChildren.length > 0 || folder.path !== record.data.path) {
        const manifestRecord = await getFolderManifest(client, folder.folderId)
        const manifest = manifestRecord?.data ?? createTglfsFolderManifest({
            folderId: folder.folderId,
            rootId: options.rootId,
            path: folder.path,
            now: options.now,
        })
        const entries: Record<string, TglfsFolderManifestEntry> = {}
        for (const [key, entry] of Object.entries(manifest.entries)) {
            entries[key] = { ...entry, path: rewritePathForMove(entry.path, options.oldPath, options.newPath) }
        }
        const activeNames = activeManifestEntryNames(manifest)
        for (const child of restoredChildren) {
            const alreadyListed = Object.values(entries).some((entry) =>
                entry.kind === "folder" && entry.folderId === child.folderId && !entry.deleted)
            if (alreadyListed || activeNames.has(child.name.toLowerCase())) continue
            entries[child.name] = {
                entryId: createRecordId("entry"),
                name: child.name,
                path: child.path,
                kind: "folder",
                folderId: child.folderId,
                deleted: false,
                updatedAt: options.now,
            }
        }
        await writeFolderManifest(client, {
            ...manifest,
            rootId: options.rootId,
            path: folder.path,
            updatedAt: options.now,
            entries,
        }, manifestRecord)
    }
    return { folder, count }
}

async function restoreDeletedFolderFromHistory(client: any, item: HistoryItem) {
    const mode = historyMode
    if (!mode || !item.folderId) return
    const scope = mode.scope
    const scopeId = scope?.data.folderId ?? TGLFS_ROOT_PARENT_ID

    // Re-read the record right before writing: never act on a stale view.
    const versions = parseHistoryFolderMessages(await listFolderRecordMessages(client, { folderId: item.folderId, limit: 20 }))
    const record = canonicalHistoryFolder(versions, item.folderId)
    if (!record || !record.data.deleted) {
        showUfidToast("This folder is no longer deleted")
        await openHistory(mode.at)
        return
    }
    if (record.data.parentFolderId !== scopeId) {
        showUfidToast("This folder was deleted somewhere else", { tone: "error" })
        return
    }
    if (!folderRecordTextHasOnlyKnownFields(record.text)) {
        showUfidToast("This folder record has fields this version of TGLFS doesn't understand", { tone: "error" })
        return
    }

    const name = record.data.name
    const now = new Date().toISOString()
    let parentManifest: { record: TglfsFolderManifestRecord | null; manifest: TglfsFolderManifest } | null = null
    if (scope) {
        parentManifest = await getFolderManifestForMutation(client, scope.data, now)
        const liveSiblings = await listFolderRecords(client, { parentFolderId: scopeId, query: name, limit: 200 })
        const names = [
            ...activeManifestEntryNames(parentManifest.manifest),
            ...liveSiblings.filter((sibling) => !sibling.data.deleted).map((sibling) => sibling.data.name),
        ]
        if (!assertFolderNameAvailable(name, names)) return
    } else if (await topLevelFolderNameExists(client, name, record.data.folderId)) {
        showUfidToast(`"${name}" already exists here`)
        return
    }

    const ok = await requestBrowserConfirm({
        title: "Restore folder?",
        message: `"${name}" and any folders deleted with it will come back in ${historyScopeName(scope)}, with the files still stored inside them. This changes the folder now, not just this view. Restoring overwrites the deletion record, so the deletion may no longer show in the history.`,
        confirmLabel: "Restore",
        icon: "restore",
    })
    if (!ok) return

    showUfidToast(`Restoring "${name}"...`, { durationMs: null })
    const newPath = scope ? joinFolderPath(scope.data.path, name) : ""
    const rootId = scope ? (scope.data.rootId ?? scope.data.folderId) : record.data.folderId
    try {
        const restored = await restoreFolderTreeFromHistory(client, record, {
            deletedAt: record.data.updatedAt,
            oldPath: record.data.path,
            newPath,
            rootId,
            now,
        })
        if (scope && parentManifest) {
            await writeFolderManifest(client, {
                ...parentManifest.manifest,
                rootId: scope.data.rootId ?? scope.data.folderId,
                path: scope.data.path,
                updatedAt: now,
                entries: {
                    ...parentManifest.manifest.entries,
                    [name]: {
                        entryId: createRecordId("entry"),
                        name,
                        path: newPath,
                        kind: "folder",
                        folderId: record.data.folderId,
                        deleted: false,
                        updatedAt: now,
                    },
                },
            }, parentManifest.record)
        }
        if (historyMode) historyMode.dirty = true
        showUfidToast(restored.count > 1 ? `Restored "${name}" and ${pluralize(restored.count - 1, "subfolder")}` : `Restored "${name}"`, { tone: "success" })
    } catch (error) {
        console.error(error)
        showUfidToast(`Restoring "${name}" failed`, { tone: "error" })
    }
    if (historyMode) await openHistory(historyMode.at)
}

/* Move a file that was moved out of this folder back, with the same writes as the Move action. */
async function moveFileBackFromHistory(client: any, item: HistoryItem, scope: FolderBrowserEntry) {
    if (!item.ufid) return
    const record = await getFileCardByUfid(client, item.ufid)
    if (!record) {
        showUfidToast("This file no longer exists", { tone: "error" })
        return
    }
    const sourceParentId = "parentFolderId" in record.data ? record.data.parentFolderId : undefined
    if (sourceParentId === scope.data.folderId) {
        showUfidToast("This file is already here")
        return
    }
    const now = new Date().toISOString()
    const { record: manifestRecord, manifest } = await getFolderManifestForMutation(client, scope.data, now)
    const name = record.data.name
    if (
        activeManifestEntryNames(manifest).has(name.toLowerCase()) ||
        activeManifestFileUfids(manifest).has(record.data.ufid) ||
        await fileNameExistsInParent(client, scope.data.folderId, name, record.msgId)
    ) {
        showUfidToast(`"${name}" already exists here`)
        return
    }
    const ok = await requestBrowserConfirm({
        title: "Move file back?",
        message: `"${name}" will be moved back to ${scope.data.name}. This changes the folder now, not just this view.`,
        confirmLabel: "Move back",
        icon: "restore",
    })
    if (!ok) return

    showUfidToast(`Moving "${name}" back...`, { durationMs: null })
    try {
        await writeFolderManifest(client, {
            ...manifest,
            rootId: scope.data.rootId ?? scope.data.folderId,
            path: scope.data.path,
            updatedAt: now,
            entries: {
                ...manifest.entries,
                [name]: {
                    entryId: createRecordId("entry"),
                    name,
                    path: joinFolderPath(scope.data.path, name),
                    kind: "file",
                    ufid: record.data.ufid,
                    size: record.data.size,
                    mtimeMs: Date.parse(now),
                    mode: 0o644,
                    deleted: false,
                    updatedAt: now,
                },
            },
        }, manifestRecord)
        await updateFileCardParent(client, record.msgId, "me", record.data, scope.data.folderId)
        if (sourceParentId && sourceParentId !== TGLFS_ROOT_PARENT_ID) {
            await tombstoneEntryInFolderManifest(client, sourceParentId, now, (entry) =>
                entry.kind === "file" && entry.ufid === record.data.ufid)
        }
        if (historyMode) historyMode.dirty = true
        showUfidToast(`Moved "${name}" back`, { tone: "success" })
    } catch (error) {
        console.error(error)
        showUfidToast(`Moving "${name}" back failed`, { tone: "error" })
    }
    if (historyMode) await openHistory(historyMode.at)
}

/* ------------------------------------------------------------- Keyboard */

function gridColumnCount() {
    const grid = document.getElementById("browserGrid")
    if (!grid || grid.hasAttribute("hidden")) return 1
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length
    return Math.max(1, columns)
}

function moveFocus(delta: number, extend: boolean) {
    keyboardNavigation = true
    const items = getVisibleItems()
    if (items.length === 0) return
    const current = state.focusIndex ?? state.lastClickedIndex
    const next = current === null
        ? (delta > 0 ? 0 : items.length - 1)
        : Math.max(0, Math.min(items.length - 1, current + delta))
    const entry = items[next]
    if (!entry) return
    if (extend) {
        state.selected.set(entry.id, entry)
        state.focusIndex = next
        updateSelectionDisplay()
    } else {
        selectOnly(entry, next)
    }
    applyFocusDisplay(true)
}

function isEditableTarget(target: EventTarget | null) {
    const element = target as HTMLElement | null
    return !!element && (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT" ||
        element.isContentEditable
    )
}

async function handleKeydown(event: KeyboardEvent) {
    const browserDiv = document.getElementById("fileBrowser")
    if (!browserDiv || browserDiv.hasAttribute("hidden")) return
    if (document.querySelector(".fx-dialog-backdrop") || isMenuOpen()) return

    if (previewModal?.isOpen()) {
        if (event.key === "Escape") {
            event.preventDefault()
            previewModal.close()
        } else if (event.key === "ArrowLeft") {
            event.preventDefault()
            await previewModal.showPrevious()
        } else if (event.key === "ArrowRight") {
            event.preventDefault()
            await previewModal.showNext()
        }
        return
    }

    const mod = event.metaKey || event.ctrlKey
    if (isEditableTarget(event.target)) {
        if (event.key === "Escape" && (event.target as HTMLElement).id === "browserSearchInput") {
            const input = event.target as HTMLInputElement
            if (input.value) {
                input.value = ""
                input.dispatchEvent(new Event("input"))
            } else {
                input.blur()
            }
        } else if (event.key === "ArrowDown" && (event.target as HTMLElement).id === "browserSearchInput") {
            event.preventDefault()
            ;(event.target as HTMLElement).blur()
            moveFocus(1, false)
        }
        return
    }

    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
        // Undo is only available while its toast is visible; otherwise leave the shortcut alone.
        if (triggerActionToast()) event.preventDefault()
        return
    }

    if (historyMode) {
        handleHistoryKeydown(event, mod)
        return
    }
    if (!mod && !event.altKey && event.key.toLowerCase() === "h") {
        event.preventDefault()
        const selected = state.selected.size === 1 ? Array.from(state.selected.values())[0] : null
        if (selected && isFolderEntry(selected)) {
            await openFolderHistory(selected)
        } else {
            await toggleHistory()
        }
        return
    }

    if (event.key === "Escape") {
        if (isSidebarOpen()) {
            closeSidebar()
        } else if (state.selected.size > 0) {
            clearSelection()
        }
        return
    }
    if (event.key === "/" || (mod && event.key.toLowerCase() === "k")) {
        event.preventDefault()
        const input = document.getElementById("browserSearchInput") as HTMLInputElement | null
        input?.focus()
        input?.select()
        return
    }
    if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault()
        const items = getVisibleItems()
        for (const entry of items) state.selected.set(entry.id, entry)
        updateSelectionDisplay()
        return
    }
    if (event.key === "Backspace" && mod && state.selected.size > 0) {
        event.preventDefault()
        await deleteSelectedEntries()
        return
    }
    if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) {
        if (state.currentFolder) {
            event.preventDefault()
            await goUp()
        }
        return
    }
    if (event.key === "Delete" && state.selected.size > 0) {
        const entries = Array.from(state.selected.values())
        if (entries.every((entry) => isFileEntry(entry) || isFolderEntry(entry))) {
            event.preventDefault()
            await deleteSelectedEntries()
        }
        return
    }
    if (event.key === "F2" && state.selected.size === 1) {
        event.preventDefault()
        await renameEntry(Array.from(state.selected.values())[0])
        return
    }
    if (event.key === "Enter") {
        const selected = state.selected.size === 1 ? Array.from(state.selected.values())[0] : null
        if (selected) {
            event.preventDefault()
            await openEntry(selected, getVisibleItems().indexOf(selected))
        }
        return
    }
    const columns = state.viewMode === "grid" ? gridColumnCount() : 1
    const deltas: Record<string, number> = state.viewMode === "grid"
        ? { ArrowDown: columns, ArrowUp: -columns, ArrowRight: 1, ArrowLeft: -1 }
        : { ArrowDown: 1, ArrowUp: -1 }
    if (event.key in deltas && !event.altKey && !mod) {
        event.preventDefault()
        moveFocus(deltas[event.key], event.shiftKey)
    }
}

/* -------------------------------------------------------------- Preview */

function wirePreviewChrome() {
    const modal = document.getElementById("previewModal")
    const prev = document.getElementById("previewPrev")
    const next = document.getElementById("previewNext")
    const counter = document.getElementById("previewCounter")
    prev?.addEventListener("click", () => void previewModal?.showPrevious())
    next?.addEventListener("click", () => void previewModal?.showNext())
    modal?.addEventListener("preview:change", (event) => {
        const detail = (event as CustomEvent<{ index: number; total: number }>).detail
        prev?.toggleAttribute("hidden", detail.index <= 0)
        next?.toggleAttribute("hidden", detail.index >= detail.total - 1)
        if (counter) counter.textContent = detail.total > 1 ? `${detail.index + 1} / ${detail.total}` : ""
    })
    if (!modal) return
    // Opening a preview adds a history entry so the system back gesture closes it.
    new MutationObserver(() => {
        const open = !modal.hasAttribute("hidden")
        const historyState = window.history.state as BrowserHistoryState | null
        if (open && !historyState?.preview) {
            try {
                window.history.pushState({ tglfs: true, trail: currentTrailIds(), preview: true }, "", window.location.href)
            } catch {}
        } else if (!open && historyState?.preview) {
            window.history.back()
        }
    }).observe(modal, { attributes: true, attributeFilter: ["hidden"] })
}

/* --------------------------------------------------------------- Init */

export async function initFileBrowser(client: any, config: Config.Config) {
    if (state.initialized) {
        // A new login reuses the existing DOM bindings with the new Telegram session.
        activeBrowserClient = client
        activeBrowserConfig = config
        if (previewModal) (previewModal as any).client = client
        return
    }
    state.initialized = true
    activeBrowserClient = client
    activeBrowserConfig = config

    previewModal = new PreviewModal(client)
    wirePreviewChrome()

    const savedView = readPreference(VIEW_STORAGE_KEY)
    if (savedView === "grid" || savedView === "list") state.viewMode = savedView
    const savedSort = readPreference(SORT_STORAGE_KEY) as SortMode | null
    const sortModes: SortMode[] = ["date_desc", "date_asc", "name_asc", "name_desc", "size_desc", "size_asc"]
    if (savedSort && sortModes.includes(savedSort)) state.sort = savedSort

    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement
    const searchClear = document.getElementById("browserSearchClear") as HTMLButtonElement | null
    const sortSelect = document.getElementById("browserSortSelect") as HTMLSelectElement
    const prevButton = document.getElementById("browserPrevPage") as HTMLButtonElement
    const nextButton = document.getElementById("browserNextPage") as HTMLButtonElement
    sortSelect.value = state.sort

    document.addEventListener("pointerdown", (event) => {
        lastPointerType = event.pointerType || "mouse"
        if (keyboardNavigation) {
            keyboardNavigation = false
            applyFocusDisplay()
        }
    }, { capture: true, passive: true })

    const doRefresh = async (options?: BrowserRefreshOptions) => {
        if (historyMode) {
            // Background refreshes (e.g. a finished upload) re-read the history and keep the chosen time.
            historyMode.dirty = true
            await openHistory(historyMode.at)
            return
        }
        const refreshSequence = ++browserRefreshSequence
        if (options?.showLoading) {
            renderBrowserLoading(options.loadingMessage)
        }
        try {
            const items = await loadFirstPage(activeBrowserClient ?? client, refreshSequence)
            if (!items || refreshSequence !== browserRefreshSequence) return
            renderBrowser(items)
        } catch (error) {
            if (refreshSequence !== browserRefreshSequence) return
            console.error(error)
            renderBrowser([])
            showUfidToast("Unable to load files. Check your connection.", { tone: "error", durationMs: 5000 })
        }
    }
    refreshBrowser = doRefresh

    window.addEventListener("tglfs:refresh-browser", async (event) => {
        const browserDiv = document.getElementById("fileBrowser")
        if (!browserDiv || browserDiv.hasAttribute("hidden")) return
        // Queued uploads finish later; only reload when the user still looks at the destination (or a search).
        const targetFolderId = (event as Event & { tglfsParentFolderId?: string }).tglfsParentFolderId
        if (targetFolderId && !state.query && targetFolderId !== currentDirectoryParentId()) return
        await doRefresh()
    })
    window.addEventListener(BROWSER_ACTIONS_CHANGED_EVENT, () => updateActionStates())
    let resizeTimer: number | undefined
    window.addEventListener("resize", () => {
        window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(() => updateActionStates(), 120)
    })
    window.addEventListener("popstate", (event) => {
        const historyState = event.state as BrowserHistoryState | null
        if (previewModal?.isOpen()) {
            if (!historyState?.preview) previewModal.close()
            return
        }
        closeMenu()
        if (historyState?.preview) {
            window.history.back()
            return
        }
        void restoreHistoryTrail(historyState?.tglfs ? historyState.trail : [])
    })

    /* Search */
    let searchTimer: number | undefined
    const scheduleSearch = (immediate: boolean) => {
        const nextQuery = (searchInput.value || "").trim()
        searchClear?.toggleAttribute("hidden", searchInput.value.length === 0)
        if (!immediate && nextQuery === state.query) return
        if (searchTimer !== undefined) {
            window.clearTimeout(searchTimer)
            searchTimer = undefined
        }
        const run = async () => {
            state.query = nextQuery
            if (historyMode) {
                // History listings are filtered locally; they are already fully loaded.
                renderHistoryListing()
                return
            }
            await doRefresh({ showLoading: true, loadingMessage: nextQuery ? `Searching for “${nextQuery}”...` : "Loading files..." })
        }
        if (immediate) {
            void run()
            return
        }
        searchTimer = window.setTimeout(() => {
            void run()
        }, 300)
    }
    searchInput.addEventListener("input", () => scheduleSearch(false))
    searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            scheduleSearch(true)
            if (isCompactViewport()) searchInput.blur()
        }
    })
    searchClear?.addEventListener("click", () => {
        searchInput.value = ""
        scheduleSearch(false)
        searchInput.focus()
    })

    /* Sort, view, paging */
    sortSelect.addEventListener("change", () => {
        state.sort = sortSelect.value as SortMode
        writePreference(SORT_STORAGE_KEY, state.sort)
        if (historyMode) {
            renderHistoryListing()
        } else if (state.pages[state.currentPage]) {
            renderBrowser(state.pages[state.currentPage])
        }
    })
    document.getElementById("viewList")?.addEventListener("click", () => setViewMode("list"))
    document.getElementById("viewGrid")?.addEventListener("click", () => setViewMode("grid"))

    prevButton.addEventListener("click", () => {
        if (historyMode) return
        if (state.currentPage > 0) {
            state.currentPage--
            state.hasMore = state.currentPage < state.pages.length - 1 || state.hasMore
            renderBrowser(state.pages[state.currentPage])
            document.getElementById("browserContent")?.scrollTo({ top: 0 })
        }
    })
    nextButton.addEventListener("click", async () => {
        if (historyMode) return
        if (state.currentPage < state.pages.length - 1 && state.pages[state.currentPage + 1]?.length) {
            state.currentPage++
            state.hasMore = state.currentPage < state.pages.length - 1 || state.hasMore
            renderBrowser(state.pages[state.currentPage])
            document.getElementById("browserContent")?.scrollTo({ top: 0 })
            return
        }
        nextButton.disabled = true
        const items = await loadNextPage(activeBrowserClient ?? client)
        if (items.length > 0) {
            state.currentPage++
            renderBrowser(items)
            document.getElementById("browserContent")?.scrollTo({ top: 0 })
            return
        }
        renderBrowser(state.pages[state.currentPage] ?? [])
    })

    /* History (time machine) */
    const historyPanelElement = document.getElementById("historyPanel")
    if (historyPanelElement) {
        historyPanel = new HistoryPanel(historyPanelElement, {
            onSelect: (index) => selectHistoryPoint(index),
            onClose: () => closeHistory(),
            onChangeClick: (itemKey) => revealHistoryItem(itemKey),
        })
    }
    document.getElementById("browserHistoryButton")?.addEventListener("click", () => void toggleHistory())

    /* Navigation chrome */
    document.getElementById("browserUpButton")?.addEventListener("click", () => void goUp())
    document.getElementById("navAllFiles")?.addEventListener("click", () => void navigateTo(null))
    document.getElementById("sidebarToggle")?.addEventListener("click", openSidebar)
    document.getElementById("sidebarClose")?.addEventListener("click", closeSidebar)
    document.getElementById("fxScrim")?.addEventListener("click", closeSidebar)
    document.querySelectorAll<HTMLElement>("#fxSidebar .fx-nav-item").forEach((item) => {
        item.addEventListener("click", () => {
            if (item.id !== "navAllFiles") closeSidebar()
        })
    })

    /* Create */
    const sidebarNew = document.getElementById("sidebarNewButton") as HTMLButtonElement | null
    sidebarNew?.addEventListener("click", () => openNewMenu(sidebarNew))
    document.getElementById("fxFab")?.addEventListener("click", () => openNewMenu())
    document.getElementById("topbarUploadButton")?.addEventListener("click", () => uploadFiles())
    document.getElementById("browserActionUpload")?.addEventListener("click", () => uploadFiles())
    document.getElementById("browserActionNewFolder")?.addEventListener("click", () => void createFolderHere())
    document.getElementById("browserActionReceive")?.addEventListener("click", () => void receiveFile())
    document.getElementById("browserActionUnsend")?.addEventListener("click", async () => {
        await (await import("../telegram")).fileUnsend(activeBrowserClient ?? client, activeBrowserConfig ?? config)
    })
    document.getElementById("browserEmpty")?.addEventListener("click", (event) => {
        const action = (event.target as HTMLElement).closest<HTMLElement>("[data-empty-action]")?.dataset.emptyAction
        if (action === "upload") uploadFiles()
        if (action === "folder") void createFolderHere()
        if (action === "clear") {
            searchInput.value = ""
            scheduleSearch(true)
        }
    })

    /* Selection chrome */
    document.getElementById("deselectAllBtn")?.addEventListener("click", () => clearSelection())
    document.getElementById("selectAllBtn")?.addEventListener("click", () => selectAllVisible())
    document.getElementById("browserSelectAllCheck")?.addEventListener("click", () => selectAllVisible())
    document.getElementById("fileActionsButtons")?.addEventListener("click", (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action-key]")
        if (!button || button.disabled) return
        const action = currentBarActions.get(button.dataset.actionKey ?? "")
        if (action) void action.run()
    })
    document.getElementById("browserContent")?.addEventListener("click", (event) => {
        // Clicking empty space clears the selection, like a desktop file manager.
        const target = event.target as HTMLElement
        if (target.closest("[data-browser-id], button, a, input, .fx-list-head")) return
        if (state.selected.size > 0 && !isTouchInteraction()) clearSelection()
    })

    /* Drag and drop upload */
    const browserDiv = document.getElementById("fileBrowser")
    const dropOverlay = document.getElementById("dropOverlay")
    let dragDepth = 0
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files")
    browserDiv?.addEventListener("dragenter", (event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        dragDepth++
        dropOverlay?.removeAttribute("hidden")
    })
    browserDiv?.addEventListener("dragover", (event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    })
    browserDiv?.addEventListener("dragleave", (event) => {
        if (!hasFiles(event)) return
        dragDepth = Math.max(0, dragDepth - 1)
        if (dragDepth === 0) dropOverlay?.setAttribute("hidden", "")
    })
    browserDiv?.addEventListener("drop", (event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        dragDepth = 0
        dropOverlay?.setAttribute("hidden", "")
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.size > 0 || file.type !== "")
        if (files.length === 0) {
            showUfidToast("Folders can't be dropped yet — drop files instead", { tone: "error" })
            return
        }
        uploadFiles(files)
    })

    window.addEventListener("keydown", (event) => {
        void handleKeydown(event)
    })
    // A delete still inside its undo window has not been written; leaving the page cancels it. Warn about
    // that (and about interrupting a write in flight) instead of trying to flush async work on unload.
    window.addEventListener("beforeunload", (event) => {
        if (!hasUnsavedBrowserWork()) return
        event.preventDefault()
        event.returnValue = ""
    })

    // Deep link: #/f/<folderId> opens that folder directly.
    const deepLinkMatch = window.location.hash.match(/^#\/f\/(.+)$/)
    if (deepLinkMatch) {
        const record = await getFolderRecord(client, decodeURIComponent(deepLinkMatch[1])).catch(() => null)
        if (record && !record.data.deleted) {
            await navigateTo(folderEntryFromRecord(record), { push: false })
            return
        }
    }
    writeHistory("replace")
    await doRefresh({ showLoading: true, loadingMessage: "Loading files..." })
}
