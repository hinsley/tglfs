import type { Mp4Metadata } from "./mp4-preview.js"

export type PreviewConversionMode = "copy" | "transcode" | "none"
export type FfmpegPlan = { args: string[]; videoMode: PreviewConversionMode; audioMode: PreviewConversionMode }

export function buildPreviewableFfmpegPlan(input: string, metadata: Mp4Metadata): FfmpegPlan {
    if (!metadata.hasVideo) throw new Error("The selected MP4 has no video track.")
    const supportedAvcProfiles = new Set([66, 77, 88, 100]) // Baseline, Main, Extended, High (8-bit)
    const copyVideo =
        (metadata.videoCodec === "avc1" || metadata.videoCodec === "avc3") &&
        metadata.videoAvcProfile !== null &&
        supportedAvcProfiles.has(metadata.videoAvcProfile)
    const copyAudio = metadata.hasAudio && metadata.audioCodec === "mp4a"
    const videoMode: PreviewConversionMode = copyVideo ? "copy" : "transcode"
    const audioMode: PreviewConversionMode = metadata.hasAudio ? (copyAudio ? "copy" : "transcode") : "none"
    const videoArgs = copyVideo
        ? ["-c:v", "copy"]
        : [
            "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "baseline", "-level:v", "3.1",
            "-x264-params", "keyint=60:min-keyint=60:scenecut=0:ref=1:bframes=0:cabac=0:weightp=0",
            "-maxrate", "5000k", "-bufsize", "10000k",
        ]
    const audioArgs = !metadata.hasAudio
        ? ["-an"]
        : copyAudio
            ? ["-c:a", "copy"]
            : ["-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ac", "2", "-ar", "48000"]
    return {
        videoMode,
        audioMode,
        args: [
            "-hide_banner", "-loglevel", "warning", "-y", "-i", input,
            "-map", "0:v:0", ...(metadata.hasAudio ? ["-map", "0:a:0?"] : []), "-sn", "-dn",
            ...videoArgs, ...audioArgs,
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+empty_moov+default_base_moof+frag_keyframe",
            "-frag_duration", "2000000", "-min_frag_duration", "500000",
            "-f", "mp4", "pipe:1",
        ],
    }
}
