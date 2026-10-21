import type { TelegramClient } from "telegram/client/TelegramClient.js"
import { dirname, basename, join } from "node:path"
import { createVerifiedFileCardPlaintextStream } from "./plaintext-stream.js"
import { probeMp4Stream } from "./mp4-preview.js"
import { uploadGeneratedCurrentFormatStream } from "./generated-upload.js"
import { collectMetadata, runMediaProcess } from "./webm-process.js"
import { isWebmSourceName, qualityReport, sampleWindows, validateWebmDimensions, webmCopyName } from "./shared/webm-policy.js"
import type { FileCardRecord } from "./types.js"
import { identifyVideoStream } from "./shared/video-stream.js"

export type WebmOptions = {
    sourcePassword: string
    chunkSize: number
    outputName?: string
    ffmpegPath?: string
    ffprobePath?: string
    signal?: AbortSignal
    onProgress?: (phase: string, bytes: number) => void
}
type ProbeStream = {
    codec_type: string; codec_name: string; pix_fmt?: string; width: number; height: number
    color_transfer?: string; color_primaries?: string; color_space?: string; color_range?: string
    field_order?: string; sample_aspect_ratio?: string; channels?: number; sample_rate?: string
    side_data_list?: { rotation?: number; side_data_type?: string }[]
    tags?: { rotate?: string; alpha_mode?: string; ALPHA_MODE?: string }; start_time?: string
}
export type WebmMetadata = { duration: number; video: ProbeStream; audio?: ProbeStream }

export function validateWebmProbe(probe: { streams: ProbeStream[]; format: { duration: string; format_name: string } }): WebmMetadata {
    if (!/^(mov,|matroska,webm$)/.test(probe.format?.format_name ?? "")) throw new Error("Only MP4/MOV/M4V and MKV/WebM containers are accepted.")
    const duration = Number(probe.format.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The source has no finite duration in its metadata.")
    const videos = probe.streams.filter(s => s.codec_type === "video"), audios = probe.streams.filter(s => s.codec_type === "audio")
    if (videos.length !== 1 || audios.length > 1 || probe.streams.length !== videos.length + audios.length) {
        throw new Error("Conversion requires one video track and at most one audio track; extra tracks would be lost.")
    }
    const video = videos[0], audio = audios[0]
    validateWebmDimensions(video.width, video.height)
    const progressive = video.field_order === "progressive" || (["vp8", "vp9", "av1"].includes(video.codec_name) && [undefined, "unknown"].includes(video.field_order))
    if (!["yuv420p", "yuvj420p"].includes(video.pix_fmt ?? "") || !progressive || Number(video.tags?.alpha_mode ?? video.tags?.ALPHA_MODE ?? 0) !== 0) {
        throw new Error("Only progressive, opaque, 8-bit 4:2:0 video is supported; higher depth, alpha and interlaced inputs are refused.")
    }
    if ([video.color_transfer, video.color_primaries, video.color_space].some(v => v && !["unknown", "bt709", "bt470bg", "smpte170m", "smpte240m", "bt470m", "gamma22", "gamma28", "iec61966-2-1", "gbr"].includes(v)) ||
        video.side_data_list?.some(s => /mastering|content light|dovi|hdr/i.test(s.side_data_type ?? ""))) {
        throw new Error("HDR or unsupported color metadata cannot be preserved safely in this preview conversion.")
    }
    if (Number(video.tags?.rotate ?? 0) !== 0 || video.side_data_list?.some(s => s.rotation) || (video.sample_aspect_ratio && !["1:1", "N/A"].includes(video.sample_aspect_ratio))) {
        throw new Error("Rotated or non-square-pixel sources are refused to preserve their presentation.")
    }
    if (Math.abs(Number(video.start_time ?? 0)) > 0.01 || (audio && Math.abs(Number(audio.start_time ?? 0)) > 0.1)) {
        throw new Error("This source has unsupported track timing offsets.")
    }
    if (audio && (![1, 2].includes(audio.channels ?? 0) || ![48000, 44100].includes(Number(audio.sample_rate)))) {
        throw new Error("Only mono/stereo audio at 44.1 or 48 kHz is supported.")
    }
    return { duration, video, audio }
}

export const WEBM_INPUT_ARGS = ["-max_alloc", "67108864", "-protocol_whitelist", "pipe", "-format_whitelist", "mov,matroska,webm", "-probesize", "33554432", "-analyzeduration", "10000000"]

export function buildWebmArgs(metadata: WebmMetadata) {
    const windows = sampleWindows(metadata.duration)
    const labels = windows.map((_, i) => i)
    const graph = [
        `[0:v]split=${windows.length}${labels.map(i => `[r${i}]`).join("")}`,
        `[dec:0]split=${windows.length}${labels.map(i => `[d${i}]`).join("")}`,
        ...windows.flatMap((w, i) => [
            `[r${i}]trim=start=${w.start}:end=${w.end},setpts=PTS-STARTPTS[rs${i}]`,
            `[d${i}]trim=start=${w.start}:end=${w.end},setpts=PTS-STARTPTS[ds${i}]`,
            `[rs${i}][ds${i}]ssim@clip${i}=shortest=1[q${i}]`,
        ]),
    ].join(";")
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-xerror", "-filter_buffered_frames", "16", "-filter_complex_threads", "2",
        ...WEBM_INPUT_ARGS, "-threads", "2", "-noautorotate", "-i", "pipe:0",
        "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "18", "-deadline", "good", "-cpu-used", "4", "-threads", "2", "-lag-in-frames", "0",
        "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-force_key_frames", "expr:gte(t,n_forced*2)"]
    for (const [key, value] of [["color_trc", metadata.video.color_transfer], ["color_primaries", metadata.video.color_primaries], ["colorspace", metadata.video.color_space], ["color_range", metadata.video.color_range]]) {
        if (value && value !== "unknown") args.push(`-${key}`, value)
    }
    if (metadata.audio) args.push("-c:a", "libopus", "-b:a", metadata.audio.channels === 1 ? "128k" : "192k", "-ar", "48000")
    args.push("-f", "webm", "-live", "1", "-cluster_time_limit", "2000", "-flush_packets", "1", "pipe:1", "-threads", "2", "-dec", "0:0", "-filter_complex", graph)
    for (const i of labels) args.push("-map", `[q${i}]`)
    args.push("-f", "null", "-")
    return args
}

