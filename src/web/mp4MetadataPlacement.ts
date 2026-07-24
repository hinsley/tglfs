export type Mp4MetadataPlacement = "front-loaded" | "trailing" | "unknown"

export type Mp4MetadataProbeResult = {
    placement: Mp4MetadataPlacement
    stream: ReadableStream<Uint8Array>
    bytesInspected: number
}

export const MP4_METADATA_PROBE_LIMIT = 16 * 1024 * 1024

type Mp4BoxHeader = {
    type: string
    size: number
    headerSize: number
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]
}

function readUint64(bytes: Uint8Array, offset: number): number {
    const value = readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4)
    if (!Number.isSafeInteger(value)) {
        throw new Error("The MP4 contains a box that is too large to inspect safely.")
    }
    return value
}

function readBoxHeader(bytes: Uint8Array, offset: number): Mp4BoxHeader | null {
    if (offset + 8 > bytes.length) return null

    const size32 = readUint32(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    let size = size32
    let headerSize = 8

    if (size32 === 1) {
        if (offset + 16 > bytes.length) return null
        size = readUint64(bytes, offset + 8)
        headerSize = 16
    } else if (size32 === 0) {
        // Zero-sized top-level boxes extend to EOF. The type is still enough to identify mdat/moov.
        size = Number.POSITIVE_INFINITY
    }

    if (size !== Number.POSITIVE_INFINITY && size < headerSize) {
        throw new Error(`The MP4 contains an invalid ${type || "unknown"} box.`)
    }

    return { type, size, headerSize }
}

/**
 * Inspects complete top-level box headers that are already available. A result of
 * "front-loaded" means a moov header precedes the first mdat header; "trailing"
 * means media data begins before moov; and "unknown" means more bytes are needed.
 */
export function inspectMp4MetadataPlacement(bytes: Uint8Array): Mp4MetadataPlacement {
    let offset = 0

    while (offset < bytes.length) {
        const box = readBoxHeader(bytes, offset)
        if (!box) return "unknown"
        if (box.type === "mdat") return "trailing"
        if (!Number.isFinite(box.size)) return "unknown"
        if (offset + box.size > bytes.length) return "unknown"
        if (box.type === "moov") return "front-loaded"
        offset += box.size
    }

    return "unknown"
}

function replayStream(
    prefixChunks: Uint8Array[],
    reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
    let prefixIndex = 0
    let finished = false

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (prefixIndex < prefixChunks.length) {
                controller.enqueue(prefixChunks[prefixIndex++])
                return
            }
            if (finished) {
                controller.close()
                return
            }

            try {
                const { value, done } = await reader.read()
                if (done) {
                    finished = true
                    reader.releaseLock()
                    controller.close()
                    return
                }
                if (value?.byteLength) controller.enqueue(value)
            } catch (error) {
                finished = true
                try { reader.releaseLock() } catch {}
                controller.error(error)
            }
        },
        async cancel(reason) {
            finished = true
            try { await reader.cancel(reason) } finally {
                try { reader.releaseLock() } catch {}
            }
        },
    })
}

/**
 * Reads only enough of an append-only MP4 stream to determine whether moov is
 * before or after mdat, then returns a stream that replays every inspected byte.
 * Unknown layouts conservatively use the staged conversion path.
 */
export async function probeMp4MetadataPlacement(
    source: ReadableStream<Uint8Array>,
    maxProbeBytes = MP4_METADATA_PROBE_LIMIT,
): Promise<Mp4MetadataProbeResult> {
    if (!Number.isSafeInteger(maxProbeBytes) || maxProbeBytes <= 0) {
        throw new TypeError("maxProbeBytes must be a positive safe integer.")
    }

    const reader = source.getReader()
    const prefixChunks: Uint8Array[] = []
    let inspectionBuffer = new Uint8Array(Math.min(maxProbeBytes, 64 * 1024))
    let inspectionLength = 0
    let placement: Mp4MetadataPlacement = "unknown"

    const appendInspectionBytes = (chunk: Uint8Array) => {
        const count = Math.min(chunk.byteLength, maxProbeBytes - inspectionLength)
        if (count <= 0) return
        const required = inspectionLength + count
        if (required > inspectionBuffer.byteLength) {
            let capacity = inspectionBuffer.byteLength
            while (capacity < required) capacity = Math.min(maxProbeBytes, Math.max(capacity * 2, required))
            const grown = new Uint8Array(capacity)
            grown.set(inspectionBuffer.subarray(0, inspectionLength))
            inspectionBuffer = grown
        }
        inspectionBuffer.set(chunk.subarray(0, count), inspectionLength)
        inspectionLength += count
    }

    try {
        while (placement === "unknown" && inspectionLength < maxProbeBytes) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue

            const stored = value.slice()
            prefixChunks.push(stored)
            appendInspectionBytes(stored)

            try {
                placement = inspectMp4MetadataPlacement(inspectionBuffer.subarray(0, inspectionLength))
            } catch {
                // Let FFmpeg inspect malformed/unusual layouts on the staged fallback path.
                placement = "unknown"
                break
            }
        }
    } catch (error) {
        try { await reader.cancel(error) } catch {}
        try { reader.releaseLock() } catch {}
        throw error
    }

    return {
        placement,
        stream: replayStream(prefixChunks, reader),
        bytesInspected: inspectionLength,
    }
}
