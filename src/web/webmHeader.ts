const VIDEO_CODECS: Record<string, string> = { V_VP8: "vp8", V_VP9: "vp9", V_AV1: "av01" }
const AUDIO_CODECS: Record<string, string> = { A_OPUS: "opus", A_VORBIS: "vorbis" }

function vint(bytes: Uint8Array, offset: number, id: boolean) {
    if (offset >= bytes.length) return null
    let mask = 0x80, length = 1
    while (length <= 8 && !(bytes[offset] & mask)) { mask >>= 1; length++ }
    if (length > (id ? 4 : 8)) throw new Error("Invalid WebM element header.")
    if (offset + length > bytes.length) return null
    let value = id ? bytes[offset] : bytes[offset] & (mask - 1)
    let unknown = !id && value === mask - 1
    for (let i = 1; i < length; i++) { value = value * 256 + bytes[offset + i]; unknown = unknown && bytes[offset + i] === 255 }
    if (!unknown && !Number.isSafeInteger(value)) throw new Error("WebM element size is too large.")
    return { value: unknown ? Infinity : value, length }
}
function element(bytes: Uint8Array, offset: number) {
    const id = vint(bytes, offset, true)
    if (!id) return null
    const size = vint(bytes, offset + id.length, false)
    if (!size) return null
    const start = offset + id.length + size.length
    return { id: id.value, start, end: start + size.value }
}

/** Inspect the bounded initialization prefix before any media is appended to MSE. */
export function inspectWebmHeader(bytes: Uint8Array): { mimeType: string } | null {
    let offset = 0
    while (offset < bytes.length) {
        const item = element(bytes, offset)
        if (!item) return null
        if (item.id === 0x18538067) { offset = item.start; continue }
        if (item.id === 0x1f43b675) throw new Error("WebM media starts before its track metadata.")
        if (item.end > bytes.length) return null
        if (item.id === 0x1654ae6b) {
            const codecs: string[] = []
            let video = false
            for (let trackOffset = item.start; trackOffset < item.end;) {
                const track = element(bytes, trackOffset)
                if (!track || track.end > item.end) throw new Error("Truncated WebM tracks.")
                trackOffset = track.end
                if (track.id !== 0xae) continue
                let type = 0, codec = ""
                for (let fieldOffset = track.start; fieldOffset < track.end;) {
                    const field = element(bytes, fieldOffset)
                    if (!field || field.end > track.end) throw new Error("Truncated WebM track.")
                    fieldOffset = field.end
                    if (field.id === 0x83) {
                        if (field.end - field.start !== 1) throw new Error("Invalid WebM track type.")
                        type = bytes[field.start]
                    }
                    if (field.id === 0x86) codec = new TextDecoder().decode(bytes.subarray(field.start, field.end))
                }
                const name = type === 1 ? VIDEO_CODECS[codec] : type === 2 ? AUDIO_CODECS[codec] : undefined
                if (!name) throw new Error(`Unsupported WebM preview track: ${codec}.`)
                video ||= type === 1
                codecs.push(name)
            }
            if (!codecs.length) throw new Error("The WebM header contains no media tracks.")
            return { mimeType: `${video ? "video" : "audio"}/webm; codecs="${codecs.join(", ")}"` }
        }
        offset = item.end
    }
    return null
}
