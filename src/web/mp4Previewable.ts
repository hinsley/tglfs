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
import { uploadGeneratedFileStream } from "./generatedUpload"
import { notifyBrowserActionsChanged, registerBrowserAction, type BrowserSelectionItem } from "./browserActions"
import { requestConfirm, requestText, showToast } from "./dialogs"

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

function showStatus(message: string, persistent = false) {
    showToast(message, { durationMs: persistent ? null : 2200 })
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
    if (!isMp4FileName(data.name)) throw new Error("The selected file is no longer an MP4.")
    return data
}

async function reportGeneratedUploadComplete(record: Awaited<ReturnType<typeof uploadGeneratedFileStream>>) {
    window.dispatchEvent(new Event("tglfs:refresh-browser"))
    let copied = false
    try {
        await navigator.clipboard.writeText(record.data.ufid)
        copied = true
    } catch (error) {
        console.warn("Unable to copy generated MP4 UFID", error)
    }
    showToast(
        `Created ${record.data.name} (${formatFileCardSize(record.data.size)})${copied ? " · UFID copied" : ""}`,
        { tone: "success", durationMs: 4000 },
    )
}

async function runStreamingPath(
    client: any,
    config: Config.Config,
    data: FileCardData,
    outputName: string,
    stream: ReadableStream<Uint8Array>,
) {
    const uploadPassword = await requestText({
        title: "Encrypt previewable MP4",
        label: "Encryption password (optional)",
        inputType: "password",
        allowEmpty: true,
        confirmLabel: "Start",
        icon: "lock",
    })
    if (uploadPassword === null) {
        await stream.cancel("Previewable MP4 creation cancelled.")
        return
    }

    showStatus("Starting storage-free MP4 conversion...", true)
    const conversion = await createStreamingPreviewableMp4(stream)
    let uploadPromise: ReturnType<typeof uploadGeneratedFileStream> | null = null

    try {
        uploadPromise = uploadGeneratedFileStream(client, config, {
            name: outputName,
            stream: conversion.stream,
            password: uploadPassword,
            parentFolderId: parentFolderId(data),
            onProgress: ({ plaintextBytes }) => {
                showStatus(`Streaming converted MP4 to Telegram: ${formatFileCardSize(plaintextBytes)}`, true)
            },
        })
        const [record] = await Promise.all([uploadPromise, conversion.completion])
        await reportGeneratedUploadComplete(record)
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
): Promise<DownloadedSource> {
    const remux = await import("./videoRemux")
    if (data.size >= remux.MAX_FFMPEG_INPUT_BYTES) {
        throw new Error(`Browser conversion is limited to files smaller than ${remux.MAX_FFMPEG_INPUT_BYTES.toLocaleString()} bytes by FFmpeg WebAssembly.`)
    }

    showStatus("MP4 metadata is trailing; staging the source in temporary OPFS...", true)
    const downloaded = await stagePlaintextStreamToTemporaryFile(
        stream,
        outputName,
        data.size,
        (progress) => showStatus(`Staging trailing-metadata MP4 ${progress}%`, true),
        { allowMemoryFallback: false },
    )

    showStatus("Preparing FFmpeg conversion from temporary storage...", true)
    const converted = await remux.remuxToStreamingMp4(downloaded.file, "mp4", (progress) => {
        showStatus(`Making MP4 previewable ${progress}%`, true)
    })
    remux.markVideoPreviewReady(converted)

    showStatus("Starting encrypted upload of the new MP4...", true)
    const Telegram = await import("../telegram")
    await Telegram.fileUpload(client, config, [converted], { parentFolderId: parentFolderId(data) })
    showStatus("MP4 upload flow finished")
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

    const confirmed = await requestConfirm({
        title: "Make MP4 previewable?",
        message: `Creates a new streaming-friendly copy of "${selected.name}". The original remains unchanged. ` +
            "Front-loaded MP4s are converted and uploaded as one bounded stream; MP4s with trailing metadata are staged in temporary browser storage first.",
        confirmLabel: "Continue",
        icon: "film",
    })
    if (!confirmed) return
    const sourcePassword = await requestText({
        title: "Decrypt source MP4",
        label: "Decryption password (leave empty if none)",
        inputType: "password",
        allowEmpty: true,
        confirmLabel: "Continue",
        icon: "key",
    })
    if (sourcePassword === null) return

    busy = true
    notifyBrowserActionsChanged()
    let downloaded: DownloadedSource | null = null
    try {
        const data = await loadFileCard(client, selected)
        const outputName = getPreviewableMp4Name(data.name)
        let sourcePhase = "Inspecting MP4 metadata layout"
        const plaintext = await createFileCardPlaintextStream(client, data, sourcePassword, (progress) => {
            showStatus(`${sourcePhase} ${progress}%`, true)
        })
        const probed = await probeMp4MetadataPlacement(plaintext)

        if (probed.placement === "front-loaded") {
            sourcePhase = "Streaming source MP4"
            await runStreamingPath(client, config, data, outputName, probed.stream)
            return
        }

        sourcePhase = probed.placement === "trailing"
            ? "Downloading trailing-metadata MP4"
            : "Downloading MP4 with an unconfirmed metadata layout"
        downloaded = await runStagedPath(client, config, data, outputName, probed.stream)
    } catch (error) {
        console.error(error)
        showToast(
            `Unable to make this MP4 previewable: ${error instanceof Error ? error.message : String(error)}`,
            { tone: "error", durationMs: 6000 },
        )
    } finally {
        await downloaded?.cleanup()
        busy = false
        notifyBrowserActionsChanged()
    }
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
