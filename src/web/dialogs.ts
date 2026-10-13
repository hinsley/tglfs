// Shared, dependency-free UI primitives: toasts, modal dialogs, popover menus and bottom sheets.
import { icon, type IconName } from "./icons"

export function escapeHtml(value: string) {
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

export function isCompactViewport() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches
}

/* ---------------------------------------------------------------- Toasts */

let toastTimer: number | undefined

export type ToastOptions = {
    durationMs?: number | null
    tone?: "default" | "success" | "error"
}

export function showToast(message: string, options: ToastOptions = {}) {
    const toast = document.getElementById("ufidToast")
    if (!toast) return
    toast.textContent = message
    toast.dataset.tone = options.tone ?? "default"
    toast.setAttribute("aria-hidden", "false")
    toast.classList.remove("is-visible")
    void toast.offsetWidth
    toast.classList.add("is-visible")
    if (toastTimer !== undefined) {
        window.clearTimeout(toastTimer)
        toastTimer = undefined
    }
    const durationMs = options.durationMs === undefined ? 2200 : options.durationMs
    if (durationMs === null) return
    toastTimer = window.setTimeout(() => {
        toast.classList.remove("is-visible")
        toast.setAttribute("aria-hidden", "true")
        toastTimer = undefined
    }, durationMs)
}

export function hideToast() {
    const toast = document.getElementById("ufidToast")
    if (!toast) return
    if (toastTimer !== undefined) {
        window.clearTimeout(toastTimer)
        toastTimer = undefined
    }
    toast.classList.remove("is-visible")
    toast.setAttribute("aria-hidden", "true")
}

/* --------------------------------------------------------- Action toast */
/*
 * A second, interactive toast ("snackbar") with an optional action button such as "Undo", an optional
 * countdown line that drains over the toast's lifetime, a dismiss button and a busy state. It lives in its
 * own element so that ordinary status toasts never clobber a pending undo; while it is visible, plain toasts
 * stack above it. Only one action toast exists at a time: showing a new one closes the previous one with
 * reason "replaced". The timer pauses while the pointer hovers it or keyboard focus is inside it.
 */

export type ActionToastCloseReason = "timeout" | "action" | "dismissed" | "replaced"

export type ActionToastOptions = {
    message: string
    tone?: "default" | "success" | "error"
    /** Label of the action button, e.g. "Undo". Omit for no button. */
    actionLabel?: string
    /** Value for aria-keyshortcuts on the action button, e.g. "Control+Z Meta+Z". */
    actionShortcut?: string
    /** Human-readable shortcut appended to the button tooltip, e.g. "Ctrl+Z". */
    actionHint?: string
    onAction?: () => void
    /** Lifetime in ms; null keeps it until closed or replaced. Defaults to 6000. */
    durationMs?: number | null
    /** Show a thin progress line draining over `durationMs`. */
    countdown?: boolean
    /** Show a spinner instead of an action (e.g. while an undo is running). */
    busy?: boolean
    /** Show a dismiss (×) button. Defaults to true unless busy. */
    dismissible?: boolean
    /** Called exactly once when this toast's content goes away, with the reason. */
    onClose?: (reason: ActionToastCloseReason) => void
}

export type ActionToastHandle = {
    /** Replace the content in place (same handle). The previous content's onClose is NOT called. */
    update: (options: ActionToastOptions) => void
    close: (reason?: ActionToastCloseReason) => void
    isActive: () => boolean
}

type ActiveActionToast = {
    id: number
    options: ActionToastOptions
    timer: number | undefined
    deadline: number
    remaining: number
    paused: boolean
}

let actionToastSeq = 0
let activeActionToast: ActiveActionToast | null = null
let actionToastHideTimer: number | undefined

