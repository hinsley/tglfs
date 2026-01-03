import * as Config from "../config"
import { listFileCards, renameFileCard, deleteFileCard, downloadFileCard, sendFileCard } from "../telegram"
import { FileCardData } from "../types/models"
import { PreviewModal } from "./preview"

function humanReadableSize(size: number): string {
    if (size <= 0 || !isFinite(size)) return "0 B"
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    const i = Math.floor(Math.log(size) / Math.log(1024))
    const value = size / Math.pow(1024, i)
    return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

function formatDate(epochSec: number): string {
    const date = new Date(epochSec * 1000)
    const pad = (n: number) => (n < 10 ? "0" + n : "" + n)
    const y = date.getFullYear()
    const m = pad(date.getMonth() + 1)
    const d = pad(date.getDate())
    const hh = pad(date.getHours())
    const mm = pad(date.getMinutes())
    const ss = pad(date.getSeconds())
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"])
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"])
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"])
const DOC_EXTS = new Set(["pdf", "doc", "docx", "txt", "rtf", "md"])
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz"])
const CODE_EXTS = new Set(["js", "ts", "py", "go", "rs", "c", "cpp", "h"])

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
    return "📁"
}

function isPreviewableName(name: string): boolean {
    const ext = getExtension(name)
    return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)
}

type BrowserState = {
    initialized: boolean
    query: string
    sort: "date_desc" | "date_asc" | "name_asc" | "name_desc" | "size_desc" | "size_asc"
    viewMode: "list" | "grid"
    pageSize: number
    currentPage: number
    pages: Array<Array<{ msgId: number; date: number; data: FileCardData }>>
    lastOffsetId: number | undefined
    selected: Map<number, { msgId: number; date: number; data: FileCardData }>
    lastClickedIndex: number | null
    hasMore: boolean
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
}

function applySort(items: Array<{ msgId: number; date: number; data: FileCardData }>) {
    const s = state.sort
    items.sort((a, b) => {
        switch (s) {
            case "date_desc":
                return b.date - a.date
            case "date_asc":
                return a.date - b.date
            case "name_asc":
                return a.data.name.localeCompare(b.data.name)
            case "name_desc":
                return b.data.name.localeCompare(a.data.name)
            case "size_desc":
                return b.data.size - a.data.size
            case "size_asc":
                return a.data.size - b.data.size
            default:
                return 0
        }
    })
}

let previewModal: PreviewModal | null = null
let ufidToastTimer: number | undefined

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
    const cards = document.getElementById("browserCards")
    if (cards) cards.innerHTML = ""
    const grid = document.getElementById("browserGrid")
    if (grid) grid.innerHTML = ""
}

function getVisibleItems() {
    return state.pages[state.currentPage] ?? []
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

function attachSelectionHandlers(
    root: HTMLElement,
    entry: { msgId: number; date: number; data: FileCardData },
    index: number,
) {
    const handleSelectionClick = () => {
        toggleSelection(entry, index)
    }

    root.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null
        if (target?.closest("button, a")) return
        handleSelectionClick()
    })
}

function renderList(items: Array<{ msgId: number; date: number; data: FileCardData }>) {
    const tbody = document.querySelector<HTMLTableSectionElement>("#browserTable tbody")
    const cards = document.getElementById("browserCards")
    for (const [index, { msgId, date, data }] of items.entries()) {
        const icon = getFileTypeIcon(data.name)
        if (tbody) {
            const tr = document.createElement("tr")
            tr.dataset.msgid = String(msgId)
            tr.innerHTML = `
                <td class="name"><span class="file-type-icon">${icon}</span>${data.name}</td>
                <td class="size">${humanReadableSize(data.size)}</td>
                <td class="ufid"><code title="Click to copy UFID" data-ufid>${data.ufid}</code></td>
                <td class="date">${formatDate(date)}</td>
                <td class="status"><span class="pill ${data.uploadComplete ? "complete" : "incomplete"}">${data.uploadComplete ? "Complete" : "Incomplete"}</span></td>`
            tbody.appendChild(tr)
            attachSelectionHandlers(tr, { msgId, date, data }, index)
            const ufidEl = tr.querySelector<HTMLElement>("[data-ufid]")
            if (ufidEl) {
                ufidEl.addEventListener("click", async () => {
                    try {
                        await navigator.clipboard.writeText(data.ufid)
                        showUfidToast("UFID copied to clipboard")
                    } catch {
                        showUfidToast("Unable to copy UFID")
                    }
                })
            }
        }

        if (cards) {
            const card = document.createElement("div")
            card.className = "file-card"
            card.dataset.msgid = String(msgId)
            card.innerHTML = `
                <div class="flex-grow-1">
                    <div class="title"><span class="file-type-icon">${icon}</span>${data.name}</div>
                    <div class="meta">${humanReadableSize(data.size)} • ${formatDate(date)}</div>
                    <div class="meta"><code title="Tap to copy UFID" data-ufid>${data.ufid}</code></div>
                </div>`
            cards.appendChild(card)
            attachSelectionHandlers(card, { msgId, date, data }, index)
            const ufidEl = card.querySelector<HTMLElement>("[data-ufid]")
            if (ufidEl) {
                ufidEl.addEventListener("click", async () => {
                    try {
                        await navigator.clipboard.writeText(data.ufid)
                        showUfidToast("UFID copied to clipboard")
                    } catch {
                        showUfidToast("Unable to copy UFID")
                    }
                })
            }
        }
    }
}

