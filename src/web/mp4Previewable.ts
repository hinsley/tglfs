import type * as Config from "../config"
import {
    formatFileCardSize,
    parseFileCardMessage,
    type FileCardData,
} from "../../packages/tglfs-cli/src/shared/file-cards"
import {
    createFileCardPlaintextStream,
    stagePlaintextStreamToTemporaryFile,
    type DownloadedSource,
} from "./tglfsDownloadSource"
import { getPreviewableMp4Name, isMp4FileName } from "./mp4PreviewableName"
import { probeMp4MetadataPlacement } from "./mp4MetadataPlacement"
import { createStreamingPreviewableMp4 } from "./streamingMp4Conversion"
import { uploadSeekableMedia } from "../../packages/tglfs-cli/src/shared/media-upload"
import { getGramJs } from "../gramjs"
import "./mediaPreviewUpgrade"
import { notifyBrowserActionsChanged, registerBrowserAction, type BrowserSelectionItem } from "./browserActions"
import { requestConfirm, requestText, showToast } from "./dialogs"
import { enqueue as enqueueTransfer, type TransferHandle } from "./transfers"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"

const DESKTOP_ID = "browserActionMakeMp4Previewable"
const MOBILE_ID = "actionMakeMp4PreviewableItem"
let busy = false

type SelectedMp4 = { msgId: number; name: string }
type AppWindow = Window & { client?: any; config?: Config.Config }

function selectedMp4(selection: BrowserSelectionItem[]): SelectedMp4 | null {
    if (selection.length !== 1) return null
    const [item] = selection
    if (item.kind !== "file" || !item.msgId) return null
    return Number.isInteger(item.msgId) && item.msgId > 0 && isMp4FileName(item.name)
        ? { msgId: item.msgId, name: item.name }
        : null
}