function ensureActionToastElement() {
    let element = document.getElementById("fxActionToast")
    if (element) return element
    element = document.createElement("div")
    element.id = "fxActionToast"
    element.className = "fx-atoast"
    element.setAttribute("role", "status")
    element.setAttribute("aria-live", "polite")
    element.setAttribute("aria-atomic", "true")
    element.setAttribute("aria-hidden", "true")
    element.toggleAttribute("inert", true)
    element.innerHTML = `
        <span class="fx-atoast-lead" aria-hidden="true"></span>
        <span class="fx-atoast-msg"></span>
        <button type="button" class="fx-atoast-action" data-atoast-action></button>
        <button type="button" class="fx-atoast-close" data-atoast-close aria-label="Dismiss" title="Dismiss">${icon("close")}</button>
        <span class="fx-atoast-timer" aria-hidden="true"><span></span></span>`
    document.body.appendChild(element)

    element.querySelector("[data-atoast-action]")?.addEventListener("click", () => triggerActionToast())
    element.querySelector("[data-atoast-close]")?.addEventListener("click", () => closeActionToast("dismissed"))
    const pause = () => setActionToastPaused(true)
    const resume = () => {
        if (element!.matches(":hover") || element!.contains(document.activeElement)) return
        setActionToastPaused(false)
    }
    element.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "mouse") pause()
    })
    element.addEventListener("pointerleave", () => resume())
    element.addEventListener("focusin", pause)
    element.addEventListener("focusout", () => window.setTimeout(resume, 0))
    return element
}

function syncActionToastOffset(element: HTMLElement | null) {
    // Lets the plain status toast stack above a visible action toast.
    const root = document.documentElement
    if (!element || !activeActionToast) {
        root.style.removeProperty("--action-toast-offset")
        return
    }
    root.style.setProperty("--action-toast-offset", `${Math.ceil(element.getBoundingClientRect().height) + 8}px`)
}

function clearActionToastTimer(toast: ActiveActionToast) {
    if (toast.timer !== undefined) window.clearTimeout(toast.timer)
    toast.timer = undefined
}

function startActionToastTimer(toast: ActiveActionToast, ms: number) {
    clearActionToastTimer(toast)
    toast.remaining = ms
    toast.deadline = Date.now() + ms
    const id = toast.id
    toast.timer = window.setTimeout(() => {
        if (activeActionToast?.id === id) closeActionToast("timeout")
    }, ms)
}

function setActionToastPaused(paused: boolean) {
    const toast = activeActionToast
    const element = document.getElementById("fxActionToast")
    if (!toast || !element || toast.paused === paused) return
    const duration = toast.options.durationMs === undefined ? 6000 : toast.options.durationMs
    if (duration === null) return
    toast.paused = paused
    element.classList.toggle("is-paused", paused)
    if (paused) {
        toast.remaining = Math.max(0, toast.deadline - Date.now())
        clearActionToastTimer(toast)
    } else {
        startActionToastTimer(toast, Math.max(800, toast.remaining))
    }
}

function renderActionToast(toast: ActiveActionToast) {
    const element = ensureActionToastElement()
    const options = toast.options
    const busy = !!options.busy
    element.dataset.tone = options.tone ?? "default"
    element.classList.toggle("is-busy", busy)
    element.classList.remove("is-paused")
    const lead = element.querySelector<HTMLElement>(".fx-atoast-lead")!
    lead.innerHTML = busy
        ? `<span class="fx-spinner fx-spinner--sm"></span>`
        : options.tone === "error" ? icon("alert") : options.tone === "success" ? icon("check") : ""
    lead.hidden = lead.innerHTML === ""
    element.querySelector<HTMLElement>(".fx-atoast-msg")!.textContent = options.message
    const action = element.querySelector<HTMLButtonElement>("[data-atoast-action]")!
    const hasAction = !busy && !!options.actionLabel && !!options.onAction
    action.hidden = !hasAction
    action.textContent = options.actionLabel ?? ""
    action.title = options.actionHint ? `${options.actionLabel} (${options.actionHint})` : options.actionLabel ?? ""
    if (options.actionShortcut) {
        action.setAttribute("aria-keyshortcuts", options.actionShortcut)
    } else {
        action.removeAttribute("aria-keyshortcuts")
    }
    const close = element.querySelector<HTMLButtonElement>("[data-atoast-close]")!
    close.hidden = !(options.dismissible ?? !busy)

    const duration = options.durationMs === undefined ? 6000 : options.durationMs
    const timerLine = element.querySelector<HTMLElement>(".fx-atoast-timer")!
    const showCountdown = !!options.countdown && duration !== null
    timerLine.hidden = !showCountdown
    const bar = timerLine.firstElementChild as HTMLElement
    bar.style.animation = "none"
    if (showCountdown) {
        void bar.offsetWidth
        bar.style.animation = `fx-atoast-drain ${duration}ms linear forwards`
    }

    if (actionToastHideTimer !== undefined) {
        window.clearTimeout(actionToastHideTimer)
        actionToastHideTimer = undefined
    }
    element.removeAttribute("inert")
    element.setAttribute("aria-hidden", "false")
    element.classList.add("is-visible")
    document.body.classList.add("fx-has-action-toast")
    clearActionToastTimer(toast)
    toast.paused = false
    if (duration !== null) startActionToastTimer(toast, duration)
    syncActionToastOffset(element)
}

