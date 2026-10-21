import type * as Config from "../config"
import { parseFileCardMessage } from "../../packages/tglfs-cli/src/shared/file-cards"
import { isWebmSourceName, webmCopyName } from "../../packages/tglfs-cli/src/shared/webm-policy"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import { notifyBrowserActionsChanged, registerBrowserAction, type BrowserSelectionItem } from "./browserActions"
import { requestConfirm, requestText, showToast } from "./dialogs"
import { enqueue } from "./transfers"
import { createFileCardPlaintextStream } from "./tglfsDownloadSource"
import { uploadGeneratedFileStream } from "./generatedUpload"

let busy = false
function selectedVideo(selection: BrowserSelectionItem[]) {
    if (selection.length !== 1) return null
    const item = selection[0]
    return item.kind === "file" && item.msgId && isWebmSourceName(item.name) ? item : null
}

async function convertSelection(selection: BrowserSelectionItem[]) {
    const selected = selectedVideo(selection)
    if (!selected || busy) return
    const { client, config } = window as Window & { client?: any; config?: Config.Config }
    if (!client || !config) return showToast("TGLFS is not connected to Telegram.", { tone: "error" })
    busy = true
    notifyBrowserActionsChanged()
    let password: string | null = null
    try {
        if (!await requestConfirm({
            title: "Create WebM preview copy?", confirmLabel: "Continue", icon: "film",
            message: "Keeps your original and uses its password for the new copy. Converts on this device without temporary video files. Checks short clips near the beginning, middle and end before saving the copy; these checks cannot guarantee every frame or audio quality. Conversion stops if safe streaming or quality checks fail. Some video types are unsupported, conversion may take time, and seeking in the preview may be limited.",
        })) return
        password = await requestText({ title: "Unlock video", label: "Password (leave empty if none)", inputType: "password", allowEmpty: true, confirmLabel: "Convert", icon: "key" })
        if (password === null) return
    } finally { busy = false; notifyBrowserActionsChanged() }
    const sourcePassword = password
    void enqueue({ direction: "upload", name: webmCopyName(selected.name), meta: { sourceMsgId: selected.msgId } }, async transfer => {
        transfer.setPhase("Checking streaming support", { span: [0, 0.05] })
        const messages = await client.getMessages("me", { ids: [selected.msgId] })
        const data = parseFileCardMessage(messages[0]?.message ?? "")
        if (!data || ![1, 2, 3].includes(data.version) || !data.uploadComplete || !isWebmSourceName(data.name)) throw new Error("Select a complete supported video file. Archives and unknown file versions cannot be converted.")
        const parent = "parentFolderId" in data ? data.parentFolderId : undefined
        const source = await createFileCardPlaintextStream(client, data, sourcePassword, () => transfer.throwIfCancelled())
        const { createStreamingWebm } = await import("./streamingWebmConversion")
        const conversion = await createStreamingWebm(source, data.name, transfer.signal)
        try {
            transfer.setPhase("Converting, comparing and uploading", { span: [0.05, 1], total: data.size })
            const record = await uploadGeneratedFileStream(client, config, {
                name: webmCopyName(data.name), stream: conversion.stream, password: sourcePassword,
                parentFolderId: parent, signal: transfer.signal,
                onProgress: p => transfer.update({ bytes: Math.min(p.plaintextBytes, data.size) }),
            })
            const report = conversion.getQuality()
            const minimum = Math.min(...report.clips.map(c => c.ssim))
            const event = new Event("tglfs:refresh-browser") as Event & { tglfsParentFolderId?: string }
            event.tglfsParentFolderId = parent ?? TGLFS_ROOT_PARENT_ID
            window.dispatchEvent(event)
            transfer.complete({ ufid: record.data.ufid, message: `Created · sampled SSIM ${minimum.toFixed(4)} · original kept` })
            showToast(`WebM copy created. Sampled clip SSIM: ${report.clips.map(c => c.ssim.toFixed(4)).join(", ")}. Original kept.`, { tone: "success" })
        } catch (error) { await conversion.cancel(error); throw error }
    }).catch(error => console.warn("WebM conversion failed:", error))
}

registerBrowserAction({
    id: "browserActionConvertWebm", menuId: "actionConvertWebmItem", label: "Create WebM preview copy", shortLabel: "Make WebM", icon: "film",
    isVisible: selection => selectedVideo(selection) !== null, isBusy: () => busy, run: convertSelection,
})
