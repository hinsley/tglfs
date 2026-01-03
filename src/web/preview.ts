import { Api } from "telegram"
import { getFileInfo } from "telegram/Utils"
import * as Encryption from "./encryption"
import { FileCardData } from "../types/models"

export type PreviewEntry = { msgId: number; date: number; data: FileCardData }
type PreviewFileType = "image" | "video" | "audio" | "unsupported"

const DOWNLOAD_PART_SIZE = 1024 * 1024

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"])
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"])
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"])

function humanReadableSize(size: number): string {
    if (size <= 0 || !isFinite(size)) return "0 B"
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    const i = Math.floor(Math.log(size) / Math.log(1024))
    const value = size / Math.pow(1024, i)
    return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

function formatDate(epochSec: number): string {
    const date = new Date(epochSec * 1000)
    const pad = (n: number) => (n < 10 ? "0" + n : "" + n)
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function getExtension(name: string): string {
    const parts = name.toLowerCase().split(".")
    if (parts.length < 2) return ""
    return parts.pop() ?? ""
}

function detectFileType(name: string): PreviewFileType {
    const ext = getExtension(name)
    if (IMAGE_EXTS.has(ext)) return "image"
    if (VIDEO_EXTS.has(ext)) return "video"
    if (AUDIO_EXTS.has(ext)) return "audio"
    return "unsupported"
}

function getMimeType(name: string): string {
    const ext = getExtension(name)
    switch (ext) {
        case "jpg":
        case "jpeg":
            return "image/jpeg"
        case "png":
            return "image/png"
        case "gif":
            return "image/gif"
        case "webp":
            return "image/webp"
        case "bmp":
            return "image/bmp"
        case "svg":
            return "image/svg+xml"
        case "mp4":
        case "m4v":
            return "video/mp4"
        case "webm":
            return "video/webm"
        case "mov":
            return "video/quicktime"
        case "avi":
            return "video/x-msvideo"
        case "mkv":
            return "video/x-matroska"
        case "mp3":
            return "audio/mpeg"
        case "wav":
            return "audio/wav"
        case "ogg":
            return "audio/ogg"
        case "flac":
            return "audio/flac"
        case "m4a":
            return "audio/mp4"
        case "aac":
            return "audio/aac"
        default:
            return "application/octet-stream"
    }
}

function base64ToBytes(base64: string) {
    const binString = atob(base64)
    return Uint8Array.from(binString, (char: string) => {
        const code = char.codePointAt(0)
        if (code === undefined) {
            throw new Error("Invalid character in base64 string")
        }
        return code
    })
}

export class PreviewModal {
    private client: any
    private modal = document.getElementById("previewModal")
    private backdrop = document.querySelector<HTMLElement>("#previewModal .preview-backdrop")
    private closeButton = document.querySelector<HTMLButtonElement>("#previewModal .preview-close")
    private loading = document.getElementById("previewLoading")
    private loadingText = document.getElementById("previewLoadingText")
    private progressBar = document.getElementById("previewProgress")
    private spinner = document.querySelector<HTMLElement>("#previewModal .spinner")
    private cancelButton = document.getElementById("previewCancel") as HTMLButtonElement | null
    private content = document.querySelector<HTMLElement>("#previewModal .preview-content")
    private mediaContainer = document.getElementById("previewMediaContainer")
    private previewImage = document.getElementById("previewImage") as HTMLImageElement | null
    private previewVideo = document.getElementById("previewVideo") as HTMLVideoElement | null
    private previewAudio = document.getElementById("previewAudio") as HTMLAudioElement | null
    private fileNameEl = document.getElementById("previewFileName")
    private fileMetaEl = document.getElementById("previewFileMeta")
    private abortController: AbortController | null = null
    private currentItems: PreviewEntry[] = []
    private currentIndex = -1
    private blobUrl: string | null = null
    private mediaSource: MediaSource | null = null
    private sourceBuffer: SourceBuffer | null = null
    private openState = false
    private touchStartX: number | null = null
    private touchStartY: number | null = null

    constructor(client: any) {
        this.client = client
        this.closeButton?.addEventListener("click", () => this.close())
        this.backdrop?.addEventListener("click", () => this.close())
        this.cancelButton?.addEventListener("click", () => this.cancel())
        this.content?.addEventListener("touchstart", (e) => {
            if (e.touches.length !== 1) return
            this.touchStartX = e.touches[0].clientX
            this.touchStartY = e.touches[0].clientY
        })
        this.content?.addEventListener("touchend", (e) => {
            if (this.touchStartX === null || this.touchStartY === null) return
            const dx = e.changedTouches[0].clientX - this.touchStartX
            const dy = e.changedTouches[0].clientY - this.touchStartY
            const isHorizontal = Math.abs(dx) > Math.abs(dy)
            if (isHorizontal && Math.abs(dx) > 40) {
                if (dx < 0) {
                    void this.showNext()
                } else {
                    void this.showPrevious()
                }
            }
            this.touchStartX = null
            this.touchStartY = null
        })
    }

    isOpen(): boolean {
        return this.openState
    }

    async open(entry: PreviewEntry, items: PreviewEntry[]) {
        const previewableItems = items.filter((item) => detectFileType(item.data.name) !== "unsupported")
        const index = previewableItems.findIndex((item) => item.msgId === entry.msgId)
        if (index < 0) {
            alert("Preview not available for this file type")
            return
        }
        this.currentItems = previewableItems
        await this.openAt(index)
    }

    async showNext() {
        if (!this.openState || this.currentIndex < 0) return
        if (this.currentIndex >= this.currentItems.length - 1) return
        await this.openAt(this.currentIndex + 1)
    }

    async showPrevious() {
        if (!this.openState || this.currentIndex <= 0) return
        await this.openAt(this.currentIndex - 1)
    }

    close() {
        this.abortController?.abort()
        this.abortController = null
        if (this.blobUrl) {
            URL.revokeObjectURL(this.blobUrl)
            this.blobUrl = null
        }
        if (this.mediaSource?.readyState === "open") {
            try {
                this.mediaSource.endOfStream()
            } catch {}
        }
        this.sourceBuffer = null
        this.mediaSource = null
        this.resetMedia()
        this.modal?.setAttribute("hidden", "")
        this.openState = false
    }

    private cancel() {
        if (this.abortController) {
            this.abortController.abort()
        }
        this.close()
    }

    private async openAt(index: number) {
        if (!this.modal) return
        const entry = this.currentItems[index]
        const type = detectFileType(entry.data.name)
        if (type === "unsupported") {
            alert("Preview not available for this file type")
            return
        }
        const password = prompt("Decryption password (leave empty if none):")
        if (password === null) return

        this.currentIndex = index
        this.openState = true
        this.modal.removeAttribute("hidden")
        this.setFileInfo(entry)
        if (type === "video" || type === "audio") {
            this.resetMedia()
            this.hideLoading()
            if (this.mediaContainer) this.mediaContainer.setAttribute("hidden", "")
        } else {
            this.showLoading()
        }
        if (this.blobUrl) {
            URL.revokeObjectURL(this.blobUrl)
            this.blobUrl = null
        }
        this.abortController?.abort()
        const controller = new AbortController()
        this.abortController = controller

        try {
            if (type === "video" || type === "audio") {
                await this.streamToMedia(entry.data, type, password, (progress) => {
                    this.updateProgress(progress)
                }, controller.signal)
            } else {
                const blob = await this.downloadToMemory(entry.data, password, (progress) => {
                    this.updateProgress(progress)
                }, controller.signal)
                const blobUrl = URL.createObjectURL(blob)
                this.blobUrl = blobUrl
                this.showMedia(type, blobUrl)
            }
        } catch (err: any) {
            if (controller.signal.aborted) {
                return
            }
            this.showError(err?.message ?? "Preview failed.")
        }
    }

    private showLoading(resetProgress = true, text = "Downloading...") {
        if (this.loading) this.loading.removeAttribute("hidden")
        if (this.mediaContainer) this.mediaContainer.setAttribute("hidden", "")
        if (this.spinner) this.spinner.removeAttribute("hidden")
        if (this.loadingText) this.loadingText.textContent = text
        if (resetProgress && this.progressBar) this.progressBar.style.width = "0%"
        if (this.cancelButton) this.cancelButton.textContent = "Cancel"
        if (resetProgress) this.resetMedia()
    }

    private hideLoading() {
        if (this.loading) this.loading.setAttribute("hidden", "")
    }

    private setLoadingText(text: string) {
        if (this.loading) this.loading.removeAttribute("hidden")
        if (this.spinner) this.spinner.removeAttribute("hidden")
        if (this.loadingText) this.loadingText.textContent = text
    }

    private showMedia(type: PreviewFileType, blobUrl: string, keepLoading = false) {
        if (!keepLoading && this.loading) this.loading.setAttribute("hidden", "")
        if (this.mediaContainer) this.mediaContainer.removeAttribute("hidden")
        if (this.previewImage) this.previewImage.setAttribute("hidden", "")
        if (this.previewVideo) this.previewVideo.setAttribute("hidden", "")
        if (this.previewAudio) this.previewAudio.setAttribute("hidden", "")
        if (type === "image" && this.previewImage) {
            this.previewImage.src = blobUrl
            this.previewImage.removeAttribute("hidden")
        } else if (type === "video" && this.previewVideo) {
            this.previewVideo.src = blobUrl
            this.previewVideo.load()
            this.previewVideo.removeAttribute("hidden")
        } else if (type === "audio" && this.previewAudio) {
            this.previewAudio.src = blobUrl
            this.previewAudio.load()
            this.previewAudio.removeAttribute("hidden")
        }
    }

    private resetMedia() {
        if (this.previewImage) {
            this.previewImage.src = ""
            this.previewImage.setAttribute("hidden", "")
        }
        if (this.previewVideo) {
            this.previewVideo.pause()
            this.previewVideo.removeAttribute("src")
            this.previewVideo.load()
            this.previewVideo.setAttribute("hidden", "")
        }
        if (this.previewAudio) {
            this.previewAudio.pause()
            this.previewAudio.removeAttribute("src")
            this.previewAudio.load()
            this.previewAudio.setAttribute("hidden", "")
        }
    }

    private updateProgress(pct: number) {
        const clamped = Math.max(0, Math.min(100, pct))
        if (this.progressBar) {
            this.progressBar.style.width = `${clamped}%`
        }
    }

    private showError(message: string) {
        if (this.loading) this.loading.removeAttribute("hidden")
        if (this.mediaContainer) this.mediaContainer.setAttribute("hidden", "")
        if (this.spinner) this.spinner.setAttribute("hidden", "")
        if (this.loadingText) this.loadingText.textContent = message
        if (this.cancelButton) this.cancelButton.textContent = "Close"
    }

    private setFileInfo(entry: PreviewEntry) {
        if (this.fileNameEl) this.fileNameEl.textContent = entry.data.name
        if (this.fileMetaEl) {
            this.fileMetaEl.textContent = `${humanReadableSize(entry.data.size)} • ${formatDate(entry.date)}`
        }
    }

    private getStreamMimeType(name: string, type: "video" | "audio"): string | null {
        if (typeof MediaSource === "undefined") return null
        const ext = getExtension(name)
        const candidates: string[] = []
        if (type === "video") {
            if (ext === "webm") {
                candidates.push('video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="vp9, opus"', "video/webm")
            } else if (ext === "mp4" || ext === "m4v" || ext === "mov") {
                candidates.push('video/mp4; codecs="avc1.42E01E, mp4a.40.2"', "video/mp4")
            }
        } else {
            if (ext === "mp3") {
                candidates.push("audio/mpeg")
            } else if (ext === "wav") {
                candidates.push("audio/wav")
            } else if (ext === "ogg") {
                candidates.push('audio/ogg; codecs="vorbis"', "audio/ogg")
            } else if (ext === "flac") {
                candidates.push("audio/flac")
            } else if (ext === "m4a" || ext === "aac") {
                candidates.push('audio/mp4; codecs="mp4a.40.2"', "audio/mp4")
            } else if (ext === "webm") {
                candidates.push('audio/webm; codecs="opus"', "audio/webm")
            }
        }
        for (const candidate of candidates) {
            if (MediaSource.isTypeSupported(candidate)) return candidate
        }
        return null
    }

    private createMediaSource(mimeType: string, signal: AbortSignal) {
        if (typeof MediaSource === "undefined") {
            throw new Error("Streaming preview is not supported in this browser.")
        }
        const mediaSource = new MediaSource()
        const objectUrl = URL.createObjectURL(mediaSource)
        const sourceBufferPromise = new Promise<SourceBuffer>((resolve, reject) => {
            const onOpen = () => {
                if (signal.aborted) {
                    reject(new Error("Preview cancelled."))
                    return
                }
                try {
                    const buffer = mediaSource.addSourceBuffer(mimeType)
                    buffer.mode = "sequence"
                    resolve(buffer)
                } catch (err) {
                    reject(err)
                }
            }
            const onError = () => reject(new Error("Failed to initialize media source."))
            mediaSource.addEventListener("sourceopen", onOpen, { once: true })
            mediaSource.addEventListener("error", onError, { once: true })
        })
        return { mediaSource, objectUrl, sourceBufferPromise }
    }

    private appendBufferAsync(sourceBuffer: SourceBuffer, chunk: Uint8Array, signal: AbortSignal) {
        return new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error("Preview cancelled."))
                return
            }
            const onError = () => {
                cleanup()
                reject(new Error("Failed to append media buffer."))
            }
            const onUpdate = () => {
                cleanup()
                resolve()
            }
            const cleanup = () => {
                sourceBuffer.removeEventListener("error", onError)
                sourceBuffer.removeEventListener("updateend", onUpdate)
            }
            sourceBuffer.addEventListener("error", onError)
            sourceBuffer.addEventListener("updateend", onUpdate)
            try {
                const buffer = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
                    ? chunk.buffer
                    : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
                sourceBuffer.appendBuffer(buffer)
            } catch (err) {
                cleanup()
                reject(err)
            }
        })
    }

    private async streamToMedia(
        data: FileCardData,
        type: "video" | "audio",
        password: string,
        onProgress: (pct: number) => void,
        signal: AbortSignal,
    ) {
        const mimeType = this.getStreamMimeType(data.name, type)
        if (!mimeType) {
            throw new Error("Streaming preview not supported for this file type.")
        }
        const { mediaSource, objectUrl, sourceBufferPromise } = this.createMediaSource(mimeType, signal)
        this.mediaSource = mediaSource
        this.blobUrl = objectUrl
        this.showMedia(type, objectUrl)
        const sourceBuffer = await sourceBufferPromise
        this.sourceBuffer = sourceBuffer
        signal.addEventListener(
            "abort",
            () => {
                try {
                    sourceBuffer.abort()
                } catch {}
            },
            { once: true },
        )

        const chunkMsgs: Api.messages.Messages = await this.client.getMessages("me", { ids: data.chunks })
        const IVBytes = base64ToBytes(data.IV)
        const salt = IVBytes.subarray(0, 16)
        const aesKey = await Encryption.deriveAESKeyFromPassword(password ?? "", salt)
        let decryptionCounter = IVBytes.slice(16)

        let aesBlockBytesWritten = 0
        const decryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)

        let bytesProcessed = 0
        const byteCounterStream = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                bytesProcessed += chunk.length
                const pct = data.size > 0 ? Math.round((bytesProcessed / data.size) * 100) : 100
                onProgress(pct)
                controller.enqueue(chunk)
            },
        })

        const decompressionStream = new DecompressionStream("gzip")
        const writer = decompressionStream.writable.getWriter()
        const reader = decompressionStream.readable.pipeThrough(byteCounterStream).getReader()

        let ready = false
        const mediaEl = type === "video" ? this.previewVideo : this.previewAudio
        const markReady = () => {
            ready = true
        }
        mediaEl?.addEventListener("loadedmetadata", markReady, { once: true })
        mediaEl?.addEventListener("canplay", markReady, { once: true })
        mediaEl?.addEventListener(
            "error",
            () => {
                this.showError("Unable to play this file in streaming preview.")
            },
            { once: true },
        )

        let appendError: unknown = null
        const appendPromise = (async () => {
            try {
                while (true) {
                    if (signal.aborted) throw new Error("Preview cancelled.")
                    const { value, done } = await reader.read()
                    if (done) break
                    if (!value || value.length === 0) continue
                    await this.appendBufferAsync(sourceBuffer, value, signal)
                }
            } catch (err) {
                appendError = err
            }
        })()

        let writeError: unknown = null
        try {
            for (const chunkMsg of chunkMsgs) {
                let chunkBytesWritten = 0
                const docSize = (chunkMsg as any).media.document.size
                while (chunkBytesWritten < docSize) {
                    if (signal.aborted) {
                        throw new Error("Preview cancelled.")
                    }
                    const chunkPart = await this.client.invoke(
                        new Api.upload.GetFile({
                            location: getFileInfo((chunkMsg as any).media).location,
                            offset: chunkBytesWritten,
                            limit: DOWNLOAD_PART_SIZE,
                            precise: false,
                            cdnSupported: false,
                        }),
                    )
                    const chunkBytes = (chunkPart as any).bytes
                    chunkBytesWritten += chunkBytes.length
                    decryptionBuffer.set(chunkBytes, aesBlockBytesWritten)
                    aesBlockBytesWritten += chunkBytes.length
                    if (aesBlockBytesWritten === decryptionBuffer.length) {
                        const decryptedData = new Uint8Array(
                            await window.crypto.subtle.decrypt(
                                { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                                aesKey,
                                decryptionBuffer,
                            ),
                        )
                        const blocks = Math.ceil(decryptionBuffer.length / 16)
                        decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, blocks)
                        aesBlockBytesWritten = 0
                        await writer.write(decryptedData)
                    }
                }
            }
            if (aesBlockBytesWritten > 0) {
                const decryptedData = new Uint8Array(
                    await window.crypto.subtle.decrypt(
                        { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                        aesKey,
                        decryptionBuffer.subarray(0, aesBlockBytesWritten),
                    ),
                )
                const tailBlocks = Math.ceil(aesBlockBytesWritten / 16)
                decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, tailBlocks)
                await writer.write(decryptedData)
            }
            await writer.close()
        } catch (err) {
            writeError = err
            try {
                await writer.abort(err)
            } catch {}
        } finally {
            await appendPromise
        }

        if (writeError) {
            if (writeError instanceof TypeError) {
                throw new Error("Incorrect decryption password.")
            }
            throw writeError
        }
        if (appendError) {
            throw appendError
        }
        if (mediaSource.readyState === "open") {
            try {
                mediaSource.endOfStream()
            } catch {}
        }
        if (!ready) {
            await new Promise((resolve) => setTimeout(resolve, 0))
            if (!ready) {
                this.showError("This file cannot be streamed in the preview.")
                return
            }
        }
        onProgress(100)
    }

    private async downloadToMemory(
        data: FileCardData,
        password: string,
        onProgress: (pct: number) => void,
        signal: AbortSignal,
    ): Promise<Blob> {
        const chunkMsgs: Api.messages.Messages = await this.client.getMessages("me", { ids: data.chunks })
        const IVBytes = base64ToBytes(data.IV)
        const salt = IVBytes.subarray(0, 16)
        const aesKey = await Encryption.deriveAESKeyFromPassword(password ?? "", salt)
        let decryptionCounter = IVBytes.slice(16)

        let aesBlockBytesWritten = 0
        const decryptionBuffer = new Uint8Array(Encryption.ENCRYPTION_CHUNK_SIZE)

        let bytesProcessed = 0
        const byteCounterStream = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                bytesProcessed += chunk.length
                const pct = data.size > 0 ? Math.round((bytesProcessed / data.size) * 100) : 100
                onProgress(pct)
                controller.enqueue(chunk)
            },
        })

        const decompressionStream = new DecompressionStream("gzip")
        const writer = decompressionStream.writable.getWriter()
        const decompressedStream = decompressionStream.readable.pipeThrough(byteCounterStream)
        const reader = decompressedStream.getReader()
        const outputChunks: Uint8Array[] = []
        let streamError: unknown = null
        const readPromise = (async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    if (value) outputChunks.push(value)
                }
            } catch (err) {
                streamError = err
            }
        })()

        let writeError: unknown = null
        try {
            for (const chunkMsg of chunkMsgs) {
                let chunkBytesWritten = 0
                const docSize = (chunkMsg as any).media.document.size
                while (chunkBytesWritten < docSize) {
                    if (signal.aborted) {
                        throw new Error("Preview cancelled.")
                    }
                    const chunkPart = await this.client.invoke(
                        new Api.upload.GetFile({
                            location: getFileInfo((chunkMsg as any).media).location,
                            offset: chunkBytesWritten,
                            limit: DOWNLOAD_PART_SIZE,
                            precise: false,
                            cdnSupported: false,
                        }),
                    )
                    const chunkBytes = (chunkPart as any).bytes
                    chunkBytesWritten += chunkBytes.length
                    decryptionBuffer.set(chunkBytes, aesBlockBytesWritten)
                    aesBlockBytesWritten += chunkBytes.length
                    if (aesBlockBytesWritten === decryptionBuffer.length) {
                        const decryptedData = new Uint8Array(
                            await window.crypto.subtle.decrypt(
                                { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                                aesKey,
                                decryptionBuffer,
                            ),
                        )
                        const blocks = Math.ceil(decryptionBuffer.length / 16)
                        decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, blocks)
                        aesBlockBytesWritten = 0
                        await writer.write(decryptedData)
                    }
                }
            }
            if (aesBlockBytesWritten > 0) {
                const decryptedData = new Uint8Array(
                    await window.crypto.subtle.decrypt(
                        { name: "AES-CTR", counter: decryptionCounter, length: 64 },
                        aesKey,
                        decryptionBuffer.subarray(0, aesBlockBytesWritten),
                    ),
                )
                const tailBlocks = Math.ceil(aesBlockBytesWritten / 16)
                decryptionCounter = Encryption.incrementCounter64By(decryptionCounter, tailBlocks)
                await writer.write(decryptedData)
            }
            await writer.close()
        } catch (err) {
            writeError = err
            try {
                await writer.abort(err)
            } catch {}
        } finally {
            await readPromise
        }

        if (writeError) {
            if (writeError instanceof TypeError) {
                throw new Error("Incorrect decryption password.")
            }
            throw writeError
        }
        if (streamError) {
            if (streamError instanceof TypeError) {
                throw new Error("Incorrect decryption password.")
            }
            throw streamError
        }

        onProgress(100)
        return new Blob(outputChunks, { type: getMimeType(data.name) })
    }
}
