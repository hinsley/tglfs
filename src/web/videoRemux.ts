import { FFmpeg } from "@ffmpeg/ffmpeg"
import coreURL from "@ffmpeg/core?url"
import wasmURL from "@ffmpeg/core/wasm?url"
import { canUseCurrentPreview, supportsStreamingMp4Preview, validateFragmentedMp4 } from "./mp4Fragment"
import { makeFallbackTranscodeArgs, makeFragmentedMp4Args } from "./videoTranscodeArgs"

export type RemuxableVideoKind = "mp4" | "mov"
type RemuxProgressCallback = (progress: number) => void

export const MAX_FFMPEG_INPUT_BYTES = 2_000_000_000
const COPY_PROGRESS_END = 35
const TRANSCODE_PROGRESS_START = 40
const TRANSCODE_PROGRESS_END = 96
const previewReadyFiles = new WeakSet<File>()
let ffmpegPromise: Promise<FFmpeg> | null = null

function extension(name: string): string {
    const dot = name.lastIndexOf(".")
    return dot < 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase()
}

function replaceExtension(name: string, next: string): string {
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"))
    const dot = name.lastIndexOf(".")
    return dot > slash ? `${name.slice(0, dot)}.${next}` : `${name}.${next}`
}

export function markVideoPreviewReady(file: File): File {
    previewReadyFiles.add(file)
    return file
}

export function getRemuxableVideoKind(file: File): RemuxableVideoKind | null {
    if (previewReadyFiles.has(file)) return null
    const ext = extension(file.name)
    const mime = file.type.toLowerCase()
    if (ext === "mov" || ext === "qt" || mime === "video/quicktime") return "mov"
    if (ext === "mp4" || ext === "m4v" || mime === "video/mp4" || mime === "application/mp4") return "mp4"
    return null
}

export function getRemuxedVideoName(file: File, kind: RemuxableVideoKind): string {
    if (kind === "mov") return replaceExtension(file.name, "mp4")
    return extension(file.name) === "mp4" ? file.name : replaceExtension(file.name, "mp4")
}

export function getRemuxConfirmMessage(file: File, kind: RemuxableVideoKind): string {
    const outputName = getRemuxedVideoName(file, kind)
    return [
        `Convert "${file.name}" for streaming before upload?`,
        "",
        "TGLFS will first try a lossless fragmented-MP4 remux. If Preview rejects the copied tracks, it will create a browser-compatible H.264/AAC encoding.",
        "If conversion cannot produce an MP4 accepted by Preview, the upload will stop with an error.",
        kind === "mov" ? `\nThis MOV result will be uploaded as:\n${outputName}` : "",
    ].filter(Boolean).join("\n")
}

async function getFFmpeg(): Promise<FFmpeg> {
    if (!ffmpegPromise) {
        ffmpegPromise = (async () => {
            const ffmpeg = new FFmpeg()
            await ffmpeg.load({ coreURL, wasmURL })
            return ffmpeg
        })().catch((error) => {
            ffmpegPromise = null
            throw error
        })
    }
    return ffmpegPromise
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function logDetails(logs: string[]): string {
    return logs.length ? `\n${logs.slice(-30).join("\n")}` : ""
}

async function readOutput(ffmpeg: FFmpeg, name: string): Promise<Uint8Array> {
    const data = await ffmpeg.readFile(name)
    if (typeof data === "string") throw new Error("FFmpeg returned text instead of MP4 bytes.")
    if (!data.length) throw new Error("FFmpeg produced an empty MP4.")
    return data.slice()
}

function outputFile(data: Uint8Array, file: File, kind: RemuxableVideoKind): File {
    return markVideoPreviewReady(new File([data], getRemuxedVideoName(file, kind), {
        type: "video/mp4",
        lastModified: file.lastModified || Date.now(),
    }))
}

export async function remuxToStreamingMp4(
    file: File,
    kind: RemuxableVideoKind,
    onProgress?: RemuxProgressCallback,
): Promise<File> {
    if (file.size >= MAX_FFMPEG_INPUT_BYTES) {
        throw new Error(`FFmpeg WebAssembly cannot convert files of ${MAX_FFMPEG_INPUT_BYTES.toLocaleString()} bytes or larger.`)
    }
    if (!supportsStreamingMp4Preview()) throw new Error("Streaming MP4 Preview is not supported by this browser.")

    const ffmpeg = await getFFmpeg()
    const inputName = kind === "mov" ? "input.mov" : "input.mp4"
    const copyName = "output-copy.mp4"
    const transcodeName = "output-transcoded.mp4"
    let progressStart = 0
    let progressEnd = COPY_PROGRESS_END
    let logs: string[] = []
    let sawAudio = false

    const logHandler = ({ message }: { message: string }) => {
        if (/Stream #\d+:\d+.*Audio:/i.test(message)) sawAudio = true
        logs.push(message)
        if (logs.length > 80) logs.shift()
    }
    const progressHandler = ({ progress }: { progress: number }) => {
        if (!Number.isFinite(progress) || progress < 0) return
        const fraction = Math.max(0, Math.min(1, progress))
        onProgress?.(Math.round(progressStart + fraction * (progressEnd - progressStart)))
    }

    ffmpeg.on("log", logHandler)
    ffmpeg.on("progress", progressHandler)
    try {
        await Promise.all([inputName, copyName, transcodeName].map((name) => ffmpeg.deleteFile(name).catch(() => undefined)))
        await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()))

        logs = []
        sawAudio = false
        const copyExit = await ffmpeg.exec(makeFragmentedMp4Args(inputName, copyName, ["-c:v", "copy", "-c:a", "copy"]))
        const inputHasAudio = sawAudio
        if (copyExit === 0) {
            try {
                const data = await readOutput(ffmpeg, copyName)
                const firstFragmentEnd = validateFragmentedMp4(data)
                onProgress?.(COPY_PROGRESS_END + 2)
                if (await canUseCurrentPreview(data, firstFragmentEnd)) {
                    onProgress?.(100)
                    return outputFile(data, file, kind)
                }
            } catch {
                // Invalid or unsupported copied tracks fall through to re-encoding.
            }
        }

        logs = []
        progressStart = TRANSCODE_PROGRESS_START
        progressEnd = TRANSCODE_PROGRESS_END
        const transcodeExit = await ffmpeg.exec(makeFallbackTranscodeArgs(inputName, transcodeName, !inputHasAudio))
        if (transcodeExit !== 0) {
            const copyFailure = copyExit === 0
                ? "The lossless remux was not accepted by Preview."
                : `Lossless remux exit code: ${copyExit}.`
            throw new Error(`${copyFailure} Browser-compatible re-encoding failed with exit code ${transcodeExit}.${logDetails(logs)}`)
        }

        const data = await readOutput(ffmpeg, transcodeName)
        const firstFragmentEnd = validateFragmentedMp4(data)
        if (!(await canUseCurrentPreview(data, firstFragmentEnd))) {
            throw new Error(`FFmpeg produced an MP4 that Preview still rejected.${logDetails(logs)}`)
        }
        onProgress?.(100)
        return outputFile(data, file, kind)
    } catch (error) {
        throw new Error(`Unable to convert "${file.name}" for streaming. ${errorText(error)}`)
    } finally {
        ffmpeg.off("log", logHandler)
        ffmpeg.off("progress", progressHandler)
        await Promise.all([inputName, copyName, transcodeName].map((name) => ffmpeg.deleteFile(name).catch(() => undefined)))
    }
}
