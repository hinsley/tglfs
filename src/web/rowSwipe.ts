/**
 * iOS-style swipe actions on list rows (touch only).
 *
 * Swipe left reveals More + Delete (a full swipe deletes, with the usual Undo toast); swipe right reveals Move.
 * Rows declare `touch-action: pan-y`, so the browser keeps vertical scrolling and hands horizontal travel to us;
 * the gesture additionally locks to one axis after a few pixels, so diagonal scrolls never swipe a row.
 * Long-press selection still works (it is cancelled by movement), taps still open, and swipes are disabled while
 * the browser is in selection mode.
 */
import { icon } from "./icons"
import {
    isFullSwipe,
    lockGestureAxis,
    swipeOffsetFor,
    swipeReleaseFor,
    type SwipeGeometry,
} from "./gestureMath"

export type RowSwipeHooks<E> = {
    entryForElement(element: HTMLElement): E | null
    canSwipe(entry: E): boolean
    isSelecting(): boolean
    /** Deletes the entry; resolves false when the user backed out (e.g. a folder delete confirmation). */
    onDelete(entry: E): Promise<boolean>
    onMore(entry: E, row: HTMLElement): void
    onMove(entry: E): void
}

const ACTION_WIDTH = 76
const SETTLE_MS = 260

function haptic(ms = 8) {
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
    if (activation && !activation.hasBeenActive) return
    try {
        navigator.vibrate?.(ms)
    } catch {}
}

type Swipe<E> = {
    row: HTMLElement
    entry: E
    under: HTMLElement
    lead: HTMLElement
    trail: HTMLElement
    geometry: SwipeGeometry
    startOffset: number
    offset: number
    full: "trailing" | "leading" | null
}

