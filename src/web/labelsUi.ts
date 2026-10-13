// Stars & tags UI: sidebar section, row/tile decorations, the tag editor, "Manage tags", export/import and the
// resolution of labelled items for the Starred / tag views. Labels live only on this device (see labels.ts).
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import type { TglfsFolderRecord } from "../../packages/tglfs-cli/src/folders"
import { getFileCardByUfid, getFolderRecord } from "../telegram"
import type { FileCardData } from "../types/models"
import { escapeHtml, isCompactViewport, showToast } from "./dialogs"
import { icon } from "./icons"
import {
    TAG_COLORS,
    applyTagChanges,
    createLabelStore,
    createTag,
    deleteTag,
    findTagByName,
    forgetItems,
    getItem,
    isStarred,
    itemTagIds,
    keysWithTag,
    listTags,
    mergeImportedLabels,
    normalizeTagName,
    parseLabelItemKey,
    recolorTag,
    renameTag,
    setStarred,
    starredKeys,
    tagNameKey,
    updateNameHints,
    type ItemRef,
    type LabelStore,
    type TagColor,
    type TagSummary,
} from "./labels"

export type VirtualView = { kind: "starred" } | { kind: "tag"; tagId: string }

export type LabelsHost = {
    /** Opens the Starred view or a tag view (pushes history). */
    openView: (view: VirtualView) => void
    /** The virtual view currently shown, if any. */
    currentView: () => VirtualView | null
    /** Called after any label change (local or from another tab). */
    onChange: (popKeys: Set<string>) => void
}

const ACCOUNT_HINT_KEY = "tglfs.labels.account-hint"
const SIDEBAR_TAG_LIMIT = 8

let host: LabelsHost | null = null
let store: LabelStore | null = null
let storeUnsubscribe: (() => void) | null = null
let readyResolve: (() => void) | null = null
let readyPromise: Promise<void> = new Promise((resolve) => (readyResolve = resolve))
let pendingPopKeys = new Set<string>()
let showAllSidebarTags = false

/* ----------------------------------------------------------- Account */

function browserStorage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage
    } catch {
        return null
    }
}

function phoneAccountKey(phone: unknown) {
    if (typeof phone !== "string" || phone.trim() === "") return null
    const digits = phone.replace(/\D/g, "")
    return digits ? `phone:${digits}` : `phone:${phone.trim().toLowerCase()}`
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("timeout")), ms)),
    ])
}

/**
 * Labels are stored per Telegram account. The key is the Telegram user id when the client can tell us
 * (stable across phone-number changes and login methods); the mock client and offline fallbacks use the phone.
 */
async function resolveAccountKey(client: any, config: any): Promise<string> {
    const phoneKey = phoneAccountKey(config?.phone)
    const storage = browserStorage()
    if (typeof client?.getMe === "function") {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const me = await withTimeout(Promise.resolve(client.getMe()), 6000)
                const id = (me as { id?: unknown } | null)?.id
                if (id !== undefined && id !== null && String(id) !== "") {
                    const key = `user:${String(id)}`
                    try {
                        storage?.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ phone: phoneKey, key }))
                    } catch {}
                    return key
                }
                break
            } catch (error) {
                console.warn("Unable to identify the Telegram account for stars and tags", error)
                await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)))
            }
        }
        try {
            const hint = JSON.parse(storage?.getItem(ACCOUNT_HINT_KEY) ?? "null")
            if (hint && typeof hint.key === "string" && (!phoneKey || hint.phone === phoneKey)) return hint.key
        } catch {}
    }
    return phoneKey ?? "default"
}

export async function setLabelsAccount(client: any, config: any) {
    const accountKey = await resolveAccountKey(client, config)
    if (store?.accountKey === accountKey) return
    storeUnsubscribe?.()
    if (store) {
        // Switching accounts: anything waiting for labels should wait for the new store.
        readyPromise = new Promise((resolve) => (readyResolve = resolve))
    }
    store = createLabelStore({ storage: browserStorage(), accountKey })
    storeUnsubscribe = store.subscribe(() => notifyChanged())
    const notice = store.takeNotice()
    if (notice) showToast(notice, { tone: store.status() === "ok" ? "default" : "error", durationMs: 8000 })
    readyResolve?.()
    notifyChanged()
}

export function labelsReady() {
    return readyPromise
}

function notifyChanged() {
    const popKeys = pendingPopKeys
    pendingPopKeys = new Set()
    renderLabelsSidebar()
    host?.onChange(popKeys)
}

/** Explains why labels can't be changed right now; returns false when they can't. */
function ensureWritable(): boolean {
    if (!store) {
        showToast("Stars and tags are still loading…")
        return false
    }
    if (store.status() !== "ok") {
        showToast("Stars and tags on this device were saved by a newer version of TGLFS and can't be changed here.", { tone: "error", durationMs: 6000 })
        return false
    }
    return true
}

/* ------------------------------------------------------------- Queries */

export function labelKeyFor(kind: "file" | "folder", id: string) {
    return `${kind}:${id}`
}

export function isLabelStarred(key: string) {
    return !!store && isStarred(store.doc(), key)
}

export function labelTagsFor(key: string): TagSummary[] {
    if (!store) return []
    const doc = store.doc()
    const all = new Map(listTags(doc).map((tag) => [tag.id, tag]))
    return itemTagIds(doc, key).map((id) => all.get(id)).filter((tag): tag is TagSummary => !!tag)
}

