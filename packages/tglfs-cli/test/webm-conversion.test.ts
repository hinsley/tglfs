import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { getGramJs } from "../src/gramjs.ts"
import { convertWebm, buildWebmArgs, openSafeWebmSource, parseWebmQuality, validateWebmProbe, WEBM_INPUT_ARGS } from "../src/convert-webm.ts"
import { collectMetadata, runMediaProcess } from "../src/webm-process.ts"
import { upgradeMediaPreview } from "../src/media-upgrade.ts"
import { uploadGeneratedCurrentFormatStream } from "../src/generated-upload.ts"
import { createVerifiedFileCardPlaintextStream } from "../src/plaintext-stream.ts"
import { patchMp4MovieDuration } from "../src/mp4-preview.ts"
import { lumaSsim, qualityReport, sampleWindows, webmCopyName } from "../src/shared/webm-policy.ts"
import { parseFileCardMessage } from "../src/shared/file-cards.ts"
import { validateProgressiveAvc } from "../src/shared/avc-safety.ts"
import { inspectWebmHeader } from "../../../src/web/webmHeader.ts"

class MemoryTelegram {
    cards = new Map<number, string>()
    chunks = new Map<number, Uint8Array>()
    parts = new Map<string, Uint8Array[]>()
    deleted: number[] = []
    nextId = 10
    ambiguousPublication = false
    async getMessages(_peer: string, options: any) {
        const { Api } = getGramJs()
        if (!options.ids) return [...this.cards].filter(([, text]) => !options.search || text.includes(options.search.replace("tglfs:file ", "")))
            .map(([id, message]) => ({ id, message, date: id }))
        return options.ids.map((id: number) => this.chunks.has(id) ? {
            id, media: new Api.MessageMediaDocument({ document: new Api.Document({
                id: BigInt(id), accessHash: 1n, fileReference: Buffer.alloc(0), date: 0,
                mimeType: "application/octet-stream", size: this.chunks.get(id)!.length, dcId: 1, attributes: [],
            } as any) }),
        } : { id, message: this.cards.get(id), date: id })
    }
    async invoke(request: any) {
        if (request.className === "upload.SaveBigFilePart") {
            const parts = this.parts.get(String(request.fileId)) ?? []
            parts[request.filePart] = Uint8Array.from(request.bytes)
            this.parts.set(String(request.fileId), parts)
            return true
        }
        if (request.className === "upload.GetFile") {
            const bytes = this.chunks.get(Number(String(request.location.id)))!
            return { bytes: bytes.slice(Number(request.offset), Number(request.offset) + request.limit) }
        }
        if (request.className === "messages.DeleteMessages") {
            for (const id of request.id) { this.deleted.push(id); this.chunks.delete(id) }
            return true
        }
        throw new Error(`Unexpected ${request.className}`)
    }
    async sendFile(_peer: string, options: any) {
        const id = this.nextId++
        this.chunks.set(id, Uint8Array.from(Buffer.concat(this.parts.get(String(options.file.id))!)))
        return { id }
    }
    async sendMessage(_peer: string, { message }: { message: string }) {
        const id = this.nextId++
        this.cards.set(id, message)
        if (this.ambiguousPublication) throw new Error("Response lost after Telegram accepted the card")
        return { id, date: id }
    }
}

const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
const ffmpeg = process.env.TGLFS_FFMPEG || "ffmpeg"
const ffprobe = process.env.TGLFS_FFPROBE || "ffprobe"
const hasFfmpeg = spawnSync(ffmpeg, ["-hide_banner", "-h", "full"], { maxBuffer: 4 * 1024 * 1024 }).stdout?.includes("-filter_buffered_frames") && spawnSync(ffprobe, ["-version"]).status === 0
function videoFixture(format = "mp4", audio = true) {
    const result = spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=3",
        ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3"] : []),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12", "-bf", "0",
        ...(audio ? ["-c:a", "aac"] : []), "-movflags", "+empty_moov+frag_keyframe+default_base_moof", "-f", format, "pipe:1"], { maxBuffer: 2 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr.toString())
    return patchMp4MovieDuration(result.stdout, 3)
}
async function collect(stream: ReadableStream<Uint8Array>) { return new Uint8Array(await new Response(stream).arrayBuffer()) }
async function probe(bytes: Uint8Array) {
    const process = runMediaProcess(ffprobe, ["-v", "error", ...WEBM_INPUT_ARGS, "-i", "pipe:0", "-show_streams", "-show_format", "-of", "json"], stream(bytes))
    const [json] = await Promise.all([collectMetadata(process.stream), process.completion])
    return JSON.parse(json)
}

