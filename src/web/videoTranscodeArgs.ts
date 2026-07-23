const FRAGMENT_ARGS = [
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+empty_moov+default_base_moof+frag_keyframe",
    "-frag_duration", "2000000",
    "-min_frag_duration", "500000",
    "-f", "mp4",
]

export function makeFragmentedMp4Args(inputName: string, outputName: string, codecArgs: string[]): string[] {
    return [
        "-hide_banner", "-y", "-i", inputName,
        "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        ...codecArgs,
        ...FRAGMENT_ARGS,
        outputName,
    ]
}

export function makeFallbackTranscodeArgs(inputName: string, outputName: string, addSilentAudio: boolean): string[] {
    const inputs = addSilentAudio
        ? ["-hide_banner", "-y", "-i", inputName, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        : ["-hide_banner", "-y", "-i", inputName]
    return [
        ...inputs,
        "-map", "0:v:0", "-map", addSilentAudio ? "1:a:0" : "0:a:0", "-sn", "-dn",
        "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-profile:v", "baseline", "-level:v", "3.1",
        "-x264-params", "keyint=60:min-keyint=60:scenecut=0:ref=1:bframes=0:cabac=0:weightp=0",
        "-maxrate", "5000k", "-bufsize", "10000k",
        "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        ...(addSilentAudio ? ["-shortest"] : []),
        ...FRAGMENT_ARGS,
        outputName,
    ]
}
