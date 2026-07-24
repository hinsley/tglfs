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

const DESKTOP_ID = "browserActionMakeMp4Previewable"
const MOBILE_ID = "actionMakeMp4PreviewableItem"
let busy = false
let toastTimer: number | undefined

type SelectedMp4 = { msgId: number; name: string }
type AppWindow = Window & { client?: any; config?: Config.Config }

function ensureActions() {
    if (!document.getElementById(DESKTOP_ID)) {
        const preview = document.getElementById("browserActionPreview")
        if (preview) {
            const button = document.createElement("button")
            button.id = DESKTOP_ID
            button.type = "button"
            button.className = "btn btn-sm btn-secondary action-hidden"
            button.textContent = "Make MP4 previewable"
            button.disabled = true
            preview.insertAdjacentElement("afterend", button)
        }
    }
    if (!document.getElementById(MOBILE_ID)) {
        const previewItem = document.getElementById("actionPreviewItem")
        if (previewItem?.parentElement) {
            const row = document.createElement("li")
            row.className = "d-none"
            const item = document.createElement("a")
            item.id = MOBILE_ID
            item.className = "dropdown-item"
            item.href = "#"
            item.textContent = "🎞️ Make MP4 previewable"
            row.append(item)
            previewItem.parentElement.insertAdjacentElement("afterend", row)
        }
    }
}

function selectedMp4(): SelectedMp4 | null {
    const selectedNodes = Array.from(document.querySelectorAll<HTMLElement>("[data-browser-id].selected"))
    const ids = new Set(selectedNodes.map((node) => node.dataset.browserId).filter((id): id is string => !!id))
    if (ids.size !== 1) return null
    const id = ids.values().next().value as string
    if (!id.startsWith("file:")) return null

    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-browser-id]"))
        .filter((node) => node.dataset.browserId === id)
    const msgId = Number(nodes.map((node) => node.dataset.msgid).find(Boolean))
    const name = nodes.map((node) => node.querySelector<HTMLElement>(".file-name-scroll")?.textContent?.trim()).find(Boolean)
        ?? nodes.map((node) => node.querySelector<HTMLElement>("td.name")?.textContent?.trim()).find(Boolean)
    return Number.isInteger(msgId) && msgId > 0 && name && isMp4FileName(name) ? { msgId, name } : null
}

function updateActionVisibility() {
    ensureActions()
    const visible = selectedMp4() !== null
    const button = document.getElementById(DESKTOP_ID) as HTMLButtonElement | null
    const item = document.getElementById(MOBILE_ID) as HTMLAnchorElement | null
    if (button) {
        button.classList.toggle("action-hidden", !visible)
        button.disabled = !visible || busy
    }
    if (item) {
        item.closest("li")?.classList.toggle("d-none", !visible)
        item.setAttribute("aria-disabled", String(!visible || busy))
    }
}

function showStatus(message: string, persistent = false) {
    const toast = document.getElementById("ufidToast")
    if (!toast) return
    toast.textContent = message
    toast.setAttribute("aria-hidden", "false")
    toast.classList.remove("is-visible")
    void toast.offsetWidth
    toast.classList.add("is-visible")
    if (toastTimer !== undefined) window.clearTimeout(toastTimer)
    toastTimer = persistent ? undefined : window.setTimeout(() => {
        toast.classList.remove("is-visible")
        toast.setAttribute("aria-hidden", "true")
        toastTimer = undefined
    }, 2200)
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
    showStatus(`Created ${record.data.name}`)
    alert([
        "Previewable MP4 upload complete.",
        "",
        `Name: ${record.data.name}`,
        `UFID: ${record.data.ufid}`,
        `Size: ${formatFileCardSize(record.data.size)}`,
    ].join("\n"))
    try { await navigator.clipboard.writeText(record.data.ufid) }
    catch (error) { console.warn("Unable to copy generated MP4 UFID", error) }
}

async function runStreamingPath(
    client: any,
    config: Config.Config,
    data: FileCardData,
    outputName: string,
    stream: ReadableStream<Uint8Array>,
) {
    const uploadPassword = prompt("(Optional) Encryption password for the new previewable MP4:")
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

async function makePreviewable() {
    if (busy) return
    const selected = selectedMp4()
    if (!selected) return
    const { client, config } = window as AppWindow
    if (!client || !config) {
        alert("TGLFS is not connected to Telegram.")
        return
    }

    const confirmed = confirm(
        `Create a new previewable MP4 from "${selected.name}"?\n\n` +
        "The original remains unchanged. TGLFS first inspects the MP4 layout while decrypting it. Front-loaded MP4s are converted and uploaded as one bounded stream without a temporary file. MP4s whose moov metadata is after media data are staged in temporary OPFS, because they require random access.",
    )
    if (!confirmed) return
    const sourcePassword = prompt("Source MP4 decryption password (leave empty if none):")
    if (sourcePassword === null) return

    busy = true
    updateActionVisibility()
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
        alert(`Unable to make this MP4 previewable.\n\n${error instanceof Error ? error.message : String(error)}`)
        showStatus("MP4 conversion failed")
    } finally {
        await downloaded?.cleanup()
        busy = false
        updateActionVisibility()
    }
}

function setup() {
    ensureActions()
    const button = document.getElementById(DESKTOP_ID)
    const item = document.getElementById(MOBILE_ID)
    button?.addEventListener("click", () => void makePreviewable())
    item?.addEventListener("click", (event) => {
        event.preventDefault()
        void makePreviewable()
    })
    const browser = document.getElementById("fileBrowser")
    if (browser) {
        new MutationObserver(updateActionVisibility).observe(browser, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "hidden"],
        })
    }
    updateActionVisibility()
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup, { once: true })
else setup()
