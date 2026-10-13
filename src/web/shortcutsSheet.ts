// Keyboard shortcuts cheat sheet ("?"). The list mirrors browser.ts `handleKeydown` plus the command palette
// and paste-to-upload; keep them in sync when adding shortcuts.
import { escapeHtml } from "./dialogs"
import { icon } from "./icons"

export type ShortcutItem = { keys: string[][]; label: string }
export type ShortcutGroup = { title: string; items: ShortcutItem[] }

export function isApplePlatform() {
    return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/** `keys` is a list of alternatives; each alternative is a chord of keys pressed together. */
export function shortcutGroups(apple = isApplePlatform()): ShortcutGroup[] {
    const mod = apple ? "⌘" : "Ctrl"
    const alt = apple ? "⌥" : "Alt"
    return [
        {
            title: "General",
            items: [
                { keys: [[mod, "K"]], label: "Command palette" },
                { keys: [["/"]], label: "Search" },
                { keys: [["?"]], label: "Keyboard shortcuts" },
                { keys: [[mod, "V"]], label: "Paste files to upload" },
                { keys: [[mod, "Z"]], label: "Undo the last change" },
                { keys: [["Esc"]], label: "Clear selection or close" },
            ],
        },
        {
            title: "Navigate",
            items: [
                { keys: [["↑"], ["↓"]], label: "Move between items" },
                { keys: [["←"], ["→"]], label: "Move across the grid" },
                { keys: [["Enter"]], label: "Open folder or preview" },
                { keys: [["Backspace"], [alt, "↑"]], label: "Up one level" },
                { keys: [["H"]], label: "Folder history (time machine)" },
                { keys: [["↓"]], label: "Jump from search to results" },
            ],
        },
        {
            title: "Select",
            items: [
                { keys: [["Shift", "↑"], ["Shift", "↓"]], label: "Extend the selection" },
                { keys: [[mod, "A"]], label: "Select all on this page" },
                { keys: [["Shift", "Click"]], label: "Select a range" },
                { keys: [[mod, "Click"]], label: "Add or remove an item" },
            ],
        },
        {
            title: "Selected items",
            items: [
                { keys: [["F2"]], label: "Rename" },
                { keys: [["Delete"], [mod, "⌫"]], label: "Delete" },
                { keys: [["Right-click"]], label: "More actions" },
            ],
        },
        {
            title: "Preview",
            items: [
                { keys: [["←"], ["→"]], label: "Previous or next file" },
                { keys: [["Esc"]], label: "Close preview" },
            ],
        },
    ]
}

function keysHtml(keys: string[][]) {
    return keys.map((chord) =>
        `<span class="fx-keys-chord">${chord.map((key) => `<kbd class="fx-kbd">${escapeHtml(key)}</kbd>`).join("")}</span>`,
    ).join(`<span class="fx-keys-or">or</span>`)
}

let closeActive: (() => void) | null = null

export function isShortcutsSheetOpen() {
    return closeActive !== null
}

export function closeShortcutsSheet() {
    closeActive?.()
}

export function openShortcutsSheet() {
    if (closeActive) return
    const backdrop = document.createElement("div")
    backdrop.className = "fx-dialog-backdrop fx-shortcuts-backdrop"
    const groups = shortcutGroups()
    backdrop.innerHTML = `
        <div class="fx-dialog fx-shortcuts" role="dialog" aria-modal="true" aria-labelledby="fxShortcutsTitle">
            <div class="fx-shortcuts-head">
                <span class="fx-dialog-icon">${icon("keyboard")}</span>
                <div class="fx-dialog-titles">
                    <h2 id="fxShortcutsTitle">Keyboard shortcuts</h2>
                    <p>Press <kbd class="fx-kbd">?</kbd> anytime to bring this back.</p>
                </div>
                <button type="button" class="fx-icon-btn fx-shortcuts-close" aria-label="Close" title="Close (Esc)">${icon("close")}</button>
            </div>
            <div class="fx-shortcuts-body">
                ${groups.map((group) => `
                    <section class="fx-shortcuts-group">
                        <h3>${escapeHtml(group.title)}</h3>
                        <dl>
                            ${group.items.map((item) => `
                                <div class="fx-shortcuts-row">
                                    <dt>${escapeHtml(item.label)}</dt>
                                    <dd>${keysHtml(item.keys)}</dd>
                                </div>`).join("")}
                        </dl>
                    </section>`).join("")}
            </div>
        </div>`
    const previouslyFocused = document.activeElement as HTMLElement | null
    document.body.appendChild(backdrop)
    requestAnimationFrame(() => backdrop.classList.add("is-open"))

    const close = () => {
        if (closeActive !== close) return
        closeActive = null
        document.removeEventListener("keydown", onKey, true)
        backdrop.classList.remove("is-open")
        window.setTimeout(() => backdrop.remove(), 160)
        previouslyFocused?.focus?.({ preventScroll: true })
    }
    const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape" || event.key === "?") {
            event.preventDefault()
            event.stopPropagation()
            close()
        }
    }
    closeActive = close
    document.addEventListener("keydown", onKey, true)
    backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) close()
    })
    const closeButton = backdrop.querySelector<HTMLButtonElement>(".fx-shortcuts-close")
    closeButton?.addEventListener("click", close)
    window.setTimeout(() => closeButton?.focus({ preventScroll: true }), 30)
}
