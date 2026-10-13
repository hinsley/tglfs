import assert from "node:assert/strict"
import { test } from "node:test"

import {
    autoScrollStep,
    describeDragCount,
    dropVerdict,
    exceedsDragThreshold,
    isFullSwipe,
    isSlowRenameClick,
    lockGestureAxis,
    pullToRefreshState,
    PULL_REFRESH_THRESHOLD,
    rubberBand,
    SLOW_CLICK_RENAME_DELAY_MS,
    stemSelectionRange,
    swipeOffsetFor,
    swipeReleaseFor,
    validateEntryName,
    type SwipeGeometry,
} from "../../../src/web/gestureMath.ts"
import { navigationDirection } from "../../../src/web/folderTransitions.ts"

const ROOT = "__tglfs-root__"
const geometry: SwipeGeometry = { width: 360, trailingWidth: 152, leadingWidth: 76, fullSwipeRatio: 0.62 }

test("axis lock waits for the slop and needs a clearly horizontal swipe", () => {
    assert.equal(lockGestureAxis(4, 3), null)
    assert.equal(lockGestureAxis(-14, 2), "x")
    assert.equal(lockGestureAxis(2, 14), "y")
    // Diagonal travel keeps scrolling rather than swiping the row.
    assert.equal(lockGestureAxis(12, 11), "y")
    assert.equal(lockGestureAxis(20, 10), "x")
})

test("mouse presses only become drags past the threshold", () => {
    assert.equal(exceedsDragThreshold(3, 3), false)
    assert.equal(exceedsDragThreshold(5, 0), true)
    assert.equal(exceedsDragThreshold(0, -6, 6), true)
})

test("rubber band grows monotonically and never exceeds its limit", () => {
    assert.equal(rubberBand(0, 100), 0)
    assert.equal(rubberBand(-20, 100), 0)
    let previous = 0
    for (const distance of [10, 50, 100, 400, 4000]) {
        const value = rubberBand(distance, 100)
        assert.ok(value > previous)
        assert.ok(value < 100)
        previous = value
    }
})

test("swipe offsets follow the finger inside the row and resist beyond it", () => {
    assert.equal(swipeOffsetFor(0, -80, geometry), -80)
    assert.equal(swipeOffsetFor(-152, 40, geometry), -112)
    const past = swipeOffsetFor(0, -500, geometry)
    assert.ok(past < -360 && past > -400, String(past))
    // No leading actions: right travel only rubber-bands a little.
    const noLeading = swipeOffsetFor(0, 200, { ...geometry, leadingWidth: 0 })
    assert.ok(noLeading > 0 && noLeading < 24, String(noLeading))
})

test("full swipe triggers past the configured share of the row width", () => {
    assert.equal(isFullSwipe(-150, geometry), null)
    assert.equal(isFullSwipe(-224, geometry), "trailing")
    assert.equal(isFullSwipe(224, geometry), "leading")
    assert.equal(isFullSwipe(224, { ...geometry, leadingWidth: 0 }), null)
})

test("swipe release settles open, closed or performs the full action", () => {
    assert.equal(swipeReleaseFor(-30, 0, geometry), "close")
    assert.equal(swipeReleaseFor(-90, 0, geometry), "open-trailing")
    assert.equal(swipeReleaseFor(-30, -0.8, geometry), "open-trailing")
    assert.equal(swipeReleaseFor(-120, 0.8, geometry), "close")
    assert.equal(swipeReleaseFor(-260, 0, geometry), "full-trailing")
    assert.equal(swipeReleaseFor(50, 0, geometry), "open-leading")
    assert.equal(swipeReleaseFor(20, 0.9, geometry), "open-leading")
    assert.equal(swipeReleaseFor(60, -0.9, geometry), "close")
    assert.equal(swipeReleaseFor(240, 0, geometry), "full-leading")
    assert.equal(swipeReleaseFor(0, 0, geometry), "close")
})

test("pull to refresh arms past the threshold with a rubber-banded distance", () => {
    const small = pullToRefreshState(20)
    assert.equal(small.armed, false)
    assert.ok(small.progress > 0 && small.progress < 1)
    const far = pullToRefreshState(400)
    assert.equal(far.armed, true)
    assert.equal(far.progress, 1)
    assert.ok(far.distance >= PULL_REFRESH_THRESHOLD && far.distance < 132)
    assert.equal(pullToRefreshState(-50).distance, 0)
})

