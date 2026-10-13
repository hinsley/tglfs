// Command palette (⌘K / Ctrl+K): one fuzzy box for actions, folders and files across every folder.
//
// Groups: Selection (actions for the current selection), Recent (empty query only), Actions, Folders (known
// this session plus a live Telegram lookup), Files (live search across all folders), and a final "Search
// everywhere" row that hands the query to the top-bar search. Read-only except for what the chosen action does.
import { getFolderRecord, listFileCards, listFolderRecords } from "../telegram"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import type { TglfsFolder } from "../../packages/tglfs-cli/src/folders"
import type { BrowserHooks, HookAction, HookFileRecord, HookFolderRecord } from "./browserHooks"
import { escapeHtml, isCompactViewport, showToast } from "./dialogs"
import { highlightSegments, rankFuzzy, type FuzzyMatch } from "./fuzzyMatch"
import { fileKindForName, fileKindIcon, icon, type IconName } from "./icons"
import {
    forgetRecentItem,
    loadRecentItems,
    recentItemKey,
    rememberRecentItem,
    type RecentItem,
} from "./recentItems"
import { createLocationResolver, formatLocation, type LocationResolver } from "./searchScope"
import { isApplePlatform, openShortcutsSheet } from "./shortcutsSheet"
import { formatStorageBytes } from "./storageStats"

type GroupId = "selection" | "recent" | "actions" | "sort" | "folders" | "files" | "search"

type PaletteItem = {
    id: string
    group: GroupId
    label: string
    keywords?: string[]
    /** Plain subtitle text. */
    subtitle?: string
    /** Subtitle resolved asynchronously from a folder trail. */
    location?: { folderId: string; dropLast?: boolean; prefix?: string; suffix?: string }
    iconHtml: string
    /** Keyboard shortcut shown as a key cap. */
    hint?: string
    /** Plain trailing text, e.g. the current sort order. */
    meta?: string
    danger?: boolean
    disabled?: boolean
    checked?: boolean
    match?: FuzzyMatch
    run: () => void | Promise<void>
}

const GROUP_TITLES: Record<GroupId, string> = {
    selection: "Selection",
    recent: "Recent",
    actions: "Actions",
    sort: "Sort by",
    folders: "Folders",
    files: "Files",
    search: "",
}

const REMOTE_DEBOUNCE_MS = 220
const REMOTE_MIN_QUERY = 2
const REMOTE_LIMIT = 30
const MAX_ACTIONS = 5
const MAX_FOLDERS = 6
const MAX_FILES = 8

function actionIcon(name: IconName, danger = false) {
    return `<span class="fx-pal-icon${danger ? " is-danger" : ""}">${icon(name)}</span>`
}

function highlighted(text: string, match?: FuzzyMatch) {
    return highlightSegments(text, match?.indices ?? [])
        .map((segment) => segment.match ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text))
        .join("")
}

function fileParentId(data: HookFileRecord["data"]) {
    const parent = "parentFolderId" in data ? data.parentFolderId : undefined
    return parent || TGLFS_ROOT_PARENT_ID
}

export type CommandPalette = {
    open(initialQuery?: string): void
    close(): void
    toggle(): void
    isOpen(): boolean
}