export function getTag(id: string): TagSummary | null {
    return store ? listTags(store.doc()).find((tag) => tag.id === id) ?? null : null
}

export function findTagIdByName(name: string): string | null {
    return store ? findTagByName(store.doc(), name) : null
}

export function labelNameHint(key: string) {
    return store ? getItem(store.doc(), key)?.name ?? null : null
}

export function viewKeys(view: VirtualView): string[] {
    if (!store) return []
    return view.kind === "starred" ? starredKeys(store.doc()) : keysWithTag(store.doc(), view.tagId)
}

export function viewMatches(view: VirtualView, key: string) {
    if (!store) return false
    return view.kind === "starred" ? isStarred(store.doc(), key) : itemTagIds(store.doc(), key).includes(view.tagId)
}

export function sameView(a: VirtualView | null, b: VirtualView | null) {
    if (!a || !b) return a === b
    return a.kind === b.kind && (a.kind === "starred" || a.tagId === (b as { tagId: string }).tagId)
}

export function viewTitle(view: VirtualView) {
    if (view.kind === "starred") return "Starred"
    return getTag(view.tagId)?.name ?? "Tag"
}

/* ---------------------------------------------------------- Mutations */

/** Stars or unstars items. Returns the new state, or null when nothing changed. */
export function setItemsStarred(refs: ItemRef[], starred: boolean): boolean | null {
    if (refs.length === 0 || !ensureWritable() || !store) return null
    if (starred) for (const ref of refs) if (!isStarred(store.doc(), ref.key)) pendingPopKeys.add(ref.key)
    store.update((doc, now) => setStarred(doc, refs, starred, now))
    return starred
}

/** Star when any item is unstarred, otherwise unstar (Gmail-style). */
export function toggleItemsStarred(refs: ItemRef[]): boolean | null {
    if (!store) return setItemsStarred(refs, true)
    const allStarred = refs.length > 0 && refs.every((ref) => isStarred(store!.doc(), ref.key))
    return setItemsStarred(refs, !allStarred)
}

export function allStarred(keys: string[]) {
    return !!store && keys.length > 0 && keys.every((key) => isStarred(store!.doc(), key))
}

export function removeTagFromItems(refs: ItemRef[], tagId: string) {
    if (!ensureWritable() || !store) return
    store.update((doc, now) => applyTagChanges(doc, refs, { remove: [tagId] }, now))
}

export function addTagToItems(refs: ItemRef[], tagId: string) {
    if (!ensureWritable() || !store) return
    store.update((doc, now) => applyTagChanges(doc, refs, { add: [tagId] }, now))
}

/** Drops every label of items that no longer exist (after a committed delete, or for stale entries). */
export function forgetLabels(keys: string[]) {
    if (!store || store.status() !== "ok" || keys.length === 0) return
    if (!keys.some((key) => store!.doc().items[key] !== undefined)) return
    store.update((doc, now) => forgetItems(doc, keys, now))
}

export function rememberNameHints(hints: Map<string, string>) {
    if (!store || store.status() !== "ok" || hints.size === 0) return
    const doc = store.doc()
    if (updateNameHints(doc, hints) === doc) return
    store.update((current) => updateNameHints(current, hints))
}

/* -------------------------------------------------------- Decorations */

const MAX_ROW_CHIPS = 2

function chipHtml(tag: TagSummary) {
    return `<span class="fx-chip" data-color="${tag.color}" title="${escapeHtml(tag.name)}"><span class="fx-tag-dot"></span><span class="fx-chip-name">${escapeHtml(tag.name)}</span></span>`
}

export function chipsHtml(tags: TagSummary[], max = MAX_ROW_CHIPS) {
    if (tags.length === 0) return ""
    const shown = tags.slice(0, max)
    const rest = tags.slice(max)
    const more = rest.length
        ? `<span class="fx-chip fx-chip--more" title="${escapeHtml(rest.map((tag) => tag.name).join(", "))}">+${rest.length}</span>`
        : ""
    return `<span class="fx-chips">${shown.map(chipHtml).join("")}${more}</span>`
}

function starHtml(key: string) {
    return `<span class="fx-star${pendingPopKeys.has(key) ? " is-popping" : ""}" title="Starred" role="img" aria-label="Starred">${icon("star")}</span>`
}

export type LabelSlot = "inline" | "sub" | "tile-star" | "tile-tags"

/** Inner HTML for one decoration slot of a row or tile. */
export function labelSlotHtml(key: string | null, slot: LabelSlot) {
    if (!key || !store) return ""
    switch (slot) {
        case "inline":
            return `${isLabelStarred(key) ? starHtml(key) : ""}${chipsHtml(labelTagsFor(key))}`
        case "sub":
            return chipsHtml(labelTagsFor(key))
        case "tile-star":
            return isLabelStarred(key) ? starHtml(key) : ""
        case "tile-tags":
            return chipsHtml(labelTagsFor(key))
    }
}

/** Re-renders decorations in place (no full list re-render), animating newly starred items. */
export function refreshLabelDecorations(popKeys: Set<string> = new Set()) {
    document.querySelectorAll<HTMLElement>("[data-label-key]").forEach((node) => {
        const key = node.dataset.labelKey ?? ""
        node.querySelectorAll<HTMLElement>("[data-labels-slot]").forEach((slot) => {
            const html = labelSlotHtml(key, slot.dataset.labelsSlot as LabelSlot)
            if (slot.innerHTML !== html) slot.innerHTML = html
            const star = slot.querySelector<HTMLElement>(".fx-star")
            if (star && popKeys.has(key)) {
                star.classList.remove("is-popping")
                void star.offsetWidth
                star.classList.add("is-popping")
            }
        })
        node.classList.toggle("is-starred", isLabelStarred(key))
    })
}

