import { open } from "node:fs/promises"

export type Mp4MetadataPlacement = "front-loaded" | "trailing" | "unknown"
export type Mp4Metadata = {
    durationSeconds: number | null
    hasVideo: boolean
    hasAudio: boolean
    videoCodec: string | null
    videoAvcProfile: number | null
    audioCodec: string | null
}
export type Mp4StreamProbeResult = {
    placement: Mp4MetadataPlacement
    metadata: Mp4Metadata | null
    stream: ReadableStream<Uint8Array>
    bytesInspected: number
}

export const MP4_METADATA_PROBE_LIMIT = 32 * 1024 * 1024
const MP4_MOOV_READ_LIMIT = 64 * 1024 * 1024
const MP4_OUTPUT_INITIALIZATION_LIMIT = 16 * 1024 * 1024

type Mp4Box = {
    type: string
    start: number
    end: number
    size: number
    headerSize: number
}

function readUint32(bytes: Uint8Array, offset: number) {
    return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]
}
function readUint64(bytes: Uint8Array, offset: number) {
    const value = readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4)
    if (!Number.isSafeInteger(value)) throw new Error("The MP4 contains a box too large to inspect safely.")
    return value
}
function writeUint32(bytes: Uint8Array, offset: number, value: number) {
    bytes[offset] = Math.floor(value / 0x1000000) & 0xff
    bytes[offset + 1] = Math.floor(value / 0x10000) & 0xff
    bytes[offset + 2] = Math.floor(value / 0x100) & 0xff
    bytes[offset + 3] = value & 0xff
}
function writeUint64(bytes: Uint8Array, offset: number, value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("The MP4 duration is too large to write safely.")
    writeUint32(bytes, offset, Math.floor(value / 2 ** 32))
    writeUint32(bytes, offset + 4, value >>> 0)
}
function readType(bytes: Uint8Array, offset: number) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function readCompleteBox(bytes: Uint8Array, offset: number, limit = bytes.length): Mp4Box | null {
    if (offset + 8 > limit) return null
    const size32 = readUint32(bytes, offset)
    const type = readType(bytes, offset + 4)
    let size = size32
    let headerSize = 8
    if (size32 === 1) {
        if (offset + 16 > limit) return null
        size = readUint64(bytes, offset + 8)
        headerSize = 16
    } else if (size32 === 0) {
        size = limit - offset
    }
    if (size < headerSize) throw new Error(`The MP4 contains an invalid ${type || "unknown"} box.`)
    if (offset + size > limit) return null
    return { type, start: offset, end: offset + size, size, headerSize }
}

function readTopLevelHeader(bytes: Uint8Array, offset: number): Mp4Box | null {
    if (offset + 8 > bytes.length) return null
    const size32 = readUint32(bytes, offset)
    const type = readType(bytes, offset + 4)
    let size = size32
    let headerSize = 8
    if (size32 === 1) {
        if (offset + 16 > bytes.length) return null
        size = readUint64(bytes, offset + 8)
        headerSize = 16
    } else if (size32 === 0) {
        size = Number.POSITIVE_INFINITY
    }
    if (Number.isFinite(size) && size < headerSize) throw new Error(`The MP4 contains an invalid ${type || "unknown"} box.`)
    return { type, start: offset, end: Number.isFinite(size) ? offset + size : Number.POSITIVE_INFINITY, size, headerSize }
}

function listBoxes(bytes: Uint8Array, start: number, end: number) {
    const boxes: Mp4Box[] = []
    for (let offset = start; offset < end;) {
        const box = readCompleteBox(bytes, offset, end)
        if (!box) throw new Error("The MP4 contains an incomplete nested box.")
        boxes.push(box)
        offset = box.end
    }
    return boxes
}
function childBox(bytes: Uint8Array, parent: Mp4Box, type: string) {
    return listBoxes(bytes, parent.start + parent.headerSize, parent.end).find((box) => box.type === type) ?? null
}
function descend(bytes: Uint8Array, parent: Mp4Box, path: string[]) {
    let current: Mp4Box | null = parent
    for (const type of path) {
        if (!current) return null
        current = childBox(bytes, current, type)
    }
    return current
}

function readMovieDuration(bytes: Uint8Array, moov: Mp4Box): number | null {
    const mvhd = childBox(bytes, moov, "mvhd")
    if (!mvhd) return null
    const fullBox = mvhd.start + mvhd.headerSize
    const version = bytes[fullBox]
    if (version !== 0 && version !== 1) return null
    const timescaleOffset = version === 1 ? fullBox + 20 : fullBox + 12
    const durationOffset = version === 1 ? fullBox + 24 : fullBox + 16
    const durationSize = version === 1 ? 8 : 4
    if (durationOffset + durationSize > mvhd.end) return null
    const timescale = readUint32(bytes, timescaleOffset)
    const duration = version === 1 ? readUint64(bytes, durationOffset) : readUint32(bytes, durationOffset)
    if (!(timescale > 0) || !(duration > 0)) return null
    const seconds = duration / timescale
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}
function readHandlerType(bytes: Uint8Array, trak: Mp4Box) {
    const hdlr = descend(bytes, trak, ["mdia", "hdlr"])
    if (!hdlr) return null
    const offset = hdlr.start + hdlr.headerSize + 8
    return offset + 4 <= hdlr.end ? readType(bytes, offset) : null
}
function readSampleEntry(bytes: Uint8Array, trak: Mp4Box) {
    const stsd = descend(bytes, trak, ["mdia", "minf", "stbl", "stsd"])
    if (!stsd) return null
    const payload = stsd.start + stsd.headerSize
    if (payload + 16 > stsd.end || readUint32(bytes, payload + 4) < 1) return null
    return readCompleteBox(bytes, payload + 8, stsd.end)
}

