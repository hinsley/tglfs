/**
 * iOS-like pull to refresh for the file list (touch only).
 *
 * Uses Touch Events because the pull has to cancel the browser's own overscroll with `preventDefault()` on the
 * first `touchmove`, which pointer events can't do. It only engages when the list is scrolled to the very top and
 * the first movement is a downward pull; the list scroller is `overscroll-behavior: contain` (and the page
 * `overscroll-behavior-y: none`) so the browser's native pull-to-refresh never fires on top of ours.
 */
import { PULL_REFRESH_THRESHOLD, pullToRefreshState } from "./gestureMath"

export type PullToRefreshHooks = {
    /** False while pulling would be confusing (selection mode, inline rename, menus). */
    canPull(): boolean
    refresh(): Promise<void>
}

const HOLD_DISTANCE = 56

function haptic(ms = 10) {
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
    if (activation && !activation.hasBeenActive) return
    try {
        navigator.vibrate?.(ms)
    } catch {}
}

export function installPullToRefresh(scroller: HTMLElement, hooks: PullToRefreshHooks) {
    const indicator = document.createElement("div")
    indicator.className = "fx-ptr"
    indicator.setAttribute("aria-hidden", "true")
    indicator.innerHTML = `
        <div class="fx-ptr-disc">
            <svg class="fx-ptr-ring" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                <circle class="fx-ptr-track" cx="12" cy="12" r="8" />
                <circle class="fx-ptr-arc" cx="12" cy="12" r="8" pathLength="100" />
            </svg>
            <svg class="fx-ptr-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v10M8 13l4 4 4-4"/></svg>
        </div>`
    scroller.prepend(indicator)
    const status = document.createElement("div")
    status.className = "fx-visually-hidden"
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    scroller.appendChild(status)

    let start: { x: number; y: number; id: number } | null = null
    let pulling = false
    let armed = false
    let refreshing = false

    const render = (distance: number, progress: number, animate: boolean) => {
        scroller.classList.toggle("is-ptr-animating", animate)
        scroller.classList.toggle("is-pulling", distance > 0 || refreshing)
        scroller.style.setProperty("--ptr-y", `${distance.toFixed(1)}px`)
        scroller.style.setProperty("--ptr-progress", progress.toFixed(3))
        indicator.classList.toggle("is-armed", armed)
    }

    const reset = (animate = true) => {
        pulling = false
        armed = false
        render(0, 0, animate)
        window.setTimeout(() => {
            if (!pulling && !refreshing) scroller.classList.remove("is-pulling", "is-ptr-animating")
        }, 320)
    }

    scroller.addEventListener("touchstart", (event) => {
        if (refreshing || event.touches.length !== 1) {
            start = null
            return
        }
        if (scroller.scrollTop > 0 || !hooks.canPull()) {
            start = null
            return
        }
        const touch = event.touches[0]
        start = { x: touch.clientX, y: touch.clientY, id: touch.identifier }
        pulling = false
    }, { passive: true })

    scroller.addEventListener("touchmove", (event) => {
        if (!start || refreshing) return
        const touch = Array.from(event.touches).find((candidate) => candidate.identifier === start!.id)
        if (!touch || event.touches.length !== 1) {
            start = null
            if (pulling) reset()
            return
        }
        const dy = touch.clientY - start.y
        const dx = touch.clientX - start.x
        if (!pulling) {
            if (dy <= 0 || scroller.scrollTop > 0) {
                start = null
                return
            }
            if (Math.max(Math.abs(dx), dy) < 8) {
                // Too early to tell a pull from a sideways row swipe. Nothing can scroll up from the top anyway,
                // so hold the browser's overscroll while deciding.
                if (event.cancelable) event.preventDefault()
                return
            }
            // A downward, mostly vertical pull at the top starts a refresh gesture; sideways travel is a row swipe.
            if (Math.abs(dx) * 1.2 > dy) {
                start = null
                return
            }
            pulling = true
            indicator.classList.remove("is-refreshing")
        }
        if (event.cancelable) event.preventDefault()
        const state = pullToRefreshState(dy)
        if (state.armed !== armed) {
            armed = state.armed
            if (armed) haptic(10)
        }
        render(state.distance, state.progress, false)
    }, { passive: false })

    const end = async () => {
        if (!start) return
        start = null
        if (!pulling) return
        pulling = false
        if (!armed) {
            reset()
            return
        }
        armed = false
        refreshing = true
        indicator.classList.add("is-refreshing")
        status.textContent = "Refreshing…"
        render(HOLD_DISTANCE, 1, true)
        const began = performance.now()
        try {
            await hooks.refresh()
        } finally {
            // Keep the spinner up long enough to read as feedback even when the refresh is instant.
            const remaining = 450 - (performance.now() - began)
            if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining))
            refreshing = false
            indicator.classList.remove("is-refreshing")
            status.textContent = "Updated"
            reset()
        }
    }
    scroller.addEventListener("touchend", () => void end(), { passive: true })
    scroller.addEventListener("touchcancel", () => {
        start = null
        if (pulling) reset()
    }, { passive: true })

    return { threshold: PULL_REFRESH_THRESHOLD }
}
