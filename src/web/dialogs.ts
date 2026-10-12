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
