import { inspectMp4InitializationSegment } from "./mp4Fragment"

const MEDIABUNNY_MODULE_URL = "https://cdn.jsdelivr.net/npm/mediabunny@1.50.9/+esm"
const MEDIABUNNY_INPUT_CACHE_BYTES = 32 * 1024 * 1024
const OUTPUT_INITIALIZATION_LIMIT = 16 * 1024 * 1024

export type StreamingMp4Conversion = {
    stream: ReadableStream<Uint8Array>
    completion: Promise<void>
    cancel: () => Promise<void>
    durationSeconds: number
}

type InputTrackLike = {
    type: "video" | "audio" | "subtitle"
    getCodec(): Promise<string | null>
    canDecode(): Promise<boolean>
}

type VideoTrackLike = InputTrackLike & {
    getDisplayWidth(): Promise<number>
}

type DiscardedTrackLike = {
    track: InputTrackLike
    reason: string
}

type ConversionLike = {
    isValid: boolean
    discardedTracks: DiscardedTrackLike[]
    execute(): Promise<void>
    cancel(): Promise<void>
}

type InputLike = {
    getDurationFromMetadata(query?: unknown, options?: { skipLiveWait?: boolean }): Promise<number | null>
    getPrimaryVideoTrack(): Promise<VideoTrackLike | null>
    getPrimaryAudioTrack(): Promise<InputTrackLike | null>
    dispose(): void
}

type MediabunnyModule = {
    MP4: unknown
    ReadableStreamSource: new (stream: ReadableStream<Uint8Array>, options?: { maxCacheSize?: number }) => unknown
    Input: new (options: { source: unknown; formats: unknown[] }) => InputLike
    Mp4OutputFormat: new (options: { fastStart: "fragmented"; minimumFragmentDuration: number }) => unknown
    AppendOnlyStreamTarget: new (stream: WritableStream<Uint8Array>) => unknown
    Output: new (options: { format: unknown; target: unknown }) => unknown
    Conversion: {
        init(options: {
            input: InputLike
            output: unknown
            tracks: "primary"
            video: (track: VideoTrackLike) => Promise<Record<string, unknown>>
            audio: (track: InputTrackLike) => Promise<Record<string, unknown>>
            tags: Record<string, never>
        }): Promise<ConversionLike>
    }
}

type Mp4Box = {
    type: string
    start: number
    end: number
    headerSize: number
}

let mediabunnyPromise: Promise<MediabunnyModule> | null = null

async function loadMediabunny(): Promise<MediabunnyModule> {
    if (!mediabunnyPromise) {
        mediabunnyPromise = import(/* @vite-ignore */ MEDIABUNNY_MODULE_URL) as Promise<MediabunnyModule>
        mediabunnyPromise = mediabunnyPromise.catch((error) => {
            mediabunnyPromise = null
            throw error
        })
    }
    return mediabunnyPromise
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
    bytes[offset] = Math.floor(value / 0x1000000) & 0xff
    bytes[offset + 1] = Math.floor(value / 0x10000) & 0xff
    bytes[offset + 2] = Math.floor(value / 0x100) & 0xff
    bytes[offset + 3] = value & 0xff
}

function readUint64(bytes: Uint8Array, offset: number): number {
    const value = readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4)
    if (!Number.isSafeInteger(value)) throw new Error("The generated MP4 contains an unsupported 64-bit box size.")
    return value
}

function writeUint64(bytes: Uint8Array, offset: number, value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("The generated MP4 duration is too large.")
    writeUint32(bytes, offset, Math.floor(value / 2 ** 32))
    writeUint32(bytes, offset + 4, value >>> 0)
}

function readCompleteBox(bytes: Uint8Array, offset: number, limit: number): Mp4Box | null {
    if (offset + 8 > limit) return null
    const size32 = readUint32(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    let size = size32
    let headerSize = 8
    if (size32 === 1) {
        if (offset + 16 > limit) return null
        size = readUint64(bytes, offset + 8)
        headerSize = 16
    } else if (size32 === 0) {
        return null
    }
    if (size < headerSize) throw new Error(`The generated MP4 contains an invalid ${type || "unknown"} box.`)
    if (offset + size > limit) return null
    return { type, start: offset, end: offset + size, headerSize }
}

function findCompleteBox(bytes: Uint8Array, type: string, start = 0, end = bytes.length): Mp4Box | null {
    for (let offset = start; offset < end;) {
        const box = readCompleteBox(bytes, offset, end)
        if (!box) return null
        if (box.type === type) return box
        offset = box.end
    }
    return null
}

/** Patches mvhd without requiring a following moof/mdat box to be complete. */
export function patchStreamingMp4Duration(bytes: Uint8Array, durationSeconds: number): Uint8Array {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("The generated MP4 has no finite positive duration.")
    }
    const output = bytes.slice()
    const moov = findCompleteBox(output, "moov")
    if (!moov) throw new Error("The generated MP4 has no complete moov box.")
    const mvhd = findCompleteBox(output, "mvhd", moov.start + moov.headerSize, moov.end)
    if (!mvhd) throw new Error("The generated MP4 has no movie header.")

    const fullBoxOffset = mvhd.start + mvhd.headerSize
    const version = output[fullBoxOffset]
    if (version !== 0 && version !== 1) throw new Error(`Unsupported mvhd version ${version}.`)
    const timescaleOffset = version === 1 ? fullBoxOffset + 20 : fullBoxOffset + 12
    const durationOffset = version === 1 ? fullBoxOffset + 24 : fullBoxOffset + 16
    const durationSize = version === 1 ? 8 : 4
    if (durationOffset + durationSize > mvhd.end) throw new Error("The generated MP4 has a truncated movie header.")

    const timescale = readUint32(output, timescaleOffset)
    if (timescale <= 0) throw new Error("The generated MP4 has an invalid movie timescale.")
    const duration = Math.max(1, Math.round(durationSeconds * timescale))
    if (version === 0) {
        if (duration > 0xffffffff) throw new Error("The MP4 duration does not fit its version-0 movie header.")
        writeUint32(output, durationOffset, duration)
    } else {
        writeUint64(output, durationOffset, duration)
    }
    return output
}