function readAvcProfile(bytes: Uint8Array, entry: Mp4Box | null): number | null {
    if (!entry || (entry.type !== "avc1" && entry.type !== "avc3")) return null
    // ISO visual sample entries have 78 bytes of fields after the box header.
    const childrenStart = entry.start + entry.headerSize + 78
    if (childrenStart >= entry.end) return null
    try {
        const avcC = listBoxes(bytes, childrenStart, entry.end).find((box) => box.type === "avcC")
        if (!avcC || avcC.start + avcC.headerSize + 2 > avcC.end) return null
        return bytes[avcC.start + avcC.headerSize + 1]
    } catch {
        return null
    }
}

export function parseMp4MoovMetadata(bytes: Uint8Array, moov: Mp4Box): Mp4Metadata {
    let hasVideo = false
    let hasAudio = false
    let videoCodec: string | null = null
    let videoAvcProfile: number | null = null
    let audioCodec: string | null = null
    for (const trak of listBoxes(bytes, moov.start + moov.headerSize, moov.end).filter((box) => box.type === "trak")) {
        const handler = readHandlerType(bytes, trak)
        if (handler === "vide" && !hasVideo) {
            hasVideo = true
            const entry = readSampleEntry(bytes, trak)
            videoCodec = entry?.type ?? null
            videoAvcProfile = readAvcProfile(bytes, entry)
        } else if (handler === "soun" && !hasAudio) {
            hasAudio = true
            audioCodec = readSampleEntry(bytes, trak)?.type ?? null
        }
    }
    return { durationSeconds: readMovieDuration(bytes, moov), hasVideo, hasAudio, videoCodec, videoAvcProfile, audioCodec }
}

export function inspectMp4Prefix(bytes: Uint8Array): { placement: Mp4MetadataPlacement; metadata: Mp4Metadata | null } {
    for (let offset = 0; offset < bytes.length;) {
        const box = readTopLevelHeader(bytes, offset)
        if (!box) return { placement: "unknown", metadata: null }
        if (box.type === "mdat") return { placement: "trailing", metadata: null }
        if (!Number.isFinite(box.size) || box.end > bytes.length) return { placement: "unknown", metadata: null }
        if (box.type === "moov") return { placement: "front-loaded", metadata: parseMp4MoovMetadata(bytes, box) }
        offset = box.end
    }
    return { placement: "unknown", metadata: null }
}

function replayStream(prefix: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>) {
    let index = 0
    let finished = false
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (index < prefix.length) {
                controller.enqueue(prefix[index++])
                return
            }
            if (finished) return controller.close()
            try {
                const { value, done } = await reader.read()
                if (done) {
                    finished = true
                    reader.releaseLock()
                    controller.close()
                } else if (value?.byteLength) {
                    controller.enqueue(value)
                }
            } catch (error) {
                finished = true
                try { reader.releaseLock() } catch {}
                controller.error(error)
            }
        },
        async cancel(reason) {
            finished = true
            try { await reader.cancel(reason) } finally { try { reader.releaseLock() } catch {} }
        },
    })
}

export async function probeMp4Stream(source: ReadableStream<Uint8Array>, maxProbeBytes = MP4_METADATA_PROBE_LIMIT): Promise<Mp4StreamProbeResult> {
    if (!Number.isSafeInteger(maxProbeBytes) || maxProbeBytes <= 0) throw new TypeError("maxProbeBytes must be positive.")
    const reader = source.getReader()
    const prefix: Uint8Array[] = []
    let buffer = new Uint8Array(Math.min(maxProbeBytes, 64 * 1024))
    let length = 0
    let inspection: ReturnType<typeof inspectMp4Prefix> = { placement: "unknown", metadata: null }
    const append = (chunk: Uint8Array) => {
        const count = Math.min(chunk.byteLength, maxProbeBytes - length)
        if (count <= 0) return
        const needed = length + count
        if (needed > buffer.byteLength) {
            let capacity = buffer.byteLength
            while (capacity < needed) capacity = Math.min(maxProbeBytes, Math.max(capacity * 2, needed))
            const grown = new Uint8Array(capacity)
            grown.set(buffer.subarray(0, length))
            buffer = grown
        }
        buffer.set(chunk.subarray(0, count), length)
        length += count
    }
    try {
        while (inspection.placement === "unknown" && length < maxProbeBytes) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue
            const stored = value.slice()
            prefix.push(stored)
            append(stored)
            inspection = inspectMp4Prefix(buffer.subarray(0, length))
        }
    } catch (error) {
        try { await reader.cancel(error) } catch {}
        try { reader.releaseLock() } catch {}
        throw error
    }
    return { ...inspection, stream: replayStream(prefix, reader), bytesInspected: length }
}

