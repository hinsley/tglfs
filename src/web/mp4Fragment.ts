type Mp4Box = {
    type: string
    start: number
    end: number
    headerSize: number
}

export type Mp4InitializationMetadata = {
    complete: boolean
    durationSeconds: number | null
}

const PREVIEW_MIME_CANDIDATES = [
    "video/mp4",
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
]

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
    if (!Number.isSafeInteger(value)) throw new Error("The generated MP4 duration is too large to read safely.")
    return value
}

function writeUint64(bytes: Uint8Array, offset: number, value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("The generated MP4 duration is too large to write safely.")
    writeUint32(bytes, offset, Math.floor(value / 2 ** 32))
    writeUint32(bytes, offset + 4, value >>> 0)
}

function readBox(bytes: Uint8Array, offset: number, limit: number): Mp4Box {
    if (offset + 8 > limit) throw new Error("The generated MP4 contains an incomplete box header.")

    const size32 = readUint32(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    let headerSize = 8
    let size = size32
    if (size32 === 1) {
        if (offset + 16 > limit) throw new Error("The generated MP4 contains an incomplete extended box header.")
        size = readUint64(bytes, offset + 8)
        headerSize = 16
    } else if (size32 === 0) {
        size = limit - offset
    }
    if (size < headerSize || offset + size > limit) {
        throw new Error(`The generated MP4 contains an invalid ${type || "unknown"} box.`)
    }
    return { type, start: offset, end: offset + size, headerSize }
}

function tryReadCompleteBox(bytes: Uint8Array, offset: number, limit: number): Mp4Box | null {
    if (offset + 8 > limit) return null

    const size32 = readUint32(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    let headerSize = 8
    let size = size32
    if (size32 === 1) {
        if (offset + 16 > limit) return null
        size = readUint64(bytes, offset + 8)
        headerSize = 16
    } else if (size32 === 0) {
        // A zero-sized top-level box extends to the physical end of the file, which is not known while streaming.
        return null
    }
    if (size < headerSize) throw new Error(`The generated MP4 contains an invalid ${type || "unknown"} box.`)
    if (offset + size > limit) return null
    return { type, start: offset, end: offset + size, headerSize }
}

function listBoxes(bytes: Uint8Array, start = 0, end = bytes.length): Mp4Box[] {
    const boxes: Mp4Box[] = []
    for (let offset = start; offset < end;) {
        const box = readBox(bytes, offset, end)
        boxes.push(box)
        offset = box.end
    }
    return boxes
}

function findCompleteTopLevelBox(bytes: Uint8Array, type: string): Mp4Box | null {
    for (let offset = 0; offset < bytes.length;) {
        const box = tryReadCompleteBox(bytes, offset, bytes.length)
        if (!box) return null
        if (box.type === type) return box
        offset = box.end
    }
    return null
}

function movieHeader(bytes: Uint8Array): Mp4Box {
    const moov = listBoxes(bytes).find((box) => box.type === "moov")
    if (!moov) throw new Error("The generated MP4 has no moov box.")
    const mvhd = listBoxes(bytes, moov.start + moov.headerSize, moov.end).find((box) => box.type === "mvhd")
    if (!mvhd) throw new Error("The generated MP4 has no movie header.")
    return mvhd
}

function readMovieHeaderDurationSeconds(bytes: Uint8Array, mvhd: Mp4Box): number {
    const fullBoxOffset = mvhd.start + mvhd.headerSize
    const version = bytes[fullBoxOffset]
    if (version !== 0 && version !== 1) throw new Error(`Unsupported mvhd version ${version}.`)
    const timescaleOffset = version === 1 ? fullBoxOffset + 20 : fullBoxOffset + 12
    const durationOffset = version === 1 ? fullBoxOffset + 24 : fullBoxOffset + 16
    const durationSize = version === 1 ? 8 : 4
    if (durationOffset + durationSize > mvhd.end) throw new Error("The generated MP4 has a truncated movie header.")
    const timescale = readUint32(bytes, timescaleOffset)
    const duration = version === 1 ? readUint64(bytes, durationOffset) : readUint32(bytes, durationOffset)
    if (timescale <= 0) throw new Error("The generated MP4 has an invalid movie timescale.")
    return duration / timescale
}

function readMovieExtendsDurationSeconds(bytes: Uint8Array, moov: Mp4Box, timescale: number): number | null {
    const mvex = listBoxes(bytes, moov.start + moov.headerSize, moov.end).find((box) => box.type === "mvex")
    if (!mvex) return null
    const mehd = listBoxes(bytes, mvex.start + mvex.headerSize, mvex.end).find((box) => box.type === "mehd")
    if (!mehd) return null
    const fullBoxOffset = mehd.start + mehd.headerSize
    const version = bytes[fullBoxOffset]
    if (version !== 0 && version !== 1) throw new Error(`Unsupported mehd version ${version}.`)
    const durationOffset = fullBoxOffset + 4
    const durationSize = version === 1 ? 8 : 4
    if (durationOffset + durationSize > mehd.end) throw new Error("The generated MP4 has a truncated movie-extends header.")
    const duration = version === 1 ? readUint64(bytes, durationOffset) : readUint32(bytes, durationOffset)
    return duration > 0 ? duration / timescale : null
}

export function parseFfmpegDurationSeconds(message: string): number | null {
    const match = message.match(/Duration:\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/i)
    if (!match) return null
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

export function writeMp4MovieDuration(bytes: Uint8Array, durationSeconds: number): Uint8Array {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("The generated MP4 has no finite positive duration.")
    }

    const output = bytes.slice()
    const mvhd = movieHeader(output)
    const fullBoxOffset = mvhd.start + mvhd.headerSize
    const version = output[fullBoxOffset]
    const timescaleOffset = version === 1 ? fullBoxOffset + 20 : fullBoxOffset + 12
    const durationOffset = version === 1 ? fullBoxOffset + 24 : fullBoxOffset + 16
    const durationSize = version === 1 ? 8 : 4
    if (version !== 0 && version !== 1) throw new Error(`Unsupported mvhd version ${version}.`)
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

export function readMp4MovieDurationSeconds(bytes: Uint8Array): number {
    return readMovieHeaderDurationSeconds(bytes, movieHeader(bytes))
}

export function inspectMp4InitializationSegment(bytes: Uint8Array): Mp4InitializationMetadata {
    const moov = findCompleteTopLevelBox(bytes, "moov")
    if (!moov) return { complete: false, durationSeconds: null }

    const mvhd = listBoxes(bytes, moov.start + moov.headerSize, moov.end).find((box) => box.type === "mvhd")
    if (!mvhd) throw new Error("The generated MP4 has no movie header.")
    const movieDuration = readMovieHeaderDurationSeconds(bytes, mvhd)
    if (Number.isFinite(movieDuration) && movieDuration > 0) {
        return { complete: true, durationSeconds: movieDuration }
    }

    const fullBoxOffset = mvhd.start + mvhd.headerSize
    const version = bytes[fullBoxOffset]
    const timescaleOffset = version === 1 ? fullBoxOffset + 20 : fullBoxOffset + 12
    const timescale = readUint32(bytes, timescaleOffset)
    const fragmentDuration = timescale > 0 ? readMovieExtendsDurationSeconds(bytes, moov, timescale) : null
    return {
        complete: true,
        durationSeconds: fragmentDuration && Number.isFinite(fragmentDuration) ? fragmentDuration : null,
    }
}

export function validateFragmentedMp4(bytes: Uint8Array): number {
    const boxes = listBoxes(bytes)
    const ftyp = boxes.find((box) => box.type === "ftyp")
    const moov = boxes.find((box) => box.type === "moov")
    const firstMdat = boxes.find((box) => box.type === "mdat")
    const firstMoofIndex = boxes.findIndex((box) => box.type === "moof")
    if (!ftyp || !moov || ftyp.start > moov.start) throw new Error("The generated MP4 is missing ordered initialization metadata.")
    if (firstMdat && firstMdat.start < moov.start) throw new Error("The generated MP4 places media data before initialization metadata.")
    if (!listBoxes(bytes, moov.start + moov.headerSize, moov.end).some((box) => box.type === "mvex")) {
        throw new Error("The generated MP4 is not fragmented: its movie metadata has no mvex box.")
    }
    if (firstMoofIndex < 0 || boxes[firstMoofIndex].start < moov.end) throw new Error("The generated MP4 has no valid media fragments.")
    const firstFragmentMdat = boxes.slice(firstMoofIndex + 1).find((box) => box.type === "mdat")
    if (!firstFragmentMdat) throw new Error("The generated MP4 has no media data for its first fragment.")
    return firstFragmentMdat.end
}

function supportedMimeType(): string | null {
    if (typeof MediaSource === "undefined") return null
    return PREVIEW_MIME_CANDIDATES.find((candidate) => MediaSource.isTypeSupported(candidate)) ?? null
}

export function supportsStreamingMp4Preview(): boolean {
    return supportedMimeType() !== null
}

export async function canUseCurrentPreview(bytes: Uint8Array, firstFragmentEnd: number): Promise<boolean> {
    if (typeof document === "undefined" || typeof MediaSource === "undefined") return false
    const mimeType = supportedMimeType()
    if (!mimeType) return false
    const metadata = inspectMp4InitializationSegment(bytes.subarray(0, firstFragmentEnd))
    if (!metadata.complete || !metadata.durationSeconds) return false

    const mediaSource = new MediaSource()
    const video = document.createElement("video")
    video.muted = true
    video.preload = "metadata"
    const objectUrl = URL.createObjectURL(mediaSource)

    return new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (result: boolean) => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            video.pause()
            video.removeAttribute("src")
            video.load()
            URL.revokeObjectURL(objectUrl)
            resolve(result)
        }
        const timeout = window.setTimeout(() => finish(false), 8_000)
        video.addEventListener("loadedmetadata", () => finish(Number.isFinite(video.duration) && video.duration > 0), { once: true })
        video.addEventListener("error", () => finish(false), { once: true })
        mediaSource.addEventListener("sourceopen", () => {
            try {
                const buffer = mediaSource.addSourceBuffer(mimeType)
                buffer.mode = "segments"
                mediaSource.duration = metadata.durationSeconds!
                buffer.addEventListener("error", () => finish(false), { once: true })
                buffer.addEventListener("updateend", () => {
                    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
                        finish(Number.isFinite(video.duration) && video.duration > 0)
                    } else if (mediaSource.readyState === "open") {
                        try { mediaSource.endOfStream() } catch {}
                    }
                }, { once: true })
                buffer.appendBuffer(bytes.slice(0, firstFragmentEnd).buffer)
            } catch {
                finish(false)
            }
        }, { once: true })
        video.src = objectUrl
        video.load()
    })
}
