import * as Config from "../config"
import {
    listFileCards,
    renameFileCard,
    deleteFileCard,
    downloadFileCard,
    sendFileCard,
} from "../telegram"
import { FileCardData } from "../types/models"

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

type BrowserState = {
    initialized: boolean
    query: string
    sort: "date_desc" | "date_asc" | "name_asc" | "name_desc" | "size_desc" | "size_asc"
    pageSize: number
    currentPage: number
    pages: Array<Array<{ msgId: number; date: number; data: FileCardData }>>
    lastOffsetId: number | undefined
    selected: { msgId: number; date: number; data: FileCardData } | null
    hasMore: boolean
}

const state: BrowserState = {
    initialized: false,
    query: "",
    sort: "date_desc",
    pageSize: 50,
    currentPage: 0,
    pages: [],
    lastOffsetId: undefined,
    selected: null,
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

function clearTable() {
    const tbody = document.querySelector<HTMLTableSectionElement>("#browserTable tbody")
    if (tbody) tbody.innerHTML = ""
    const cards = document.getElementById("browserCards")
    if (cards) cards.innerHTML = ""
}

function renderTable(client: any, config: Config.Config, items: Array<{ msgId: number; date: number; data: FileCardData }>) {
    clearTable()
    const tbody = document.querySelector<HTMLTableSectionElement>("#browserTable tbody")
    const cards = document.getElementById("browserCards")
    applySort(items)

    for (const { msgId, date, data } of items) {
        // Desktop row.
        if (tbody) {
            const tr = document.createElement("tr")
            tr.innerHTML = `
                <td class="name">${data.name}</td>
                <td class="size">${humanReadableSize(data.size)}</td>
                <td class="ufid"><code title="Click to copy UFID" data-ufid>${data.ufid}</code></td>
                <td class="date">${formatDate(date)}</td>
                <td class="status"><span class="pill ${data.uploadComplete ? "complete" : "incomplete"}">${data.uploadComplete ? "Complete" : "Incomplete"}</span></td>`
            tbody.appendChild(tr)
            attachRowSelection(tr, { msgId, date, data })
            const ufidEl = tr.querySelector<HTMLElement>("[data-ufid]")
            if (ufidEl) {
                ufidEl.addEventListener("click", async (e) => {
                    e.stopPropagation()
                    await navigator.clipboard.writeText(data.ufid)
                })
            }
        }

        // Mobile card.
        if (cards) {
            const card = document.createElement("div")
            card.className = "file-card"
            card.innerHTML = `
                <div class="flex-grow-1">
                    <div class="title">${data.name}</div>
                    <div class="meta">${humanReadableSize(data.size)} • ${formatDate(date)}</div>
                    <div class="meta"><code title="Tap to copy UFID" data-ufid>${data.ufid}</code></div>
                </div>`
            cards.appendChild(card)
            attachRowSelection(card, { msgId, date, data })
            const ufidEl = card.querySelector<HTMLElement>("[data-ufid]")
            if (ufidEl) {
                ufidEl.addEventListener("click", async (e) => {
                    e.stopPropagation()
                    await navigator.clipboard.writeText(data.ufid)
                })
            }
        }
    }

    const pageInfo = document.getElementById("browserPageInfo")
    if (pageInfo) {
        const k = state.currentPage + 1
        const n = state.hasMore ? "…" : String(state.pages.length)
        pageInfo.textContent = `Page ${k}/${n}`
    }
    updateTopActionsEnabled()
}

function attachRowSelection(root: HTMLElement, entry: { msgId: number; date: number; data: FileCardData }) {
    root.addEventListener("click", () => {
        state.selected = entry
        document.querySelectorAll("#browserTable tbody tr").forEach((tr) => tr.classList.remove("selected"))
        if (root.tagName === "TR") root.classList.add("selected")
        else if (root.classList.contains("file-card")) root.classList.add("selected")
        updateTopActionsEnabled()
    })
}

function updateTopActionsEnabled() {
    const has = !!state.selected
    const set = (id: string) => {
        const btn = document.getElementById(id) as HTMLButtonElement | null
        if (btn) btn.disabled = !has
    }
    set("browserActionDownload")
    set("browserActionRename")
    set("browserActionDelete")
    set("browserActionSend")
    const actionsBtn = document.getElementById("browserActionsBtn") as HTMLButtonElement | null
    if (actionsBtn) actionsBtn.disabled = !has
}

async function loadFirstPage(client: any) {
    state.pages = []
    state.currentPage = 0
    state.lastOffsetId = undefined
    state.selected = null
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

    const searchInput = document.getElementById("browserSearchInput") as HTMLInputElement
    const sortSelect = document.getElementById("browserSortSelect") as HTMLSelectElement
    const prevButton = document.getElementById("browserPrevPage") as HTMLButtonElement
    const nextButton = document.getElementById("browserNextPage") as HTMLButtonElement
    const actionDownload = document.getElementById("browserActionDownload") as HTMLButtonElement
    const actionRename = document.getElementById("browserActionRename") as HTMLButtonElement
    const actionDelete = document.getElementById("browserActionDelete") as HTMLButtonElement
    const actionSend = document.getElementById("browserActionSend") as HTMLButtonElement
    const actionUpload = document.getElementById("browserActionUpload") as HTMLButtonElement
    const actionReceive = document.getElementById("browserActionReceive") as HTMLButtonElement
    const actionUnsend = document.getElementById("browserActionUnsend") as HTMLButtonElement
    const homeButton = document.getElementById("browserHomeButton") as HTMLButtonElement
    const actionDownloadItem = document.getElementById("actionDownloadItem") as HTMLAnchorElement
    const actionRenameItem = document.getElementById("actionRenameItem") as HTMLAnchorElement
    const actionDeleteItem = document.getElementById("actionDeleteItem") as HTMLAnchorElement
    const actionSendItem = document.getElementById("actionSendItem") as HTMLAnchorElement
    const actionUnsendItem = document.getElementById("actionUnsendItem") as HTMLAnchorElement

    const doRefresh = async () => {
        const items = await loadFirstPage(client)
        renderTable(client, config, items)
    }

    searchInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
            state.query = (searchInput.value || "").trim()
            await doRefresh()
        }
    })

    sortSelect.addEventListener("change", () => {
        state.sort = sortSelect.value as BrowserState["sort"]
        if (state.pages[state.currentPage]) {
            renderTable(client, config, state.pages[state.currentPage])
        }
    })

    prevButton.addEventListener("click", () => {
        if (state.currentPage > 0) {
            state.currentPage--
            renderTable(client, config, state.pages[state.currentPage])
        }
    })

    nextButton.addEventListener("click", async () => {
        if (state.currentPage < state.pages.length - 1 && state.pages[state.currentPage + 1]?.length) {
            state.currentPage++
            renderTable(client, config, state.pages[state.currentPage])
            return
        }
        const items = await loadNextPage(client)
        if (items.length > 0) {
            state.currentPage++
            renderTable(client, config, items)
        }
    })

    homeButton.addEventListener("click", () => {
        const controlsDiv = document.getElementById("controls")
        const browserDiv = document.getElementById("fileBrowser")
        browserDiv?.setAttribute("hidden", "")
        controlsDiv?.removeAttribute("hidden")
    })
    actionUpload.addEventListener("click", () => {
        const uploadInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
        if (uploadInput) uploadInput.click()
    })
    actionReceive.addEventListener("click", async () => {
        // Reuse existing flow via original button to keep prompts intact.
        const btn = document.getElementById("receiveFileButton") as HTMLButtonElement | null
        if (btn) btn.click()
    })
    actionUnsend.addEventListener("click", async () => {
        const btn = document.getElementById("unsendFileButton") as HTMLButtonElement | null
        if (btn) btn.click()
    })

    actionDownload.addEventListener("click", async () => {
        if (!state.selected) return
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, state.selected.data, password)
    })
    actionRename.addEventListener("click", async () => {
        if (!state.selected) return
        const newName = prompt(`Rename file:\n\n${state.selected.data.name}\n\nEnter new name:`)
        if (!newName || newName.trim() === "") return
        await renameFileCard(client, state.selected.msgId, "me", state.selected.data, newName.trim())
        state.selected.data.name = newName.trim()
        renderTable(client, config, state.pages[state.currentPage])
    })
    actionDelete.addEventListener("click", async () => {
        if (!state.selected) return
        const ok = confirm(`Delete file "${state.selected.data.name}"?`)
        if (!ok) return
        await deleteFileCard(client, state.selected.msgId, state.selected.data)
        const page = state.pages[state.currentPage]
        const idx = page.findIndex((p) => p.msgId === state.selected!.msgId)
        if (idx >= 0) page.splice(idx, 1)
        state.selected = null
        renderTable(client, config, page)
    })
    actionSend.addEventListener("click", async () => {
        if (!state.selected) return
        const recipient = prompt("Enter recipient:")
        if (!recipient || recipient.trim() === "") return
        await sendFileCard(client, state.selected.data, recipient.trim())
        alert("File sent.")
    })

    // Dropdown items map to the same actions.
    actionDownloadItem.addEventListener("click", async (e) => {
        e.preventDefault(); if (!state.selected) return
        const password = prompt("(Optional) Decryption password:")
        if (password === null) return
        await downloadFileCard(client, config, state.selected.data, password)
    })
    actionRenameItem.addEventListener("click", async (e) => {
        e.preventDefault(); if (!state.selected) return
        const newName = prompt(`Rename file:\n\n${state.selected.data.name}\n\nEnter new name:`)
        if (!newName || newName.trim() === "") return
        await renameFileCard(client, state.selected.msgId, "me", state.selected.data, newName.trim())
        state.selected.data.name = newName.trim()
        renderTable(client, config, state.pages[state.currentPage])
    })
    actionDeleteItem.addEventListener("click", async (e) => {
        e.preventDefault(); if (!state.selected) return
        const ok = confirm(`Delete file "${state.selected.data.name}"?`)
        if (!ok) return
        await deleteFileCard(client, state.selected.msgId, state.selected.data)
        const page = state.pages[state.currentPage]
        const idx = page.findIndex((p) => p.msgId === state.selected!.msgId)
        if (idx >= 0) page.splice(idx, 1)
        state.selected = null
        renderTable(client, config, page)
    })
    actionSendItem.addEventListener("click", async (e) => {
        e.preventDefault(); if (!state.selected) return
        const recipient = prompt("Enter recipient:")
        if (!recipient || recipient.trim() === "") return
        await sendFileCard(client, state.selected.data, recipient.trim())
        alert("File sent.")
    })
    actionUnsendItem.addEventListener("click", async (e) => {
        e.preventDefault()
        const btn = document.getElementById("unsendFileButton") as HTMLButtonElement | null
        if (btn) btn.click()
    })

    const items = await loadFirstPage(client)
    renderTable(client, config, items)
} 