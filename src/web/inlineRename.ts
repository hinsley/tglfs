/**
 * In-place rename for list rows and grid tiles (desktop). The name turns into a text field with the stem selected;
 * Enter or blur commits, Esc cancels, and validation problems show inline under the field. Phones keep the
 * dialog-based rename (editing inside a scrolling list is fiddly on touch).
 *
 * The browser re-renders rows wholesale (e.g. when a background count or upload refresh lands), so the editor
 * re-attaches itself to the freshly rendered row for the same entry instead of silently disappearing.
 */
import {
    SLOW_CLICK_RENAME_DELAY_MS,
    isSlowRenameClick,
    stemSelectionRange,
    validateEntryName,
} from "./gestureMath"

export type InlineRenameHooks<E> = {
    idOf(entry: E): string
    nameOf(entry: E): string
    kindOf(entry: E): "file" | "folder"
    /** Names of the other entries in the current listing (for duplicate detection). */
    siblingNames(entry: E): string[]
    /** Looks up the current entry object for an id (rows are re-rendered with fresh objects). */
    entryById(id: string): E | null
    /** Writes the rename; resolves true when it was written. */
    commit(entry: E, newName: string): Promise<boolean>
    showError(message: string): void
}

type Session<E> = {
    id: string
    entry: E
    editor: HTMLElement
    input: HTMLInputElement
    error: HTMLElement
    committing: boolean
    observer: MutationObserver
}

let session: Session<any> | null = null
let renameHooks: InlineRenameHooks<any> | null = null

export function isInlineRenameActive() {
    return session !== null
}

function findNodes(id: string) {
    const escaped = CSS.escape(id)
    const grid = document.getElementById("browserGrid")
    const useGrid = !!grid && !grid.hasAttribute("hidden")
    const node = document.querySelector<HTMLElement>(`${useGrid ? "#browserGrid" : "#browserRows"} [data-browser-id="${escaped}"]`)
    if (!node) return null
    const name = node.querySelector<HTMLElement>(".fx-name, .fx-tile-name")
    return name ? { node, name } : null
}

function mountEditor(current: Session<any>) {
    const nodes = findNodes(current.id)
    if (!nodes) return false
    nodes.node.classList.add("is-renaming")
    nodes.name.setAttribute("hidden", "")
    nodes.name.insertAdjacentElement("afterend", current.editor)
    return true
}

function unmount(current: Session<any>) {
    current.observer.disconnect()
    current.editor.remove()
    document.querySelectorAll<HTMLElement>(`[data-browser-id="${CSS.escape(current.id)}"]`).forEach((node) => {
        node.classList.remove("is-renaming")
        node.querySelector(".fx-name, .fx-tile-name")?.removeAttribute("hidden")
    })
}

function end(current: Session<any>) {
    if (session === current) session = null
    unmount(current)
}

function showValidation(current: Session<any>, message: string | null) {
    current.error.textContent = message ?? ""
    current.error.toggleAttribute("hidden", !message)
    current.input.setAttribute("aria-invalid", String(!!message))
    current.editor.classList.toggle("is-invalid", !!message)
}

function validate(current: Session<any>) {
    const hooks = renameHooks!
    return validateEntryName({
        value: current.input.value,
        kind: hooks.kindOf(current.entry),
        currentName: hooks.nameOf(current.entry),
        siblingNames: hooks.siblingNames(current.entry),
    })
}

async function commit(current: Session<any>, reason: "enter" | "blur") {
    if (current.committing || session !== current) return
    const hooks = renameHooks!
    const result = validate(current)
    if (!result.ok) {
        if (reason === "blur") {
            end(current)
            hooks.showError(result.message)
            return
        }
        showValidation(current, result.message)
        current.editor.classList.remove("is-shaking")
        void current.editor.offsetWidth
        current.editor.classList.add("is-shaking")
        current.input.focus()
        return
    }
    if (result.name === hooks.nameOf(current.entry)) {
        end(current)
        return
    }
    current.committing = true
    current.input.readOnly = true
    current.editor.classList.add("is-saving")
    showValidation(current, null)
    try {
        await hooks.commit(current.entry, result.name)
    } finally {
        end(current)
    }
}

