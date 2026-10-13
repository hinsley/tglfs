/**
 * Animated folder navigation with the View Transitions API.
 *
 * Entering a folder slides the listing forward, going up/back slides it backward, and breadcrumb segments morph
 * into place (each crumb gets a stable `view-transition-name` derived from its folder id). The transition captures
 * the old listing and the *loading skeleton* the navigation renders synchronously; data that arrives later just
 * renders normally (the new side of a view transition is live), followed by a short fade-in.
 *
 * Feature-detected and skipped under `prefers-reduced-motion`. The update callback only does the synchronous part
 * of the navigation (never waits for the network), so rendering is paused for a single frame at most; the animation
 * is short and any pointer/wheel input skips straight to its end.
 */

export type NavDirection = "forward" | "back" | "none"

/** Compares folder-id trails: deeper is forward, shallower is back, same depth (a sibling jump) is a plain swap. */
export function navigationDirection(from: readonly string[], to: readonly string[]): NavDirection {
    if (from.length === to.length) {
        return from.every((id, index) => id === to[index]) ? "none" : "forward"
    }
    return to.length > from.length ? "forward" : "back"
}

function reducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function folderTransitionsSupported() {
    return typeof document !== "undefined" && typeof (document as any).startViewTransition === "function" && !reducedMotion()
}

function crumbTransitionName(id: string) {
    return `fx-crumb-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

/** Gives every breadcrumb segment a unique, stable transition name so segments morph between locations. */
function tagCrumbs() {
    const seen = new Set<string>()
    document.querySelectorAll<HTMLElement>("#browserBreadcrumb .fx-crumb[data-crumb-id]").forEach((crumb) => {
        const name = crumbTransitionName(crumb.dataset.crumbId ?? "")
        if (seen.has(name)) {
            crumb.style.removeProperty("view-transition-name")
            return
        }
        seen.add(name)
        crumb.style.setProperty("view-transition-name", name)
        crumb.style.setProperty("view-transition-class", "fx-crumb")
    })
}

let transitionSerial = 0
let activeTransition: { skipTransition(): void } | null = null
let skipListenersInstalled = false

/**
 * While a view transition animates, the browser hit-tests the document element instead of the page. Any pointer
 * or wheel input therefore ends the animation at once, so the next interaction is never held up.
 */
function installSkipOnInput() {
    if (skipListenersInstalled) return
    skipListenersInstalled = true
    const skip = () => activeTransition?.skipTransition()
    window.addEventListener("pointerdown", skip, { capture: true, passive: true })
    window.addEventListener("wheel", skip, { capture: true, passive: true })
}

/**
 * Runs `navigate` (whose synchronous part must render the next location, e.g. the loading skeleton) inside a view
 * transition. Resolves with `navigate`'s result.
 */
export function runFolderTransition<T>(direction: NavDirection, navigate: () => Promise<T>): Promise<T> {
    if (direction === "none" || !folderTransitionsSupported() || document.visibilityState !== "visible") {
        return navigate()
    }
    const root = document.documentElement
    const serial = ++transitionSerial
    root.dataset.fxNav = direction
    tagCrumbs()
    let result: Promise<T> | null = null
    let transition: { updateCallbackDone: Promise<void>; finished: Promise<void>; skipTransition(): void }
    installSkipOnInput()
    try {
        transition = (document as any).startViewTransition(() => {
            result = navigate()
            tagCrumbs()
        })
    } catch {
        delete root.dataset.fxNav
        return result ?? navigate()
    }
    activeTransition = transition
    transition.finished
        .catch(() => undefined)
        .finally(() => {
            if (activeTransition === transition) activeTransition = null
            if (serial === transitionSerial) delete root.dataset.fxNav
        })
    return transition.updateCallbackDone.then(
        () => result!,
        () => result ?? navigate(),
    )
}

/**
 * Adds a short fade-in when real rows replace the loading skeleton (the content area's `aria-busy` flips from
 * "true" to "false").
 */
export function installContentReveal(content: HTMLElement) {
    let busy = content.getAttribute("aria-busy") === "true"
    let timer: number | undefined
    new MutationObserver(() => {
        const nowBusy = content.getAttribute("aria-busy") === "true"
        if (busy && !nowBusy && !reducedMotion()) {
            content.classList.remove("is-revealing")
            void content.offsetWidth
            content.classList.add("is-revealing")
            window.clearTimeout(timer)
            timer = window.setTimeout(() => content.classList.remove("is-revealing"), 400)
        }
        busy = nowBusy
    }).observe(content, { attributes: true, attributeFilter: ["aria-busy"] })
}
