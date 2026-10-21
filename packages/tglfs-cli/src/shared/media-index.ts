export type MediaSegment = { time: number; offset: number; length: number; keyframe: boolean }
export type MediaIndex = {
    type: "tglfs:media-index"
    version: 1
    container: "mp4" | "webm"
    duration: number
    initializationLength: number
    segments: MediaSegment[]
}
const MAX_HEADER = 32 * 1024 * 1024
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o)
const uint = (b: Uint8Array, o: number, n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 256 + b[o + i]
    if (!Number.isSafeInteger(v)) throw new Error("Media metadata number exceeds the supported range.")
    return v
}
type WebmCluster = { offset: number; time?: number; keyframe?: boolean }
const WEBM_SEGMENT_CHILDREN = new Set([
    0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367,
])
type Box = { type: string; start: number; end: number; data: number }
function boxes(b: Uint8Array, start = 0, end = b.length): Box[] {
    const result: Box[] = []
    for (let o = start; o < end; ) {
        if (o + 8 > end) throw new Error("Truncated MP4 index metadata.")
        let size = u32(b, o)
        let header = 8
        if (size === 1) {
            if (o + 16 > end) throw new Error("Truncated MP4 box size.")
            size = uint(b, o + 8, 8)
            header = 16
        }
        if (size < header || o + size > end) throw new Error("Invalid MP4 index metadata.")
        result.push({
            type: new TextDecoder().decode(b.subarray(o + 4, o + 8)),
            start: o,
            end: o + size,
            data: o + header,
        })
        o += size
    }
    return result
}
function vint(b: Uint8Array, o: number, id = false): { value: number; length: number } | null {
    if (o >= b.length) return null
    let mask = 128,
        length = 1
    while (length <= 8 && !(b[o] & mask)) {
        mask >>= 1
        length++
    }
    if (length > (id ? 4 : 8)) throw new Error("Invalid WebM index metadata.")
    if (o + length > b.length) return null
    let value = id ? b[o] : b[o] & (mask - 1)
    let unknown = !id && value === mask - 1
    for (let i = 1; i < length; i++) {
        value = value * 256 + b[o + i]
        unknown &&= b[o + i] === 255
    }
    if (!unknown && !Number.isSafeInteger(value)) throw new Error("Invalid WebM element size.")
    return { value: unknown ? Infinity : value, length }
}
function element(b: Uint8Array, o: number) {
    const id = vint(b, o, true)
    if (!id) return null
    const size = vint(b, o + id.length)
    if (!size) return null
    const data = o + id.length + size.length
    return { id: id.value, data, end: data + size.value }
}
function children(b: Uint8Array, start: number, end: number) {
    const result: { id: number; data: number; end: number }[] = []
    for (let o = start; o < end; ) {
        const e = element(b, o)
        if (!e || e.end > end) throw new Error("Truncated WebM metadata.")
        result.push(e)
        o = e.end
    }
    return result
}

