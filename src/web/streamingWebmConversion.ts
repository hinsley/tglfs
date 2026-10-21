import type { Input, VideoSample } from "mediabunny"
import { probeMp4MetadataPlacement } from "./mp4MetadataPlacement"
import { validateProgressiveAvc } from "../../packages/tglfs-cli/src/shared/avc-safety"
import { identifyVideoStream } from "../../packages/tglfs-cli/src/shared/video-stream"
import {
    isWebmSourceName, lumaSsim, qualityReport, sampleWindows, validateWebmDimensions,
    WEBM_CACHE_BYTES, WEBM_REFERENCE_BYTES, type WebmQualityReport,
} from "../../packages/tglfs-cli/src/shared/webm-policy"

/** Keep the plaintext reader available so the complete source is verified even if a demuxer stops early. */
function retainSource(source: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    const reader = source.getReader()
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> = Promise.resolve({ done: false, value: new Uint8Array() })
    let done = false
    let metadataOnly = true, metadataBytes = 0
    const abort = () => { void reader.cancel(signal?.reason).catch(() => {}) }
    signal?.addEventListener("abort", abort, { once: true })
    const next = () => pending = pending.then(async () => {
        signal?.throwIfAborted()
        const result = await reader.read()
        done = result.done
        if (!result.done && metadataOnly) {
            metadataBytes += result.value.length
            if (metadataBytes > 64 * 1024 * 1024) throw new Error("Metadata inspection exceeded 64 MiB. This layout cannot safely stream.")
        }
        return result
    })
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const result = await next()
            if (result.done) controller.close()
            else controller.enqueue(result.value)
        },
        cancel() {},
    })
    return {
        stream,
        startConversion() { metadataOnly = false },
        async drain() { await pending; while (!done) await next(); signal?.removeEventListener("abort", abort); reader.releaseLock() },
        async cancel(reason?: unknown) { signal?.removeEventListener("abort", abort); await reader.cancel(reason).catch(() => {}) },
    }
}

function readLuma(sample: VideoSample, canvas: OffscreenCanvas, width: number, height: number) {
    if (sample.displayWidth !== width || sample.displayHeight !== height) throw new Error("Video dimensions changed during conversion.")
    const context = canvas.getContext("2d", { willReadFrequently: true })!
    sample.draw(context, 0, 0, width, height)
    const rgba = context.getImageData(0, 0, width, height).data
    const luma = new Uint8Array(width * height)
    for (let i = 0; i < luma.length; i++) luma[i] = Math.round(0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2])
    return luma
}

