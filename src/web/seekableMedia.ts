import type { BlockReader } from "../../packages/tglfs-cli/src/shared/block-format"
import { inspectMp4InitializationSegment } from "./mp4Fragment"
import { inspectWebmHeader } from "./webmHeader"

const BUFFER_AHEAD = 20
const BUFFER_BEHIND = 8
const MAX_FRAGMENT = 32 * 1024 * 1024
function waitUpdate(buffer: SourceBuffer, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const clean = () => {
            buffer.removeEventListener("updateend", done)
            buffer.removeEventListener("error", fail)
            signal.removeEventListener("abort", abort)
        }
        const done = () => {
            clean()
            resolve()
        }
        const fail = () => {
            clean()
            reject(new Error("This browser cannot decode the indexed media fragment."))
        }
        const abort = () => {
            clean()
            reject(new DOMException("Preview closed.", "AbortError"))
        }
        if (signal.aborted) return abort()
        buffer.addEventListener("updateend", done, { once: true })
        buffer.addEventListener("error", fail, { once: true })
        signal.addEventListener("abort", abort, { once: true })
    })
}
async function append(buffer: SourceBuffer, bytes: Uint8Array, signal: AbortSignal) {
    signal.throwIfAborted()
    const ready = waitUpdate(buffer, signal)
    try {
        buffer.appendBuffer(bytes)
    } catch (error) {
        void ready.catch(() => {})
        throw error
    }
    await ready
}
async function range(reader: BlockReader, offset: number, length: number) {
    if (length > MAX_FRAGMENT)
        throw new Error("This media fragment exceeds the preview memory limit. Re-encode with shorter fragments.")
    const bytes = new Uint8Array(length)
    for (let n = 0; n < length; ) {
        const count = Math.min(reader.content.blockSize, length - n)
        bytes.set(await reader.readRange(offset + n, count), n)
        n += count
    }
    return bytes
}

/** Fetch indexed fragments around the current playhead and restart from a prior keyframe after seeking. */
export async function playSeekableMedia(
    media: HTMLMediaElement,
    reader: BlockReader,
    parentSignal: AbortSignal,
): Promise<void> {
    const stop = new AbortController()
    const signal = (AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }).any([
        parentSignal,
        stop.signal,
    ])
    const index = reader.plan.mediaIndex
    if (!index) throw new Error("This preview has no encrypted media seek index. Upgrade its preview first.")
    if (typeof MediaSource === "undefined") throw new Error("This browser does not support indexed media previews.")
    const initialization = await range(reader, 0, index.initializationLength)
    const mime =
        index.container === "webm"
            ? inspectWebmHeader(initialization)?.mimeType
            : inspectMp4InitializationSegment(initialization).complete
              ? ["video/mp4", 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'].find((value) =>
                    MediaSource.isTypeSupported(value),
                )
              : undefined
    if (!mime || !MediaSource.isTypeSupported(mime))
        throw new Error("This browser cannot decode the indexed preview codecs.")
    const source = new MediaSource()
    const url = URL.createObjectURL(source)
    let stopped = false,
        pending = false,
        running = false,
        next = 0,
        generation = 0
    let buffer: SourceBuffer | undefined
    const cleanup = () => {
        if (stopped) return
        stopped = true
        generation++
        media.removeEventListener("seeking", seek)
        media.removeEventListener("timeupdate", request)
        media.removeEventListener("playing", request)
        if (buffer?.updating) {
            try {
                buffer.abort()
            } catch {}
        }
        URL.revokeObjectURL(url)
        signal.removeEventListener("abort", cleanup)
        stop.abort(new DOMException("Preview closed.", "AbortError"))
    }
    signal.addEventListener("abort", cleanup, { once: true })
    const fail = (error: unknown) => {
        if (signal.aborted || stopped) return
        cleanup()
        media.dispatchEvent(
            new CustomEvent("tglfs:media-error", { detail: error instanceof Error ? error : new Error(String(error)) }),
        )
    }
    const request = () => {
        pending = true
        if (!running) void pump().catch(fail)
    }
    const seek = () => {
        generation++
        pending = true
        if (!running) void pump().catch(fail)
    }
    let appliedGeneration = -1
    const pump = async () => {
        if (!buffer || stopped || running) return
        running = true
        try {
            while (pending && !stopped) {
                pending = false
                const current = generation
                if (current !== appliedGeneration) {
                    if (buffer.buffered.length) {
                        const done = waitUpdate(buffer, signal)
                        buffer.remove(0, Math.max(index.duration, buffer.buffered.end(buffer.buffered.length - 1)) + 1)
                        await done
                    }
                    const target = Math.max(0, media.currentTime)
                    next = 0
                    for (let i = 0; i < index.segments.length; i++) {
                        if (index.segments[i].time > target) break
                        if (index.segments[i].keyframe) next = i
                    }
                    await append(buffer, initialization, signal)
                    appliedGeneration = current
                }
                while (next < index.segments.length && !stopped && generation === current) {
                    const segment = index.segments[next]
                    if (segment.time > media.currentTime + BUFFER_AHEAD) break
                    const bytes = await range(reader, segment.offset, segment.length)
                    if (generation !== current || stopped) break
                    await append(buffer, bytes, signal)
                    next++
                }
                if (generation !== current) {
                    pending = true
                    continue
                }
                const trim = media.currentTime - BUFFER_BEHIND
                if (trim > 0 && buffer.buffered.length && buffer.buffered.start(0) < trim) {
                    const done = waitUpdate(buffer, signal)
                    buffer.remove(0, trim)
                    await done
                }
                if (next === index.segments.length && source.readyState === "open" && !buffer.updating)
                    source.endOfStream()
            }
        } finally {
            running = false
        }
    }
    media.src = url
    try {
        await new Promise<void>((resolve, reject) => {
            const done = () => {
                clean()
                resolve()
            }
            const abort = () => {
                clean()
                reject(new DOMException("Preview closed.", "AbortError"))
            }
            const timeout = setTimeout(() => {
                clean()
                reject(new Error("The indexed preview could not start."))
            }, 10000)
            const clean = () => {
                clearTimeout(timeout)
                source.removeEventListener("sourceopen", done)
                signal.removeEventListener("abort", abort)
            }
            if (signal.aborted) return abort()
            source.addEventListener("sourceopen", done, { once: true })
            signal.addEventListener("abort", abort, { once: true })
        })
        source.duration = index.duration
        buffer = source.addSourceBuffer(mime)
        media.addEventListener("seeking", seek)
        media.addEventListener("timeupdate", request)
        media.addEventListener("playing", request)
        pending = true
        await pump()
    } catch (error) {
        cleanup()
        throw error
    }
}
