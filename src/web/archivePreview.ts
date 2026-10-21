import { getGramJs } from "../gramjs"
import { formatFileCardSize } from "../../packages/tglfs-cli/src/shared/file-cards"
import type { FileCardData, FileCardRecord } from "../../packages/tglfs-cli/src/shared/file-cards"
import { openRemoteArchive, upgradeArchive } from "../../packages/tglfs-cli/src/shared/archive-transfer"
import type { ArchiveReader, ArchiveMember } from "../../packages/tglfs-cli/src/shared/archive-format"
import { UfidAccumulator } from "../../packages/tglfs-cli/src/ufid"
import * as Transfers from "./transfers"

const TEXT_PREVIEW_BYTES = 256 * 1024
const IMAGE_PREVIEW_BYTES = 32 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "js", "ts", "py", "c", "cpp", "h", "rs", "go", "css", "html", "sh", "svg"])

function extension(path: string) {
    return path.split(".").pop()?.toLowerCase() ?? ""
}

function memberMime(path: string): string {
    const types: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
        mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska",
        mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", pdf: "application/pdf",
    }
    return types[extension(path)] ?? "application/octet-stream"
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
}

type MemberUrl = { url: string; close(): void }

async function createMemberUrl(reader: ArchiveReader, entry: ArchiveMember, signal: AbortSignal, callbacks?: { complete(): void; error(error: Error): void; progress(): void }, downloadOnly = false): Promise<MemberUrl> {
    if (!("serviceWorker" in navigator)) throw new Error("Streaming member previews require browser service worker support.")
    const worker = navigator.serviceWorker.controller
    if (!worker) throw new Error("Reload TGLFS once to enable streaming member previews.")
    const token = crypto.randomUUID().replace(/-/g, "")
    const channel = new MessageChannel()
    let closed = false
    let readyTimer: ReturnType<typeof setTimeout>
    let rejectReady: (error: Error) => void = () => {}
    const close = () => {
        if (closed) return
        closed = true
        clearTimeout(readyTimer)
        rejectReady(new Error("Archive preview closed."))
        channel.port1.postMessage({ type: "close" })
        channel.port1.close()
        signal.removeEventListener("abort", close)
        navigator.serviceWorker.removeEventListener("controllerchange", close)
    }
    const ready = new Promise<void>((resolve, reject) => {
        rejectReady = reject
        readyTimer = setTimeout(() => reject(new Error("Streaming member preview could not start. Reload TGLFS and try again.")), 10000)
        channel.port1.onmessage = async (event) => {
            const request = event.data
            if (request?.type === "download-complete") { callbacks?.complete(); return }
            if (request?.type === "download-error") { callbacks?.error(new Error(request.error || "Archive download failed or was cancelled.")); return }
            if (request?.type === "ready") {
                clearTimeout(readyTimer)
                resolve()
                return
            }
            if (request?.type === "error") {
                reject(new Error(request.error || "Unable to open member preview."))
                return
            }
            if (request?.type !== "read" || closed) return
            try {
                if (!Number.isSafeInteger(request.offset) || !Number.isSafeInteger(request.length) ||
                    request.offset < 0 || request.length <= 0 || request.length > 256 * 1024 || request.offset + request.length > entry.size) {
                    throw new Error("Invalid member range request.")
                }
                const bytes = await reader.readRange(entry.dataOffset + request.offset, request.length)
                callbacks?.progress()
                if (!closed) channel.port1.postMessage({ type: "bytes", id: request.id, bytes }, [bytes.buffer as ArrayBuffer])
            } catch {
                if (!closed) channel.port1.postMessage({ type: "error", id: request.id })
            }
        }
    })
    signal.addEventListener("abort", close, { once: true })
    navigator.serviceWorker.addEventListener("controllerchange", close, { once: true })
    if (signal.aborted) close()
    else worker.postMessage({ type: "REGISTER_ARCHIVE_MEMBER", token, name: entry.path.split("/").pop() || "archive-member", size: entry.size, mime: memberMime(entry.path), downloadOnly }, [channel.port2])
    try {
        await ready
    } catch (error) {
        close()
        throw error
    }
    return { url: `/archive-member/${token}`, close }
}