export async function createStreamingWebm(
    plaintext: ReadableStream<Uint8Array>, name: string, signal?: AbortSignal,
) {
    let source = plaintext
    let input: Input | undefined
    let retained: ReturnType<typeof retainSource> | undefined
    try {
        if (!isWebmSourceName(name)) throw new Error("Supported inputs are MP4, MOV, M4V, MKV and WebM.")
        if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined" || typeof OffscreenCanvas === "undefined") {
            throw new Error("This browser cannot encode and quality-check a WebM stream. Use the TGLFS convert-webm command on a supported computer.")
        }
        const identified = await identifyVideoStream(source)
        source = identified.stream
        if (identified.container === "mp4") {
            const probed = await probeMp4MetadataPlacement(source)
            source = probed.stream
            if (probed.placement !== "front-loaded") throw new Error("This MP4/MOV requires seeking to trailing metadata. Conversion was refused because temporary video files are disabled.")
        }
        const mb = await import("mediabunny")
        retained = retainSource(source, signal)
        input = new mb.Input({ source: new mb.ReadableStreamSource(retained.stream, { maxCacheSize: WEBM_CACHE_BYTES }), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM] })
        const tracks = await input.getTracks()
        const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack()
        if (!video || tracks.length !== 1 + Number(!!audio)) throw new Error("Conversion requires one video track and at most one audio track; extra tracks would be lost.")
        const duration = await input.getDurationFromMetadata(undefined, { skipLiveWait: true })
        const windows = sampleWindows(duration ?? NaN)
        const width = await video.getDisplayWidth(), height = await video.getDisplayHeight()
        validateWebmDimensions(width, height)
        const decoder = await video.getDecoderConfig()
        if (await video.canBeTransparent()) throw new Error("Transparent video is refused to preserve its presentation.")
        if (!decoder || !/^(avc[13]\.(42|4d|58|64)[0-9a-f]{4}|vp8|vp09\.00\.[0-9]{2}\.08(?:\..*)?)$/i.test(decoder.codec) || !await video.canDecode()) {
            throw new Error("This browser cannot safely decode the source as opaque 8-bit video. Unsupported codecs, high bit depth and HDR are refused.")
        }
        const color = await video.getColorSpace()
        if (/^avc/i.test(decoder.codec)) validateProgressiveAvc(decoder.description)
        if ([color.transfer, color.primaries, color.matrix].some(v => v && !["bt709", "bt470bg", "smpte170m", "iec61966-2-1", "rgb"].includes(v))) throw new Error(`HDR or unsupported color metadata cannot be preserved safely (${JSON.stringify(color)}).`)
        if (await video.getRotation() !== 0 || await video.getCodedWidth() !== width || await video.getCodedHeight() !== height) {
            throw new Error("Rotated, cropped or non-square-pixel sources are refused to preserve their presentation.")
        }
        if (Math.abs(await video.getFirstTimestamp()) > 0.01 || (audio && Math.abs(await audio.getFirstTimestamp()) > 0.1)) throw new Error("This source has unsupported track timing offsets.")
        if (audio && (!await audio.canDecode() || ![1, 2].includes(await audio.getNumberOfChannels()) || ![44100, 48000].includes(await audio.getSampleRate()))) {
            throw new Error("This browser requires decodable mono/stereo audio at 44.1 or 48 kHz.")
        }
        const canvas = new OffscreenCanvas(width, height)
        const refs = new Map<number, { luma: Uint8Array; clip: number }>()
        const totals = windows.map(() => ({ sum: 0, frames: 0, last: -Infinity }))
        let referenceBytes = 0, sourceFrames = 0, decodedFrames = 0, lastSourceEnd = 0, lastDecodedEnd = 0
        const outgoing = new TransformStream<Uint8Array, Uint8Array>()
        const output = new mb.Output({
            format: new mb.WebMOutputFormat({ appendOnly: true, minimumClusterDuration: 1 }),
            target: new mb.AppendOnlyStreamTarget(outgoing.writable),
        })
        const conversion = await mb.Conversion.init({
            input, output, tracks: "all", tags: {}, showWarnings: false, trim: { start: 0 },
            video: {
                codec: "vp9", forceTranscode: true, bitrate: mb.QUALITY_VERY_HIGH, keyFrameInterval: 2,
                hardwareAcceleration: "prefer-software", allowRotationMetadata: false,
                process(sample) {
                    signal?.throwIfAborted()
                    if (!sample.format || !["I420", "NV12"].includes(sample.format)) throw new Error("The decoded video is not opaque 8-bit 4:2:0. Conversion was refused.")
                    sourceFrames++
                    lastSourceEnd = sample.timestamp + sample.duration
                    const clip = windows.findIndex(w => sample.timestamp >= w.start - 0.001 && sample.timestamp < w.end - 0.001)
                    if (clip >= 0 && sample.timestamp - totals[clip].last >= 0.12) {
                        const luma = readLuma(sample, canvas, width, height)
                        if (referenceBytes + luma.length > WEBM_REFERENCE_BYTES) throw new Error("The quality comparison exceeded its bounded frame memory. This input cannot safely stream.")
                        refs.set(Math.round(sample.timestamp * 1e6), { luma, clip })
                        totals[clip].last = sample.timestamp
                        referenceBytes += luma.length
                    }
                    return sample
                },
            },
            audio: { codec: "opus", forceTranscode: true, bitrate: 192_000, sampleRate: 48000 },
        })
        if (!conversion.isValid || conversion.discardedTracks.length) throw new Error("This browser cannot encode all source tracks to VP9/Opus WebM.")
        const qualityBridge = new TransformStream<Uint8Array, Uint8Array>()
        const qualityWriter = qualityBridge.writable.getWriter()
        const comparisonInput = new mb.Input({ source: new mb.ReadableStreamSource(qualityBridge.readable, { maxCacheSize: WEBM_CACHE_BYTES }), formats: [mb.WEBM] })
        const compare = (async () => {
            const track = await comparisonInput.getPrimaryVideoTrack()
            if (!track || !await track.canDecode()) throw new Error("The generated WebM cannot be decoded for its quality comparison.")
            for await (const sample of new mb.VideoSampleSink(track).samples()) {
                try {
                    signal?.throwIfAborted()
                    decodedFrames++
                    lastDecodedEnd = sample.timestamp + sample.duration
                    // WebM timestamps are stored in milliseconds.
                    const key = [...refs.keys()].find(t => Math.abs(t - sample.timestamp * 1e6) <= 1100)
                    if (key !== undefined) {
                        const ref = refs.get(key)!
                        const score = lumaSsim(ref.luma, readLuma(sample, canvas, width, height), width, height)
                        totals[ref.clip].sum += score
                        totals[ref.clip].frames++
                        refs.delete(key)
                        referenceBytes -= ref.luma.length
                    }
                } finally { sample.close() }
            }
        })().finally(() => comparisonInput.dispose())
        void compare.catch(error => { void qualityWriter.abort(error).catch(() => {}); void conversion.cancel().catch(() => {}) })
        retained.startConversion()
        const execution = conversion.execute()
        void execution.catch(error => { void qualityWriter.abort(error).catch(() => {}) })
        const outputReader = outgoing.readable.getReader()
        let report: WebmQualityReport | undefined
        const abort = async (reason?: unknown) => {
            await retained!.cancel(reason)
            await Promise.allSettled([qualityWriter.abort(reason), conversion.cancel(), outputReader.cancel(reason)])
            input?.dispose()
        }
        const onAbort = () => { void abort(signal?.reason) }
        signal?.addEventListener("abort", onAbort, { once: true })
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    signal?.throwIfAborted()
                    const { value, done } = await outputReader.read()
                    if (!done) {
                        await qualityWriter.write(value)
                        controller.enqueue(value)
                        return
                    }
                    await qualityWriter.close()
                    await Promise.all([execution, compare])
                    input!.dispose()
                    await retained!.drain()
                    if (!sourceFrames || sourceFrames !== decodedFrames || refs.size || Math.abs(lastSourceEnd - lastDecodedEnd) > 0.1 || Math.abs(lastSourceEnd - duration!) > 0.5) {
                        throw new Error("The generated WebM lost frames, timing, or quality samples; no file card was published.")
                    }
                    report = qualityReport(windows.map((w, i) => ({ ...w, ssim: totals[i].sum / totals[i].frames, frames: totals[i].frames })))
                    signal?.removeEventListener("abort", onAbort)
                    controller.close()
                } catch (error) {
                    await abort(error)
                    signal?.removeEventListener("abort", onAbort)
                    controller.error(error)
                }
            },
            async cancel(reason) { signal?.removeEventListener("abort", onAbort); await abort(reason) },
        })
        return { stream, duration: duration!, getQuality: () => {
            if (!report) throw new Error("The quality comparison is incomplete.")
            return report
        }, cancel: abort }
    } catch (error) {
        input?.dispose()
        await retained?.cancel(error)
        await source.cancel(error).catch(() => {})
        throw error
    }
}