/** Index container fragments while discarding encoded frame data after inspection. */
export class MediaStreamIndexer {
    private pending = new Uint8Array()
    private offset = 0
    private skip = 0
    private total = 0
    private initializationLength = 0
    private segments: MediaSegment[] = []
    private duration = 0
    private videoTrack = 0
    private timescale = 0
    private defaultFlags = 0x10000
    private timestampScale = 1000000
    private videoDefaultDuration = 0
    private videoEnd = 0
    private finalVideoDurationKnown = false
    private seenHeader = false
    private unknownCluster: WebmCluster | null = null
    constructor(readonly container: "mp4" | "webm") {}
    append(bytes: Uint8Array) {
        this.total += bytes.length
        const combined = new Uint8Array(this.pending.length + bytes.length)
        combined.set(this.pending)
        combined.set(bytes, this.pending.length)
        this.pending = combined
        if (this.container === "mp4") this.parseMp4()
        else this.parseWebm()
        if (this.pending.length > MAX_HEADER)
            throw new Error(
                "The media index needs more than 32 MiB of container metadata. Re-encode with shorter fragments.",
            )
    }
    private consume(n: number) {
        this.pending = this.pending.subarray(n)
        this.offset += n
    }
    private addSegment(time: number, offset: number, keyframe: boolean) {
        if (
            !Number.isFinite(time) ||
            time < 0 ||
            (this.segments.length && time < this.segments[this.segments.length - 1].time) ||
            this.segments.length >= 100000
        )
            throw new Error("The media fragment timeline cannot be indexed safely.")
        const previous = this.segments[this.segments.length - 1]
        if (previous) previous.length = offset - previous.offset
        this.segments.push({ time, offset, length: 0, keyframe })
    }
    private parseMp4() {
        while (true) {
            if (this.skip) {
                const n = Math.min(this.skip, this.pending.length)
                this.consume(n)
                this.skip -= n
                if (this.skip) return
            }
            const b = this.pending
            if (b.length < 8) return
            const type = new TextDecoder().decode(b.subarray(4, 8))
            let size = u32(b, 0)
            let header = 8
            if (size === 1) {
                if (b.length < 16) return
                size = uint(b, 8, 8)
                header = 16
            }
            if (size < header)
                throw new Error("An MP4 box has no bounded size. Re-encode before upgrading its preview.")
            if (type === "moov" || type === "moof") {
                if (size > MAX_HEADER) throw new Error("MP4 fragment metadata exceeds 32 MiB.")
                if (b.length < size) return
                if (type === "moov") {
                    this.readMoov(b.subarray(0, size))
                    this.initializationLength = this.offset + size
                    this.seenHeader = true
                } else {
                    if (!this.seenHeader) throw new Error("MP4 fragments precede initialization metadata.")
                    this.readMoof(b.subarray(0, size), this.offset)
                }
                this.consume(size)
            } else {
                this.consume(header)
                this.skip = size - header
            }
        }
    }
    private readMoov(b: Uint8Array) {
        const moov = boxes(b)[0]
        for (const child of boxes(b, moov.data, moov.end)) {
            if (child.type === "mvhd") {
                const v = b[child.data]
                const ts = u32(b, child.data + (v === 1 ? 20 : 12))
                const d = uint(b, child.data + (v === 1 ? 24 : 16), v === 1 ? 8 : 4)
                if (ts && d !== 0xffffffff) this.duration = d / ts
            }
            if (child.type === "trak") {
                const fields = boxes(b, child.data, child.end)
                const tkhd = fields.find((x) => x.type === "tkhd")
                const mdia = fields.find((x) => x.type === "mdia")
                if (!tkhd || !mdia) continue
                const md = boxes(b, mdia.data, mdia.end)
                const hdlr = md.find((x) => x.type === "hdlr")
                const mdhd = md.find((x) => x.type === "mdhd")
                if (!hdlr || !mdhd || new TextDecoder().decode(b.subarray(hdlr.data + 8, hdlr.data + 12)) !== "vide")
                    continue
                if (this.videoTrack)
                    throw new Error("Multiple video tracks cannot be indexed by this preview protocol.")
                this.videoTrack = u32(b, tkhd.data + (b[tkhd.data] === 1 ? 20 : 12))
                this.timescale = u32(b, mdhd.data + (b[mdhd.data] === 1 ? 20 : 12))
            }
        }
        const mvex = boxes(b, moov.data, moov.end).find((x) => x.type === "mvex")
        if (mvex)
            for (const trex of boxes(b, mvex.data, mvex.end))
                if (trex.type === "trex" && u32(b, trex.data + 4) === this.videoTrack)
                    this.defaultFlags = u32(b, trex.data + 20)
        if (!this.videoTrack || !this.timescale) throw new Error("The MP4 has no supported video timeline.")
    }
    private readMoof(b: Uint8Array, position: number) {
        const root = boxes(b)[0]
        for (const traf of boxes(b, root.data, root.end).filter((x) => x.type === "traf")) {
            const fields = boxes(b, traf.data, traf.end)
            const tfhd = fields.find((x) => x.type === "tfhd")
            const tfdt = fields.find((x) => x.type === "tfdt")
            const trun = fields.find((x) => x.type === "trun")
            if (!tfhd || u32(b, tfhd.data + 4) !== this.videoTrack) continue
            if (!tfdt || !trun) throw new Error("An MP4 fragment has no indexed decode timeline.")
            const flags = u32(b, tfhd.data) & 0xffffff
            let cursor = tfhd.data + 8
            if (flags & 1) cursor += 8
            if (flags & 2) cursor += 4
            if (flags & 8) cursor += 4
            if (flags & 16) cursor += 4
            let sampleFlags = flags & 32 ? u32(b, cursor) : this.defaultFlags
            const runFlags = u32(b, trun.data) & 0xffffff
            cursor = trun.data + 8
            if (runFlags & 1) cursor += 4
            if (runFlags & 4) sampleFlags = u32(b, cursor)
            else if (runFlags & 0x400) {
                if (runFlags & 0x100) cursor += 4
                if (runFlags & 0x200) cursor += 4
                sampleFlags = u32(b, cursor)
            }
            const time = uint(b, tfdt.data + 4, b[tfdt.data] === 1 ? 8 : 4) / this.timescale
            this.addSegment(time, position, !(sampleFlags & 0x10000))
            return
        }
        throw new Error("An MP4 fragment has no primary video samples.")
    }
    private parseWebm() {
        while (true) {
            if (this.skip) {
                const n = Math.min(this.skip, this.pending.length)
                this.consume(n)
                this.skip -= n
                if (this.skip) return
            }
            const e = element(this.pending, 0)
            if (!e) return
            if (this.unknownCluster) {
                if (WEBM_SEGMENT_CHILDREN.has(e.id)) {
                    this.finishCluster(this.unknownCluster)
                    this.unknownCluster = null
                    continue
                }
                if (
                    !Number.isFinite(e.end) ||
                    e.end > MAX_HEADER ||
                    this.offset - this.unknownCluster.offset + e.end > MAX_HEADER
                )
                    throw new Error("A WebM cluster exceeds the bounded preview fragment size.")
                if (e.end > this.pending.length) return
                this.readClusterField(this.pending, e, this.unknownCluster)
                this.consume(e.end)
                continue
            }
            if (e.id === 0x18538067) {
                this.consume(e.data)
                continue
            }
            if (!Number.isFinite(e.end)) {
                if (e.id !== 0x1f43b675 || !this.seenHeader || !this.videoTrack)
                    throw new Error("Unsupported unknown-size WebM metadata.")
                if (!this.segments.length) this.initializationLength = this.offset
                this.unknownCluster = { offset: this.offset }
                this.consume(e.data)
                continue
            }
            if ([0x1549a966, 0x1654ae6b, 0x1f43b675].includes(e.id)) {
                if (e.end > MAX_HEADER)
                    throw new Error("WebM cluster metadata exceeds 32 MiB. Re-encode with shorter clusters.")
                if (e.end > this.pending.length) return
                const b = this.pending
                if (e.id === 0x1549a966) {
                    for (const f of children(b, e.data, e.end)) {
                        if (f.id === 0x2ad7b1) this.timestampScale = uint(b, f.data, f.end - f.data)
                        if (f.id === 0x4489) {
                            const view = new DataView(b.buffer, b.byteOffset + f.data, f.end - f.data)
                            this.duration =
                                ((f.end - f.data === 4 ? view.getFloat32(0) : view.getFloat64(0)) *
                                    this.timestampScale) /
                                1e9
                        }
                    }
                } else if (e.id === 0x1654ae6b) {
                    for (const track of children(b, e.data, e.end).filter((x) => x.id === 0xae)) {
                        const fields = children(b, track.data, track.end)
                        const type = fields.find((x) => x.id === 0x83)
                        const number = fields.find((x) => x.id === 0xd7)
                        if (type && number && uint(b, type.data, type.end - type.data) === 1) {
                            if (this.videoTrack)
                                throw new Error("Multiple video tracks cannot be indexed by this preview protocol.")
                            this.videoTrack = uint(b, number.data, number.end - number.data)
                            const duration = fields.find((x) => x.id === 0x23e383)
                            if (duration)
                                this.videoDefaultDuration = uint(b, duration.data, duration.end - duration.data) / 1e9
                        }
                    }
                    this.seenHeader = true
                } else {
                    if (!this.seenHeader || !this.videoTrack) throw new Error("WebM clusters precede track metadata.")
                    if (!this.segments.length) this.initializationLength = this.offset
                    const cluster: WebmCluster = { offset: this.offset }
                    for (const field of children(b, e.data, e.end)) this.readClusterField(b, field, cluster)
                    this.finishCluster(cluster)
                }
                this.consume(e.end)
            } else {
                this.consume(e.data)
                this.skip = e.end - e.data
            }
        }
    }
    private readClusterField(
        bytes: Uint8Array,
        field: { id: number; data: number; end: number },
        cluster: WebmCluster,
    ) {
        if (field.id === 0xe7)
            cluster.time = (uint(bytes, field.data, field.end - field.data) * this.timestampScale) / 1e9
        if (field.id === 0xa3) {
            const number = vint(bytes, field.data)
            if (number?.value === this.videoTrack) {
                if (cluster.keyframe === undefined) cluster.keyframe = !!(bytes[field.data + number.length + 2] & 128)
                this.videoBlock(bytes, field.data + number.length, field.end, cluster.time, this.videoDefaultDuration)
            }
        }
        if (field.id === 0xa0) {
            const fields = children(bytes, field.data, field.end)
            const block = fields.find((item) => item.id === 0xa1)
            const number = block ? vint(bytes, block.data) : null
            if (number?.value === this.videoTrack) {
                if (cluster.keyframe === undefined) cluster.keyframe = !fields.some((item) => item.id === 0xfb)
                const duration = fields.find((item) => item.id === 0x9b)
                this.videoBlock(
                    bytes,
                    block!.data + number.length,
                    block!.end,
                    cluster.time,
                    duration
                        ? (uint(bytes, duration.data, duration.end - duration.data) * this.timestampScale) / 1e9
                        : this.videoDefaultDuration,
                )
            }
        }
    }
    private finishCluster(cluster: WebmCluster) {
        if (cluster.time === undefined || (cluster.keyframe === undefined && !this.segments.length))
            throw new Error("A WebM cluster has no supported video timeline.")
        if (cluster.keyframe !== undefined) this.addSegment(cluster.time, cluster.offset, cluster.keyframe)
    }
    private videoBlock(
        bytes: Uint8Array,
        header: number,
        end: number,
        clusterTime: number | undefined,
        duration: number,
    ) {
        if (header + 3 > end || clusterTime === undefined || bytes[header + 2] & 6)
            throw new Error("Laced or malformed WebM video blocks cannot be indexed safely.")
        const relative = new DataView(bytes.buffer, bytes.byteOffset + header, 2).getInt16(0)
        const timestamp = clusterTime + (relative * this.timestampScale) / 1e9
        if (timestamp < 0) throw new Error("Negative WebM video timestamps cannot be indexed safely.")
        this.videoEnd = Math.max(this.videoEnd, timestamp + duration)
        this.finalVideoDurationKnown = duration > 0
    }
    finish(duration?: number): MediaIndex {
        if (this.unknownCluster && !this.pending.length && !this.skip) {
            this.finishCluster(this.unknownCluster)
            this.unknownCluster = null
        }
        if (
            this.skip ||
            this.pending.length ||
            !this.segments.length ||
            !this.segments[0].keyframe ||
            !this.initializationLength
        )
            throw new Error("This media cannot be indexed for seeking. Make a new previewable copy first.")
        const length = duration ?? (this.duration || (this.finalVideoDurationKnown ? this.videoEnd : 0))
        if (!Number.isFinite(length) || length <= 0 || this.segments[this.segments.length - 1].time >= length)
            throw new Error(
                `The media has no finite duration matching its fragment timeline (${length}; last fragment ${this.segments[this.segments.length - 1].time}). Make a new previewable copy.`,
            )
        this.segments[this.segments.length - 1].length = this.total - this.segments[this.segments.length - 1].offset
        return {
            type: "tglfs:media-index",
            version: 1,
            container: this.container,
            duration: length,
            initializationLength: this.initializationLength,
            segments: this.segments,
        }
    }
}
