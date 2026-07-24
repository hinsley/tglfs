import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { open, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"

import type { TelegramClient } from "telegram/client/TelegramClient.js"

import type { DownloadMode, DownloadProgress } from "./download.js"
import { CliError, EXIT_CODES } from "./errors.js"
import { buildPreviewableFfmpegPlan, type FfmpegPlan, type PreviewConversionMode } from "./ffmpeg-plan.js"
import { uploadGeneratedCurrentFormatStream } from "./generated-upload.js"
import {
    createMp4DurationPatchTransform,
    inspectMp4File,
    probeMp4Stream,
    type Mp4Metadata,
    type Mp4MetadataPlacement,
} from "./mp4-preview.js"
import { createVerifiedFileCardPlaintextStream } from "./plaintext-stream.js"
import type { FileCardData, FileCardRecord } from "./types.js"

export type { PreviewConversionMode } from "./ffmpeg-plan.js"
export type MakePreviewableProgress = {
    phase: "download" | "stage" | "convert-upload"
    bytesProcessed: number
    totalBytes?: number
}
export type MakePreviewableOptions = {
    sourcePassword: string
    uploadPassword: string
    chunkSize: number
    outputName?: string
    ffmpegPath?: string
    ffprobePath?: string
    mode?: DownloadMode
    onProgress?: (progress: MakePreviewableProgress) => void
}
export type MakePreviewableResult = {
    sourceName: string
    sourceUfid: string
    name: string
    ufid: string
    size: number
    msgId: number
    date: number
    chunks: number[]
    metadataPlacement: Mp4MetadataPlacement
    stagedSource: boolean
    videoMode: PreviewConversionMode
    audioMode: PreviewConversionMode
}
type RunningConversion = {
    stream: ReadableStream<Uint8Array>
    completion: Promise<void>
    cancel(): Promise<void>
}

function isMp4(name: string) {
    return /\.mp4$/i.test(name.trim())
}

export function getPreviewableMp4Name(name: string) {
    const trimmed = name.trim()
    if (!isMp4(trimmed)) throw new Error(`Not an MP4 file name: ${name}`)
    const base = trimmed.slice(0, -4)
    const numbered = base.match(/^(.*)\.previewable-(\d+)$/i)
    if (numbered) return `${numbered[1]}.previewable-${Number(numbered[2]) + 1}.mp4`
    if (/\.previewable$/i.test(base)) return `${base}-2.mp4`
    return `${base}.previewable.mp4`
}

function parentFolderId(data: FileCardData) {
    const value = (data as FileCardData & { parentFolderId?: unknown }).parentFolderId
    return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function binaryError(binary: string, error: unknown) {
    const candidate = error as NodeJS.ErrnoException
    if (candidate?.code === "ENOENT") {
        return new CliError("ffmpeg_not_found", `${binary} was not found. Install FFmpeg or pass its path explicitly.`, EXIT_CODES.GENERAL_ERROR)
    }
    return error instanceof Error ? error : new Error(String(error))
}

async function pumpInput(stream: ReadableStream<Uint8Array>, child: ReturnType<typeof spawn>, isCancelled: () => boolean) {
    if (!child.stdin) throw new Error("FFmpeg stdin is unavailable.")
    const reader = stream.getReader()
    try {
        while (true) {
            if (isCancelled()) throw new Error("MP4 conversion cancelled.")
            const { value, done } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue
            if (!child.stdin.write(Buffer.from(value))) await once(child.stdin, "drain")
        }
        child.stdin.end()
    } catch (error) {
        child.stdin.destroy(error instanceof Error ? error : new Error(String(error)))
        try { await reader.cancel(error) } catch {}
        throw error
    } finally {
        try { reader.releaseLock() } catch {}
    }
}

function runFfmpeg(ffmpeg: string, plan: FfmpegPlan, duration: number, inputStream?: ReadableStream<Uint8Array>): RunningConversion {
    const child = spawn(ffmpeg, plan.args, { stdio: [inputStream ? "pipe" : "ignore", "pipe", "pipe"] })
    if (!child.stdout || !child.stderr) throw new Error("FFmpeg did not expose its output streams.")
    let cancelled = false
    const stderr: string[] = []
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (text: string) => {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
            stderr.push(line)
            if (stderr.length > 40) stderr.shift()
        }
    })
    const inputPromise = inputStream ? pumpInput(inputStream, child, () => cancelled) : Promise.resolve()
    const exitPromise = new Promise<void>((resolve, reject) => {
        child.once("error", (error: unknown) => reject(binaryError(ffmpeg, error)))
        child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
            if (code === 0) resolve()
            else reject(new CliError(
                "conversion_failed",
                `FFmpeg exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}.${stderr.length ? `\n${stderr.join("\n")}` : ""}`,
                EXIT_CODES.GENERAL_ERROR,
            ))
        })
    })
    const completion = Promise.all([inputPromise, exitPromise]).then(() => undefined)
    const raw = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    const stream = raw
        .pipeThrough(createMp4DurationPatchTransform(duration))
        .pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) { controller.enqueue(chunk) },
            async flush() { await completion },
        }))
    return {
        stream,
        completion,
        async cancel() {
            if (cancelled) return
            cancelled = true
            child.kill("SIGKILL")
            try { await inputStream?.cancel("MP4 conversion cancelled.") } catch {}
            try { await completion } catch {}
        },
    }
}