test("quality policy covers beginning, middle and end without overlap and refuses missing or bad samples", () => {
    assert.deepEqual(sampleWindows(10), [{ start: 0, end: 1 }, { start: 4.5, end: 5.5 }, { start: 9, end: 10 }])
    assert.throws(() => sampleWindows(NaN))
    assert.throws(() => qualityReport([{ start: 0, end: 1, ssim: 0.8 }]), /quality failed/)
    assert.throws(() => qualityReport([{ start: 0, end: 1, ssim: NaN }]))
    assert.throws(() => parseWebmQuality("", 10))
    const detail = Uint8Array.from({ length: 256 }, (_, i) => i)
    assert.equal(lumaSsim(detail, detail, 16, 16), 1)
    assert.ok(lumaSsim(detail, new Uint8Array(256), 16, 16) < 0.1)
    assert.equal(webmCopyName("Trip.MOV"), "Trip.preview.webm")
})

test("trailing metadata is refused and its source reader is cancelled", async () => {
    let cancelled = false
    const bytes = Uint8Array.of(0, 0, 0, 8, 109, 100, 97, 116)
    await assert.rejects(openSafeWebmSource(new ReadableStream({ pull(c) { c.enqueue(bytes) }, cancel() { cancelled = true } })), /requires seeking/)
    assert.equal(cancelled, true)
})

test("metadata validation refuses HDR, alpha, extra tracks, rotation and unsupported audio", () => {
    const video = { codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", field_order: "progressive", width: 160, height: 90 }
    const metadata = (streams: any[]) => ({ streams, format: { duration: "3", format_name: "mov,mp4,m4a,3gp,3g2,mj2" } })
    assert.equal(validateWebmProbe(metadata([video])).duration, 3)
    for (const change of [{ color_transfer: "smpte2084" }, { pix_fmt: "yuva420p" }, { field_order: "tt" }, { field_order: "unknown" }, { width: 16384 }, { tags: { rotate: "90" } }, { tags: { alpha_mode: "1" } }]) {
        assert.throws(() => validateWebmProbe(metadata([{ ...video, ...change }])))
    }
    assert.throws(() => validateWebmProbe(metadata([video, { codec_type: "subtitle" }])))
    assert.throws(() => validateWebmProbe(metadata([video, { codec_type: "audio", channels: 6, sample_rate: "48000" }])))
})

for (const [format, password] of [["mp4", "private sample password"], ["mov", ""]]) {
    test(`real ${format} converts through encrypted Telegram streams; original and password are retained`, { skip: !hasFfmpeg, timeout: 30000 }, async () => {
        const client = new MemoryTelegram()
        const input = videoFixture(format)
        const original = await uploadGeneratedCurrentFormatStream(client as any, { name: `source.${format}`, stream: stream(input), password, chunkSize: 512 * 1024, parentFolderId: "folder-test" })
        const originalText = client.cards.get(original.msgId)
        const originalChunks = original.data.chunks.map(id => client.chunks.get(id)!.slice())
        await assert.rejects(convertWebm(client as any, original, { sourcePassword: "incorrect source password", chunkSize: 512 * 1024, ffmpegPath: ffmpeg, ffprobePath: ffprobe }))
        assert.equal(client.cards.size, 1)
        const result = await convertWebm(client as any, original, { sourcePassword: password, chunkSize: 512 * 1024, ffmpegPath: ffmpeg, ffprobePath: ffprobe })
        assert.equal(result.originalRetained, true)
        assert.equal(result.stagedSource, false)
        assert.equal(result.data.version, 5)
        assert.equal(client.cards.get(original.msgId), originalText)
        assert.deepEqual(original.data.chunks.map(id => client.chunks.get(id)), originalChunks)
        assert.equal((result.data as any).parentFolderId, "folder-test")
        assert.notEqual(result.data.IV, original.data.IV)
        assert.equal(result.quality.clips.length, 3)
        assert.ok(result.quality.clips.every(c => c.ssim >= 0.98))
        const output = await collect(await createVerifiedFileCardPlaintextStream(client as any, result.data, password))
        const inspected = await probe(output)
        assert.equal(inspected.streams[0].codec_name, "vp9")
        assert.equal(inspected.streams[0].width, 160)
        assert.equal(inspected.streams[0].height, 90)
        assert.equal(inspected.streams[1].codec_name, "opus")
        assert.equal(inspected.streams[1].channels, 1)
        assert.equal(inspectWebmHeader(output)?.mimeType, 'video/webm; codecs="vp9, opus"')
        assert.equal(inspectWebmHeader(output.subarray(0, 12)), null)
        assert.deepEqual(client.deleted, [])
        if (password) await assert.rejects(async () => collect(await createVerifiedFileCardPlaintextStream(client as any, result.data, "wrong")))
    })
}

test("poor actual encode samples fail quality checks", { skip: !hasFfmpeg, timeout: 30000 }, async () => {
    const fixture = videoFixture("mp4", false)
    const metadata = validateWebmProbe(await probe(fixture))
    const args = buildWebmArgs(metadata)
    args[args.indexOf("-crf") + 1] = "63"
    const conversion = runMediaProcess(ffmpeg, args, stream(fixture))
    const [, log] = await Promise.all([collect(conversion.stream), conversion.completion])
    assert.throws(() => parseWebmQuality(log, 3), /quality failed/)
})

test("AVC sequence inspection refuses interlacing and missing or truncated SPS metadata", () => {
    function configuration(progressive: boolean) {
        const bits: number[] = []
        const write = (value: number, size: number) => { for (let i = size - 1; i >= 0; i--) bits.push((value >> i) & 1) }
        const ue = (value: number) => { const size = Math.floor(Math.log2(value + 1)) + 1; write(0, size - 1); write(value + 1, size) }
        write(66, 8); write(0, 8); write(30, 8); ue(0); ue(0); ue(0); ue(0); ue(1); write(0, 1); ue(9); ue(5); write(Number(progressive), 1)
        while (bits.length % 8) bits.push(0)
        const nal = Uint8Array.from([0x67, ...Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((sum, bit) => sum * 2 + bit, 0))])
        return Uint8Array.from([1, 66, 0, 30, 255, 225, 0, nal.length, ...nal])
    }
    validateProgressiveAvc(configuration(true))
    assert.throws(() => validateProgressiveAvc(configuration(false)), /Interlaced/)
    assert.throws(() => validateProgressiveAvc(undefined))
    assert.throws(() => validateProgressiveAvc(configuration(true).subarray(0, 9)))
})