/* ------------------------------------------------------------- Sidebar */

function tagNavButton(tag: TagSummary, active: boolean) {
    return `<button type="button" class="fx-nav-item fx-tag-nav${active ? " is-active" : ""}" data-tag-id="${escapeHtml(tag.id)}" title="${escapeHtml(tag.name)}">
        <span class="fx-tag-dot" data-color="${tag.color}"></span><span class="fx-nav-label">${escapeHtml(tag.name)}</span>
        <span class="fx-nav-count">${tag.count || ""}</span></button>`
}

export function renderLabelsSidebar() {
    const view = host?.currentView() ?? null
    const starredButton = document.getElementById("navStarred")
    starredButton?.classList.toggle("is-active", view?.kind === "starred")
    const starredCount = document.getElementById("navStarredCount")
    if (starredCount) {
        const count = store ? starredKeys(store.doc()).length : 0
        starredCount.textContent = count ? String(count) : ""
    }
    const list = document.getElementById("navTags")
    if (!list) return
    const tags = store ? listTags(store.doc()) : []
    const activeTagId = view?.kind === "tag" ? view.tagId : null
    const limit = showAllSidebarTags ? tags.length : SIDEBAR_TAG_LIMIT
    // Keep the active tag visible even when it falls beyond the collapsed limit.
    const visible = tags.filter((tag, index) => index < limit || tag.id === activeTagId)
    const hidden = tags.length - visible.length
    list.innerHTML = `
        ${tags.length === 0 ? `<p class="fx-nav-empty">Select items and choose Tags… to organize them.</p>` : visible.map((tag) => tagNavButton(tag, tag.id === activeTagId)).join("")}
        ${hidden > 0 ? `<button type="button" class="fx-nav-item fx-nav-more" data-tags-more>${icon("chevronDown")}<span class="fx-nav-label">${hidden} more</span></button>` : ""}
        ${showAllSidebarTags && tags.length > SIDEBAR_TAG_LIMIT ? `<button type="button" class="fx-nav-item fx-nav-more" data-tags-less>${icon("chevronUp")}<span class="fx-nav-label">Show less</span></button>` : ""}
        <button type="button" id="navManageTags" class="fx-nav-item" data-manage-tags>${icon("sliders")}<span class="fx-nav-label">Manage tags</span></button>`
}

/* --------------------------------------------------------- Dialog base */

type MountedDialog = { backdrop: HTMLElement; dialog: HTMLElement; close: () => void }

function mountLabelsDialog(inner: string, options: { className?: string; onDismiss: () => void }): MountedDialog {
    const backdrop = document.createElement("div")
    const sheet = isCompactViewport()
    backdrop.className = `fx-dialog-backdrop fx-labels-backdrop${sheet ? " is-sheet" : ""}`
    backdrop.innerHTML = `<div class="fx-dialog ${options.className ?? ""}" role="dialog" aria-modal="true" aria-labelledby="fxDialogTitle">${sheet ? `<div class="fx-sheet-grip fx-dialog-grip" aria-hidden="true"></div>` : ""}${inner}</div>`
    const previouslyFocused = document.activeElement as HTMLElement | null
    document.body.appendChild(backdrop)
    requestAnimationFrame(() => backdrop.classList.add("is-open"))
    backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) options.onDismiss()
    })
    const close = () => {
        backdrop.classList.remove("is-open")
        backdrop.classList.add("is-closing")
        window.setTimeout(() => backdrop.remove(), sheet ? 200 : 0)
        previouslyFocused?.focus?.({ preventScroll: true })
    }
    return { backdrop, dialog: backdrop.querySelector<HTMLElement>(".fx-dialog")!, close }
}

function dialogHead(title: string, subtitle: string, iconName: "tag" | "sliders") {
    return `
        <div class="fx-dialog-head">
            <span class="fx-dialog-icon">${icon(iconName)}</span>
            <div class="fx-dialog-titles">
                <h2 id="fxDialogTitle">${escapeHtml(title)}</h2>
                ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
            </div>
        </div>`
}

function randomTagId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `tag-${crypto.randomUUID().slice(0, 8)}`
    return `tag-${Math.random().toString(36).slice(2, 10)}`
}

/* ---------------------------------------------------------- Tag editor */

type TagState = "all" | "some" | "none"
type DraftTag = { id: string; name: string; color: TagColor; isNew: boolean; count: number }