function renderGrid(items: Array<{ msgId: number; date: number; data: FileCardData }>) {
    const grid = document.getElementById("browserGrid")
    if (!grid) return
    for (const [index, { msgId, date, data }] of items.entries()) {
        const icon = getFileTypeIcon(data.name)
        const item = document.createElement("div")
        item.className = "file-grid-item fade-in"
        item.dataset.msgid = String(msgId)
        item.innerHTML = `
            <div class="file-icon">${icon}</div>
            <div class="file-info">
                <div class="file-name" title="${data.name}">
                    <span class="file-name-text"><span class="file-name-scroll">${data.name}</span></span>
                </div>
                <div class="file-meta">
                    <span>${humanReadableSize(data.size)}</span>
                    <span class="dot-separator">•</span>
                    <span>${formatDate(date).split(' ')[0]}</span>
                </div>
            </div>`
        grid.appendChild(item)
        attachSelectionHandlers(item, { msgId, date, data }, index)
        applyGridMarquee(item)
    }
}

function renderBrowser(items: Array<{ msgId: number; date: number; data: FileCardData }>) {
    clearViews()
    applySort(items)
    renderList(items)
    renderGrid(items)
    const pageInfo = document.getElementById("browserPageInfo")
    if (pageInfo) {
        const k = state.currentPage + 1
        const n = state.hasMore ? "…" : String(state.pages.length)
        pageInfo.textContent = `Page ${k}/${n}`
    }
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

function selectSingle(entry: { msgId: number; date: number; data: FileCardData }, index: number) {
    state.selected.clear()
    state.selected.set(entry.msgId, entry)
    state.lastClickedIndex = index
    updateSelectionDisplay()
}

function toggleSelection(entry: { msgId: number; date: number; data: FileCardData }, index: number) {
    if (state.selected.has(entry.msgId)) {
        state.selected.delete(entry.msgId)
    } else {
        state.selected.set(entry.msgId, entry)
    }
    state.lastClickedIndex = index
    updateSelectionDisplay()
}

function selectRange(index: number) {
    const items = getVisibleItems()
    const start = state.lastClickedIndex ?? index
    const [from, to] = start < index ? [start, index] : [index, start]
    state.selected.clear()
    for (let i = from; i <= to; i++) {
        const item = items[i]
        if (item) state.selected.set(item.msgId, item)
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
    document.querySelectorAll<HTMLElement>("[data-msgid]:not(input)").forEach((node) => {
        const msgId = Number(node.dataset.msgid)
        node.classList.toggle("selected", selectedIds.has(msgId))
    })
    updateActionStates()
}

function updateActionStates() {
    const selectedCount = state.selected.size
    const hasAny = selectedCount > 0
    const hasSingle = selectedCount === 1
    const selectedEntry = hasSingle ? Array.from(state.selected.values())[0] : null
    const previewEnabled = !!selectedEntry && isPreviewableName(selectedEntry.data.name)

    // Toggle button visibility (hidden when not available)
    const setButtonVisible = (id: string, visible: boolean) => {
        const btn = document.getElementById(id) as HTMLButtonElement | null
        if (btn) {
            btn.classList.toggle("action-hidden", !visible)
            btn.disabled = !visible
        }
    }
    // Preview and Rename only work on single file
    setButtonVisible("browserActionPreview", previewEnabled)
    setButtonVisible("browserActionRename", hasSingle)
    // Download only works on a single file
    setButtonVisible("browserActionDownload", hasSingle)
    setButtonVisible("browserActionDelete", hasAny)
    setButtonVisible("browserActionSend", hasAny)

    const actionsBtn = document.getElementById("browserActionsBtn") as HTMLButtonElement | null
    if (actionsBtn) actionsBtn.disabled = !hasAny

    // Toggle dropdown item visibility
    const setDropdownVisible = (id: string, visible: boolean) => {
        const item = document.getElementById(id) as HTMLAnchorElement | null
        if (!item) return
        const li = item.closest("li")
        if (li) li.classList.toggle("d-none", !visible)
    }
    setDropdownVisible("actionPreviewItem", previewEnabled)
    setDropdownVisible("actionRenameItem", hasSingle)
    setDropdownVisible("actionDownloadItem", hasSingle)
    setDropdownVisible("actionDeleteItem", hasAny)
    setDropdownVisible("actionSendItem", hasAny)

    // Toggle file actions bar visibility based on selection
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

    // Toggle Clear selection button visibility (hide when none are selected)
    const deselectAllBtn = document.getElementById("deselectAllBtn") as HTMLButtonElement | null
    if (deselectAllBtn) {
        deselectAllBtn.classList.toggle("action-hidden", selectedCount === 0)
    }
    const deselectAllBtnMobile = document.getElementById("selectAllBtnMobile") as HTMLButtonElement | null
    if (deselectAllBtnMobile) {
        deselectAllBtnMobile.classList.toggle("action-hidden", selectedCount === 0)
    }
}

async function loadFirstPage(client: any) {
    state.pages = []
    state.currentPage = 0
    state.lastOffsetId = undefined
    state.selected.clear()
    state.lastClickedIndex = null
    const items = await listFileCards(client, { query: state.query, limit: state.pageSize })
    if (items.length > 0) state.lastOffsetId = items[items.length - 1].msgId
    state.pages.push(items)
    state.hasMore = items.length === state.pageSize
    return items
}

async function loadNextPage(client: any) {
    const items = await listFileCards(client, { query: state.query, limit: state.pageSize, offsetId: state.lastOffsetId })
    if (items.length > 0) state.lastOffsetId = items[items.length - 1].msgId
    state.pages.push(items)
    if (items.length < state.pageSize) state.hasMore = false
    return items
}

export async function initFileBrowser(client: any, config: Config.Config) {
    if (state.initialized) return
    state.initialized = true

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
    const getSelectedEntries = () => Array.from(state.selected.values())
    const removeEntriesFromPage = (ids: Set<number>) => {
        const page = state.pages[state.currentPage]
        if (!page) return
        state.pages[state.currentPage] = page.filter((entry) => !ids.has(entry.msgId))
    }

    const doRefresh = async () => {
        const items = await loadFirstPage(client)
        renderBrowser(items)
    }

    // Allow other modules to request a refresh when the browser is visible (e.g., after upload completes).
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
        state.sort = sortSelect.value as BrowserState["sort"]
        if (state.pages[state.currentPage]) {
            renderBrowser(state.pages[state.currentPage])
        }
    })

    prevButton.addEventListener("click", () => {
        if (state.currentPage > 0) {
            state.currentPage--
            clearSelection()
            renderBrowser(state.pages[state.currentPage])
        }
    })

    nextButton.addEventListener("click", async () => {
        if (state.currentPage < state.pages.length - 1 && state.pages[state.currentPage + 1]?.length) {
            state.currentPage++
            clearSelection()
            renderBrowser(state.pages[state.currentPage])
            return
        }
        const items = await loadNextPage(client)
        if (items.length > 0) {
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
        const selected = getSingleSelection()
        if (!selected) return
        await previewModal?.open(selected, getVisibleItems())
    })
    actionDownload.addEventListener("click", async () => {
        const selected = getSingleSelection()
        if (!selected) return
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    actionRename.addEventListener("click", async () => {
        const selected = getSingleSelection()
        if (!selected) return
        const newName = prompt(`Rename file:\n\n${selected.data.name}\n\nEnter new name:`)
        if (!newName || newName.trim() === "") return
        await renameFileCard(client, selected.msgId, "me", selected.data, newName.trim())
        selected.data.name = newName.trim()
        renderBrowser(state.pages[state.currentPage])
    })
    actionDelete.addEventListener("click", async () => {
        const entries = getSelectedEntries()
        if (entries.length === 0) return
        if (entries.length === 1) {
            const selected = entries[0]
            const ok = confirm(`Delete file "${selected.data.name}"?`)
            if (!ok) return
            await deleteFileCard(client, selected.msgId, selected.data)
            removeEntriesFromPage(new Set([selected.msgId]))
        } else {
            const names = entries.slice(0, 5).map((entry) => entry.data.name).join(", ")
            const more = entries.length > 5 ? ` and ${entries.length - 5} more` : ""
            const ok = confirm(`Delete ${entries.length} files?\n\n${names}${more}`)
            if (!ok) return
            for (const entry of entries) {
                await deleteFileCard(client, entry.msgId, entry.data)
            }
            removeEntriesFromPage(new Set(entries.map((entry) => entry.msgId)))
        }
        clearSelection()
        renderBrowser(state.pages[state.currentPage])
    })
    actionSend.addEventListener("click", async () => {
        const entries = getSelectedEntries()
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
        if (!selected) return
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    bulkDelete?.addEventListener("click", async () => {
        const entries = getSelectedEntries()
        if (entries.length === 0) return
        const names = entries.slice(0, 5).map((entry) => entry.data.name).join(", ")
        const more = entries.length > 5 ? ` and ${entries.length - 5} more` : ""
        const ok = confirm(`Delete ${entries.length} file${entries.length === 1 ? "" : "s"}?\n\n${names}${more}`)
        if (!ok) return
        for (const entry of entries) {
            await deleteFileCard(client, entry.msgId, entry.data)
        }
        removeEntriesFromPage(new Set(entries.map((entry) => entry.msgId)))
        clearSelection()
        renderBrowser(state.pages[state.currentPage])
    })
    bulkSend?.addEventListener("click", async () => {
        const entries = getSelectedEntries()
        if (entries.length === 0) return
        const recipient = prompt("Enter recipient:")
        if (!recipient || recipient.trim() === "") return
        for (const entry of entries) {
            await sendFileCard(client, entry.data, recipient.trim())
        }
        alert("Files sent.")
    })

    // Dropdown items map to the same actions.
    actionPreviewItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const selected = getSingleSelection()
        if (!selected) return
        await previewModal?.open(selected, getVisibleItems())
    })
    actionDownloadItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const selected = getSingleSelection()
        if (!selected) return
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, selected.data, password)
    })
    actionRenameItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const selected = getSingleSelection()
        if (!selected) return
        const newName = prompt(`Rename file:\n\n${selected.data.name}\n\nEnter new name:`)
        if (!newName || newName.trim() === "") return
        await renameFileCard(client, selected.msgId, "me", selected.data, newName.trim())
        selected.data.name = newName.trim()
        renderBrowser(state.pages[state.currentPage])
    })
    actionDeleteItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const entries = getSelectedEntries()
        if (entries.length === 0) return
        if (entries.length === 1) {
            const selected = entries[0]
            const ok = confirm(`Delete file "${selected.data.name}"?`)
            if (!ok) return
            await deleteFileCard(client, selected.msgId, selected.data)
            removeEntriesFromPage(new Set([selected.msgId]))
        } else {
            const names = entries.slice(0, 5).map((entry) => entry.data.name).join(", ")
            const more = entries.length > 5 ? ` and ${entries.length - 5} more` : ""
            const ok = confirm(`Delete ${entries.length} files?\n\n${names}${more}`)
            if (!ok) return
            for (const entry of entries) {
                await deleteFileCard(client, entry.msgId, entry.data)
            }
            removeEntriesFromPage(new Set(entries.map((entry) => entry.msgId)))
        }
        clearSelection()
        renderBrowser(state.pages[state.currentPage])
    })
    actionSendItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const entries = getSelectedEntries()
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
            }
            return
        }
        if (e.key === "Delete" && state.selected.size > 0) {
            e.preventDefault()
            bulkDelete?.click()
            return
        }
        if (e.key === "Enter") {
            const selected = getSingleSelection()
            if (selected) {
                e.preventDefault()
                await previewModal?.open(selected, getVisibleItems())
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
