/**
 * Pure decision helpers for pointer/touch interactions in the file browser (drag to move, swipe actions,
 * pull to refresh, slow-click rename). No DOM access, so node tests can cover them.
 */

/* ------------------------------------------------------------ Direction */

export type GestureAxis = "x" | "y"

/**
 * Locks a gesture to one axis once it has moved past `slop` pixels. Horizontal needs to clearly dominate
 * (a 1.2:1 ratio) so slightly diagonal scrolls keep scrolling instead of swiping a row.
 */
export function lockGestureAxis(dx: number, dy: number, slop = 10): GestureAxis | null {
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    if (Math.max(ax, ay) < slop) return null
    return ax > ay * 1.2 ? "x" : "y"
}

/** A mouse press becomes a drag only after it travels this far (keeps clicks and double-clicks intact). */
export function exceedsDragThreshold(dx: number, dy: number, threshold = 5): boolean {
    return dx * dx + dy * dy >= threshold * threshold
}

/** iOS-style rubber band: displacement grows ever more slowly past the natural range, approaching `limit`. */
export function rubberBand(distance: number, limit: number, coefficient = 0.55): number {
    if (distance <= 0 || limit <= 0) return 0
    return (1 - 1 / ((distance * coefficient) / limit + 1)) * limit
}

/* --------------------------------------------------------- Swipe actions */

export type SwipeGeometry = {
    /** Row width in px. */
    width: number
    /** Width of the actions revealed by swiping left (trailing actions, e.g. More + Delete). */
    trailingWidth: number
    /** Width of the actions revealed by swiping right (leading actions, e.g. Move). */
    leadingWidth: number
    /** Fraction of the row width past which releasing performs the full-swipe action. */
    fullSwipeRatio?: number
}

export type SwipeRelease = "close" | "open-trailing" | "open-leading" | "full-trailing" | "full-leading"

function fullSwipeDistance(geometry: SwipeGeometry) {
    return Math.max(geometry.trailingWidth, geometry.leadingWidth, geometry.width * (geometry.fullSwipeRatio ?? 0.6))
}

/**
 * Maps the finger's horizontal travel to the row offset. `startOffset` is where the row rested when the gesture
 * began (0, -trailingWidth or +leadingWidth). Travel past the row width rubber-bands.
 */
export function swipeOffsetFor(startOffset: number, dx: number, geometry: SwipeGeometry): number {
    const raw = startOffset + dx
    if (raw < 0 && geometry.trailingWidth <= 0) return -rubberBand(-raw, 24)
    if (raw > 0 && geometry.leadingWidth <= 0) return rubberBand(raw, 24)
    const limit = geometry.width
    if (raw < -limit) return -(limit + rubberBand(-raw - limit, 40))
    if (raw > limit) return limit + rubberBand(raw - limit, 40)
    return raw
}

/** True while the row is pulled far enough that letting go performs the full-swipe action. */
export function isFullSwipe(offset: number, geometry: SwipeGeometry): "trailing" | "leading" | null {
    const distance = fullSwipeDistance(geometry)
    if (offset <= -distance && geometry.trailingWidth > 0) return "trailing"
    if (offset >= distance && geometry.leadingWidth > 0) return "leading"
    return null
}

/**
 * Decides where a released row settles. `velocity` is px/ms (negative = moving left). A quick flick opens the
 * actions even when the row travelled less than half their width; a flick the other way closes them.
 */
export function swipeReleaseFor(offset: number, velocity: number, geometry: SwipeGeometry): SwipeRelease {
    const full = isFullSwipe(offset, geometry)
    if (full === "trailing") return "full-trailing"
    if (full === "leading") return "full-leading"
    const flick = 0.45
    if (offset < 0 && geometry.trailingWidth > 0) {
        if (velocity > flick) return "close"
        if (offset <= -geometry.trailingWidth / 2 || (velocity < -flick && offset < -16)) return "open-trailing"
        return "close"
    }
    if (offset > 0 && geometry.leadingWidth > 0) {
        if (velocity < -flick) return "close"
        if (offset >= geometry.leadingWidth / 2 || (velocity > flick && offset > 16)) return "open-leading"
        return "close"
    }
    return "close"
}

/* ------------------------------------------------------- Pull to refresh */

export const PULL_REFRESH_THRESHOLD = 64
export const PULL_REFRESH_MAX = 132