async function readFileHeader(handle: Awaited<ReturnType<typeof open>>, offset: number, fileSize: number): Promise<Mp4Box | null> {
    if (offset + 8 > fileSize) return null
    const header = new Uint8Array(Math.min(16, fileSize - offset))
    const { bytesRead } = await handle.read(header, 0, header.length, offset)
    if (bytesRead < 8) return null
    const size32 = readUint32(header, 0)
    const type = readType(header, 4)
    let size = size32
    let headerSize = 8
    if (size32 === 1) {
        if (bytesRead < 16) return null
        size = readUint64(header, 8)
        headerSize = 16
    } else if (size32 === 0) {
        size = fileSize - offset
    }
    if (size < headerSize || offset + size > fileSize) throw new Error(`The MP4 contains an invalid ${type || "unknown"} box.`)
    return { type, start: offset, end: offset + size, size, headerSize }
}

export async function inspectMp4File(filePath: string): Promise<{ placement: Mp4MetadataPlacement; metadata: Mp4Metadata | null }> {
    const handle = await open(filePath, "r")
    try {
        const fileSize = (await handle.stat()).size
        let sawMdat = false
        for (let offset = 0; offset < fileSize;) {
            const box = await readFileHeader(handle, offset, fileSize)
            if (!box) break
            if (box.type === "mdat") sawMdat = true
            if (box.type === "moov") {
                if (box.size > MP4_MOOV_READ_LIMIT) throw new Error("The MP4 moov box is too large to inspect safely.")
                const bytes = new Uint8Array(box.size)
                let bytesRead = 0
                while (bytesRead < bytes.length) {
                    const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, box.start + bytesRead)
                    if (result.bytesRead <= 0) throw new Error("The MP4 moov box could not be read completely.")
                    bytesRead += result.bytesRead
                }
                const local = readCompleteBox(bytes, 0)
                if (!local) throw new Error("The MP4 moov box is incomplete.")
                return { placement: sawMdat ? "trailing" : "front-loaded", metadata: parseMp4MoovMetadata(bytes, local) }
            }
            offset = box.end
        }
        return { placement: sawMdat ? "trailing" : "unknown", metadata: null }
    } finally {
        await handle.close()
    }
}

function concatenate(chunks: Uint8Array[], total: number) {
    const output = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
    return output
}
function findCompleteTopLevelBox(bytes: Uint8Array, type: string) {
    for (let offset = 0; offset < bytes.length;) {
        const box = readCompleteBox(bytes, offset)
        if (!box) return null
        if (box.type === type) return box
        offset = box.end
    }
    return null
}
export function patchMp4MovieDuration(bytes: Uint8Array, durationSeconds: number) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("The generated MP4 has no finite duration.")
    const output = bytes.slice()
    const moov = findCompleteTopLevelBox(output, "moov")
    if (!moov) throw new Error("The generated MP4 has no complete moov box.")
    const mvhd = childBox(output, moov, "mvhd")
    if (!mvhd) throw new Error("The generated MP4 has no movie header.")
    const fullBox = mvhd.start + mvhd.headerSize
    const version = output[fullBox]
    if (version !== 0 && version !== 1) throw new Error(`Unsupported mvhd version ${version}.`)
    const timescaleOffset = version === 1 ? fullBox + 20 : fullBox + 12
    const durationOffset = version === 1 ? fullBox + 24 : fullBox + 16
    const durationSize = version === 1 ? 8 : 4
    if (durationOffset + durationSize > mvhd.end) throw new Error("The generated MP4 has a truncated movie header.")
    const timescale = readUint32(output, timescaleOffset)
    if (!(timescale > 0)) throw new Error("The generated MP4 has an invalid timescale.")
    const duration = Math.max(1, Math.round(durationSeconds * timescale))
    if (version === 0) {
        if (duration > 0xffffffff) throw new Error("The duration does not fit the MP4 movie header.")
        writeUint32(output, durationOffset, duration)
    } else writeUint64(output, durationOffset, duration)
    return output
}
export function createMp4DurationPatchTransform(durationSeconds: number) {
    const chunks: Uint8Array[] = []
    let bytes = 0
    let written = false
    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            if (written) return controller.enqueue(chunk)
            const stored = chunk.slice()
            chunks.push(stored)
            bytes += stored.byteLength
            if (bytes > MP4_OUTPUT_INITIALIZATION_LIMIT) throw new Error("The generated MP4 initialization segment is unexpectedly large.")
            const combined = concatenate(chunks, bytes)
            if (!findCompleteTopLevelBox(combined, "moov")) return
            controller.enqueue(patchMp4MovieDuration(combined, durationSeconds))
            written = true
            chunks.length = 0
            bytes = 0
        },
        flush() { if (!written) throw new Error("The generated MP4 ended before its initialization metadata was complete.") },
    })
}