/** Starts editing `entry`'s name in place. Returns false when its row/tile isn't on screen. */
export function startInlineRename<E>(entry: E, hooks: InlineRenameHooks<E>): boolean {
    renameHooks = hooks
    if (session) {
        if (session.id === hooks.idOf(entry)) {
            session.input.focus()
            return true
        }
        void commit(session, "blur")
        if (session) end(session)
    }
    const id = hooks.idOf(entry)
    if (!findNodes(id)) return false

    const editor = document.createElement("span")
    editor.className = "fx-rename"
    const input = document.createElement("input")
    input.type = "text"
    input.className = "fx-rename-input"
    input.value = hooks.nameOf(entry)
    input.spellcheck = false
    input.autocomplete = "off"
    input.setAttribute("autocapitalize", "off")
    input.setAttribute("aria-label", `Rename ${hooks.nameOf(entry)}`)
    input.setAttribute("enterkeyhint", "done")
    const error = document.createElement("span")
    error.className = "fx-rename-error"
    error.setAttribute("role", "alert")
    error.hidden = true
    editor.append(input, error)

    const current: Session<E> = {
        id,
        entry,
        editor,
        input,
        error,
        committing: false,
        observer: new MutationObserver(() => {
            if (session !== current || editor.isConnected) return
            const fresh = hooks.entryById(id)
            if (!fresh) {
                end(current)
                return
            }
            current.entry = fresh
            const hadFocus = !current.committing
            const [start, finish] = [input.selectionStart, input.selectionEnd]
            if (!mountEditor(current)) {
                end(current)
                return
            }
            if (hadFocus) {
                input.focus({ preventScroll: true })
                if (start !== null && finish !== null) input.setSelectionRange(start, finish)
            }
        }),
    }

    // Keep row/tile handlers (select, open, drag, context menu) away from the editor.
    for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
        editor.addEventListener(type, (event) => event.stopPropagation())
    }
    input.addEventListener("keydown", (event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
            event.preventDefault()
            void commit(current, "enter")
        } else if (event.key === "Escape") {
            event.preventDefault()
            end(current)
            const nodes = findNodes(id)
            nodes?.node.focus({ preventScroll: true })
        } else if (event.key === "Tab") {
            event.preventDefault()
            void commit(current, "blur")
        }
    })
    input.addEventListener("input", () => {
        const result = validate(current)
        showValidation(current, result.ok ? null : result.message)
        editor.classList.remove("is-shaking")
    })
    input.addEventListener("blur", () => {
        // A re-render detaches the field (and blurs it); the observer re-attaches it, so ignore that blur.
        window.setTimeout(() => {
            if (session !== current || current.committing) return
            if (!input.isConnected || document.activeElement === input) return
            void commit(current, "blur")
        }, 0)
    })

    session = current
    mountEditor(current)
    const content = document.getElementById("browserContent")
    if (content) current.observer.observe(content, { childList: true, subtree: true })
    input.focus({ preventScroll: false })
    const [start, finish] = stemSelectionRange(input.value, hooks.kindOf(entry))
    input.setSelectionRange(start, finish)
    editor.scrollIntoView({ block: "nearest" })
    return true
}

export function cancelInlineRename() {
    if (session) end(session)
}

/* ---------------------------------------------------- Slow second click */

export type SlowClickHooks = {
    /** Id of the only selected entry, or null. */
    soleSelectedId(): string | null
    /** Starts a rename for the entry with this id (desktop only). */
    rename(id: string): void
    isBlocked(): boolean
}

/**
 * Finder-style rename: clicking the name of the single selected item again (not a double-click) starts an inline
 * rename after a short pause. Any other interaction in the meantime cancels it.
 */
export function installSlowClickRename(hooks: SlowClickHooks) {
    let lastSelectionCandidate: { id: string; at: number } | null = null
    let press: { id: string; wasSole: boolean; selectedForMs: number } | null = null
    let timer: number | undefined
    const cancel = () => {
        if (timer !== undefined) window.clearTimeout(timer)
        timer = undefined
    }
    const rowFor = (target: EventTarget | null) =>
        (target as HTMLElement | null)?.closest<HTMLElement>("#browserRows [data-browser-id], #browserGrid [data-browser-id]") ?? null

    document.addEventListener("pointerdown", (event) => {
        cancel()
        press = null
        if (event.pointerType !== "mouse" || event.button !== 0) return
        const row = rowFor(event.target)
        const id = row?.dataset.browserId
        if (!row || !id) return
        const now = performance.now()
        const wasSole = hooks.soleSelectedId() === id
        const selectedForMs = !wasSole
            ? 0
            : lastSelectionCandidate?.id === id ? now - lastSelectionCandidate.at : Number.POSITIVE_INFINITY
        if (!wasSole) lastSelectionCandidate = { id, at: now }
        press = { id, wasSole, selectedForMs }
    }, true)

    document.addEventListener("click", (event) => {
        const current = press
        press = null
        if (!current) return
        const row = rowFor(event.target)
        if (!row || row.dataset.browserId !== current.id) return
        const onName = !!(event.target as HTMLElement).closest(".fx-name, .fx-tile-name")
        const slow = isSlowRenameClick({
            wasSoleSelectionAtPress: current.wasSole,
            selectedForMs: current.selectedForMs,
            clickCount: event.detail,
            modifier: event.shiftKey || event.metaKey || event.ctrlKey || event.altKey,
            onName,
        })
        if (!slow || hooks.isBlocked()) return
        cancel()
        timer = window.setTimeout(() => {
            timer = undefined
            if (hooks.isBlocked() || hooks.soleSelectedId() !== current.id) return
            hooks.rename(current.id)
        }, SLOW_CLICK_RENAME_DELAY_MS)
    })

    document.addEventListener("dblclick", cancel, true)
    document.addEventListener("keydown", cancel, true)
    document.addEventListener("wheel", cancel, { capture: true, passive: true })
    document.getElementById("browserContent")?.addEventListener("scroll", cancel, { passive: true })
}
