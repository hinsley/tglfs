// Paste to upload: Ctrl/Cmd+V with files or an image on the clipboard uploads into the current folder through
// the same path as the Upload button (password prompt, then the transfer tray).
import type { BrowserHooks } from "./browserHooks"
import { isMenuOpen, showToast } from "./dialogs"
import { describePastedUpload, namePastedFiles } from "./pastedFiles"

function isEditableTarget(target: EventTarget | null) {
    const element = target as HTMLElement | null
    return !!element && (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT" ||
        element.isContentEditable
    )
}

function clipboardFiles(data: DataTransfer): File[] {
    const files = Array.from(data.files ?? [])
    if (files.length > 0) return files
    // Some browsers only expose pasted bitmaps through `items`.
    const fromItems: File[] = []
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== "file") continue
        const file = item.getAsFile()
        if (file) fromItems.push(file)
    }
    return fromItems
}

export function initPasteUpload(hooks: BrowserHooks) {
    document.addEventListener("paste", (event) => {
        if (!hooks.isBrowserVisible() || !event.clipboardData) return
        if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
        if (document.querySelector(".fx-dialog-backdrop, .fx-palette-layer") || isMenuOpen()) return
        if (!document.getElementById("previewModal")?.hasAttribute("hidden")) return
        // Directories copied in a file manager show up as zero-byte, typeless entries; skip them.
        const files = clipboardFiles(event.clipboardData).filter((file) => file.size > 0 || file.type !== "")
        if (files.length === 0) return
        event.preventDefault()
        const names = namePastedFiles(files, new Date())
        const named = files.map((file, index) => names[index] === file.name
            ? file
            : new File([file], names[index], { type: file.type, lastModified: file.lastModified || Date.now() }))
        showToast(describePastedUpload(named.length))
        hooks.uploadFiles(named)
    })
}