function hideActionToastElement() {
    const element = document.getElementById("fxActionToast")
    document.body.classList.remove("fx-has-action-toast")
    syncActionToastOffset(null)
    if (!element) return
    const hadFocus = element.contains(document.activeElement)
    element.classList.remove("is-visible")
    element.setAttribute("aria-hidden", "true")
    element.toggleAttribute("inert", true)
    if (hadFocus) (document.activeElement as HTMLElement | null)?.blur?.()
    actionToastHideTimer = window.setTimeout(() => {
        actionToastHideTimer = undefined
        if (!activeActionToast) element.querySelector<HTMLElement>(".fx-atoast-msg")!.textContent = ""
    }, 240)
}

export function showActionToast(options: ActionToastOptions): ActionToastHandle {
    if (activeActionToast) closeActionToast("replaced", { keepVisible: true })
    const toast: ActiveActionToast = { id: ++actionToastSeq, options, timer: undefined, deadline: 0, remaining: 0, paused: false }
    activeActionToast = toast
    renderActionToast(toast)
    const id = toast.id
    return {
        update: (next) => {
            if (activeActionToast?.id !== id) return
            toast.options = next
            renderActionToast(toast)
        },
        close: (reason = "dismissed") => {
            if (activeActionToast?.id === id) closeActionToast(reason)
        },
        isActive: () => activeActionToast?.id === id,
    }
}

export function closeActionToast(reason: ActionToastCloseReason = "dismissed", internal: { keepVisible?: boolean } = {}) {
    const toast = activeActionToast
    if (!toast) return
    activeActionToast = null
    clearActionToastTimer(toast)
    if (!internal.keepVisible) hideActionToastElement()
    try {
        toast.options.onClose?.(reason)
    } catch (error) {
        console.error(error)
    }
}

/** Runs the visible action toast's action (e.g. Undo). Returns false when no action is available. */
export function triggerActionToast(): boolean {
    const toast = activeActionToast
    if (!toast || toast.options.busy || !toast.options.actionLabel || !toast.options.onAction) return false
    const onAction = toast.options.onAction
    closeActionToast("action")
    onAction()
    return true
}

/* --------------------------------------------------------------- Dialogs */

export type DialogOptions = {
    title: string
    message?: string
    label?: string
    initialValue?: string
    placeholder?: string
    confirmLabel?: string
    cancelLabel?: string
    inputType?: string
    allowEmpty?: boolean
    danger?: boolean
    icon?: IconName
    /** Select only the file stem (text before the last dot) when the dialog opens. */
    selectStem?: boolean
}

export type ChoiceOption = {
    value: string
    label: string
    detail?: string
    icon?: IconName
}

function mountDialog(inner: string, onDismiss: () => void) {
    const backdrop = document.createElement("div")
    backdrop.className = "fx-dialog-backdrop"
    backdrop.innerHTML = `<div class="fx-dialog" role="dialog" aria-modal="true" aria-labelledby="fxDialogTitle">${inner}</div>`
    const previouslyFocused = document.activeElement as HTMLElement | null
    document.body.appendChild(backdrop)
    requestAnimationFrame(() => backdrop.classList.add("is-open"))
    backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) onDismiss()
    })
    const close = () => {
        backdrop.remove()
        previouslyFocused?.focus?.({ preventScroll: true })
    }
    return { backdrop, close }
}

