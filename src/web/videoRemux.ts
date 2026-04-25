import { FFmpeg } from "@ffmpeg/ffmpeg"
import coreURL from "@ffmpeg/core?url"
import wasmURL from "@ffmpeg/core/wasm?url"

export type RemuxableVideoKind = "mp4" | "mov"

type RemuxProgressCallback = (progress: number) => void

let ffmpegPromise: Promise<FFmpeg> | null = null

function getExtension(name: string): string {
    const lastDot = name.lastIndexOf(".")
    if (lastDot < 0 || lastDot === name.length - 1) {
        return ""
    }
    return name.slice(lastDot + 1).toLowerCase()
}

function replaceExtension(name: string, extension: string): string {
    const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"))
    const lastDot = name.lastIndexOf(".")
    if (lastDot > lastSlash) {
        return `${name.slice(0, lastDot)}.${extension}`
    }
    return `${name}.${extension}`
}

export function getRemuxableVideoKind(file: File): RemuxableVideoKind | null {
    const extension = getExtension(file.name)
    const mimeType = file.type.toLowerCase()

    if (extension === "mov" || extension === "qt" || mimeType === "video/quicktime") {
        return "mov"
    }
    if (extension === "mp4" || extension === "m4v" || mimeType === "video/mp4" || mimeType === "application/mp4") {
        return "mp4"
    }
    return null
}

export function getRemuxedVideoName(file: File, kind: RemuxableVideoKind): string {
    if (kind === "mov") {
        return replaceExtension(file.name, "mp4")
    }
    const extension = getExtension(file.name)
    if (extension === "mp4") {
        return file.name
    }
    return replaceExtension(file.name, "mp4")
}

export function getRemuxConfirmMessage(file: File, kind: RemuxableVideoKind): string {
    const outputName = getRemuxedVideoName(file, kind)
    const movNote =
        kind === "mov"
            ? `\n\nThis is a MOV file. The remuxed result will be uploaded as an MP4 file named:\n${outputName}`
            : ""

    return [
        `Remux "${file.name}" for streaming before upload?`,
        "",
        "This rewrites the container for browser streaming without re-encoding the video or audio tracks.",
        "If the file cannot be remuxed as a streamable MP4, the upload will stop with an error.",
        movNote,
    ]
        .filter((line) => line.length > 0)
        .join("\n")
}

async function getFFmpeg(): Promise<FFmpeg> {
    if (!ffmpegPromise) {
        ffmpegPromise = (async () => {
            const ffmpeg = new FFmpeg()
            await ffmpeg.load({ coreURL, wasmURL })
            return ffmpeg
        })()
    }
    return ffmpegPromise
}

function getErrorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return String(error)
}

function assertMoovBeforeMdat(bytes: Uint8Array) {
    let offset = 0
    let sawMoov = false

    while (offset + 8 <= bytes.length) {
        const size =
            bytes[offset] * 0x1000000 +
            bytes[offset + 1] * 0x10000 +
            bytes[offset + 2] * 0x100 +
            bytes[offset + 3]
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])

        if (type === "moov") {
            sawMoov = true
        }
        if (type === "mdat" && !sawMoov) {
            throw new Error("The remuxed MP4 is not web-optimized because media data appears before metadata.")
        }
        if (type === "moof" && sawMoov) {
            return
        }
        if (sawMoov && type === "mdat") {
            return
        }
        if (size === 1) {
            if (offset + 16 > bytes.length) {
                break
            }
            const largeSize =
                Number(bytes[offset + 8]) * 2 ** 56 +
                Number(bytes[offset + 9]) * 2 ** 48 +
                Number(bytes[offset + 10]) * 2 ** 40 +
                Number(bytes[offset + 11]) * 2 ** 32 +
                bytes[offset + 12] * 0x1000000 +
                bytes[offset + 13] * 0x10000 +
                bytes[offset + 14] * 0x100 +
                bytes[offset + 15]
            if (!Number.isSafeInteger(largeSize) || largeSize <= 0) {
                break
            }
            offset += largeSize
            continue
        }
        if (size < 8) {
            break
        }
        offset += size
    }

    if (!sawMoov) {
        throw new Error("The remuxed MP4 does not contain front-loaded metadata.")
    }
}

export async function remuxToStreamingMp4(
    file: File,
    kind: RemuxableVideoKind,
    onProgress?: RemuxProgressCallback,
): Promise<File> {
    const ffmpeg = await getFFmpeg()
    const inputName = kind === "mov" ? "input.mov" : "input.mp4"
    const outputName = "output.mp4"
    const logs: string[] = []
    const logHandler = ({ message }: { message: string }) => {
        logs.push(message)
        if (logs.length > 20) {
            logs.shift()
        }
    }
    const progressHandler = ({ progress }: { progress: number }) => {
        if (Number.isFinite(progress) && progress >= 0) {
            onProgress?.(Math.max(0, Math.min(100, Math.round(progress * 100))))
        }
    }

    ffmpeg.on("log", logHandler)
    ffmpeg.on("progress", progressHandler)
    try {
        await ffmpeg.deleteFile(inputName).catch(() => undefined)
        await ffmpeg.deleteFile(outputName).catch(() => undefined)
        await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()))
        const exitCode = await ffmpeg.exec([
            "-i",
            inputName,
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart+frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            outputName,
        ])
        if (exitCode !== 0) {
            const details = logs.length > 0 ? ` ${logs.join("\n")}` : ""
            throw new Error(`FFmpeg remux failed with exit code ${exitCode}.${details}`)
        }
        const data = await ffmpeg.readFile(outputName)
        if (typeof data === "string") {
            throw new Error("FFmpeg returned text instead of MP4 bytes.")
        }
        if (data.length === 0) {
            throw new Error("FFmpeg produced an empty MP4.")
        }
        assertMoovBeforeMdat(data)
        onProgress?.(100)
        return new File([data], getRemuxedVideoName(file, kind), {
            type: "video/mp4",
            lastModified: file.lastModified || Date.now(),
        })
    } catch (error) {
        throw new Error(`Unable to remux "${file.name}" for streaming. ${getErrorText(error)}`)
    } finally {
        ffmpeg.off("log", logHandler)
        ffmpeg.off("progress", progressHandler)
        await ffmpeg.deleteFile(inputName).catch(() => undefined)
        await ffmpeg.deleteFile(outputName).catch(() => undefined)
    }
}