/** Converts finger travel into the indicator's displayed distance and whether releasing would refresh. */
export function pullToRefreshState(fingerTravel: number, threshold = PULL_REFRESH_THRESHOLD, max = PULL_REFRESH_MAX) {
    const distance = rubberBand(Math.max(0, fingerTravel), max, 0.9)
    return {
        distance,
        progress: Math.min(1, distance / threshold),
        armed: distance >= threshold,
    }
}

/* --------------------------------------------------------- Drag to move */

/** Px per frame to auto-scroll while dragging near the top/bottom edge of the list (0 when not near an edge). */
export function autoScrollStep(pointerY: number, top: number, bottom: number, edge = 56, maxStep = 18): number {
    if (bottom - top <= edge * 2) return 0
    if (pointerY < top + edge) {
        const depth = Math.min(1, (top + edge - pointerY) / edge)
        return -Math.ceil(depth * depth * maxStep)
    }
    if (pointerY > bottom - edge) {
        const depth = Math.min(1, (pointerY - (bottom - edge)) / edge)
        return Math.ceil(depth * depth * maxStep)
    }
    return 0
}

export type DropVerdict = "ok" | "self" | "descendant" | "current"

export type DropCheck = {
    /** Folder ids among the dragged entries. */
    draggedFolderIds: ReadonlySet<string>
    /** Folder the dragged entries currently live in (the root sentinel for "All files"). */
    sourceFolderId: string
    /** Drop target folder id (the root sentinel for "All files"). */
    targetFolderId: string
    /** Known ancestors of the target, nearest last (e.g. the breadcrumb trail). Used to spot descendants. */
    targetAncestorIds?: readonly string[]
}

/** Whether entries may be dropped on a folder: never onto themselves, into their own subtree, or where they are. */
export function dropVerdict(check: DropCheck): DropVerdict {
    if (check.draggedFolderIds.has(check.targetFolderId)) return "self"
    if (check.targetAncestorIds?.some((id) => check.draggedFolderIds.has(id))) return "descendant"
    if (check.targetFolderId === check.sourceFolderId) return "current"
    return "ok"
}

export function describeDragCount(count: number): string {
    return count === 1 ? "1 item" : `${count} items`
}

/* ----------------------------------------------------- Slow-click rename */

export const SLOW_CLICK_RENAME_DELAY_MS = 520

/**
 * Finder-style "click the name of the already selected item again" detection. The press must be a plain single
 * click on the only selected entry, which was already selected before this press for longer than a double-click.
 */
export function isSlowRenameClick(input: {
    wasSoleSelectionAtPress: boolean
    selectedForMs: number
    clickCount: number
    modifier: boolean
    onName: boolean
}): boolean {
    return input.wasSoleSelectionAtPress &&
        input.onName &&
        !input.modifier &&
        input.clickCount === 1 &&
        input.selectedForMs >= SLOW_CLICK_RENAME_DELAY_MS
}

/* --------------------------------------------------------- Inline rename */

export type RenameValidation = { ok: true; name: string } | { ok: false; message: string }

/**
 * Validates an inline rename. Folder names follow the same rules as `validateFolderName` in the browser; file and
 * folder names must not collide (case-insensitively) with siblings in the listing.
 */
export function validateEntryName(input: {
    value: string
    kind: "file" | "folder"
    currentName: string
    siblingNames: Iterable<string>
}): RenameValidation {
    const name = input.value.trim()
    if (!name) return { ok: false, message: "Name can't be empty" }
    if (input.kind === "folder") {
        if (name === "." || name === "..") return { ok: false, message: `“${name}” isn't a valid folder name` }
        if (/[\\/]/.test(name)) return { ok: false, message: "Folder names can't contain / or \\" }
    }
    if (/[\u0000-\u001f]/.test(name)) return { ok: false, message: "Names can't contain control characters" }
    if (name === input.currentName) return { ok: true, name }
    const lower = name.toLowerCase()
    const currentLower = input.currentName.toLowerCase()
    for (const sibling of input.siblingNames) {
        const siblingLower = sibling.toLowerCase()
        if (siblingLower === lower && siblingLower !== currentLower) {
            return { ok: false, message: `“${name}” already exists in this folder` }
        }
    }
    return { ok: true, name }
}

/** Selection range covering the file stem ("report" in "report.final.pdf" → up to the last dot). */
export function stemSelectionRange(name: string, kind: "file" | "folder"): [number, number] {
    if (kind === "folder") return [0, name.length]
    const dot = name.lastIndexOf(".")
    return dot > 0 ? [0, dot] : [0, name.length]
}