function dialogHeader(options: DialogOptions) {
    const iconHtml = options.icon
        ? `<span class="fx-dialog-icon${options.danger ? " is-danger" : ""}">${icon(options.icon)}</span>`
        : ""
    return `
        <div class="fx-dialog-head">
            ${iconHtml}
            <div class="fx-dialog-titles">
                <h2 id="fxDialogTitle">${escapeHtml(options.title)}</h2>
                ${options.message ? `<p>${escapeHtml(options.message)}</p>` : ""}
            </div>
        </div>`
}

function dialogActions(options: DialogOptions, defaultConfirm: string) {
    return `
        <div class="fx-dialog-actions">
            <button type="button" class="fx-btn fx-btn-ghost" data-dialog-cancel>${escapeHtml(options.cancelLabel ?? "Cancel")}</button>
            <button type="button" class="fx-btn ${options.danger ? "fx-btn-danger" : "fx-btn-primary"}" data-dialog-confirm>${escapeHtml(options.confirmLabel ?? defaultConfirm)}</button>
        </div>`
}

export function requestText(options: DialogOptions): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false
        const finish = (value: string | null) => {
            if (settled) return
            settled = true
            dialog.close()
            resolve(value)
        }
        const dialog = mountDialog(`
            ${dialogHeader(options)}
            <label class="fx-field">
                <span class="fx-field-label">${escapeHtml(options.label ?? "Value")}</span>
                <input class="fx-input" data-dialog-input type="${escapeHtml(options.inputType ?? "text")}"
                    placeholder="${escapeHtml(options.placeholder ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" />
            </label>
            ${dialogActions(options, "Save")}`, () => finish(null))
        const input = dialog.backdrop.querySelector<HTMLInputElement>("[data-dialog-input]")!
        input.value = options.initialValue ?? ""
        const submit = () => {
            const value = input.value
            if (!options.allowEmpty && value.trim() === "") {
                input.focus()
                input.classList.add("is-invalid")
                return
            }
            finish(value)
        }
        input.addEventListener("input", () => input.classList.remove("is-invalid"))
        dialog.backdrop.querySelector("[data-dialog-confirm]")?.addEventListener("click", submit)
        dialog.backdrop.querySelector("[data-dialog-cancel]")?.addEventListener("click", () => finish(null))
        dialog.backdrop.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                finish(null)
            } else if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                event.stopPropagation()
                submit()
            }
        })
        window.setTimeout(() => {
            input.focus()
            const value = input.value
            const dot = value.lastIndexOf(".")
            if (options.selectStem && dot > 0) {
                input.setSelectionRange(0, dot)
            } else {
                input.select()
            }
        }, 30)
    })
}

export function requestConfirm(options: DialogOptions): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false
        const finish = (value: boolean) => {
            if (settled) return
            settled = true
            dialog.close()
            resolve(value)
        }
        const dialog = mountDialog(`${dialogHeader(options)}${dialogActions(options, "Confirm")}`, () => finish(false))
        const confirmButton = dialog.backdrop.querySelector<HTMLButtonElement>("[data-dialog-confirm]")
        confirmButton?.addEventListener("click", () => finish(true))
        dialog.backdrop.querySelector("[data-dialog-cancel]")?.addEventListener("click", () => finish(false))
        dialog.backdrop.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                finish(false)
            } else if (event.key === "Enter") {
                event.preventDefault()
                event.stopPropagation()
                finish(true)
            }
        })
        window.setTimeout(() => confirmButton?.focus(), 30)
    })
}