function concatenate(chunks: Uint8Array[], totalBytes: number): Uint8Array {
    const result = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result
}

function createDurationPatchingTransform(durationSeconds: number) {
    const chunks: Uint8Array[] = []
    let bufferedBytes = 0
    let initializationWritten = false

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            if (initializationWritten) {
                controller.enqueue(chunk)
                return
            }

            const stored = chunk.slice()
            chunks.push(stored)
            bufferedBytes += stored.byteLength
            if (bufferedBytes > OUTPUT_INITIALIZATION_LIMIT) {
                throw new Error("The generated MP4 initialization segment is unexpectedly large.")
            }

            const combined = concatenate(chunks, bufferedBytes)
            const metadata = inspectMp4InitializationSegment(combined)
            if (!metadata.complete) return

            controller.enqueue(patchStreamingMp4Duration(combined, durationSeconds))
            initializationWritten = true
            chunks.length = 0
            bufferedBytes = 0
        },
        flush() {
            if (!initializationWritten) {
                throw new Error("The generated MP4 ended before its initialization metadata was complete.")
            }
        },
    })
}

function discardedTrackDetails(discardedTracks: DiscardedTrackLike[]) {
    if (!discardedTracks.length) return ""
    return ` ${discardedTracks.map(({ track, reason }) => `${track.type}: ${reason}`).join("; ")}.`
}

/**
 * Converts a front-loaded MP4 using only bounded stream/cache memory. No source
 * or generated output File is materialized. Compatible AVC/AAC tracks are copied;
 * incompatible primary tracks are transcoded with WebCodecs when supported.
 */
export async function createStreamingPreviewableMp4(
    sourceStream: ReadableStream<Uint8Array>,
): Promise<StreamingMp4Conversion> {
    const mediabunny = await loadMediabunny()
    const source = new mediabunny.ReadableStreamSource(sourceStream, {
        maxCacheSize: MEDIABUNNY_INPUT_CACHE_BYTES,
    })
    const input = new mediabunny.Input({ source, formats: [mediabunny.MP4] })

    let conversion: ConversionLike | null = null
    try {
        const durationSeconds = await input.getDurationFromMetadata(undefined, { skipLiveWait: true })
        const primaryVideo = await input.getPrimaryVideoTrack()
        const primaryAudio = await input.getPrimaryAudioTrack()
        if (!Number.isFinite(durationSeconds) || !(durationSeconds! > 0)) {
            throw new Error("The front-loaded MP4 does not expose a finite duration in its metadata.")
        }
        if (!primaryVideo) throw new Error("The selected MP4 has no primary video track.")

        const patchedOutput = createDurationPatchingTransform(durationSeconds!)
        const output = new mediabunny.Output({
            format: new mediabunny.Mp4OutputFormat({
                fastStart: "fragmented",
                minimumFragmentDuration: 2,
            }),
            target: new mediabunny.AppendOnlyStreamTarget(patchedOutput.writable),
        })

        conversion = await mediabunny.Conversion.init({
            input,
            output,
            tracks: "primary",
            video: async (track) => {
                const codec = await track.getCodec()
                if (codec === "avc" && await track.canDecode()) return {}
                const displayWidth = await track.getDisplayWidth()
                return {
                    codec: "avc",
                    width: displayWidth > 1280 ? 1280 : undefined,
                    keyFrameInterval: 2,
                    hardwareAcceleration: "prefer-hardware",
                }
            },
            audio: async (track) => {
                const codec = await track.getCodec()
                if (codec === "aac" && await track.canDecode()) return {}
                return {
                    codec: "aac",
                    bitrate: 128_000,
                    numberOfChannels: 2,
                    sampleRate: 48_000,
                }
            },
            tags: {},
        })

        const discardedPrimary = conversion.discardedTracks.find(({ track }) =>
            track === primaryVideo || (!!primaryAudio && track === primaryAudio),
        )
        if (!conversion.isValid || discardedPrimary) {
            throw new Error(
                `This browser cannot stream-convert the MP4's primary tracks.${discardedTrackDetails(conversion.discardedTracks)}`,
            )
        }

        let disposed = false
        const dispose = () => {
            if (disposed) return
            disposed = true
            input.dispose()
        }
        const completion = conversion.execute().finally(dispose)

        return {
            stream: patchedOutput.readable,
            completion,
            durationSeconds: durationSeconds!,
            cancel: async () => {
                try { await conversion?.cancel() } finally { dispose() }
            },
        }
    } catch (error) {
        try { await conversion?.cancel() } catch {}
        input.dispose()
        throw error
    }
}
