import "./mp4Previewable"
import { PreviewModal as CorePreviewModal } from "./previewCore"
import type { PreviewEntry } from "./previewCore"
import {
    getBufferedAheadSeconds,
    getFurthestBufferedEnd,
    getMp4BufferLimits,
    getMp4EvictionRange,
    MP4_BUFFER_BEHIND_SECONDS,
    MP4_QUOTA_BUFFER_BEHIND_SECONDS,
} from "./mp4BufferPolicy"
import { inspectMp4InitializationSegment } from "./mp4Fragment"

const LEGACY_FIXED_MP4_MIME = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
const MP4_INITIALIZATION_BUFFER_LIMIT = 8 * 1024 * 1024
const mp4SourceBuffers = new WeakSet<SourceBuffer>()

type Mp4BufferState = {
    totalAppendedBytes: number
    furthestBufferedEnd: number
    mediaSource: MediaSource
    initializationChunks: Uint8Array[]
    initializationBytes: number
    initializationComplete: boolean
    durationSeconds: number | null
    durationApplied: boolean
}

const mp4BufferStates = new WeakMap<SourceBuffer, Mp4BufferState>()

function extension(name: string): string {
    const parts = name.toLowerCase().split(".")
    return parts.length > 1 ? parts.pop() ?? "" : ""
}

function previewVideo(): HTMLVideoElement | null {
    return document.getElementById("previewVideo") as HTMLVideoElement | null
}

function formatDuration(seconds: number): string {
    const totalSeconds = Math.max(0, Math.round(seconds))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const remainder = totalSeconds % 60
    const padded = (value: number) => value.toString().padStart(2, "0")
    return hours > 0 ? `${hours}:${padded(minutes)}:${padded(remainder)}` : `${minutes}:${padded(remainder)}`
}

function updateDurationLabel(durationSeconds: number) {
    const metadata = document.getElementById("previewFileMeta")
    if (!metadata) return
    const base = (metadata.textContent ?? "").replace(/\s+•\s+Duration:\s+[^•]+$/, "")
    metadata.textContent = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? `${base} • Duration: ${formatDuration(durationSeconds)}`
        : base
}

function abortError() {
    return new Error("Preview cancelled.")
}

function isQuotaExceededError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const candidate = error as { name?: unknown; message?: unknown }
    return candidate.name === "QuotaExceededError" ||
        (typeof candidate.message === "string" && /sourcebuffer is full|quota/i.test(candidate.message))
}

function waitForMediaProgress(media: HTMLMediaElement, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortError())
            return
        }
        let timeout = 0
        const cleanup = () => {
            window.clearTimeout(timeout)
            media.removeEventListener("timeupdate", finish)
            media.removeEventListener("playing", finish)
            media.removeEventListener("seeked", finish)
            signal.removeEventListener("abort", cancel)
        }
        const finish = () => {
            cleanup()
            resolve()
        }
        const cancel = () => {
            cleanup()
            reject(abortError())
        }
        media.addEventListener("timeupdate", finish, { once: true })
        media.addEventListener("playing", finish, { once: true })
        media.addEventListener("seeked", finish, { once: true })
        signal.addEventListener("abort", cancel, { once: true })
        timeout = window.setTimeout(finish, 750)
    })
}

function removeBufferAsync(sourceBuffer: SourceBuffer, start: number, end: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortError())
            return
        }
        const cleanup = () => {
            sourceBuffer.removeEventListener("error", onError)
            sourceBuffer.removeEventListener("updateend", onUpdate)
            signal.removeEventListener("abort", onAbort)
        }
        const onError = () => {
            cleanup()
            reject(new Error("Failed to evict old MP4 preview data."))
        }
        const onUpdate = () => {
            cleanup()
            resolve()
        }
        const onAbort = () => {
            cleanup()
            reject(abortError())
        }
        sourceBuffer.addEventListener("error", onError)
        sourceBuffer.addEventListener("updateend", onUpdate)
        signal.addEventListener("abort", onAbort, { once: true })
        try {
            sourceBuffer.remove(start, end)
        } catch (error) {
            cleanup()
            reject(error)
        }
    })
}

async function evictOldMp4Data(
    sourceBuffer: SourceBuffer,
    media: HTMLMediaElement,
    signal: AbortSignal,
    keepBehindSeconds: number,
    minimumSeconds: number,
): Promise<boolean> {
    const range = getMp4EvictionRange(sourceBuffer.buffered, media.currentTime, keepBehindSeconds, minimumSeconds)
    if (!range) return false
    await removeBufferAsync(sourceBuffer, range.start, range.end, signal)
    return true
}

async function waitForMp4BufferCapacity(sourceBuffer: SourceBuffer, media: HTMLMediaElement, signal: AbortSignal) {
    const state = mp4BufferStates.get(sourceBuffer)
    const limits = getMp4BufferLimits(state?.totalAppendedBytes ?? 0, state?.furthestBufferedEnd ?? 0)
    if (getBufferedAheadSeconds(sourceBuffer.buffered, media.currentTime) < limits.highWaterSeconds) return

    while (true) {
        if (signal.aborted) throw abortError()
        await evictOldMp4Data(sourceBuffer, media, signal, MP4_BUFFER_BEHIND_SECONDS, 5)
        const ahead = getBufferedAheadSeconds(sourceBuffer.buffered, media.currentTime)
        if (ahead <= limits.lowWaterSeconds) return
        await waitForMediaProgress(media, signal)
    }
}

function concatenateChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
    const output = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
    }
    return output
}

function collectMp4Initialization(state: Mp4BufferState, chunk: Uint8Array): Uint8Array | null {
    if (state.initializationComplete) return chunk

    const storedChunk = chunk.slice()
    state.initializationChunks.push(storedChunk)
    state.initializationBytes += storedChunk.byteLength
    const combined = concatenateChunks(state.initializationChunks, state.initializationBytes)
    const metadata = inspectMp4InitializationSegment(combined)
    if (!metadata.complete && state.initializationBytes < MP4_INITIALIZATION_BUFFER_LIMIT) return null

    state.initializationComplete = true
    state.durationSeconds = metadata.durationSeconds
    state.initializationChunks = []
    state.initializationBytes = 0
    return combined
}

function applyMp4Duration(sourceBuffer: SourceBuffer, state: Mp4BufferState) {
    if (state.durationApplied || !state.durationSeconds) return
    if (state.mediaSource.readyState !== "open" || sourceBuffer.updating) return
    try {
        // MSE allows the application to set the full presentation duration. Setting it before the
        // initialization segment is appended prevents a fragmented MP4 from being treated as live/Infinity.
        state.mediaSource.duration = state.durationSeconds
        state.durationApplied = true
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Unable to set the MP4 preview duration. ${detail}`)
    }
}

export class PreviewModal extends CorePreviewModal {
    constructor(client: any) {
        super(client)

        previewVideo()?.addEventListener("durationchange", (event) => {
            updateDurationLabel((event.currentTarget as HTMLVideoElement).duration)
        })

        const originalMime = (this as any).getStreamMimeType?.bind(this)
        ;(this as any).getStreamMimeType = (name: string, type: "video" | "audio") => {
            const ext = extension(name)
            if (type === "video" && (ext === "mp4" || ext === "m4v" || ext === "mov")) {
                // Prefer the generic MP4 byte-stream declaration so the initialization segment identifies
                // the actual tracks. Converted fallback files deliberately use the legacy AVC/AAC profile pair.
                for (const candidate of ["video/mp4", LEGACY_FIXED_MP4_MIME]) {
                    if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(candidate)) return candidate
                }
                return null
            }
            return originalMime?.(name, type) ?? null
        }

        const originalCreateMediaSource = (this as any).createMediaSource?.bind(this)
        ;(this as any).createMediaSource = (mimeType: string, signal: AbortSignal) => {
            const result = originalCreateMediaSource(mimeType, signal)
            if (!mimeType.toLowerCase().startsWith("video/mp4")) return result
            return {
                ...result,
                sourceBufferPromise: result.sourceBufferPromise.then((sourceBuffer: SourceBuffer) => {
                    // Fragmented MP4 carries real decode timestamps; segments mode preserves them and seeking geometry.
                    sourceBuffer.mode = "segments"
                    mp4SourceBuffers.add(sourceBuffer)
                    mp4BufferStates.set(sourceBuffer, {
                        totalAppendedBytes: 0,
                        furthestBufferedEnd: 0,
                        mediaSource: result.mediaSource,
                        initializationChunks: [],
                        initializationBytes: 0,
                        initializationComplete: false,
                        durationSeconds: null,
                        durationApplied: false,
                    })
                    return sourceBuffer
                }),
            }
        }

        const originalAppendBuffer = (this as any).appendBufferAsync?.bind(this)
        ;(this as any).appendBufferAsync = async (sourceBuffer: SourceBuffer, chunk: Uint8Array, signal: AbortSignal) => {
            if (!mp4SourceBuffers.has(sourceBuffer)) {
                return await originalAppendBuffer(sourceBuffer, chunk, signal)
            }
            const media = previewVideo()
            const state = mp4BufferStates.get(sourceBuffer)
            if (!media || !state) return await originalAppendBuffer(sourceBuffer, chunk, signal)

            const appendChunk = collectMp4Initialization(state, chunk)
            if (!appendChunk) return
            applyMp4Duration(sourceBuffer, state)

            while (true) {
                await waitForMp4BufferCapacity(sourceBuffer, media, signal)
                try {
                    await originalAppendBuffer(sourceBuffer, appendChunk, signal)
                    state.totalAppendedBytes += appendChunk.byteLength
                    state.furthestBufferedEnd = Math.max(state.furthestBufferedEnd, getFurthestBufferedEnd(sourceBuffer.buffered))
                    await evictOldMp4Data(sourceBuffer, media, signal, MP4_BUFFER_BEHIND_SECONDS, 5)
                    return
                } catch (error) {
                    if (!isQuotaExceededError(error)) throw error

                    // Chrome throws QuotaExceededError synchronously instead of automatically applying enough
                    // backpressure. Drop data safely behind playback, or wait until playback advances enough to do so.
                    const evicted = await evictOldMp4Data(
                        sourceBuffer,
                        media,
                        signal,
                        MP4_QUOTA_BUFFER_BEHIND_SECONDS,
                        0.25,
                    )
                    if (!evicted) await waitForMediaProgress(media, signal)
                }
            }
        }
    }
}

export type { PreviewEntry }