test("process cancellation stops a bounded pipe and cancels its plaintext source", { timeout: 10000 }, async () => {
    const abort = new AbortController()
    let pulled = 0, cancelled = false
    const source = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(65536)) }, cancel() { cancelled = true } })
    const process = runMediaProcess(globalThis.process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], source, abort.signal)
    const reader = process.stream.getReader()
    await reader.read()
    abort.abort(new Error("test cancellation"))
    await assert.rejects(process.completion)
    await process.cancel()
    assert.equal(cancelled, true)
    assert.ok(pulled < 64, `Unexpected read-ahead: ${pulled * 65536} bytes`)
})

test("metadata-only probing cancels its source instead of reading the whole video", { timeout: 10000 }, async () => {
    let pulled = 0, cancelled = false
    const source = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(65536)) }, cancel() { cancelled = true } })
    const probe = runMediaProcess(globalThis.process.execPath, ["-e", "process.stdin.once('data',()=>{ process.stdout.end('{}'); process.exit(0) })"], source, undefined, true)
    const [result] = await Promise.all([collectMetadata(probe.stream), probe.completion])
    assert.equal(result, "{}")
    assert.equal(cancelled, true)
    assert.ok(pulled < 64)
})

test("archives and future file protocols fail before any Telegram access", async () => {
    const client = { getMessages() { throw new Error("must not read") } }
    for (const version of [4, 99]) await assert.rejects(convertWebm(client as any, { data: { version, name: "archive.mp4", uploadComplete: true } } as any, { sourcePassword: "", chunkSize: 512 * 1024 }), /archives and unknown/)
})