/** Opens the tag editor for one or more items. Changes apply to the whole selection on "Done". */
export function openTagEditor(refs: ItemRef[], subtitle: string) {
    if (refs.length === 0 || !ensureWritable() || !store) return
    const labelStore = store
    const doc = labelStore.doc()
    const draftTags: DraftTag[] = listTags(doc).map((tag) => ({ ...tag, isNew: false }))
    const initial = new Map<string, TagState>()
    for (const tag of draftTags) {
        const having = refs.filter((ref) => itemTagIds(doc, ref.key).includes(tag.id)).length
        initial.set(tag.id, having === 0 ? "none" : having === refs.length ? "all" : "some")
    }
    const states = new Map(initial)
    let highlight = 0
    let arrowed = false
    let settled = false

    const mounted = mountLabelsDialog(`
        ${dialogHead("Tags", subtitle, "tag")}
        <div class="fx-tagbox" data-tagbox>
            <span class="fx-tagbox-chips" data-chips></span>
            <input class="fx-tagbox-input" data-tag-input type="text" placeholder="Add a tag…" autocomplete="off"
                autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Add a tag" maxlength="48"
                role="combobox" aria-expanded="true" aria-controls="fxTagSuggest" aria-autocomplete="list" />
        </div>
        <div class="fx-tag-suggest" id="fxTagSuggest" role="listbox" aria-label="Tags" data-suggest></div>
        <div class="fx-dialog-actions fx-tag-actions">
            <button type="button" class="fx-link fx-tag-manage" data-open-manage>${icon("sliders")}Manage tags</button>
            <span class="fx-tag-actions-spacer"></span>
            <button type="button" class="fx-btn fx-btn-ghost" data-dialog-cancel>Cancel</button>
            <button type="button" class="fx-btn fx-btn-primary" data-dialog-confirm>Done</button>
        </div>`, { className: "fx-tag-dialog", onDismiss: () => finish(false) })
    const { backdrop } = mounted
    const input = backdrop.querySelector<HTMLInputElement>("[data-tag-input]")!
    const chips = backdrop.querySelector<HTMLElement>("[data-chips]")!
    const suggest = backdrop.querySelector<HTMLElement>("[data-suggest]")!

    const query = () => normalizeTagName(input.value) ?? ""
    const matches = () => {
        const q = query().toLocaleLowerCase()
        return draftTags.filter((tag) => !q || tag.name.toLocaleLowerCase().includes(q))
    }
    const exactMatch = () => {
        const q = query()
        return q ? draftTags.find((tag) => tagNameKey(tag.name) === tagNameKey(q)) ?? null : null
    }
    type Option = { kind: "tag"; tag: DraftTag } | { kind: "create"; name: string }
    const options = (): Option[] => {
        const list: Option[] = matches().map((tag) => ({ kind: "tag", tag }))
        const q = query()
        if (q && !exactMatch()) list.unshift({ kind: "create", name: q })
        return list
    }

    const render = () => {
        const applied = draftTags.filter((tag) => states.get(tag.id) === "all" || states.get(tag.id) === "some")
        chips.innerHTML = applied.map((tag) => {
            const mixed = states.get(tag.id) === "some"
            return `<span class="fx-chip fx-chip--edit${mixed ? " is-mixed" : ""}" data-color="${tag.color}" data-chip-id="${escapeHtml(tag.id)}"
                    title="${mixed ? `On some of the selected items — click to add to all` : escapeHtml(tag.name)}">
                    <span class="fx-tag-dot"></span><span class="fx-chip-name">${escapeHtml(tag.name)}</span>${mixed ? `<span class="fx-chip-mixed" aria-label="on some items">–</span>` : ""}
                    <button type="button" class="fx-chip-x" data-chip-remove="${escapeHtml(tag.id)}" aria-label="Remove ${escapeHtml(tag.name)}">${icon("close")}</button>
                </span>`
        }).join("")
        input.placeholder = applied.length ? "Add another…" : draftTags.length ? "Add a tag…" : "Name a new tag…"
        const list = options()
        highlight = Math.max(0, Math.min(highlight, list.length - 1))
        const isActive = (index: number) => (arrowed || !!query()) && index === highlight
        suggest.innerHTML = list.length
            ? list.map((option, index) => {
                if (option.kind === "create") {
                    return `<button type="button" class="fx-tag-option is-create${isActive(index) ? " is-active" : ""}" role="option" data-option="${index}" aria-selected="${isActive(index)}">
                        <span class="fx-tag-option-lead">${icon("plus")}</span><span class="fx-tag-option-name">Create “${escapeHtml(option.name)}”</span></button>`
                }
                const state = states.get(option.tag.id) ?? "none"
                return `<button type="button" class="fx-tag-option${isActive(index) ? " is-active" : ""}" role="option" data-option="${index}" aria-selected="${isActive(index)}" aria-checked="${state === "all" ? "true" : state === "some" ? "mixed" : "false"}">
                    <span class="fx-tag-option-lead"><span class="fx-tag-dot" data-color="${option.tag.color}"></span></span>
                    <span class="fx-tag-option-name">${escapeHtml(option.tag.name)}</span>
                    ${option.tag.isNew ? `<span class="fx-tag-option-meta">new</span>` : option.tag.count ? `<span class="fx-tag-option-meta">${option.tag.count}</span>` : ""}
                    <span class="fx-check" role="presentation" aria-checked="${state === "all" ? "true" : state === "some" ? "mixed" : "false"}">${icon("check")}</span>
                </button>`
            }).join("")
            : `<div class="fx-tag-suggest-empty">${draftTags.length ? "No matching tags" : "Type a name to create your first tag"}</div>`
        suggest.querySelector(".is-active")?.scrollIntoView({ block: "nearest" })
    }

    const createDraft = (name: string) => {
        const existing = draftTags.find((tag) => tagNameKey(tag.name) === tagNameKey(name))
        if (existing) return existing
        const used = new Map<string, number>()
        for (const tag of draftTags) used.set(tag.color, (used.get(tag.color) ?? 0) + 1)
        const color = [...TAG_COLORS].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0]
        const draft: DraftTag = { id: `new:${draftTags.length}:${name}`, name, color, isNew: true, count: 0 }
        draftTags.push(draft)
        return draft
    }

    // Keep typing flow on desktop; on touch only keep the keyboard if it is already up.
    const touchLike = isCompactViewport() || window.matchMedia("(hover: none)").matches
    const refocus = () => {
        if (!touchLike || document.activeElement === input) input.focus({ preventScroll: true })
    }

    const activate = (option: Option | undefined) => {
        if (!option) return
        if (option.kind === "create") {
            const draft = createDraft(option.name)
            states.set(draft.id, "all")
        } else {
            const state = states.get(option.tag.id) ?? "none"
            states.set(option.tag.id, state === "all" ? "none" : "all")
        }
        if (input.value) {
            input.value = ""
            highlight = 0
        }
        render()
        refocus()
    }

    const finish = (apply: boolean) => {
        if (settled) return
        settled = true
        mounted.close()
        document.removeEventListener("keydown", onKey, true)
        if (!apply) return
        // Typed text that was never confirmed still counts, like a chip input on blur.
        const pending = query()
        if (pending) {
            const draft = createDraft(pending)
            if ((states.get(draft.id) ?? "none") === "none") states.set(draft.id, "all")
        }
        const changed = draftTags.filter((tag) => (states.get(tag.id) ?? "none") !== (initial.get(tag.id) ?? "none"))
        if (changed.length === 0) return
        labelStore.update((current, now) => {
            let next = current
            const add: string[] = []
            const remove: string[] = []
            for (const tag of changed) {
                const state = states.get(tag.id) ?? "none"
                let id = tag.id
                if (tag.isNew) {
                    if (state === "none") continue
                    const created = createTag(next, tag.name, { now, id: randomTagId(), color: tag.color })
                    if (!created) continue
                    next = created.doc
                    id = created.id
                }
                if (state === "all") add.push(id)
                if (state === "none") remove.push(id)
            }
            return applyTagChanges(next, refs, { add, remove }, now)
        })
    }

    const onKey = (event: KeyboardEvent) => {
        if (!backdrop.isConnected) return
        if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            if (input.value) {
                input.value = ""
                render()
            } else {
                finish(false)
            }
        }
    }
    document.addEventListener("keydown", onKey, true)

    input.addEventListener("input", () => {
        highlight = 0
        arrowed = false
        if (input.value.includes(",")) {
            const parts = input.value.split(",")
            input.value = parts.pop() ?? ""
            for (const part of parts) {
                const name = normalizeTagName(part)
                if (name) states.set(createDraft(name).id, "all")
            }
        }
        render()
    })
    input.addEventListener("keydown", (event) => {
        const list = options()
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            highlight = arrowed
                ? Math.max(0, Math.min(list.length - 1, highlight + (event.key === "ArrowDown" ? 1 : -1)))
                : 0
            arrowed = true
            render()
        } else if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault()
            // Enter picks the highlighted suggestion while typing; on an empty field it confirms the dialog.
            if (event.metaKey || event.ctrlKey || (!input.value.trim() && !arrowed)) {
                finish(true)
            } else {
                activate(list[highlight])
            }
        } else if (event.key === "Backspace" && !input.value) {
            const applied = draftTags.filter((tag) => (states.get(tag.id) ?? "none") !== "none")
            const last = applied[applied.length - 1]
            if (last) {
                event.preventDefault()
                states.set(last.id, "none")
                render()
            }
        }
    })
    suggest.addEventListener("mousedown", (event) => event.preventDefault())
    suggest.addEventListener("click", (event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>("[data-option]")
        if (!button) return
        highlight = Number(button.dataset.option)
        activate(options()[highlight])
    })
    // Clicking chips must not steal focus from the field (keeps the caret, and the phone keyboard, in place).
    chips.addEventListener("mousedown", (event) => event.preventDefault())
    chips.addEventListener("click", (event) => {
        const target = event.target as HTMLElement
        const removeId = target.closest<HTMLElement>("[data-chip-remove]")?.dataset.chipRemove
        if (removeId) {
            states.set(removeId, "none")
            render()
            refocus()
            return
        }
        const chipId = target.closest<HTMLElement>("[data-chip-id]")?.dataset.chipId
        if (chipId && states.get(chipId) === "some") {
            states.set(chipId, "all")
            render()
        }
        refocus()
    })
    backdrop.querySelector("[data-tagbox]")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) input.focus()
    })
    backdrop.querySelector("[data-dialog-cancel]")?.addEventListener("click", () => finish(false))
    backdrop.querySelector("[data-dialog-confirm]")?.addEventListener("click", () => finish(true))
    backdrop.querySelector("[data-open-manage]")?.addEventListener("click", () => {
        finish(true)
        openManageTags()
    })
    render()
    // On phones the tag list is the quick path; don't pop the keyboard over it until the field is tapped.
    if (touchLike) return
    // Focus right away (keystrokes typed while the dialog opens must not be lost) and again after layout.
    input.focus({ preventScroll: true })
    window.setTimeout(() => {
        if (document.activeElement !== input) input.focus({ preventScroll: true })
    }, 40)
}