export async function downloadArchiveFile(client: any, data: FileCardData, password: string, options: { signal?: AbortSignal; onProgress?: (bytes: number, total: number) => void } = {}): Promise<void> {
    const controller = new AbortController()
    const memberUrl: { current: MemberUrl | null } = { current: null }
    const downloadFrame: { current: HTMLIFrameElement | null } = { current: null }
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let rejectDownload: (error: Error) => void = () => {}
    const cancel = () => {
        controller.abort()
        rejectDownload(new Error("Archive download was interrupted."))
    }
    window.addEventListener("beforeunload", cancel, { once: true })
    options.signal?.addEventListener("abort", cancel, { once: true })
    navigator.serviceWorker?.addEventListener("controllerchange", cancel, { once: true })
    try {
        if (options.signal?.aborted) throw Transfers.abortError()
        const { Api, getFileInfo } = await getGramJs()
        const reader = await openRemoteArchive(client, { Api, getFileInfo, record: { data, msgId: 0, date: 0 }, password, signal: controller.signal })
        const hash = new UfidAccumulator()
        let verifiedBytes = 0
        const downloadReader: ArchiveReader = {
            ...reader,
            async readRange(offset, length) {
                if (offset !== verifiedBytes) throw new Error("Restart this archive download to verify the complete file.")
                const bytes = await reader.readRange(offset, length)
                await hash.update(bytes)
                verifiedBytes += bytes.length
                if (verifiedBytes === data.size && await hash.digest() !== data.ufid) throw new Error("Archive content verification failed.")
                options.onProgress?.(verifiedBytes, data.size)
                return bytes
            },
        }
        const entry: ArchiveMember = { id: "full-archive", path: data.name, kind: "file", dataOffset: 0, headerOffset: 0, size: data.size }
        const done = new Promise<void>((resolve, reject) => {
            rejectDownload = reject
            const progress = () => {
                clearTimeout(idleTimer)
                idleTimer = setTimeout(() => reject(new Error("Archive download stopped responding. Your stored archive is unchanged.")), 90000)
            }
            progress()
            void createMemberUrl(downloadReader, entry, controller.signal, { complete: resolve, error: reject, progress }, true).then((mounted) => {
                memberUrl.current = mounted
                downloadFrame.current = node("iframe")
                downloadFrame.current.hidden = true
                downloadFrame.current.src = `${mounted.url}?download=1`
                document.body.append(downloadFrame.current)
            }, reject)
        })
        await done
    } finally {
        clearTimeout(idleTimer)
        controller.abort()
        memberUrl.current?.close()
        downloadFrame.current?.remove()
        window.removeEventListener("beforeunload", cancel)
        options.signal?.removeEventListener("abort", cancel)
        navigator.serviceWorker?.removeEventListener("controllerchange", cancel)
    }
}

