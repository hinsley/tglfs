/**
 * Drag to move (desktop, mouse) for the file browser.
 *
 * Built on Pointer Events rather than native HTML5 drag and drop:
 * - OS file drops (drag-and-drop upload) keep using the HTML5 DnD events in `initFileBrowser`; internal drags never
 *   produce DnD events, so the two can't be confused (no "Files" type sniffing, no upload overlay flicker).
 * - The ghost is a real element we fully control ("3 items" badge, live drop hint), instead of a static
 *   `setDragImage` bitmap that browsers render inconsistently.
 * - Auto-scroll, Esc-to-cancel and the not-allowed state behave identically in every desktop browser.
 * - Rows don't need `draggable`, so clicks, double-clicks, range selection and the context menu are untouched: a
 *   press only becomes a drag after the pointer travels a few pixels.
 */
import { autoScrollStep, describeDragCount, dropVerdict, exceedsDragThreshold, type DropVerdict } from "./gestureMath"
import { escapeHtml } from "./dialogs"

export const DRAG_ROOT_TARGET = "__tglfs-root__"

export type DragMoveTarget = {
    /** Folder id, or DRAG_ROOT_TARGET for "All files". */
    folderId: string
    label: string
    element: HTMLElement
}

export type DragMoveHooks<E> = {
    /** The browser entry rendered by a row/tile, or null when it can't be dragged. */
    entryForElement(element: HTMLElement): E | null
    idOf(entry: E): string
    /** Entries carried by a drag that starts on `entry` (the selection when `entry` is selected). */
    beginDrag(entry: E): E[]
    describe(entries: E[]): { iconHtml: string; name: string }
    /** Folder id of a folder entry (null for files). */
    folderIdOf(entry: E): string | null
    folderNameOf(entry: E): string
    /** Folder currently shown (DRAG_ROOT_TARGET for "All files"). */
    currentFolderId(): string
    /** Folder ids from the top level down to the current folder. */
    currentTrailIds(): string[]
    drop(entries: E[], target: DragMoveTarget): void | Promise<void>
    /** True while something else owns the pointer (dialogs, inline rename, preview). */
    isBlocked(): boolean
}

const ROW_SELECTOR = "#browserRows [data-browser-id], #browserGrid [data-browser-id]"
const IGNORE_SELECTOR = ".fx-check, .fx-more, input, textarea, select, a, .fx-rename"

type Pending = { pointerId: number; x: number; y: number; element: HTMLElement }

type ActiveDrag<E> = {
    pointerId: number
    entries: E[]
    folderIds: Set<string>
    sources: HTMLElement[]
    ghost: HTMLElement
    hint: HTMLElement
    captureElement: HTMLElement
    x: number
    y: number
    target: DragMoveTarget | null
    verdict: DropVerdict | null
    hoverElement: HTMLElement | null
    frame: number
}

let activeDragFlag = false

/** True while an internal drag is in progress (other handlers should stand down). */
export function isDragMoveActive() {
    return activeDragFlag
}