export function installRowSwipe<E>(container: HTMLElement, hooks: RowSwipeHooks<E>) {
    let gesture: {
        pointerId: number
        row: HTMLElement
        x: number
        y: number
        axis: "x" | "y" | null
        samples: Array<{ x: number; t: number }>
    } | null = null
    let active: Swipe<E> | null = null
    let open: Swipe<E> | null = null
    let swallowClickUntil = 0
    const live = new Set<Swipe<E>>()

    const setOffset = (swipe: Swipe<E>, offset: number, animate: boolean) => {
        swipe.offset = offset
        const transition = animate ? `transform ${SETTLE_MS}ms var(--ease)` : "none"
        swipe.row.style.transition = transition
        swipe.row.style.transform = offset === 0 ? "" : `translate3d(${offset}px, 0, 0)`
        swipe.trail.style.transition = animate ? `width ${SETTLE_MS}ms var(--ease)` : "none"
        swipe.lead.style.transition = swipe.trail.style.transition
        swipe.trail.style.width = `${Math.max(0, -offset)}px`
        swipe.lead.style.width = `${Math.max(0, offset)}px`
        swipe.under.dataset.side = offset < 0 ? "trailing" : offset > 0 ? "leading" : ""
        const full = isFullSwipe(offset, swipe.geometry)
        if (full !== swipe.full) {
            if (full) haptic(10)
            swipe.full = full
        }
        swipe.under.classList.toggle("is-full-trailing", full === "trailing")
        swipe.under.classList.toggle("is-full-leading", full === "leading")
    }

    const teardown = (swipe: Swipe<E>) => {
        live.delete(swipe)
        swipe.under.remove()
        swipe.row.classList.remove("is-swiping", "is-swipe-open")
        swipe.row.style.transition = ""
        swipe.row.style.transform = ""
        if (open === swipe) open = null
        if (active === swipe) active = null
    }

    const settle = (swipe: Swipe<E>, offset: number) => {
        setOffset(swipe, offset, true)
        if (offset === 0) {
            window.setTimeout(() => {
                if (swipe.offset === 0 && open !== swipe && active !== swipe) teardown(swipe)
            }, SETTLE_MS)
        }
    }

    const close = (swipe: Swipe<E> | null) => {
        if (!swipe) return
        if (open === swipe) open = null
        swipe.row.classList.remove("is-swipe-open")
        settle(swipe, 0)
    }

    const createSwipe = (row: HTMLElement, entry: E): Swipe<E> => {
        const under = document.createElement("div")
        under.className = "fx-swipe-under"
        under.setAttribute("aria-hidden", "true")
        under.innerHTML = `
            <div class="fx-swipe-lead">
                <button type="button" class="fx-swipe-btn is-move" data-swipe-action="move" tabindex="-1">${icon("move")}<span>Move</span></button>
            </div>
            <div class="fx-swipe-trail">
                <button type="button" class="fx-swipe-btn is-more" data-swipe-action="more" tabindex="-1">${icon("more")}<span>More</span></button>
                <button type="button" class="fx-swipe-btn is-delete" data-swipe-action="delete" tabindex="-1">${icon("trash")}<span>Delete</span></button>
            </div>`
        under.style.top = `${row.offsetTop}px`
        under.style.height = `${row.offsetHeight}px`
        container.appendChild(under)
        row.classList.add("is-swiping")
        const swipe: Swipe<E> = {
            row,
            entry,
            under,
            lead: under.querySelector<HTMLElement>(".fx-swipe-lead")!,
            trail: under.querySelector<HTMLElement>(".fx-swipe-trail")!,
            geometry: {
                width: row.offsetWidth,
                trailingWidth: ACTION_WIDTH * 2,
                leadingWidth: ACTION_WIDTH,
                fullSwipeRatio: 0.62,
            },
            startOffset: 0,
            offset: 0,
            full: null,
        }
        live.add(swipe)
        under.addEventListener("click", (event) => {
            const button = (event.target as HTMLElement).closest<HTMLElement>("[data-swipe-action]")
            if (!button) return
            event.stopPropagation()
            void runAction(swipe, button.dataset.swipeAction as "move" | "more" | "delete")
        })
        return swipe
    }

    const runAction = async (swipe: Swipe<E>, action: "move" | "more" | "delete") => {
        if (action === "delete") {
            setOffset(swipe, -swipe.geometry.width, true)
            swipe.row.classList.add("is-swipe-removing")
            const deleted = await hooks.onDelete(swipe.entry).catch(() => false)
            if (!deleted) {
                swipe.row.classList.remove("is-swipe-removing")
                close(swipe)
            } else if (swipe.row.isConnected) {
                // The row normally re-renders away; if it is still here (e.g. the delete was refused), restore it.
                window.setTimeout(() => {
                    if (!swipe.row.isConnected) return
                    swipe.row.classList.remove("is-swipe-removing")
                    close(swipe)
                }, 600)
            }
            return
        }
        close(swipe)
        if (action === "more") hooks.onMore(swipe.entry, swipe.row)
        else hooks.onMove(swipe.entry)
    }

    container.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" || !event.isPrimary) return
        const target = event.target as HTMLElement
        if (target.closest(".fx-swipe-under")) return
        const row = target.closest<HTMLElement>(".fx-row[data-browser-id]")
        if (open && open.row !== row) {
            // A touch anywhere else closes the open row (and does nothing else).
            close(open)
            swallowClickUntil = performance.now() + 700
            gesture = null
            return
        }
        if (!row || row.classList.contains("fx-skeleton") || hooks.isSelecting()) return
        gesture = { pointerId: event.pointerId, row, x: event.clientX, y: event.clientY, axis: null, samples: [{ x: event.clientX, t: event.timeStamp }] }
    })

    container.addEventListener("pointermove", (event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return
        const dx = event.clientX - gesture.x
        const dy = event.clientY - gesture.y
        gesture.samples.push({ x: event.clientX, t: event.timeStamp })
        if (gesture.samples.length > 6) gesture.samples.shift()
        if (gesture.axis === null) {
            gesture.axis = lockGestureAxis(dx, dy, 10)
            if (gesture.axis === null) return
            if (gesture.axis === "y" || hooks.isSelecting()) {
                gesture = null
                return
            }
            const entry = hooks.entryForElement(gesture.row)
            if (!entry || !hooks.canSwipe(entry)) {
                gesture = null
                return
            }
            if (open && open.row === gesture.row) {
                active = open
                open = null
                active.startOffset = active.offset
            } else {
                active = createSwipe(gesture.row, entry)
            }
            // Re-base so the row doesn't jump by the lock distance.
            gesture.x = event.clientX - (dx > 0 ? 10 : -10)
        }
        if (!active) return
        setOffset(active, swipeOffsetFor(active.startOffset, event.clientX - gesture.x, active.geometry), false)
    })

    const release = (event: PointerEvent, cancelled: boolean) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return
        const samples = gesture.samples
        gesture = null
        const swipe = active
        active = null
        if (!swipe) return
        swallowClickUntil = performance.now() + 700
        const first = samples[0]
        const last = samples[samples.length - 1]
        const velocity = last && first && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0
        const outcome = cancelled ? "close" : swipeReleaseFor(swipe.offset, velocity, swipe.geometry)
        swipe.startOffset = 0
        switch (outcome) {
            case "open-trailing":
                open = swipe
                swipe.row.classList.add("is-swipe-open")
                settle(swipe, -swipe.geometry.trailingWidth)
                break
            case "open-leading":
                open = swipe
                swipe.row.classList.add("is-swipe-open")
                settle(swipe, swipe.geometry.leadingWidth)
                break
            case "full-trailing":
                haptic(12)
                void runAction(swipe, "delete")
                break
            case "full-leading":
                void runAction(swipe, "move")
                break
            default:
                close(swipe)
        }
    }
    container.addEventListener("pointerup", (event) => {
        if (gesture && event.pointerId === gesture.pointerId && !active && open && gesture.row === open.row) {
            // Tapping the open row closes it instead of opening the item.
            gesture = null
            close(open)
            swallowClickUntil = performance.now() + 700
            return
        }
        release(event, false)
    })
    container.addEventListener("pointercancel", (event) => release(event, true))

    // Swallow the tap that ends a swipe (or closes an open row) so it doesn't open the item.
    window.addEventListener("click", (event) => {
        if (performance.now() < swallowClickUntil) {
            swallowClickUntil = 0
            if ((event.target as HTMLElement).closest(".fx-swipe-under")) return
            event.preventDefault()
            event.stopImmediatePropagation()
        }
    }, true)

    // Rows are re-rendered wholesale; drop swipe chrome that belongs to rows that are gone.
    new MutationObserver(() => {
        for (const swipe of Array.from(live)) {
            if (!swipe.row.isConnected) teardown(swipe)
        }
    }).observe(container, { childList: true })

    const closeOpen = () => close(open)
    document.getElementById("browserContent")?.addEventListener("scroll", closeOpen, { passive: true })
    window.addEventListener("resize", closeOpen)
    return { closeOpen }
}