export function requestChoice(options: DialogOptions & { choices: ChoiceOption[] }): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false
        const finish = (value: string | null) => {
            if (settled) return
            settled = true
            dialog.close()
            resolve(value)
        }
        const showFilter = options.choices.length > 6
        const dialog = mountDialog(`
            ${dialogHeader(options)}
            ${options.label ? `<div class="fx-field-label">${escapeHtml(options.label)}</div>` : ""}
            ${showFilter ? `<div class="fx-search fx-search--inline">${icon("search")}<input class="fx-search-input" data-choice-filter type="search" placeholder="Filter" autocomplete="off" /></div>` : ""}
            <div class="fx-choice-list" role="listbox" tabindex="0"></div>
            ${dialogActions(options, "Choose")}`, () => finish(null))
        const list = dialog.backdrop.querySelector<HTMLElement>(".fx-choice-list")!
        const filter = dialog.backdrop.querySelector<HTMLInputElement>("[data-choice-filter]")
        const confirmButton = dialog.backdrop.querySelector<HTMLButtonElement>("[data-dialog-confirm]")!
        let selectedValue: string | null = options.choices[0]?.value ?? null
        let visible = options.choices

        const render = () => {
            const query = filter?.value.trim().toLowerCase() ?? ""
            visible = query
                ? options.choices.filter((choice) => `${choice.label} ${choice.detail ?? ""}`.toLowerCase().includes(query))
                : options.choices
            if (!visible.some((choice) => choice.value === selectedValue)) {
                selectedValue = visible[0]?.value ?? null
            }
            list.innerHTML = visible.length
                ? visible.map((choice) => `
                    <button type="button" class="fx-choice${choice.value === selectedValue ? " is-selected" : ""}" role="option"
                        aria-selected="${choice.value === selectedValue}" data-value="${escapeHtml(choice.value)}">
                        <span class="fx-choice-icon">${icon(choice.icon ?? "folder")}</span>
                        <span class="fx-choice-text"><span class="fx-choice-label">${escapeHtml(choice.label)}</span>
                        ${choice.detail ? `<span class="fx-choice-detail">${escapeHtml(choice.detail)}</span>` : ""}</span>
                        <span class="fx-choice-check">${icon("check")}</span>
                    </button>`).join("")
                : `<div class="fx-choice-empty">No matches</div>`
            confirmButton.disabled = selectedValue === null
            list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" })
        }
        list.addEventListener("click", (event) => {
            const button = (event.target as HTMLElement).closest<HTMLElement>("[data-value]")
            if (!button) return
            selectedValue = button.dataset.value ?? null
            render()
        })
        list.addEventListener("dblclick", (event) => {
            const button = (event.target as HTMLElement).closest<HTMLElement>("[data-value]")
            if (button) finish(button.dataset.value ?? null)
        })
        filter?.addEventListener("input", render)
        confirmButton.addEventListener("click", () => finish(selectedValue))
        dialog.backdrop.querySelector("[data-dialog-cancel]")?.addEventListener("click", () => finish(null))
        dialog.backdrop.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                finish(null)
            } else if (event.key === "Enter") {
                event.preventDefault()
                event.stopPropagation()
                if (selectedValue !== null) finish(selectedValue)
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                const index = visible.findIndex((choice) => choice.value === selectedValue)
                const next = Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
                selectedValue = visible[next]?.value ?? selectedValue
                render()
            }
        })
        render()
        window.setTimeout(() => (filter ?? list).focus(), 30)
    })
}

/* ----------------------------------------------------- Menus and sheets */

export type MenuItem =
    | {
        id?: string
        label: string
        icon?: IconName
        hint?: string
        danger?: boolean
        disabled?: boolean
        onSelect: () => void | Promise<void>
    }
    | { divider: true }

export type MenuOptions = {
    anchor?: HTMLElement | { x: number; y: number }
    title?: string
    subtitle?: string
    headerHtml?: string
    items: MenuItem[]
    /** Force bottom-sheet presentation even on wide screens. */
    sheet?: boolean
    /** Called once the menu closes; `chosen` is true when an item was activated. */
    onClose?: (chosen: boolean) => void
}

let activeMenu: { close: () => void } | null = null

export function isMenuOpen() {
    return activeMenu !== null
}

export function closeMenu() {
    activeMenu?.close()
}