async function stageSource(stream: ReadableStream<Uint8Array>, expectedSize: number, onProgress?: MakePreviewableOptions["onProgress"]) {
    const directory = await mkdtemp(join(tmpdir(), "tglfs-mp4-preview-"))
    const filePath = join(directory, "source.mp4")
    const handle = await open(filePath, "w")
    const reader = stream.getReader()
    let bytes = 0
    let failure: unknown
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue
            let offset = 0
            while (offset < value.byteLength) {
                const result = await handle.write(value, offset, value.byteLength - offset)
                if (result.bytesWritten <= 0) throw new Error("Unable to write the temporary MP4 source file.")
                offset += result.bytesWritten
            }
            bytes += value.byteLength
            onProgress?.({ phase: "stage", bytesProcessed: bytes, totalBytes: expectedSize })
        }
        if (bytes !== expectedSize) throw new Error(`The staged source produced ${bytes} bytes; expected ${expectedSize}.`)
    } catch (error) {
        failure = error
    } finally {
        try { reader.releaseLock() } catch {}
        await handle.close()
    }
    if (failure) {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
        throw failure
    }
    return { filePath, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

function deriveFfprobe(ffmpeg: string) {
    const file = basename(ffmpeg)
    const next = /^ffmpeg(?:\.exe)?$/i.test(file) ? file.replace(/^ffmpeg/i, "ffprobe") : process.platform === "win32" ? "ffprobe.exe" : "ffprobe"
    return dirname(ffmpeg) === "." ? next : join(dirname(ffmpeg), next)
}
async function probeDuration(ffprobe: string, filePath: string) {
    const child = spawn(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], { stdio: ["ignore", "pipe", "pipe"] })
    if (!child.stdout || !child.stderr) throw new Error("ffprobe did not expose output streams.")
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (text: string) => { stdout += text })
    child.stderr.on("data", (text: string) => { stderr += text })
    const code = await new Promise<number>((resolve, reject) => {
        child.once("error", (error: unknown) => reject(binaryError(ffprobe, error)))
        child.once("close", (value: number | null) => resolve(value ?? 1))
    })
    if (code !== 0) throw new CliError("conversion_failed", `ffprobe exited with code ${code}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`, EXIT_CODES.GENERAL_ERROR)
    const duration = Number(stdout.trim())
    if (!Number.isFinite(duration) || duration <= 0) throw new CliError("invalid_media", "The MP4 has no finite duration.", EXIT_CODES.GENERAL_ERROR)
    return duration
}

export async function makeMp4Previewable(
    client: TelegramClient,
    source: FileCardRecord,
    options: MakePreviewableOptions,
): Promise<MakePreviewableResult> {
    if (!isMp4(source.data.name)) throw new CliError("invalid_media", `${source.data.name} is not an MP4 file.`, EXIT_CODES.GENERAL_ERROR)
    const outputName = options.outputName?.trim() || getPreviewableMp4Name(source.data.name)
    if (!isMp4(outputName)) throw new CliError("invalid_argument", "The output name must end in .mp4.", EXIT_CODES.GENERAL_ERROR)
    const ffmpeg = options.ffmpegPath?.trim() || process.env.TGLFS_FFMPEG?.trim() || "ffmpeg"
    const ffprobe = options.ffprobePath?.trim() || process.env.TGLFS_FFPROBE?.trim() || deriveFfprobe(ffmpeg)

    const plaintext = await createVerifiedFileCardPlaintextStream(
        client,
        source.data,
        options.sourcePassword,
        options.mode ?? "current",
        (progress: DownloadProgress) => options.onProgress?.({ phase: "download", bytesProcessed: progress.bytesWritten, totalBytes: progress.totalBytes }),
    )
    const probed = await probeMp4Stream(plaintext)
    let metadata = probed.metadata
    let input = "pipe:0"
    let inputStream: ReadableStream<Uint8Array> | undefined = probed.stream
    let stagedSource = false
    let cleanup = async () => {}

    if (probed.placement !== "front-loaded" || !metadata?.durationSeconds) {
        stagedSource = true
        const staged = await stageSource(probed.stream, source.data.size, options.onProgress)
        cleanup = staged.cleanup
        input = staged.filePath
        inputStream = undefined
        const inspected = await inspectMp4File(staged.filePath)
        metadata = inspected.metadata
        if (!metadata) {
            await cleanup()
            throw new CliError("invalid_media", "Unable to read MP4 movie metadata.", EXIT_CODES.GENERAL_ERROR)
        }
        if (!metadata.durationSeconds) metadata = { ...metadata, durationSeconds: await probeDuration(ffprobe, staged.filePath) }
    }
    if (!metadata?.durationSeconds) {
        await cleanup()
        throw new CliError("invalid_media", "The MP4 has no finite duration.", EXIT_CODES.GENERAL_ERROR)
    }

    const plan = buildPreviewableFfmpegPlan(input, metadata)
    const conversion = runFfmpeg(ffmpeg, plan, metadata.durationSeconds, inputStream)
    try {
        const upload = uploadGeneratedCurrentFormatStream(client, {
            name: outputName,
            stream: conversion.stream,
            chunkSize: options.chunkSize,
            password: options.uploadPassword,
            parentFolderId: parentFolderId(source.data),
            onProgress: (bytesProcessed) => options.onProgress?.({ phase: "convert-upload", bytesProcessed }),
        })
        const [record] = await Promise.all([upload, conversion.completion])
        return {
            sourceName: source.data.name,
            sourceUfid: source.data.ufid,
            name: record.data.name,
            ufid: record.data.ufid,
            size: record.data.size,
            msgId: record.msgId,
            date: record.date,
            chunks: record.data.chunks,
            metadataPlacement: probed.placement,
            stagedSource,
            videoMode: plan.videoMode,
            audioMode: plan.audioMode,
        }
    } catch (error) {
        await conversion.cancel()
        throw error
    } finally {
        await cleanup()
    }
}