export function installDragMove<E>(hooks: DragMoveHooks<E>) {
    const scroller = document.getElementById("browserContent")
    let pending: Pending | null = null
    let drag: ActiveDrag<E> | null = null
    let swallowClickUntil = 0

    const hintFor = (verdict: DropVerdict | null, target: DragMoveTarget | null) => {
        if (!target || !verdict) return ""
        if (verdict === "ok") return `Move to ${target.label}`
        if (verdict === "current") return "Already here"
        return "Can't move a folder into itself"
    }

    const resolveTarget = (element: Element | null, current: ActiveDrag<E>): { target: DragMoveTarget; verdict: DropVerdict } | null => {
        if (!element) return null
        const trail = hooks.currentTrailIds()
        const crumb = element.closest<HTMLElement>(".fx-crumb[data-crumb-id]")
        if (crumb) {
            const folderId = crumb.dataset.crumbId === "root" ? DRAG_ROOT_TARGET : crumb.dataset.crumbId!
            const position = folderId === DRAG_ROOT_TARGET ? -1 : trail.indexOf(folderId)
            const target = { folderId, label: crumb.textContent?.trim() || "this folder", element: crumb }
            return {
                target,
                verdict: dropVerdict({
                    draggedFolderIds: current.folderIds,
                    sourceFolderId: hooks.currentFolderId(),
                    targetFolderId: folderId,
                    targetAncestorIds: position > 0 ? trail.slice(0, position) : [],
                }),
            }
        }
        const navAll = element.closest<HTMLElement>("#navAllFiles")
        if (navAll) {
            return {
                target: { folderId: DRAG_ROOT_TARGET, label: "All files", element: navAll },
                verdict: dropVerdict({
                    draggedFolderIds: current.folderIds,
                    sourceFolderId: hooks.currentFolderId(),
                    targetFolderId: DRAG_ROOT_TARGET,
                }),
            }
        }
        const node = element.closest<HTMLElement>(ROW_SELECTOR)
        if (!node || node.dataset.kind !== "folder") return null
        const entry = hooks.entryForElement(node)
        const folderId = entry ? hooks.folderIdOf(entry) : null
        if (!entry || !folderId) return null
        return {
            target: { folderId, label: hooks.folderNameOf(entry), element: node },
            verdict: dropVerdict({
                draggedFolderIds: current.folderIds,
                sourceFolderId: hooks.currentFolderId(),
                targetFolderId: folderId,
                targetAncestorIds: [...trail, hooks.currentFolderId()],
            }),
        }
    }

    const paintTarget = (current: ActiveDrag<E>) => {
        const hit = document.elementFromPoint(current.x, current.y)
        const resolved = resolveTarget(hit, current)
        const element = resolved?.target.element ?? null
        if (current.hoverElement !== element) {
            current.hoverElement?.classList.remove("is-drop-target", "is-drop-invalid")
            current.hoverElement = element
        }
        current.target = resolved?.target ?? null
        current.verdict = resolved?.verdict ?? null
        const valid = current.verdict === "ok"
        element?.classList.toggle("is-drop-target", valid)
        element?.classList.toggle("is-drop-invalid", !!element && !valid)
        document.body.classList.toggle("fx-drag-invalid", !!element && !valid)
        current.ghost.classList.toggle("is-valid", valid)
        current.ghost.classList.toggle("is-invalid", !!element && !valid)
        const hint = hintFor(current.verdict, current.target)
        current.hint.textContent = hint
        current.hint.toggleAttribute("hidden", !hint)
    }

    const positionGhost = (current: ActiveDrag<E>) => {
        current.ghost.style.transform = `translate3d(${Math.round(current.x + 14)}px, ${Math.round(current.y + 16)}px, 0)`
    }

    const tick = () => {
        const current = drag
        if (!current) return
        if (scroller) {
            const rect = scroller.getBoundingClientRect()
            const step = autoScrollStep(current.y, rect.top, rect.bottom)
            const insideX = current.x >= rect.left && current.x <= rect.right
            if (step !== 0 && insideX) {
                const before = scroller.scrollTop
                scroller.scrollTop += step
                if (scroller.scrollTop !== before) paintTarget(current)
            }
        }
        current.frame = requestAnimationFrame(tick)
    }

    const start = (state: Pending, event: PointerEvent) => {
        const entry = hooks.entryForElement(state.element)
        if (!entry) return false
        const entries = hooks.beginDrag(entry)
        if (entries.length === 0) return false
        const { iconHtml, name } = hooks.describe(entries)
        const ghost = document.createElement("div")
        ghost.className = `fx-drag-ghost${entries.length > 1 ? " fx-drag-ghost--stack" : ""}`
        ghost.setAttribute("aria-hidden", "true")
        ghost.innerHTML = `
            <div class="fx-drag-ghost-card">
                ${iconHtml}
                <span class="fx-drag-ghost-name">${escapeHtml(entries.length === 1 ? name : describeDragCount(entries.length))}</span>
            </div>
            <div class="fx-drag-ghost-hint" hidden></div>`
        document.body.appendChild(ghost)
        const ids = new Set(entries.map((candidate) => hooks.idOf(candidate)))
        const sources = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR))
            .filter((node) => ids.has(node.dataset.browserId ?? ""))
        sources.forEach((node) => node.classList.add("is-drag-source"))
        try {
            state.element.setPointerCapture(event.pointerId)
        } catch {}
        drag = {
            pointerId: event.pointerId,
            entries,
            folderIds: new Set(entries.map((candidate) => hooks.folderIdOf(candidate)).filter((id): id is string => !!id)),
            sources,
            ghost,
            hint: ghost.querySelector<HTMLElement>(".fx-drag-ghost-hint")!,
            captureElement: state.element,
            x: event.clientX,
            y: event.clientY,
            target: null,
            verdict: null,
            hoverElement: null,
            frame: 0,
        }
        activeDragFlag = true
        document.body.classList.add("fx-dragging")
        window.getSelection()?.removeAllRanges()
        positionGhost(drag)
        paintTarget(drag)
        drag.frame = requestAnimationFrame(tick)
        return true
    }

    const finish = (commit: boolean) => {
        const current = drag
        drag = null
        pending = null
        activeDragFlag = false
        if (!current) return
        cancelAnimationFrame(current.frame)
        try {
            current.captureElement.releasePointerCapture(current.pointerId)
        } catch {}
        current.hoverElement?.classList.remove("is-drop-target", "is-drop-invalid")
        current.sources.forEach((node) => node.classList.remove("is-drag-source"))
        document.body.classList.remove("fx-dragging", "fx-drag-invalid")
        swallowClickUntil = performance.now() + 400
        const dropped = commit && current.target && current.verdict === "ok"
        if (dropped) {
            current.ghost.classList.add("is-dropping")
            current.target!.element.classList.add("is-drop-accepted")
            const accepted = current.target!.element
            window.setTimeout(() => accepted.classList.remove("is-drop-accepted"), 500)
            window.setTimeout(() => current.ghost.remove(), 160)
            void hooks.drop(current.entries, current.target!)
        } else {
            current.ghost.classList.add("is-cancelled")
            window.setTimeout(() => current.ghost.remove(), 160)
        }
    }

    document.addEventListener("pointerdown", (event) => {
        swallowClickUntil = 0
        if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
        const target = event.target as HTMLElement | null
        if (!target || target.closest(IGNORE_SELECTOR)) return
        const element = target.closest<HTMLElement>(ROW_SELECTOR)
        if (!element || element.classList.contains("fx-skeleton") || hooks.isBlocked()) return
        pending = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, element }
    }, true)

    document.addEventListener("pointermove", (event) => {
        if (drag && event.pointerId === drag.pointerId) {
            drag.x = event.clientX
            drag.y = event.clientY
            positionGhost(drag)
            paintTarget(drag)
            return
        }
        if (!pending || event.pointerId !== pending.pointerId) return
        if ((event.buttons & 1) === 0) {
            pending = null
            return
        }
        if (!exceedsDragThreshold(event.clientX - pending.x, event.clientY - pending.y, 6)) return
        const state = pending
        pending = null
        if (hooks.isBlocked()) return
        if (start(state, event)) event.preventDefault()
    }, true)

    document.addEventListener("pointerup", (event) => {
        if (drag && event.pointerId === drag.pointerId) {
            drag.x = event.clientX
            drag.y = event.clientY
            paintTarget(drag)
            finish(true)
            return
        }
        pending = null
    }, true)

    document.addEventListener("pointercancel", (event) => {
        if (drag && event.pointerId === drag.pointerId) finish(false)
        pending = null
    }, true)

    window.addEventListener("blur", () => {
        if (drag) finish(false)
        pending = null
    })

    // Esc cancels; capture so the browser's own Escape handling (clear selection) doesn't also run.
    window.addEventListener("keydown", (event) => {
        if (!drag) return
        if (event.key === "Escape") {
            event.preventDefault()
            event.stopImmediatePropagation()
            finish(false)
        }
    }, true)

    // The click that follows a drag must not change the selection or open anything.
    window.addEventListener("click", (event) => {
        if (performance.now() < swallowClickUntil) {
            swallowClickUntil = 0
            event.preventDefault()
            event.stopImmediatePropagation()
        }
    }, true)

    // A press on a row may turn into a drag: text selection can't start (e.g. sweeping across the sidebar).
    document.addEventListener("selectstart", (event) => {
        if (drag || pending) event.preventDefault()
    }, true)
}