function parentFolderId(data: FileCardData): string | undefined {
    const value = (data as FileCardData & { parentFolderId?: unknown }).parentFolderId
    return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function loadFileCard(client: any, selected: SelectedMp4): Promise<FileCardData> {
    const messages = await client.getMessages("me", { ids: [selected.msgId] })
    const text = messages[0]?.message
    const data = typeof text === "string" ? parseFileCardMessage(text) : null
    if (!data) throw new Error("The selected Telegram message is not a valid TGLFS file card.")
    if (data.version === 4 || (data.version === 5 && data.content.archive)) throw new Error("This record contains a tar archive. Open its archive preview instead of converting it to MP4.")
    if (!isMp4FileName(data.name)) throw new Error("The selected file is no longer an MP4.")
    return data
}

function reportGeneratedUploadComplete(record: Awaited<ReturnType<typeof uploadSeekableMedia>>, transfer: TransferHandle) {
    const event = new Event("tglfs:refresh-browser") as Event & { tglfsParentFolderId?: string }
    event.tglfsParentFolderId = parentFolderId(record.data) ?? TGLFS_ROOT_PARENT_ID
    window.dispatchEvent(event)
    transfer.complete({
        ufid: record.data.ufid,
        message: `Created · ${formatFileCardSize(record.data.size)}`,
    })
}

async function runStreamingPath(
    client: any,
    config: Config.Config,
    data: FileCardData,
    outputName: string,
    stream: ReadableStream<Uint8Array>,
    sourcePassword: string,
    transfer: TransferHandle,
) {
    transfer.setPhase("Converting and uploading", { span: [0.02, 1], total: data.size })
    const conversion = await createStreamingPreviewableMp4(stream)
    let uploadPromise: ReturnType<typeof uploadSeekableMedia> | null = null

    try {
        const { Api, getFileInfo } = await getGramJs()
        uploadPromise = uploadSeekableMedia(client, {
            Api, getFileInfo, container: "mp4", duration: conversion.durationSeconds,
            name: outputName,
            stream: conversion.stream,
            password: sourcePassword,
            parentFolderId: parentFolderId(data),
            signal: transfer.signal,
            onBytes: (plaintextBytes) => {
                // The converted MP4 is roughly the size of the source; cap at the source size for the bar.
                transfer.update({ bytes: Math.min(plaintextBytes, data.size) })
            },
        })
        const [record] = await Promise.all([uploadPromise, conversion.completion])
        reportGeneratedUploadComplete(record, transfer)
    } catch (error) {
        try { await conversion.cancel() } catch {}
        try { await uploadPromise } catch {}
        throw error
    }
}

async function runStagedPath(
    client: any,
    config: Config.Config,
    data: FileCardData,
    outputName: string,
    stream: ReadableStream<Uint8Array>,
    sourcePassword: string,
    transfer: TransferHandle,
): Promise<DownloadedSource> {
    const remux = await import("./videoRemux")
    if (data.size >= remux.MAX_FFMPEG_INPUT_BYTES) {
        throw new Error(`Browser conversion is limited to files smaller than ${remux.MAX_FFMPEG_INPUT_BYTES.toLocaleString()} bytes by FFmpeg WebAssembly.`)
    }

    transfer.setPhase("Downloading source", { span: [0.02, 0.35], total: 100, unit: "percent" })
    const downloaded = await stagePlaintextStreamToTemporaryFile(
        stream,
        outputName,
        data.size,
        (progress) => {
            transfer.throwIfCancelled()
            transfer.update({ bytes: progress })
        },
        { allowMemoryFallback: false },
    )

    try {
        transfer.setPhase("Making previewable", { span: [0.35, 0.6], total: 100, unit: "percent" })
        const converted = await remux.remuxToStreamingMp4(downloaded.file, "mp4", (progress) => {
            transfer.update({ bytes: progress })
        })
        remux.markVideoPreviewReady(converted)
        transfer.throwIfCancelled()

        const { Api, getFileInfo } = await getGramJs()
        const uploaded = await uploadSeekableMedia(client, {
            Api, getFileInfo, container: "mp4", name: outputName, stream: converted.stream(),
            password: sourcePassword, parentFolderId: parentFolderId(data), signal: transfer.signal,
            onBytes: bytes => transfer.update({ bytes }),
        })
        reportGeneratedUploadComplete(uploaded, transfer)
    } catch (error) {
        await downloaded.cleanup()
        throw error
    }
    return downloaded
}

async function makePreviewable(selection: BrowserSelectionItem[]) {
    if (busy) return
    const selected = selectedMp4(selection)
    if (!selected) return
    const { client, config } = window as AppWindow
    if (!client || !config) {
        showToast("TGLFS is not connected to Telegram.", { tone: "error" })
        return
    }

    // All questions are asked up front, so the queued job never waits on a dialog.
    busy = true
    notifyBrowserActionsChanged()
    let sourcePassword: string | null = null
    try {
        const confirmed = await requestConfirm({
            title: "Make MP4 previewable?",
            message: `Creates a new streaming-friendly copy of "${selected.name}". The original remains unchanged and the copy uses its password. Encrypted seek metadata allows scrubbing across the copy. ` +
                "Front-loaded MP4s are converted and uploaded as one bounded stream; MP4s with trailing metadata are staged in temporary browser storage first.",
            confirmLabel: "Continue",
            icon: "film",
        })
        if (!confirmed) return
        sourcePassword = await requestText({
            title: "Decrypt source MP4",
            label: "Decryption password (leave empty if none)",
            inputType: "password",
            allowEmpty: true,
            confirmLabel: "Continue",
            icon: "key",
        })
        if (sourcePassword === null) return
    } finally {
        busy = false
        notifyBrowserActionsChanged()
    }

    const decryptPassword = sourcePassword
    void enqueueTransfer(
        { direction: "upload", name: getPreviewableMp4Name(selected.name), meta: { sourceMsgId: selected.msgId } },
        async (transfer) => {
            transfer.setPhase("Reading source", { span: [0, 0.02] })
            const data = await loadFileCard(client, selected)
            const outputName = getPreviewableMp4Name(data.name)
            transfer.update({ name: outputName, size: data.size })
            const plaintext = await createFileCardPlaintextStream(client, data, decryptPassword, () => {
                transfer.throwIfCancelled()
            })
            const probed = await probeMp4MetadataPlacement(plaintext)
            transfer.throwIfCancelled()

            if (probed.placement === "front-loaded") {
                await runStreamingPath(client, config, data, outputName, probed.stream, decryptPassword, transfer)
                return
            }
            const downloaded = await runStagedPath(client, config, data, outputName, probed.stream, decryptPassword, transfer)
            await downloaded.cleanup()
        },
    ).catch((error) => {
        // The failure (with its message) is shown on the transfer's row in the tray.
        console.warn("Make MP4 previewable failed:", error)
    })
}

registerBrowserAction({
    id: DESKTOP_ID,
    menuId: MOBILE_ID,
    label: "Make MP4 previewable",
    shortLabel: "Make MP4",
    icon: "film",
    isVisible: (selection) => selectedMp4(selection) !== null,
    isBusy: () => busy,
    run: (selection) => makePreviewable(selection),
})