test("auto-scroll speeds up towards the list edges", () => {
    assert.equal(autoScrollStep(300, 100, 700), 0)
    assert.ok(autoScrollStep(110, 100, 700) < 0)
    assert.ok(autoScrollStep(690, 100, 700) > 0)
    assert.ok(autoScrollStep(101, 100, 700) < autoScrollStep(140, 100, 700))
    assert.ok(autoScrollStep(699, 100, 700) > autoScrollStep(660, 100, 700))
    // Too short to have distinct edges: never scroll.
    assert.equal(autoScrollStep(105, 100, 180), 0)
})

test("drops are refused onto the dragged folder, into its subtree and onto the current folder", () => {
    const dragged = new Set(["folder-a"])
    assert.equal(dropVerdict({ draggedFolderIds: dragged, sourceFolderId: ROOT, targetFolderId: "folder-b" }), "ok")
    assert.equal(dropVerdict({ draggedFolderIds: dragged, sourceFolderId: ROOT, targetFolderId: "folder-a" }), "self")
    assert.equal(dropVerdict({
        draggedFolderIds: dragged,
        sourceFolderId: ROOT,
        targetFolderId: "folder-c",
        targetAncestorIds: ["folder-a", "folder-b"],
    }), "descendant")
    assert.equal(dropVerdict({ draggedFolderIds: new Set(), sourceFolderId: ROOT, targetFolderId: ROOT }), "current")
    assert.equal(dropVerdict({ draggedFolderIds: new Set(), sourceFolderId: "folder-b", targetFolderId: ROOT }), "ok")
    assert.equal(describeDragCount(1), "1 item")
    assert.equal(describeDragCount(3), "3 items")
})

test("slow second click renames only a lone, already selected item clicked once on its name", () => {
    const base = { wasSoleSelectionAtPress: true, selectedForMs: 2000, clickCount: 1, modifier: false, onName: true }
    assert.equal(isSlowRenameClick(base), true)
    assert.equal(isSlowRenameClick({ ...base, wasSoleSelectionAtPress: false }), false)
    assert.equal(isSlowRenameClick({ ...base, clickCount: 2 }), false)
    assert.equal(isSlowRenameClick({ ...base, modifier: true }), false)
    assert.equal(isSlowRenameClick({ ...base, onName: false }), false)
    assert.equal(isSlowRenameClick({ ...base, selectedForMs: SLOW_CLICK_RENAME_DELAY_MS - 1 }), false)
})

test("inline rename validation mirrors folder rules and catches duplicates", () => {
    const siblings = ["README.md", "Photos", "notes.txt"]
    assert.deepEqual(validateEntryName({ value: "  ", kind: "file", currentName: "a.txt", siblingNames: siblings }), { ok: false, message: "Name can't be empty" })
    assert.equal(validateEntryName({ value: "a/b", kind: "folder", currentName: "x", siblingNames: [] }).ok, false)
    assert.equal(validateEntryName({ value: "..", kind: "folder", currentName: "x", siblingNames: [] }).ok, false)
    assert.equal(validateEntryName({ value: "a\u0001b", kind: "file", currentName: "x", siblingNames: [] }).ok, false)
    const duplicate = validateEntryName({ value: "readme.MD", kind: "file", currentName: "a.txt", siblingNames: siblings })
    assert.equal(duplicate.ok, false)
    assert.match((duplicate as { message: string }).message, /already exists/)
    // Changing only the case of the item's own name is fine.
    assert.deepEqual(validateEntryName({ value: "Notes.TXT", kind: "file", currentName: "notes.txt", siblingNames: siblings }), { ok: true, name: "Notes.TXT" })
    assert.deepEqual(validateEntryName({ value: " report.pdf ", kind: "file", currentName: "a.pdf", siblingNames: siblings }), { ok: true, name: "report.pdf" })
})

test("rename selects the stem for files and the whole name for folders", () => {
    assert.deepEqual(stemSelectionRange("report.final.pdf", "file"), [0, 12])
    assert.deepEqual(stemSelectionRange(".gitignore", "file"), [0, 10])
    assert.deepEqual(stemSelectionRange("Makefile", "file"), [0, 8])
    assert.deepEqual(stemSelectionRange("v1.2 photos", "folder"), [0, 11])
})

test("folder navigation direction follows trail depth", () => {
    assert.equal(navigationDirection([], ["a"]), "forward")
    assert.equal(navigationDirection(["a"], ["a", "b"]), "forward")
    assert.equal(navigationDirection(["a", "b"], ["a"]), "back")
    assert.equal(navigationDirection(["a", "b"], []), "back")
    assert.equal(navigationDirection(["a"], ["a"]), "none")
    assert.equal(navigationDirection(["a"], ["c"]), "forward")
})
