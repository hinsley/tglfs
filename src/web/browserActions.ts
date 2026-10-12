// Registry for optional file-browser actions contributed by other web modules (for example MP4 conversion).
import type { IconName } from "./icons"

export type BrowserSelectionItem = {
    kind: "file" | "folder" | "missing-file"
    id: string
    name: string
    msgId?: number
}

export type ExtraBrowserAction = {
    /** DOM id used for the selection-bar button. */
    id: string
    /** DOM id used for the item in context menus and action sheets. */
    menuId: string
    label: string
    shortLabel?: string
    icon: IconName
    isVisible: (selection: BrowserSelectionItem[]) => boolean
    isBusy?: () => boolean
    run: (selection: BrowserSelectionItem[]) => void | Promise<void>
}

const extraActions: ExtraBrowserAction[] = []

export const BROWSER_ACTIONS_CHANGED_EVENT = "tglfs:browser-actions-changed"

export function registerBrowserAction(action: ExtraBrowserAction) {
    const existing = extraActions.findIndex((candidate) => candidate.id === action.id)
    if (existing >= 0) {
        extraActions[existing] = action
    } else {
        extraActions.push(action)
    }
    notifyBrowserActionsChanged()
}

export function getExtraBrowserActions(): readonly ExtraBrowserAction[] {
    return extraActions
}

export function notifyBrowserActionsChanged() {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(BROWSER_ACTIONS_CHANGED_EVENT))
    }
}