export function parseWebmQuality(log: string, duration: number) {
    const clips = sampleWindows(duration).map((window, i) => {
        const match = new RegExp(`\\[ssim@clip${i}[^\\]]*\\] SSIM Y:([\\d.]+)`).exec(log)
        return { ...window, ssim: match ? Number(match[1]) : NaN }
    })
    return qualityReport(clips)
}

export async function openSafeWebmSource(source: ReadableStream<Uint8Array>) {
    const identified = await identifyVideoStream(source)
    if (identified.container === "mp4") {
        const probe = await probeMp4Stream(identified.stream)
        if (probe.placement !== "front-loaded") {
            await probe.stream.cancel().catch(() => {})
            throw new Error("MP4/MOV metadata must precede media data. This file requires seeking, so strict streaming conversion is refused.")
        }
        return probe.stream
    }
    return identified.stream
}

export async function convertWebm(client: TelegramClient, source: FileCardRecord, options: WebmOptions) {
    if (![1, 2, 3].includes(source.data.version) || !source.data.uploadComplete || !isWebmSourceName(source.data.name)) {
        throw new Error("Select a complete supported video file; archives and unknown file protocols cannot be converted.")
    }
    const name = options.outputName?.trim() || webmCopyName(source.data.name)
    if (!/\.webm$/i.test(name)) throw new Error("The output name must end in .webm.")
    const ffmpeg = options.ffmpegPath || process.env.TGLFS_FFMPEG || "ffmpeg"
    const ffprobe = options.ffprobePath || process.env.TGLFS_FFPROBE || join(dirname(ffmpeg), basename(ffmpeg).replace(/^ffmpeg/, "ffprobe"))
    await checkWebmCapabilities(ffmpeg, options.signal)
    const open = async (phase: string) => {
        options.signal?.throwIfAborted()
        return openSafeWebmSource(await createVerifiedFileCardPlaintextStream(client, source.data, options.sourcePassword, "current", p => {
            options.signal?.throwIfAborted()
            options.onProgress?.(phase, p.bytesWritten)
        }))
    }
    let inspectedBytes = 0
    const metadataSource = (await open("Checking source")).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            inspectedBytes += chunk.byteLength
            if (inspectedBytes > 64 * 1024 * 1024) throw new Error("Metadata inspection exceeded 64 MiB. This layout cannot safely stream.")
            controller.enqueue(chunk)
        },
    }))
    const probe = runMediaProcess(ffprobe, ["-v", "error", ...WEBM_INPUT_ARGS, "-i", "pipe:0", "-read_intervals", "%+#1", "-show_streams", "-show_format", "-of", "json"], metadataSource, options.signal, true)
    let metadata: WebmMetadata
    try {
        const [json] = await Promise.all([collectMetadata(probe.stream), probe.completion])
        metadata = validateWebmProbe(JSON.parse(json))
    } catch (error) { await probe.cancel(); throw error }
    const conversion = runMediaProcess(ffmpeg, buildWebmArgs(metadata), await open("Converting and comparing"), options.signal)
    const quality = conversion.completion.then(log => parseWebmQuality(log, metadata.duration))
    void quality.catch(() => {})
    const checked = conversion.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { controller.enqueue(chunk) },
        async flush() { await quality },
    }))
    try {
        const record = await uploadGeneratedCurrentFormatStream(client, {
            name, stream: checked, password: options.sourcePassword, chunkSize: options.chunkSize,
            parentFolderId: "parentFolderId" in source.data ? source.data.parentFolderId : undefined, signal: options.signal,
        })
        return { ...record, sourceUfid: source.data.ufid, originalRetained: true, stagedSource: false, quality: await quality }
    } catch (error) { await conversion.cancel(); throw error }
}

async function checkWebmCapabilities(ffmpeg: string, signal?: AbortSignal) {
    for (const [args, required] of [
        [["-h", "full"], ["-filter_buffered_frames"]],
        [["-encoders"], ["libvpx-vp9", "libopus"]],
        [["-filters"], ["ssim"]],
    ]) {
        const command = runMediaProcess(ffmpeg, ["-hide_banner", ...args], new ReadableStream({ start(c) { c.close() } }), signal)
        try {
            const [stdout, stderr] = await Promise.all([collectMetadata(command.stream, 4 * 1024 * 1024), command.completion])
            if (!required.every(value => (stdout + stderr).includes(value))) throw new Error("WebM conversion requires FFmpeg with libvpx-vp9, libopus, SSIM, loopback decoders and bounded filter buffers (FFmpeg 8+).")
        } catch (error) { await command.cancel(); throw error }
    }
}