/* ---------------------------------------------------------- Manage tags */

export function openManageTags() {
    if (!store) {
        showToast("Stars and tags are still loading…")
        return
    }
    const labelStore = store
    const readOnly = labelStore.status() !== "ok"
    let expanded: { id: string; mode: "color" | "rename" | "delete" } | null = null
    let renameError = ""
    let renameDraft: string | null = null
    let settled = false

    const mounted = mountLabelsDialog(`
        ${dialogHead("Manage tags", "Rename, recolor or delete tags. Deleting a tag removes it from every item.", "sliders")}
        <form class="fx-tagnew" data-new-form ${readOnly ? "hidden" : ""}>
            <input class="fx-input" data-new-input type="text" placeholder="New tag name" maxlength="48" autocomplete="off" aria-label="New tag name" />
            <button type="submit" class="fx-btn fx-btn-secondary">${icon("plus")}Add</button>
        </form>
        <div class="fx-tagman" data-list role="list"></div>
        <p class="fx-labels-note">${icon("lock")}<span>Stars and tags are saved on this device.
            <button type="button" class="fx-link" data-export>Export</button> a backup or
            <button type="button" class="fx-link" data-import>import</button> one.</span></p>
        <div class="fx-dialog-actions">
            <button type="button" class="fx-btn fx-btn-primary" data-dialog-confirm>Done</button>
        </div>`, { className: "fx-tagman-dialog", onDismiss: () => finish() })
    const { backdrop } = mounted
    const list = backdrop.querySelector<HTMLElement>("[data-list]")!

    const render = () => {
        const tags = listTags(labelStore.doc())
        if (tags.length === 0) {
            list.innerHTML = `<div class="fx-tagman-empty">${icon("tag")}<span>No tags yet. Add one above, or select items and choose <strong>Tags…</strong></span></div>`
            return
        }
        list.innerHTML = tags.map((tag) => {
            const open = expanded?.id === tag.id ? expanded.mode : null
            const countText = tag.count === 1 ? "1 item" : `${tag.count} items`
            let extra = ""
            if (open === "color") {
                extra = `<div class="fx-swatches" role="radiogroup" aria-label="Color for ${escapeHtml(tag.name)}">
                    ${TAG_COLORS.map((color) => `<button type="button" class="fx-swatch${color === tag.color ? " is-selected" : ""}" data-color="${color}" data-pick-color="${color}" role="radio" aria-checked="${color === tag.color}" aria-label="${color}" title="${color}"><span class="fx-tag-dot"></span>${color === tag.color ? icon("check") : ""}</button>`).join("")}
                </div>`
            } else if (open === "delete") {
                extra = `<div class="fx-tagman-confirm"><span>Delete “${escapeHtml(tag.name)}”?${tag.count ? ` It will be removed from ${countText}.` : ""}</span>
                    <span class="fx-tagman-confirm-actions"><button type="button" class="fx-btn fx-btn-ghost" data-cancel-expand>Cancel</button>
                    <button type="button" class="fx-btn fx-btn-danger" data-confirm-delete>Delete</button></span></div>`
            }
            const nameHtml = open === "rename"
                ? `<form class="fx-tagman-rename" data-rename-form><input class="fx-input${renameError ? " is-invalid" : ""}" data-rename-input type="text" value="${escapeHtml(renameDraft ?? tag.name)}" maxlength="48" aria-label="Tag name" />
                    <button type="submit" class="fx-icon-btn" aria-label="Save name" title="Save">${icon("check")}</button></form>
                    ${renameError ? `<span class="fx-tagman-error">${escapeHtml(renameError)}</span>` : ""}`
                : `<span class="fx-tagman-name">${escapeHtml(tag.name)}</span><span class="fx-tagman-count">${countText}</span>`
            return `<div class="fx-tagman-row${open ? ` is-${open}` : ""}" role="listitem" data-tag-id="${escapeHtml(tag.id)}">
                <div class="fx-tagman-main">
                    <button type="button" class="fx-tagman-swatch" data-color="${tag.color}" data-expand="color" aria-label="Change color of ${escapeHtml(tag.name)}" title="Change color" ${readOnly ? "disabled" : ""}><span class="fx-tag-dot"></span></button>
                    <div class="fx-tagman-text">${nameHtml}</div>
                    ${open === "rename" ? "" : `<button type="button" class="fx-icon-btn" data-expand="rename" aria-label="Rename ${escapeHtml(tag.name)}" title="Rename" ${readOnly ? "disabled" : ""}>${icon("pencil")}</button>
                    <button type="button" class="fx-icon-btn fx-tagman-delete" data-expand="delete" aria-label="Delete ${escapeHtml(tag.name)}" title="Delete" ${readOnly ? "disabled" : ""}>${icon("trash")}</button>`}
                </div>
                ${extra}
            </div>`
        }).join("")
        const renameInput = list.querySelector<HTMLInputElement>("[data-rename-input]")
        if (renameInput && document.activeElement !== renameInput) {
            renameInput.focus()
            renameInput.select()
        }
    }

    const unsubscribe = labelStore.subscribe(render)
    const finish = () => {
        if (settled) return
        settled = true
        unsubscribe()
        document.removeEventListener("keydown", onKey, true)
        mounted.close()
    }
    const onKey = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || !backdrop.isConnected) return
        event.preventDefault()
        event.stopPropagation()
        if (expanded) {
            expanded = null
            renameError = ""
            renameDraft = null
            render()
        } else {
            finish()
        }
    }
    document.addEventListener("keydown", onKey, true)

    const saveRename = (id: string) => {
        const value = list.querySelector<HTMLInputElement>("[data-rename-input]")?.value ?? ""
        const tag = getTag(id)
        if (tag && normalizeTagName(value) === tag.name) {
            expanded = null
            renameError = ""
            render()
            return
        }
        let error = ""
        labelStore.update((doc, now) => {
            const result = renameTag(doc, id, value, now)
            if (result.ok) return result.doc
            error = result.error === "duplicate" ? "A tag with that name already exists" : "Enter a name (up to 48 characters)"
            return doc
        })
        renameError = error
        // Keep what was typed when the name is refused, so it can be corrected.
        renameDraft = error ? value : null
        if (!error) expanded = null
        render()
    }

    list.addEventListener("click", (event) => {
        const target = event.target as HTMLElement
        const row = target.closest<HTMLElement>("[data-tag-id]")
        const id = row?.dataset.tagId
        if (!id || readOnly) return
        const expand = target.closest<HTMLElement>("[data-expand]")?.dataset.expand as "color" | "rename" | "delete" | undefined
        if (expand) {
            expanded = expanded?.id === id && expanded.mode === expand ? null : { id, mode: expand }
            renameError = ""
            renameDraft = null
            render()
            return
        }
        const color = target.closest<HTMLElement>("[data-pick-color]")?.dataset.pickColor
        if (color) {
            expanded = null
            labelStore.update((doc, now) => recolorTag(doc, id, color, now))
            render()
            return
        }
        if (target.closest("[data-cancel-expand]")) {
            expanded = null
            render()
            return
        }
        if (target.closest("[data-confirm-delete]")) {
            expanded = null
            const name = getTag(id)?.name ?? "Tag"
            labelStore.update((doc, now) => deleteTag(doc, id, now))
            showToast(`Deleted tag “${name}”`)
            render()
        }
    })
    list.addEventListener("submit", (event) => {
        event.preventDefault()
        const id = (event.target as HTMLElement).closest<HTMLElement>("[data-tag-id]")?.dataset.tagId
        if (id) saveRename(id)
    })
    list.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.target as HTMLElement).matches("[data-rename-input]")) {
            event.preventDefault()
            const id = (event.target as HTMLElement).closest<HTMLElement>("[data-tag-id]")?.dataset.tagId
            if (id) saveRename(id)
        }
    })
    const newForm = backdrop.querySelector<HTMLFormElement>("[data-new-form]")
    const newInput = backdrop.querySelector<HTMLInputElement>("[data-new-input]")
    newForm?.addEventListener("submit", (event) => {
        event.preventDefault()
        if (!newInput) return
        const name = normalizeTagName(newInput.value)
        if (!name) {
            newInput.classList.add("is-invalid")
            newInput.focus()
            return
        }
        if (findTagByName(labelStore.doc(), name)) {
            showToast(`“${name}” already exists`)
            return
        }
        labelStore.update((doc, now) => createTag(doc, name, { now, id: randomTagId() })?.doc ?? doc)
        newInput.value = ""
        render()
    })
    newInput?.addEventListener("input", () => newInput.classList.remove("is-invalid"))
    backdrop.querySelector("[data-export]")?.addEventListener("click", () => exportLabels())
    backdrop.querySelector("[data-import]")?.addEventListener("click", () => importLabels())
    backdrop.querySelector("[data-dialog-confirm]")?.addEventListener("click", () => finish())
    render()
    window.setTimeout(() => backdrop.querySelector<HTMLElement>("[data-dialog-confirm]")?.focus({ preventScroll: true }), 40)
}