export function initCommandPalette(hooks: BrowserHooks): CommandPalette {
    const resolver: LocationResolver = createLocationResolver({
        known: (folderId) => hooks.getKnownFolder(folderId),
        fetch: async (folderId) => {
            const client = hooks.getClient()
            return client ? (await getFolderRecord(client, folderId))?.data ?? null : null
        },
    })

    let layer: HTMLElement | null = null
    let input: HTMLInputElement | null = null
    let list: HTMLElement | null = null
    let previouslyFocused: HTMLElement | null = null
    let mode: "root" | "sort" = "root"
    let items: PaletteItem[] = []
    let activeId: string | null = null
    /** True once the user picked a row (arrows or mouse); until then the top row follows new results. */
    let activeChosen = false
    let remoteTimer: number | undefined
    let remoteSeq = 0
    let remote: { query: string; folders: HookFolderRecord[]; files: HookFileRecord[]; loading: boolean; failed: boolean } = {
        query: "",
        folders: [],
        files: [],
        loading: false,
        failed: false,
    }

    const isOpen = () => layer !== null

    /* ------------------------------------------------------- Item sources */

    // The chosen action decides where focus goes next (a dialog, the revealed file…), so don't restore it.
    const runAndClose = (task: () => void | Promise<void>) => () => {
        close({ restoreFocus: false })
        return task()
    }

    const clickSidebarButton = (id: string) => () => {
        const button = document.getElementById(id) as HTMLButtonElement | null
        if (button && !button.disabled) button.click()
    }

    const baseActions = (): PaletteItem[] => {
        const dark = document.documentElement.dataset.theme === "dark"
        const grid = hooks.getViewMode() === "grid"
        const inFolder = !!hooks.getCurrentFolder()
        const migrateButton = document.getElementById("migrateDirectoryParentsButton") as HTMLButtonElement | null
        const actions: PaletteItem[] = [
            { id: "action:upload", group: "actions", label: "Upload files", keywords: ["add files", "import"], iconHtml: actionIcon("upload"), run: runAndClose(() => hooks.uploadFiles()) },
            { id: "action:new-folder", group: "actions", label: "New folder", keywords: ["create folder", "directory", "mkdir"], iconHtml: actionIcon("folderPlus"), run: runAndClose(() => hooks.createFolder()) },
            { id: "action:receive", group: "actions", label: "Receive file", keywords: ["import shared file", "ufid"], iconHtml: actionIcon("inbox"), run: runAndClose(() => hooks.receiveFile()) },
            {
                id: "action:view",
                group: "actions",
                label: grid ? "Switch to list view" : "Switch to grid view",
                keywords: ["toggle grid list", "layout", "view mode"],
                iconHtml: actionIcon(grid ? "list" : "grid"),
                run: runAndClose(() => hooks.setViewMode(grid ? "list" : "grid")),
            },
            {
                id: "action:sort",
                group: "actions",
                label: "Sort by…",
                keywords: ["order", "arrange"],
                iconHtml: actionIcon("sort"),
                meta: hooks.getSortOptions().find((option) => option.value === hooks.getSort())?.label,
                run: () => enterMode("sort"),
            },
            {
                id: "action:theme",
                group: "actions",
                label: dark ? "Switch to light mode" : "Switch to dark mode",
                keywords: ["theme", "dark mode", "light mode", "appearance"],
                iconHtml: actionIcon(dark ? "sun" : "moon"),
                run: runAndClose(clickSidebarButton("themeToggle")),
            },
            { id: "action:home", group: "actions", label: "Go to All files", keywords: ["home", "root", "top level"], iconHtml: actionIcon("home"), run: runAndClose(() => hooks.goHome()) },
        ]
        if (document.getElementById("browserHistoryButton")) {
            actions.push({ id: "action:history", group: "actions", label: "Folder history", keywords: ["time machine", "versions", "past", "restore", "timeline"], iconHtml: actionIcon("history"), hint: "H", run: runAndClose(clickSidebarButton("browserHistoryButton")) })
        }
        if (inFolder) {
            actions.push({ id: "action:up", group: "actions", label: "Go up one level", keywords: ["parent folder", "back"], iconHtml: actionIcon("arrowUp"), hint: "⌫", run: runAndClose(() => hooks.goUp()) })
        }
        actions.push(
            {
                id: "action:migrate",
                group: "actions",
                label: "Migrate folder index",
                keywords: ["repair", "upgrade", "parent references"],
                iconHtml: actionIcon("wrench"),
                disabled: !!migrateButton?.disabled,
                run: runAndClose(clickSidebarButton("migrateDirectoryParentsButton")),
            },
            { id: "action:labels-export", group: "actions", label: "Export stars & tags", keywords: ["backup", "labels", "download"], iconHtml: actionIcon("download"), run: runAndClose(clickSidebarButton("labelsExportButton")) },
            { id: "action:labels-import", group: "actions", label: "Import stars & tags", keywords: ["restore", "labels", "backup"], iconHtml: actionIcon("upload"), run: runAndClose(clickSidebarButton("labelsImportButton")) },
            { id: "action:legacy", group: "actions", label: "Download by UFID (legacy)", keywords: ["ufid", "old download"], iconHtml: actionIcon("key"), run: runAndClose(clickSidebarButton("downloadFileLegacyButton")) },
            { id: "action:logout", group: "actions", label: "Log out", keywords: ["sign out", "exit"], iconHtml: actionIcon("logout"), run: runAndClose(clickSidebarButton("logoutButton")) },
        )
        // Keyboard users get the cheat sheet up front; on touch screens it stays reachable but last.
        const shortcuts: PaletteItem = { id: "action:shortcuts", group: "actions", label: "Keyboard shortcuts", keywords: ["help", "keys", "hotkeys", "cheat sheet"], iconHtml: actionIcon("keyboard"), hint: "?", run: runAndClose(() => openShortcutsSheet()) }
        const touchOnly = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches
        if (touchOnly) actions.push(shortcuts)
        else actions.splice(actions.findIndex((item) => item.id === "action:migrate"), 0, shortcuts)
        return actions
    }

    const sortItems = (): PaletteItem[] => {
        const current = hooks.getSort()
        return hooks.getSortOptions().map((option) => ({
            id: `sort:${option.value}`,
            group: "sort",
            label: option.label,
            keywords: ["sort by", "order"],
            iconHtml: actionIcon("sort"),
            checked: option.value === current,
            run: runAndClose(() => hooks.setSort(option.value)),
        }))
    }

    const selectionItems = (): { title: string; detail: string; items: PaletteItem[] } => {
        const selection = hooks.getSelection()
        if (selection.count === 0) return { title: "", detail: "", items: [] }
        return {
            title: "Selection",
            detail: selection.label,
            items: selection.actions.map((action: HookAction) => ({
                id: `selection:${action.key}`,
                group: "selection" as const,
                label: action.label,
                iconHtml: actionIcon(action.icon, action.danger),
                hint: action.hint,
                danger: action.danger,
                disabled: action.disabled,
                run: runAndClose(action.run),
            })),
        }
    }

    const folderItem = (record: HookFolderRecord, group: GroupId = "folders"): PaletteItem => ({
        id: `folder:${record.data.folderId}`,
        group,
        label: record.data.name,
        iconHtml: fileKindIcon("folder"),
        location: { folderId: record.data.parentFolderId ?? TGLFS_ROOT_PARENT_ID },
        run: runAndClose(() => hooks.openFolder(record)),
    })

    const fileItem = (record: HookFileRecord): PaletteItem => ({
        id: `file:${record.msgId}`,
        group: "files",
        label: record.data.name,
        iconHtml: fileKindIcon(fileKindForName(record.data.name)),
        location: { folderId: fileParentId(record.data), suffix: ` · ${formatStorageBytes(record.data.size)}` },
        run: runAndClose(() => revealFile({
            msgId: record.msgId,
            ufid: record.data.ufid,
            name: record.data.name,
            parentFolderId: fileParentId(record.data),
        })),
    })

    const recentItem = (recent: RecentItem): PaletteItem => {
        if (recent.kind === "folder") {
            return {
                id: `recent:${recentItemKey(recent)}`,
                group: "recent",
                label: recent.name,
                iconHtml: fileKindIcon("folder"),
                location: { folderId: recent.folderId, dropLast: true },
                run: runAndClose(async () => {
                    const opened = await hooks.openFolderById(recent.folderId)
                    if (!opened) {
                        forgetRecentItem(recentItemKey(recent))
                        showToast(`“${recent.name}” no longer exists`, { tone: "error" })
                    }
                }),
            }
        }
        return {
            id: `recent:${recentItemKey(recent)}`,
            group: "recent",
            label: recent.name,
            iconHtml: fileKindIcon(fileKindForName(recent.name)),
            location: { folderId: recent.parentFolderId },
            run: runAndClose(() => revealFile(recent)),
        }
    }

    const revealFile = async (ref: { msgId: number; ufid: string; name: string; parentFolderId: string }) => {
        const found = await hooks.revealFile(ref)
        if (!found) {
            forgetRecentItem(`file:${ref.ufid}`)
            showToast(`“${ref.name}” couldn't be found`, { tone: "error" })
            return
        }
        rememberRecentItem({ kind: "file", msgId: ref.msgId, ufid: ref.ufid, name: ref.name, parentFolderId: ref.parentFolderId, at: Date.now() })
    }

    /* ------------------------------------------------------------ Build */

    type Section = { group: GroupId; title: string; detail?: string; items: PaletteItem[]; loading?: boolean }

    const buildSections = (query: string): Section[] => {
        const trimmed = query.trim()
        if (mode === "sort") {
            const ranked = trimmed ? rankFuzzy(trimmed, sortItems(), (item) => [item.label, ...(item.keywords ?? [])]) : null
            const sorted = ranked ? ranked.map(({ item, match }) => ({ ...item, match })) : sortItems()
            return [{ group: "sort", title: GROUP_TITLES.sort, items: sorted }]
        }

        const selection = selectionItems()
        const sections: Section[] = []
        if (!trimmed) {
            if (selection.items.length) sections.push({ group: "selection", title: selection.title, detail: selection.detail, items: selection.items })
            const recents = loadRecentItems()
            if (recents.length) sections.push({ group: "recent", title: GROUP_TITLES.recent, items: recents.map(recentItem) })
            sections.push({ group: "actions", title: GROUP_TITLES.actions, items: baseActions() })
            return sections
        }

        const textsOf = (item: PaletteItem) => [item.label, ...(item.keywords ?? [])]
        const withMatch = (ranked: ReturnType<typeof rankFuzzy<PaletteItem>>) => ranked.map(({ item, match }) => ({ ...item, match }))
        if (selection.items.length) {
            const ranked = withMatch(rankFuzzy(trimmed, selection.items, textsOf))
            if (ranked.length) sections.push({ group: "selection", title: selection.title, detail: selection.detail, items: ranked })
        }

        // Individual sort orders are reachable directly ("sort name") as well as through "Sort by…".
        const actionPool = [...baseActions().filter((item) => item.id !== "action:sort"), ...sortItems().map((item) => ({
            ...item,
            group: "actions" as const,
            label: `Sort: ${item.label}`,
            meta: item.checked ? "Current" : undefined,
            checked: false,
        }))]
        const actions = withMatch(rankFuzzy(trimmed, actionPool, textsOf, { limit: MAX_ACTIONS }))

        const knownFolders: TglfsFolder[] = hooks.getKnownFolders().filter((folder) => !folder.deleted)
        const folderRecords = new Map<string, HookFolderRecord>()
        for (const folder of knownFolders) folderRecords.set(folder.folderId, { msgId: 0, date: 0, data: folder })
        if (remote.query === trimmed) {
            for (const record of remote.folders) if (!record.data.deleted) folderRecords.set(record.data.folderId, record)
        }
        const folders = rankFuzzy(trimmed, [...folderRecords.values()], (record) => record.data.name, { limit: MAX_FOLDERS })
            .map(({ item, match }) => ({ ...folderItem(item), match }))

        const remoteCurrent = remote.query === trimmed
        const files = remoteCurrent
            ? rankFuzzy(trimmed, remote.files, (record) => record.data.name, { limit: MAX_FILES })
                .map(({ item, match }) => ({ ...fileItem(item), match }))
            : []
        const filesLoading = trimmed.length >= REMOTE_MIN_QUERY && (!remoteCurrent || remote.loading)

        const ranked: Section[] = []
        if (actions.length) ranked.push({ group: "actions", title: GROUP_TITLES.actions, items: actions })
        if (folders.length) ranked.push({ group: "folders", title: GROUP_TITLES.folders, items: folders })
        if (files.length || filesLoading) ranked.push({ group: "files", title: GROUP_TITLES.files, items: files, loading: filesLoading })
        // Put the group holding the best match first so Enter does the obvious thing; ties keep this order.
        const best = (section: Section) => section.items[0]?.match?.score ?? -Infinity
        ranked.sort((a, b) => best(b) - best(a))
        sections.push(...ranked)

        sections.push({
            group: "search",
            title: "",
            items: [{
                id: "search:everywhere",
                group: "search",
                label: `Search everywhere for “${trimmed}”`,
                iconHtml: actionIcon("search"),
                subtitle: "Show all matching files and folders",
                run: runAndClose(() => hooks.searchEverywhere(trimmed)),
            }],
        })
        return sections
    }

    /* ----------------------------------------------------------- Render */

    const locationText = (item: PaletteItem, names: string[] | null) => {
        if (!item.location) return ""
        if (names === null) return "Folder no longer found"
        const trail = item.location.dropLast ? names.slice(0, -1) : names
        return `${item.location.prefix ?? ""}${formatLocation(trail)}${item.location.suffix ?? ""}`
    }

    const subtitleHtml = (item: PaletteItem, index: number) => {
        if (item.subtitle) return `<span class="fx-pal-sub">${escapeHtml(item.subtitle)}</span>`
        if (!item.location) return ""
        const cached = resolver.cached(item.location.folderId)
        if (cached !== undefined) return `<span class="fx-pal-sub">${escapeHtml(locationText(item, cached))}</span>`
        return `<span class="fx-pal-sub is-pending" data-pal-loc="${index}"><span class="fx-skel fx-skel-line"></span></span>`
    }

    const render = () => {
        if (!list || !input) return
        const sections = buildSections(input.value)
        items = sections.flatMap((section) => section.items)
        const selectable = items.filter((item) => !item.disabled)
        if (!activeChosen || !activeId || !selectable.some((item) => item.id === activeId)) {
            activeId = selectable[0]?.id ?? null
            activeChosen = false
        }

        let index = 0
        const html = sections.map((section) => {
            const rows = section.items.map((item) => {
                const itemIndex = index++
                const active = item.id === activeId
                const trailing = item.checked
                    ? `<span class="fx-pal-check">${icon("check")}</span>`
                    : item.hint ? `<kbd class="fx-pal-hint">${escapeHtml(item.hint)}</kbd>`
                    : item.meta ? `<span class="fx-pal-meta">${escapeHtml(item.meta)}</span>` : ""
                return `
                    <div class="fx-pal-item${active ? " is-active" : ""}${item.danger ? " is-danger" : ""}${item.disabled ? " is-disabled" : ""}"
                        role="option" id="fxPalOpt${itemIndex}" data-pal-index="${itemIndex}" aria-selected="${active}"
                        ${item.disabled ? 'aria-disabled="true"' : ""}>
                        ${item.iconHtml}
                        <span class="fx-pal-text">
                            <span class="fx-pal-label">${highlighted(item.label, item.match)}</span>
                            ${subtitleHtml(item, itemIndex)}
                        </span>
                        <span class="fx-pal-trail">${trailing}<span class="fx-pal-enter" aria-hidden="true">${icon("cornerDownLeft")}</span></span>
                    </div>`
            }).join("")
            const loading = section.loading
                ? `<div class="fx-pal-loading"><span class="fx-spinner fx-spinner--sm" aria-hidden="true"></span>${section.items.length ? "Looking for more…" : "Searching all folders…"}</div>`
                : ""
            const title = section.title
                ? `<div class="fx-pal-group-title" role="presentation">${escapeHtml(section.title)}${section.detail
                    ? `<span class="fx-pal-group-detail">${escapeHtml(section.detail)}</span>`
                    : ""}</div>`
                : `<div class="fx-pal-divider" role="presentation"></div>`
            return `<div class="fx-pal-group" role="group" data-group="${section.group}">${title}${rows}${loading}</div>`
        }).join("")

        const query = input.value.trim()
        list.innerHTML = html || `<div class="fx-pal-empty">${escapeHtml(query ? `Nothing matches “${query}”` : "Nothing here yet")}</div>`
        if (remote.failed && remote.query === query && query) {
            list.insertAdjacentHTML("beforeend", `<div class="fx-pal-note">${icon("alert")}Couldn't search Telegram right now.</div>`)
        }
        syncActive(false)
        hydrateLocations()
    }

    const hydrateLocations = () => {
        if (!list) return
        list.querySelectorAll<HTMLElement>("[data-pal-loc]").forEach((element) => {
            const item = items[Number(element.dataset.palLoc)]
            if (!item?.location) return
            const expectedId = item.id
            void resolver.trail(item.location.folderId).then((names) => {
                if (!element.isConnected || items[Number(element.dataset.palLoc)]?.id !== expectedId) return
                element.classList.remove("is-pending")
                element.textContent = locationText(item, names)
            })
        })
    }

    const syncActive = (scroll: boolean) => {
        if (!list || !input) return
        let activeElement: HTMLElement | null = null
        list.querySelectorAll<HTMLElement>("[data-pal-index]").forEach((element) => {
            const active = items[Number(element.dataset.palIndex)]?.id === activeId
            element.classList.toggle("is-active", active)
            element.setAttribute("aria-selected", String(active))
            if (active) activeElement = element
        })
        if (activeElement) {
            input.setAttribute("aria-activedescendant", (activeElement as HTMLElement).id)
            if (scroll) (activeElement as HTMLElement).scrollIntoView({ block: "nearest" })
        } else {
            input.removeAttribute("aria-activedescendant")
        }
    }

    const moveActive = (delta: number) => {
        const selectable = items.filter((item) => !item.disabled)
        if (selectable.length === 0) return
        const current = selectable.findIndex((item) => item.id === activeId)
        const next = current === -1 ? 0 : (current + delta + selectable.length) % selectable.length
        activeId = selectable[next].id
        activeChosen = true
        syncActive(true)
    }

    const runItem = (item: PaletteItem | undefined) => {
        if (!item || item.disabled) return
        void Promise.resolve()
            .then(() => item.run())
            .catch((error) => {
                console.error(error)
                showToast("That didn't work. Try again.", { tone: "error" })
            })
    }

    /* ----------------------------------------------------------- Remote */

    const scheduleRemote = () => {
        window.clearTimeout(remoteTimer)
        const query = input?.value.trim() ?? ""
        if (mode !== "root" || query.length < REMOTE_MIN_QUERY) {
            remote = { query, folders: [], files: [], loading: false, failed: false }
            return
        }
        if (remote.query === query && !remote.loading) return
        remoteTimer = window.setTimeout(() => void runRemote(query), REMOTE_DEBOUNCE_MS)
    }

    const runRemote = async (query: string) => {
        const client = hooks.getClient()
        if (!client) return
        const seq = ++remoteSeq
        remote = { query, folders: [], files: [], loading: true, failed: false }
        render()
        const [folders, files] = await Promise.all([
            listFolderRecords(client, { query, limit: REMOTE_LIMIT }).catch((error) => {
                console.warn("Palette folder search failed", error)
                return null
            }),
            listFileCards(client, { query, limit: REMOTE_LIMIT }).catch((error) => {
                console.warn("Palette file search failed", error)
                return null
            }),
        ])
        if (seq !== remoteSeq || !isOpen()) return
        remote = { query, folders: folders ?? [], files: files ?? [], loading: false, failed: !folders || !files }
        render()
    }

    /* ------------------------------------------------------- Open/close */

    const enterMode = (next: "root" | "sort") => {
        mode = next
        activeId = null
        activeChosen = false
        if (input) {
            input.value = ""
            input.placeholder = next === "sort" ? "Sort by…" : placeholder()
            input.focus()
        }
        layer?.classList.toggle("is-submode", next !== "root")
        render()
    }

    const placeholder = () => isCompactViewport() ? "Search files, folders, actions" : "Search files, folders and actions…"

    function open(initialQuery = "") {
        if (layer) {
            input?.focus()
            return
        }
        if (!hooks.isBrowserVisible()) return
        previouslyFocused = document.activeElement as HTMLElement | null
        mode = "root"
        activeId = null
        resolver.clear()
        remote = { query: "", folders: [], files: [], loading: false, failed: false }

        const modKey = isApplePlatform() ? "⌘" : "Ctrl"
        layer = document.createElement("div")
        layer.className = "fx-palette-layer"
        layer.innerHTML = `
            <div class="fx-palette" role="dialog" aria-modal="true" aria-label="Command palette">
                <div class="fx-pal-head">
                    <span class="fx-pal-search-icon">${icon("search")}</span>
                    <button type="button" class="fx-pal-back" aria-label="Back" title="Back">${icon("chevronLeft")}</button>
                    <input class="fx-pal-input" type="text" role="combobox" aria-expanded="true" aria-controls="fxPalList"
                        aria-autocomplete="list" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" />
                    <kbd class="fx-pal-esc">esc</kbd>
                    <button type="button" class="fx-pal-cancel">Cancel</button>
                </div>
                <div id="fxPalList" class="fx-pal-list" role="listbox" aria-label="Results"></div>
                <div class="fx-pal-foot" aria-hidden="true">
                    <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                    <span><kbd>↵</kbd> open</span>
                    <span><kbd>esc</kbd> close</span>
                    <span class="fx-pal-foot-spacer"></span>
                    <span><kbd>${modKey}</kbd><kbd>K</kbd> palette · <kbd>?</kbd> shortcuts</span>
                </div>
            </div>`
        document.body.appendChild(layer)
        input = layer.querySelector<HTMLInputElement>(".fx-pal-input")
        list = layer.querySelector<HTMLElement>(".fx-pal-list")
        input!.placeholder = placeholder()
        input!.value = initialQuery
        requestAnimationFrame(() => layer?.classList.add("is-open"))

        input!.addEventListener("input", () => {
            activeId = null
            activeChosen = false
            render()
            scheduleRemote()
        })
        input!.addEventListener("keydown", onInputKey)
        layer.addEventListener("mousedown", (event) => {
            if (event.target === layer) {
                event.preventDefault()
                close()
            }
        })
        layer.querySelector(".fx-pal-cancel")?.addEventListener("click", () => close())
        layer.querySelector(".fx-pal-back")?.addEventListener("click", () => enterMode("root"))
        list!.addEventListener("pointermove", (event) => {
            // Touch drags scroll the list; only a mouse moves the highlight.
            if (event.pointerType !== "mouse") return
            const row = (event.target as HTMLElement).closest<HTMLElement>("[data-pal-index]")
            const item = row ? items[Number(row.dataset.palIndex)] : undefined
            if (!item || item.disabled || item.id === activeId) return
            activeId = item.id
            activeChosen = true
            syncActive(false)
        })
        list!.addEventListener("mousedown", (event) => event.preventDefault())
        list!.addEventListener("click", (event) => {
            const row = (event.target as HTMLElement).closest<HTMLElement>("[data-pal-index]")
            if (row) runItem(items[Number(row.dataset.palIndex)])
        })
        render()
        scheduleRemote()
        input!.focus()
        if (initialQuery) input!.select()
    }

    function onInputKey(event: KeyboardEvent) {
        if (event.isComposing) return
        const mod = event.metaKey || event.ctrlKey
        if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey) || (event.ctrlKey && event.key === "n")) {
            event.preventDefault()
            moveActive(1)
        } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) || (event.ctrlKey && event.key === "p")) {
            event.preventDefault()
            moveActive(-1)
        } else if (event.key === "Enter") {
            // Keep Enter away from the browser's own shortcut handler (it would open the selected item).
            event.preventDefault()
            event.stopPropagation()
            runItem(items.find((item) => item.id === activeId))
        } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            if (mode !== "root") enterMode("root")
            else close()
        } else if (event.key === "Backspace" && mode !== "root" && input?.value === "") {
            event.preventDefault()
            enterMode("root")
        } else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
            event.preventDefault()
            event.stopPropagation()
            close()
        }
    }

    function close(options: { restoreFocus?: boolean } = {}) {
        if (!layer) return
        const closing = layer
        layer = null
        input = null
        list = null
        window.clearTimeout(remoteTimer)
        remoteSeq++
        closing.classList.remove("is-open")
        closing.classList.add("is-closing")
        window.setTimeout(() => closing.remove(), 160)
        const restore = options.restoreFocus ?? true
        const focused = document.activeElement
        if (restore && previouslyFocused && document.contains(previouslyFocused) && previouslyFocused.id !== "paletteButton") {
            previouslyFocused.focus({ preventScroll: true })
        } else if (focused instanceof HTMLElement && (closing.contains(focused) || focused.id === "paletteButton")) {
            focused.blur()
        }
        previouslyFocused = null
    }

    return {
        open,
        close: () => close(),
        toggle: () => (isOpen() ? close() : open()),
        isOpen,
    }
}
