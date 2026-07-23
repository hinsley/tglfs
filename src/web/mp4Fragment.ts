type Mp4Box = {
    type: string
    start: number
    end: number
    headerSize: number
}

const PREVIEW_MIME_CANDIDATES = [
    "video/mp4",
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
]

function readUint32(bytes: Uint8Array, offset: number): number {
    return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]
}

function readBox(bytes: Uint8Array, offset: number, limit: number): Mp4Box {
    if (offset + 8 > limit) throw new Error("The generated MP4 contains an incomplete box header.")

    const size32 = readUint32(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    let headerSize = 8
    let size = size32
    if (size32 === 1) {
        if (offset + 16 > limit) throw new Error("The generated MP4 contains an incomplete extended box header.")
        size = readUint32(bytes, offset + 8) * 2 ** 32 + readUint32(bytes, offset + 12)
        headerSize = 16
        if (!Number.isSafeInteger(size)) throw new Error("The generated MP4 contains a box too large to validate safely.")
    } else if (size32 === 0) {
        size = limit - offset
    }
    if (size < headerSize || offset + size > limit) {
        throw new Error(`The generated MP4 contains an invalid ${type || "unknown"} box.`)
    }
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
        video.addEventListener("loadedmetadata", () => finish(true), { once: true })
        video.addEventListener("error", () => finish(false), { once: true })
        mediaSource.addEventListener("sourceopen", () => {
            try {
                const buffer = mediaSource.addSourceBuffer(mimeType)
                buffer.mode = "sequence"
                buffer.addEventListener("error", () => finish(false), { once: true })
                buffer.addEventListener("updateend", () => {
                    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) finish(true)
                    else if (mediaSource.readyState === "open") {
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