/* ------------------------------------------------------- Export/import */

export function exportLabels() {
    if (!store) {
        showToast("Stars and tags are still loading…")
        return
    }
    const text = store.exportText()
    const date = new Date().toISOString().slice(0, 10)
    const blob = new Blob([text], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `tglfs-stars-and-tags-${date}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
    const doc = store.doc()
    const stars = starredKeys(doc).length
    const tags = listTags(doc).length
    showToast(`Exported ${stars} ${stars === 1 ? "star" : "stars"} and ${tags} ${tags === 1 ? "tag" : "tags"}`, { tone: "success" })
}

export function importLabels() {
    if (!ensureWritable() || !store) return
    const labelStore = store
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.hidden = true
    document.body.appendChild(input)
    input.addEventListener("change", async () => {
        const file = input.files?.[0]
        input.remove()
        if (!file) return
        let text = ""
        try {
            text = await file.text()
        } catch {
            showToast("Couldn't read that file", { tone: "error" })
            return
        }
        let outcome: ReturnType<typeof mergeImportedLabels> | null = null
        labelStore.update((doc, now) => {
            outcome = mergeImportedLabels(doc, text, { now, newId: randomTagId })
            return outcome.ok ? outcome.doc : doc
        })
        const result = outcome as ReturnType<typeof mergeImportedLabels> | null
        if (!result) return
        if (!result.ok) {
            showToast(result.error === "future-version"
                ? "That backup was made by a newer version of TGLFS"
                : "That file isn't a TGLFS stars & tags backup", { tone: "error", durationMs: 5000 })
            return
        }
        const { summary } = result
        const parts = [
            summary.starsAdded ? `${summary.starsAdded} ${summary.starsAdded === 1 ? "star" : "stars"}` : "",
            summary.tagsCreated ? `${summary.tagsCreated} new ${summary.tagsCreated === 1 ? "tag" : "tags"}` : "",
            summary.tagAssignmentsAdded ? `${summary.tagAssignmentsAdded} tag ${summary.tagAssignmentsAdded === 1 ? "assignment" : "assignments"}` : "",
        ].filter(Boolean)
        const message = parts.length
            ? `Imported ${parts.join(", ")}`
            : "Nothing new to import — everything was already here"
        const notes = [
            summary.otherAccount ? "backup is from another account" : "",
            summary.skipped ? `${summary.skipped} unreadable ${summary.skipped === 1 ? "entry" : "entries"} skipped` : "",
        ].filter(Boolean)
        showToast(notes.length ? `${message} (${notes.join("; ")})` : message, { tone: parts.length ? "success" : "default", durationMs: 6000 })
    }, { once: true })
    input.click()
}

/* ----------------------------------------------------- Item resolution */

export type ResolvedLabelItem =
    | { key: string; kind: "file"; record: { msgId: number; date: number; data: FileCardData }; location: string }
    | { key: string; kind: "folder"; record: TglfsFolderRecord; location: string }
    | { key: string; kind: "missing"; itemKind: "file" | "folder"; id: string; name: string; location: string }

const ROOT_LOCATION = "All files"

function fileParentId(data: FileCardData) {
    const parent = "parentFolderId" in data ? (data as { parentFolderId?: string }).parentFolderId : undefined
    return parent && parent !== TGLFS_ROOT_PARENT_ID ? parent : null
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++
            results[index] = await task(items[index])
        }
    })
    await Promise.all(workers)
    return results
}

/**
 * Looks up each labelled item in Telegram (files by UFID, folders by folderId) plus its folder location.
 * Items that don't exist any more come back as "missing". Lookup errors propagate (never reported as missing).
 */
export async function resolveLabelItems(client: any, keys: string[]): Promise<ResolvedLabelItem[]> {
    const folderLookups = new Map<string, Promise<TglfsFolderRecord | null>>()
    const lookupFolder = (folderId: string) => {
        let lookup = folderLookups.get(folderId)
        if (!lookup) {
            lookup = getFolderRecord(client, folderId)
            folderLookups.set(folderId, lookup)
        }
        return lookup
    }
    const locationOf = async (parentId: string | null): Promise<string> => {
        if (!parentId) return ROOT_LOCATION
        const names: string[] = []
        const seen = new Set<string>()
        let current: string | null = parentId
        while (current && !seen.has(current) && names.length < 24) {
            seen.add(current)
            const record = await lookupFolder(current)
            if (!record) {
                names.unshift("Deleted folder")
                break
            }
            names.unshift(record.data.name)
            const parent = record.data.parentFolderId
            current = parent && parent !== TGLFS_ROOT_PARENT_ID ? parent : null
        }
        return names.join(" › ")
    }

    const resolved = await mapWithConcurrency(keys, 4, async (key): Promise<ResolvedLabelItem | null> => {
        const parsed = parseLabelItemKey(key)
        if (!parsed) return null
        const hint = labelNameHint(key)
        if (parsed.kind === "file") {
            const record = await getFileCardByUfid(client, parsed.id)
            if (!record) return { key, kind: "missing", itemKind: "file", id: parsed.id, name: hint ?? parsed.id, location: "" }
            return { key, kind: "file", record, location: await locationOf(fileParentId(record.data)) }
        }
        const record = await lookupFolder(parsed.id)
        if (!record || record.data.deleted) return { key, kind: "missing", itemKind: "folder", id: parsed.id, name: hint ?? parsed.id, location: "" }
        const parent = record.data.parentFolderId
        return { key, kind: "folder", record, location: await locationOf(parent && parent !== TGLFS_ROOT_PARENT_ID ? parent : null) }
    })
    const items = resolved.filter((item): item is ResolvedLabelItem => !!item)
    const hints = new Map<string, string>()
    for (const item of items) {
        if (item.kind === "file") hints.set(item.key, item.record.data.name)
        if (item.kind === "folder") hints.set(item.key, item.record.data.name)
    }
    rememberNameHints(hints)
    return items
}

/* ---------------------------------------------------------------- Init */

let initialized = false

export function initLabels(labelsHost: LabelsHost) {
    host = labelsHost
    if (initialized) return
    initialized = true
    document.getElementById("navStarred")?.addEventListener("click", () => host?.openView({ kind: "starred" }))
    document.getElementById("navTags")?.addEventListener("click", (event) => {
        const target = event.target as HTMLElement
        const tagId = target.closest<HTMLElement>("[data-tag-id]")?.dataset.tagId
        if (tagId) {
            host?.openView({ kind: "tag", tagId })
            return
        }
        if (target.closest("[data-tags-more]")) {
            showAllSidebarTags = true
            renderLabelsSidebar()
        } else if (target.closest("[data-tags-less]")) {
            showAllSidebarTags = false
            renderLabelsSidebar()
        } else if (target.closest("[data-manage-tags]")) {
            openManageTags()
        }
    })
    document.getElementById("labelsExportButton")?.addEventListener("click", () => exportLabels())
    document.getElementById("labelsImportButton")?.addEventListener("click", () => importLabels())
    window.addEventListener("storage", (event) => {
        if (store && event.key === store.storageKey) store.reload()
    })
    renderLabelsSidebar()
}

/** Tag colours as palette names, for callers that need them (e.g. breadcrumbs). */
export function tagColor(tagId: string): TagColor | null {
    return getTag(tagId)?.color ?? null
}