export class ArchivePreviewModal {
    private modal: HTMLElement | null = null
    private controller: AbortController | null = null
    private reader: ArchiveReader | null = null
    private memberUrl: MemberUrl | null = null
    private blobUrl: string | null = null
    private body: HTMLElement | null = null
    private status: HTMLElement | null = null
    private details: HTMLElement | null = null
    private listing: HTMLElement | null = null
    private breadcrumb: HTMLElement | null = null
    private currentPath = ""
    private directoryLimit = 200
    private downloadFrames = new Set<HTMLIFrameElement>()
    private downloadUrls = new Set<MemberUrl>()
    private operation = 0
    private memberOperation = 0
    private memberRead: Promise<void> = Promise.resolve()
    private previousFocus: HTMLElement | null = null
    private keyHandler = (event: KeyboardEvent) => {
        if (!this.modal) return
        if (event.key === "Escape") {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.close()
        }
        if (event.key === "Tab") {
            const items = Array.from(this.modal.querySelectorAll<HTMLElement>("button:not(:disabled), input, a[href], video, audio, iframe"))
                .filter((element) => !element.closest("[hidden]"))
            if (!items.length) return
            const first = items[0]
            const last = items[items.length - 1]
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
            }
        }
    }

    constructor(private client: any, private onUpgrade: (record: FileCardRecord) => Promise<void>, private onOpenChange?: (open: boolean) => void) {}

    isOpen() { return this.modal !== null }

    close(notify = true) {
        const wasOpen = this.modal !== null
        this.operation++
        this.memberOperation++
        this.controller?.abort()
        this.controller = null
        this.clearMember()
        this.reader = null
        this.modal?.remove()
        this.modal = null
        this.body = null
        this.status = null
        this.details = null
        this.listing = null
        this.breadcrumb = null
        document.removeEventListener("keydown", this.keyHandler, true)
        this.previousFocus?.focus()
        this.previousFocus = null
        if (notify && wasOpen) this.onOpenChange?.(false)
    }

    private clearMember() {
        for (const url of this.downloadUrls) url.close()
        this.downloadUrls.clear()
        for (const frame of this.downloadFrames) frame.remove()
        this.downloadFrames.clear()
        this.memberUrl?.close()
        this.memberUrl = null
        if (this.blobUrl) URL.revokeObjectURL(this.blobUrl)
        this.blobUrl = null
        this.details?.querySelectorAll("video, audio").forEach((element) => {
            const media = element as HTMLMediaElement
            media.pause()
            media.removeAttribute("src")
            media.load()
        })
        this.details?.replaceChildren()
    }

    private create(record: FileCardRecord, title: string) {
        this.close(false)
        this.previousFocus = document.activeElement as HTMLElement | null
        this.controller = new AbortController()
        const modal = node("div", "archive-preview-modal")
        modal.setAttribute("role", "dialog")
        modal.setAttribute("aria-modal", "true")
        modal.setAttribute("aria-labelledby", "archivePreviewTitle")
        const backdrop = node("div", "archive-preview-backdrop")
        backdrop.addEventListener("click", () => this.close())
        const panel = node("section", "archive-preview-panel")
        const header = node("div", "archive-preview-header")
        const heading = node("h2", undefined, title)
        heading.id = "archivePreviewTitle"
        const close = node("button", "fx-btn fx-btn-secondary", "Close")
        close.addEventListener("click", () => this.close())
        header.append(heading, close)
        const name = node("p", "archive-preview-name", `${record.data.name} · Archive v${record.data.version} · Message ${record.msgId}`)
        this.status = node("p", "archive-preview-status")
        this.status.setAttribute("role", "status")
        this.status.setAttribute("aria-live", "polite")
        this.body = node("div", "archive-preview-body")
        panel.append(header, name, this.status, this.body)
        modal.append(backdrop, panel)
        document.body.append(modal)
        this.modal = modal
        this.onOpenChange?.(true)
        document.addEventListener("keydown", this.keyHandler, true)
        close.focus()
        return { operation: this.operation, signal: this.controller.signal }
    }

    private passwordForm(label: string, explanation: string, action: (password: string) => Promise<void>) {
        const form = node("form", "archive-unlock-form")
        form.append(node("p", undefined, explanation))
        const labelElement = node("label", undefined, "Password (leave empty if none)")
        const input = node("input", "fx-input")
        input.type = "password"
        input.autocomplete = "off"
        labelElement.append(input)
        const submit = node("button", "fx-btn fx-btn-primary", label)
        submit.type = "submit"
        form.append(labelElement, submit)
        form.addEventListener("submit", async (event) => {
            event.preventDefault()
            const password = input.value
            input.value = ""
            submit.disabled = true
            input.disabled = true
            try { await action(password) }
            finally {
                submit.disabled = false
                input.disabled = false
            }
        })
        this.body?.replaceChildren(form)
        input.focus()
    }

    async open(record: FileCardRecord, initialPassword = "") {
        const { operation, signal } = this.create(record, "Browse archive")
        const unlock = async (password: string) => {
            this.status!.textContent = "Opening encrypted directory…"
            try {
                const { Api, getFileInfo } = await getGramJs()
                const reader = await openRemoteArchive(this.client, { Api, getFileInfo, record, password, signal })
                if (operation !== this.operation) return
                this.reader = reader
                this.currentPath = ""
                this.directoryLimit = 200
                this.showDirectory()
            } catch (error) {
                if (signal.aborted || operation !== this.operation) return
                this.status!.textContent = error instanceof Error ? error.message : "Unable to unlock this archive."
                this.passwordForm("Unlock archive", "Enter the archive password. Its filenames and contents stay encrypted until it is unlocked.", unlock)
            }
        }
        await unlock(initialPassword)
    }

    async upgrade(record: FileCardRecord) {
        const { operation, signal } = this.create(record, "Upgrade archive")
        this.status!.textContent = "Your original archive and all its stored data will be kept."
        this.passwordForm("Create upgraded copy", "TGLFS will stream this archive into a separate copy that supports browsing, then verify the new copy. It normally reads the original once; some older uploads may require another pass. No temporary local file is saved. Keep this tab open until verification finishes. Closing this window cancels the upgrade; the original remains available.", async (password) => {
            const transfer = Transfers.begin({ direction: "task", name: `Upgrade ${record.data.name}`, size: record.data.size, queue: false })
            const modalController = this.controller!
            const cancel = () => modalController.abort()
            transfer.signal.addEventListener("abort", cancel, { once: true })
            this.body?.replaceChildren(node("p", undefined, "Creating a new archive copy. The original remains available."))
            const progress = node("progress", "archive-upgrade-progress")
            progress.max = record.data.size || 1
            progress.value = 0
            this.body?.append(progress)
            try {
                const { Api, getFileInfo } = await getGramJs()
                const upgraded = await upgradeArchive(this.client, {
                    Api, getFileInfo, source: record, password, signal,
                    onProgress: (update) => {
                        if (operation !== this.operation) return
                        const phases = { reading: "Reading original", uploading: "Uploading new copy", verifying: "Verifying new copy" }
                        transfer.update({ bytes: update.bytesProcessed, total: update.totalBytes, phase: phases[update.phase] })
                        this.status!.textContent = `${phases[update.phase]}… ${formatFileCardSize(update.bytesProcessed)} of ${formatFileCardSize(update.totalBytes)}`
                        progress.max = update.totalBytes || 1
                        progress.value = update.bytesProcessed
                    },
                })
                transfer.complete({ message: "Upgrade verified. Original archive kept.", ufid: upgraded.data.ufid })
                if (operation !== this.operation) return
                this.status!.textContent = "Upgrade verified. Your original archive has been kept."
                await this.onUpgrade(upgraded)
                if (operation === this.operation) await this.open(upgraded, password)
            } catch (error) {
                if (signal.aborted) transfer.markCancelled()
                else transfer.fail(error)
                if (operation !== this.operation) return
                if (signal.aborted) {
                    this.status!.textContent = "Upgrade cancelled. Your original archive is unchanged."
                    return
                }
                this.status!.textContent = `${error instanceof Error ? error.message : "Upgrade failed."} Your original archive is unchanged. A cancelled or failed attempt may leave an incomplete copy; it is not used as a replacement.`
            } finally {
                transfer.signal.removeEventListener("abort", cancel)
            }
        })
    }

    private showDirectory() {
        if (!this.reader || !this.body) return
        this.body.replaceChildren()
        this.breadcrumb = node("nav", "archive-breadcrumb")
        this.breadcrumb.setAttribute("aria-label", "Archive folders")
        const columns = node("div", "archive-preview-columns")
        this.listing = node("div", "archive-entry-list")
        this.details = node("section", "archive-entry-preview")
        this.details.setAttribute("aria-label", "Selected archive member")
        columns.append(this.listing, this.details)
        this.body.append(this.breadcrumb, columns)
        this.status!.textContent = `${this.reader.index.entries.length} entries. Only selected file contents are fetched.`
        this.renderDirectory()
    }

    private renderDirectory() {
        if (!this.reader || !this.listing || !this.breadcrumb) return
        this.memberOperation++
        this.clearMember()
        this.breadcrumb.replaceChildren()
        const root = node("button", "fx-btn fx-btn-secondary", "Archive")
        root.addEventListener("click", () => { this.currentPath = ""; this.directoryLimit = 200; this.renderDirectory() })
        this.breadcrumb.append(root)
        let prefix = ""
        for (const segment of this.currentPath.split("/").filter(Boolean)) {
            prefix += `${segment}/`
            const path = prefix
            const crumb = node("button", "fx-btn fx-btn-secondary", segment)
            crumb.addEventListener("click", () => { this.currentPath = path; this.directoryLimit = 200; this.renderDirectory() })
            this.breadcrumb.append(crumb)
        }
        this.listing.replaceChildren()
        const folders = new Set<string>()
        const files: ArchiveMember[] = []
        for (const entry of this.reader.index.entries) {
            const path = entry.path.replace(/^\.\//, "")
            if (!path.startsWith(this.currentPath)) continue
            const relative = path.slice(this.currentPath.length)
            const slash = relative.indexOf("/")
            if (slash >= 0) {
                if (slash > 0) folders.add(relative.slice(0, slash))
            } else if (relative && entry.kind === "directory") folders.add(relative)
            else if (relative) files.push(entry)
        }
        let displayed = 0
        for (const name of Array.from(folders).sort().slice(0, this.directoryLimit)) {
            const button = node("button", "archive-entry-row", `📁 ${name}`)
            button.addEventListener("click", () => { this.currentPath += `${name}/`; this.directoryLimit = 200; this.renderDirectory() })
            this.listing.append(button)
            displayed++
        }
        for (const entry of files.slice(0, Math.max(0, this.directoryLimit - displayed))) {
            const button = node("button", "archive-entry-row")
            button.append(node("span", undefined, entry.path.split("/").pop() || entry.path), node("small", undefined, entry.kind === "file" ? formatFileCardSize(entry.size) : entry.kind))
            button.addEventListener("click", () => { void this.previewEntry(entry) })
            this.listing.append(button)
            displayed++
        }
        if (displayed < folders.size + files.length) {
            const more = node("button", "fx-btn fx-btn-secondary", `Show more (${displayed} of ${folders.size + files.length})`)
            more.addEventListener("click", () => { this.directoryLimit += 200; this.renderDirectory() })
            this.listing.append(more)
        }
        if (!folders.size && !files.length) this.listing.append(node("p", undefined, "This folder is empty."))
    }

    private async previewEntry(entry: ArchiveMember) {
        if (!this.reader || !this.details || !this.controller) return
        const reader = this.reader
        const signal = this.controller.signal
        const operation = ++this.memberOperation
        this.clearMember()
        this.details.append(node("h3", undefined, entry.path))
        if (entry.kind !== "file") {
            this.details.append(node("p", undefined, `This entry is a ${entry.kind}. Links are displayed without following them.`))
            if (entry.linkTarget) this.details.append(node("pre", undefined, entry.linkTarget))
            return
        }
        const mime = memberMime(entry.path)
        const info = node("p", "archive-member-info", `Loading ${formatFileCardSize(entry.size)} member…`)
        this.details.append(info)
        try {
            if (TEXT_EXTENSIONS.has(extension(entry.path))) {
                const bytes = await this.readMemberBytes(reader, entry, Math.min(entry.size, TEXT_PREVIEW_BYTES), operation, signal)
                if (operation !== this.memberOperation || signal.aborted) return
                this.details.append(node("pre", "archive-text-preview", new TextDecoder().decode(bytes)))
                info.textContent = entry.size > TEXT_PREVIEW_BYTES ? `Showing the first ${formatFileCardSize(TEXT_PREVIEW_BYTES)} of ${formatFileCardSize(entry.size)}.` : formatFileCardSize(entry.size)
            } else if (mime.startsWith("image/") && entry.size <= IMAGE_PREVIEW_BYTES) {
                const bytes = await this.readMemberBytes(reader, entry, entry.size, operation, signal)
                if (operation !== this.memberOperation || signal.aborted) return
                this.blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
                const image = node("img", "archive-member-image")
                image.alt = entry.path
                image.src = this.blobUrl
                this.details.append(image)
                info.textContent = formatFileCardSize(entry.size)
            } else {
                info.textContent = mime.startsWith("image/") ? "This image is too large for an in-memory preview. You can download this member separately." : "Only requested portions of this member are fetched."
            }
            const memberUrl = await createMemberUrl(reader, entry, signal, {
                complete: () => {
                    for (const frame of this.downloadFrames) frame.remove()
                    this.downloadFrames.clear()
                    if (operation === this.memberOperation) info.textContent = "Member download completed."
                },
                error: (error) => { if (operation === this.memberOperation) info.textContent = error.message },
                progress: () => {},
            })
            if (operation !== this.memberOperation || signal.aborted) { memberUrl.close(); return }
            this.memberUrl = memberUrl
            if (mime.startsWith("video/") || mime.startsWith("audio/")) {
                const media = node(mime.startsWith("video/") ? "video" : "audio", "archive-member-media")
                media.controls = true
                media.preload = "metadata"
                media.src = memberUrl.url
                media.addEventListener("error", () => { info.textContent = "This browser cannot play the member, or a requested block could not be read. You can download the member separately." })
                this.details.append(media)
            } else if (mime === "application/pdf") {
                const frame = node("iframe", "archive-member-pdf")
                frame.title = entry.path
                frame.src = memberUrl.url
                this.details.append(frame)
            }
            const download = node("a", "fx-btn fx-btn-secondary", "Download this file")
            download.href = `${memberUrl.url}?download=1`
            download.addEventListener("click", async (event) => {
                event.preventDefault()
                if (download.getAttribute("aria-disabled") === "true") return
                download.setAttribute("aria-disabled", "true")
                let mounted: MemberUrl | null = null
                let frame: HTMLIFrameElement | null = null
                const cleanup = () => {
                    frame?.remove()
                    if (frame) this.downloadFrames.delete(frame)
                    mounted?.close()
                    if (mounted) this.downloadUrls.delete(mounted)
                    download.removeAttribute("aria-disabled")
                }
                try {
                    mounted = await createMemberUrl(reader, entry, signal, {
                        complete: () => { cleanup(); if (operation === this.memberOperation) info.textContent = "Member download completed." },
                        error: (error) => { cleanup(); if (operation === this.memberOperation) info.textContent = error.message },
                        progress: () => {},
                    }, true)
                    if (operation !== this.memberOperation || signal.aborted) { cleanup(); return }
                    this.downloadUrls.add(mounted)
                    frame = node("iframe")
                    frame.hidden = true
                    frame.src = `${mounted.url}?download=1`
                    this.downloadFrames.add(frame)
                    document.body.append(frame)
                } catch (error) {
                    cleanup()
                    if (operation === this.memberOperation) info.textContent = error instanceof Error ? error.message : "Member download failed."
                }
            })
            this.details.append(download)
        } catch (error) {
            if (operation !== this.memberOperation || signal.aborted) return
            info.textContent = error instanceof Error ? error.message : "Unable to preview this member."
        }
    }

    private async readMemberBytes(reader: ArchiveReader, entry: ArchiveMember, length: number, operation: number, signal: AbortSignal): Promise<Uint8Array> {
        const previous = this.memberRead
        let release!: () => void
        this.memberRead = new Promise<void>((resolve) => { release = resolve })
        try {
            await previous
            if (signal.aborted || operation !== this.memberOperation) throw new DOMException("Preview cancelled.", "AbortError")
            const bytes = new Uint8Array(length)
            for (let offset = 0; offset < length; offset += 1024 * 1024) {
                if (signal.aborted || operation !== this.memberOperation) throw new DOMException("Preview cancelled.", "AbortError")
                const part = await reader.readRange(entry.dataOffset + offset, Math.min(1024 * 1024, length - offset))
                if (signal.aborted || operation !== this.memberOperation) throw new DOMException("Preview cancelled.", "AbortError")
                bytes.set(part, offset)
            }
            return bytes
        } finally {
            release()
        }
    }
}
