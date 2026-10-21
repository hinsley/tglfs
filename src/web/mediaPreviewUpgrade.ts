import { parseFileCardMessage } from "../../packages/tglfs-cli/src/shared/file-cards"
import {
    getMediaPreviewUpgradeCapability,
    seekableMediaCopyName,
} from "../../packages/tglfs-cli/src/shared/media-preview"
import { uploadSeekableMedia } from "../../packages/tglfs-cli/src/shared/media-upload"
import { getGramJs } from "../gramjs"
import { createFileCardPlaintextStream } from "./tglfsDownloadSource"
import { notifyBrowserActionsChanged, registerBrowserAction, type BrowserSelectionItem } from "./browserActions"
import { requestConfirm, requestText, showToast } from "./dialogs"
import { enqueue } from "./transfers"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"

let busy = false
function selectedMedia(selection: BrowserSelectionItem[]) {
    if (selection.length !== 1) return null
    const item = selection[0]
    return item.kind === "file" && !item.mediaPreviewCurrent && item.msgId && /\.(mp4|webm)$/i.test(item.name)
        ? item
        : null
}
async function upgrade(selection: BrowserSelectionItem[]) {
    const selected = selectedMedia(selection)
    if (!selected || busy) return
    const { client } = window as Window & { client?: any }
    if (!client) return showToast("TGLFS is not connected to Telegram.", { tone: "error" })
    busy = true
    notifyBrowserActionsChanged()
    let password: string | null = null
    try {
        if (
            !(await requestConfirm({
                title: "Upgrade media preview?",
                icon: "film",
                confirmLabel: "Continue",
                message:
                    "Creates a separate copy with encrypted seek metadata. Keeps the original video and its password. Existing fragmented MP4 and WebM files are copied without changing their quality. If this file cannot be indexed safely, use Make MP4 previewable or Create WebM preview copy.",
            }))
        )
            return
        password = await requestText({
            title: "Unlock video",
            label: "Password (leave empty if none)",
            inputType: "password",
            allowEmpty: true,
            confirmLabel: "Upgrade",
            icon: "key",
        })
        if (password === null) return
    } finally {
        busy = false
        notifyBrowserActionsChanged()
    }
    const sourcePassword = password
    void enqueue(
        { direction: "upload", name: seekableMediaCopyName(selected.name), meta: { sourceMsgId: selected.msgId } },
        async (transfer) => {
            const messages = await client.getMessages("me", { ids: [selected.msgId] })
            const data = parseFileCardMessage(messages[0]?.message ?? "")
            if (!data) throw new Error("The selected file card is malformed or unsupported.")
            const capability = getMediaPreviewUpgradeCapability(data)
            if (!capability.supported) throw new Error(capability.reason)
            transfer.setPhase("Indexing and uploading", { total: data.size })
            const { Api, getFileInfo } = await getGramJs()
            const stream = await createFileCardPlaintextStream(client, data, sourcePassword, () =>
                transfer.throwIfCancelled(),
            )
            const record = await uploadSeekableMedia(client, {
                Api,
                getFileInfo,
                name: seekableMediaCopyName(data.name),
                stream,
                password: sourcePassword,
                container: /\.webm$/i.test(data.name) ? "webm" : "mp4",
                parentFolderId: "parentFolderId" in data ? data.parentFolderId : undefined,
                source: {
                    type: "tglfs:media-source",
                    version: 1,
                    messageId: selected.msgId!,
                    fileVersion: data.version,
                    ufid: data.ufid,
                },
                expectedSize: data.size,
                expectedUfid: data.ufid,
                signal: transfer.signal,
                onBytes: (bytes) => transfer.update({ bytes }),
            })
            const event = new Event("tglfs:refresh-browser") as Event & { tglfsParentFolderId?: string }
            event.tglfsParentFolderId =
                "parentFolderId" in record.data ? record.data.parentFolderId : TGLFS_ROOT_PARENT_ID
            window.dispatchEvent(event)
            transfer.complete({ ufid: record.data.ufid, message: "Seekable preview created · original kept" })
        },
    ).catch((error) => console.warn("Media preview upgrade failed:", error))
}
registerBrowserAction({
    id: "browserActionUpgradeMediaPreview",
    menuId: "actionUpgradeMediaPreviewItem",
    label: "Upgrade media preview",
    shortLabel: "Upgrade preview",
    icon: "film",
    isVisible: (selection) => selectedMedia(selection) !== null,
    isBusy: () => busy,
    run: upgrade,
})