export function openMenu(options: MenuOptions) {
    closeMenu()
    const useSheet = options.sheet || isCompactViewport() || !options.anchor
    const layer = document.createElement("div")
    layer.className = `fx-menu-layer ${useSheet ? "is-sheet" : "is-popover"}`
    const header = options.title || options.headerHtml
        ? `<div class="fx-menu-header">${options.headerHtml ?? ""}<div class="fx-menu-titles">
                ${options.title ? `<div class="fx-menu-title">${escapeHtml(options.title)}</div>` : ""}
                ${options.subtitle ? `<div class="fx-menu-subtitle">${escapeHtml(options.subtitle)}</div>` : ""}
            </div></div>`
        : ""
    const items = options.items.map((item, index) => {
        if ("divider" in item) return `<div class="fx-menu-divider" role="separator"></div>`
        return `<button type="button" role="menuitem" class="fx-menu-item${item.danger ? " is-danger" : ""}"
            data-menu-index="${index}" ${item.id ? `id="${escapeHtml(item.id)}"` : ""} ${item.disabled ? "disabled" : ""}>
            ${item.icon ? icon(item.icon) : ""}<span class="fx-menu-label">${escapeHtml(item.label)}</span>
            ${item.hint ? `<kbd class="fx-menu-hint">${escapeHtml(item.hint)}</kbd>` : ""}
        </button>`
    }).join("")
    layer.innerHTML = `<div class="fx-menu" role="menu">${useSheet ? `<div class="fx-sheet-grip" aria-hidden="true"></div>` : ""}${header}<div class="fx-menu-items">${items}</div></div>`
    document.body.appendChild(layer)
    const menu = layer.querySelector<HTMLElement>(".fx-menu")!
    const previouslyFocused = document.activeElement as HTMLElement | null

    if (!useSheet && options.anchor) {
        const rect = options.anchor instanceof HTMLElement
            ? options.anchor.getBoundingClientRect()
            : new DOMRect(options.anchor.x, options.anchor.y, 0, 0)
        const menuRect = menu.getBoundingClientRect()
        const margin = 8
        let left = options.anchor instanceof HTMLElement ? rect.right - menuRect.width : rect.left
        let top = rect.bottom + 4
        if (left + menuRect.width > window.innerWidth - margin) left = window.innerWidth - margin - menuRect.width
        if (left < margin) left = margin
        if (top + menuRect.height > window.innerHeight - margin) {
            top = Math.max(margin, (options.anchor instanceof HTMLElement ? rect.top - 4 : rect.top) - menuRect.height)
        }
        menu.style.left = `${left}px`
        menu.style.top = `${top}px`
    }
    requestAnimationFrame(() => layer.classList.add("is-open"))

    let closed = false
    let chosen = false
    const close = () => {
        if (closed) return
        closed = true
        window.setTimeout(() => options.onClose?.(chosen), 0)
        activeMenu = null
        document.removeEventListener("keydown", onKey, true)
        window.removeEventListener("resize", close)
        layer.classList.remove("is-open")
        layer.classList.add("is-closing")
        window.setTimeout(() => layer.remove(), 160)
        if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true })
    }
    const buttons = () => Array.from(menu.querySelectorAll<HTMLButtonElement>(".fx-menu-item:not(:disabled)"))
    const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault()
            event.stopPropagation()
            close()
            return
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            event.stopPropagation()
            const list = buttons()
            const index = list.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === "ArrowDown" ? (index + 1) % list.length : (index - 1 + list.length) % list.length
            list[next]?.focus()
        }
    }
    document.addEventListener("keydown", onKey, true)
    window.addEventListener("resize", close)
    layer.addEventListener("mousedown", (event) => {
        if (event.target === layer) close()
    })
    layer.addEventListener("contextmenu", (event) => {
        event.preventDefault()
        if (event.target === layer) close()
    })
    layer.addEventListener("click", (event) => {
        if (event.target === layer) {
            close()
            return
        }
        const button = (event.target as HTMLElement).closest<HTMLElement>("[data-menu-index]")
        if (!button) return
        const item = options.items[Number(button.dataset.menuIndex)]
        if (!item || "divider" in item || item.disabled) return
        chosen = true
        close()
        void item.onSelect()
    })
    activeMenu = { close }
    if (!useSheet) buttons()[0]?.focus({ preventScroll: true })
    return close
}