test("failed quality stream and cancellation publish no card and preserve the original", async () => {
    const client = new MemoryTelegram()
    const original = await uploadGeneratedCurrentFormatStream(client as any, { name: "original.txt", stream: stream(new TextEncoder().encode("original")), password: "p", chunkSize: 512 * 1024 })
    const sourceIds = [...original.data.chunks]
    const fail = stream(new Uint8Array(1024)).pipeThrough(new TransformStream({
        transform(chunk, c) { c.enqueue(chunk) }, flush() { qualityReport([{ start: 0, end: 1, ssim: 0.2 }]) },
    }))
    await assert.rejects(uploadGeneratedCurrentFormatStream(client as any, { name: "bad.webm", stream: fail, password: "p", chunkSize: 512 * 1024 }), /quality failed/)
    const aborted = AbortSignal.abort(new Error("cancelled"))
    await assert.rejects(uploadGeneratedCurrentFormatStream(client as any, { name: "cancel.webm", stream: stream(new Uint8Array(32)), password: "p", chunkSize: 512 * 1024, signal: aborted }), /cancelled/)
    assert.equal(client.cards.size, 1)
    assert.ok(sourceIds.every(id => client.chunks.has(id)))
})

test("an uncertain Telegram publication retains chunks so a possibly published copy remains readable", async () => {
    const client = new MemoryTelegram()
    client.ambiguousPublication = true
    await assert.rejects(uploadGeneratedCurrentFormatStream(client as any, { name: "copy.webm", stream: stream(new TextEncoder().encode("test")), password: "p", chunkSize: 512 * 1024 }), /Response lost/)
    assert.equal(client.cards.size, 1)
    const data = parseFileCardMessage([...client.cards.values()][0])!
    assert.ok(data.chunks.every(id => client.chunks.has(id)))
    assert.equal(new TextDecoder().decode(await collect(await createVerifiedFileCardPlaintextStream(client as any, data, "p"))), "test")
})

for (const password of ["", "same source password"]) test(`existing preview media upgrades without changing bytes or ${password ? "its password" : "an empty password"}`, { skip: !hasFfmpeg, timeout: 30000 }, async () => {
    const client = new MemoryTelegram(); const bytes = videoFixture("mp4")
    const original = await uploadGeneratedCurrentFormatStream(client as any, { name: "old.preview.mp4", stream: stream(bytes), password, chunkSize: 512 * 1024 })
    const originalText = client.cards.get(original.msgId); const originalChunks = original.data.chunks.map(id => client.chunks.get(id)!.slice())
    const upgraded = await upgradeMediaPreview(client as any, original, { password })
    assert.equal(upgraded.data.version, 5)
    assert.equal(upgraded.data.ufid, original.data.ufid)
    assert.notEqual(upgraded.msgId, original.msgId)
    assert.equal(client.cards.get(original.msgId), originalText)
    assert.deepEqual(original.data.chunks.map(id => client.chunks.get(id)), originalChunks)
    assert.equal(upgraded.data.mediaPreview?.source?.messageId, original.msgId)
    assert.deepEqual(await collect(await createVerifiedFileCardPlaintextStream(client as any, upgraded.data, password)), Uint8Array.from(bytes))
    await assert.rejects(upgradeMediaPreview(client as any, upgraded, { password }), /already has/)
    assert.deepEqual(client.deleted, [])
})

for (const password of ["", "protected MP4 source"]) test(`MP4 preview conversion keeps ${password ? "the source password" : "the empty source password"} despite obsolete output-password input`, { skip: !hasFfmpeg, timeout: 30000 }, async () => {
    const { makeMp4Previewable } = await import("../src/make-previewable.ts")
    const client = new MemoryTelegram()
    const { Api } = getGramJs()
    const original = await uploadGeneratedCurrentFormatStream(client as any, { Api, name: "original.mp4", password, stream: stream(videoFixture("mp4", false)), chunkSize: 512 * 1024 })
    const originalCard = client.cards.get(original.msgId)
    const originals = original.data.chunks.map(id => [id, client.chunks.get(id)!.slice()] as const)
    const result = await makeMp4Previewable(client as any, original, { sourcePassword: password, uploadPassword: "must never be used", chunkSize: 512 * 1024, ffmpegPath: ffmpeg, ffprobePath: ffprobe } as any)
    const data = parseFileCardMessage(client.cards.get(result.msgId)!)!
    assert.equal(data.version, 5)
    assert.ok((data as any).mediaPreview)
    assert.ok((await collect(await createVerifiedFileCardPlaintextStream(client as any, data, password))).length > 0)
    await assert.rejects(async () => collect(await createVerifiedFileCardPlaintextStream(client as any, data, "must never be used")), /password|corrupt/)
    assert.equal(client.cards.get(original.msgId), originalCard)
    for (const [id, bytes] of originals) assert.deepEqual(client.chunks.get(id), bytes)
    assert.deepEqual(client.deleted, [])
})
