import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { blockFixture } from "./helpers/block-fixture.ts"
import { uploadSeekableMedia } from "../src/shared/media-upload.ts"
import { MediaStreamIndexer } from "../src/shared/media-index.ts"
import { openBlockFile } from "../src/shared/block-transfer.ts"
import { parseJson } from "../src/shared/block-format.ts"
import { getMediaPreviewUpgradeCapability } from "../src/shared/media-preview.ts"
import { parseFileCardMessage, serializeFileCardMessage } from "../src/shared/file-cards.ts"
import { patchMp4MovieDuration } from "../src/mp4-preview.ts"

const ffmpeg = process.env.TGLFS_FFMPEG || "ffmpeg"
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0
function fixture(container: "mp4" | "webm") {
    const result = spawnSync(
        ffmpeg,
        [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=12:duration=6",
            ...(container === "mp4"
                ? [
                      "-c:v",
                      "libx264",
                      "-preset",
                      "ultrafast",
                      "-g",
                      "12",
                      "-bf",
                      "0",
                      "-movflags",
                      "+empty_moov+frag_keyframe+default_base_moof",
                  ]
                : [
                      "-c:v",
                      "libvpx-vp9",
                      "-deadline",
                      "realtime",
                      "-cpu-used",
                      "8",
                      "-g",
                      "12",
                      "-cluster_time_limit",
                      "1000",
                      "-live",
                      "1",
                  ]),
            "-an",
            "-f",
            container,
            "pipe:1",
        ],
        { maxBuffer: 8 * 1024 * 1024 },
    )
    assert.equal(result.status, 0, result.stderr.toString())
    return container === "mp4"
        ? Uint8Array.from(patchMp4MovieDuration(result.stdout, 6))
        : Uint8Array.from(result.stdout)
}
function stream(bytes: Uint8Array) {
    let offset = 0
    return new ReadableStream<Uint8Array>(
        {
            pull(c) {
                if (offset === bytes.length) return c.close()
                const end = Math.min(bytes.length, offset + 8191)
                c.enqueue(bytes.slice(offset, end))
                offset = end
            },
        },
        { highWaterMark: 0 },
    )
}
for (const container of ["mp4", "webm"] as const)
    for (const password of ["", "a private video password"]) {
        test(
            `${container} v5 indexed media seeks into encrypted late blocks with ${password ? "a" : "an empty"} password`,
            { skip: !hasFfmpeg, timeout: 30000 },
            async () => {
                const f = blockFixture()
                const bytes = fixture(container)
                const original = { id: 50, date: 0, message: "original card" }
                f.messages.push(original)
                const result = await uploadSeekableMedia(f.client, {
                    ...f.options,
                    name: `copy.${container}`,
                    stream: stream(bytes),
                    password,
                    container,
                    duration: container === "mp4" ? 6 : undefined,
                    blockSize: 65536,
                    source: {
                        type: "tglfs:media-source",
                        version: 1,
                        messageId: 50,
                        fileVersion: 3,
                        ufid: "a".repeat(64),
                    },
                })
                assert.equal(result.data.version, 5)
                assert.deepEqual(
                    f.messages.find((m) => m.id === 50),
                    original,
                )
                assert.deepEqual(f.deletes, [])
                assert.equal(result.data.mediaPreview?.type, "tglfs:media-preview")
                assert.equal(result.data.mediaPreview?.version, 1)
                assert.equal(parseFileCardMessage(serializeFileCardMessage(result.data))?.version, 5)
                const reader = await openBlockFile(f.client, { ...f.options, data: result.data, password })
                assert.ok(reader.plan.mediaIndex)
                assert.ok(reader.plan.mediaIndex.segments.length >= 3)
                const seek = [...reader.plan.mediaIndex.segments].reverse().find((s) => s.keyframe && s.time >= 3)!
                assert.ok(seek)
                const map = parseJson(f.documents.get(result.data.chunks[0])!)
                assert.ok(seek.offset >= 65536, "Late seek must be beyond the first encrypted block")
                f.reads.length = 0
                const sample = await reader.readRange(seek.offset, Math.min(4096, seek.length))
                assert.deepEqual(sample, bytes.slice(seek.offset, seek.offset + sample.length))
                const expectedIndex = Math.floor(seek.offset / 65536)
                assert.ok(
                    f.reads.every((id) => id === map.messages[expectedIndex] || id === map.messages[expectedIndex + 1]),
                )
                assert.ok(
                    !f.reads.includes(map.messages[0]),
                    "Seeking near the end must not fetch the encrypted prefix",
                )
                assert.deepEqual(new Uint8Array(await new Response(reader.stream()).arrayBuffer()), bytes)
                await assert.rejects(
                    openBlockFile(f.client, { ...f.options, data: result.data, password: "different" }),
                    /password|corrupt/,
                )
                assert.equal(getMediaPreviewUpgradeCapability(result.data).current, true)
                assert.equal(getMediaPreviewUpgradeCapability({ ...result.data, version: 99 } as any).supported, false)
            },
        )
    }

test("unindexable generated media never publishes a file card or removes an original", async () => {
    const f = blockFixture()
    f.messages.push({ id: 50, message: "original", date: 0 })
    const invalid = new Uint8Array(70000)
    await assert.rejects(
        uploadSeekableMedia(f.client, {
            ...f.options,
            name: "copy.mp4",
            stream: stream(invalid),
            password: "p",
            container: "mp4",
            blockSize: 65536,
        }),
        /MP4|media|bounded/,
    )
    assert.equal(f.messages.length, 1)
    assert.equal(f.messages[0].id, 50)
})
test("incomplete index and unsupported media records fail closed", () => {
    const parser = new MediaStreamIndexer("mp4")
    parser.append(Uint8Array.of(0, 0, 0, 8, 102, 116, 121, 112))
    assert.throws(() => parser.finish(5), /cannot be indexed/)
    for (const version of [4, 99])
        assert.equal(
            getMediaPreviewUpgradeCapability({ version, uploadComplete: true, name: "x.mp4" } as any).supported,
            false,
        )
})
test(
    "uncertain media publication retains all blocks for a possibly published card",
    { skip: !hasFfmpeg, timeout: 30000 },
    async () => {
        const f = blockFixture()
        const bytes = fixture("mp4")
        f.controls.lostPublication = true
        await assert.rejects(
            uploadSeekableMedia(f.client, {
                ...f.options,
                name: "copy.mp4",
                stream: stream(bytes),
                password: "p",
                container: "mp4",
                duration: 6,
                blockSize: 65536,
            }),
            /publication/,
        )
        const data = parseFileCardMessage(f.messages.find((m) => m.message.startsWith("tglfs:file"))!.message)!
        assert.equal(data.version, 5)
        const reader = await openBlockFile(f.client, { ...f.options, data: data as any, password: "p" })
        assert.deepEqual(new Uint8Array(await new Response(reader.stream()).arrayBuffer()), bytes)
        assert.deepEqual(f.deletes, [])
    },
)

for (const short of [false, true])
    test(
        `the player seeks from a prior keyframe ${short ? "after reaching end of stream" : "in a long video"} without replaying earlier fragments`,
        { skip: !hasFfmpeg, timeout: 10000 },
        async () => {
            const { playSeekableMedia } = await import("../../../src/web/seekableMedia.ts")
            const bytes = fixture("mp4")
            const parser = new MediaStreamIndexer("mp4")
            parser.append(bytes)
            const index = parser.finish(6)
            if (!short) {
                index.duration = 60
                index.segments = index.segments.map((s, i) => ({ ...s, time: i * 10 }))
            }
            const requested: number[] = []
            const priorSource = globalThis.MediaSource
            const priorCreate = URL.createObjectURL,
                priorRevoke = URL.revokeObjectURL
            let source: FakeSource
            let revoked = 0
            class FakeBuffer extends EventTarget {
                updating = false
                buffered = {
                    length: 0,
                    start() {
                        return 0
                    },
                    end() {
                        return index.duration
                    },
                }
                appendBuffer() {
                    if (source.readyState === "closed") throw new Error("Source closed")
                    source.readyState = "open"
                    this.updating = true
                    queueMicrotask(() => {
                        this.buffered.length = 1
                        this.updating = false
                        this.dispatchEvent(new Event("updateend"))
                    })
                }
                remove() {
                    if (source.readyState === "closed") throw new Error("Source closed")
                    source.readyState = "open"
                    this.updating = true
                    queueMicrotask(() => {
                        this.buffered.length = 0
                        this.updating = false
                        this.dispatchEvent(new Event("updateend"))
                    })
                }
                abort() {
                    this.updating = false
                }
            }
            class FakeSource extends EventTarget {
                static isTypeSupported() {
                    return true
                }
                readyState = "closed"
                duration = 0
                constructor() {
                    super()
                    source = this
                }
                addSourceBuffer() {
                    return new FakeBuffer()
                }
                endOfStream() {
                    this.readyState = "ended"
                }
            }
            class FakeMedia extends EventTarget {
                currentTime = 0
                set src(_value: string) {
                    queueMicrotask(() => {
                        source.readyState = "open"
                        source.dispatchEvent(new Event("sourceopen"))
                    })
                }
            }
            try {
                globalThis.MediaSource = FakeSource as any
                URL.createObjectURL = () => "blob:fake"
                URL.revokeObjectURL = () => {
                    revoked++
                }
                const controller = new AbortController()
                const media = new FakeMedia()
                let failRead = false
                const reader = {
                    content: { blockSize: 65536 },
                    plan: { mediaIndex: index },
                    async readRange(offset: number, length: number) {
                        if (failRead) throw new Error("Network interrupted")
                        requested.push(offset)
                        return bytes.slice(offset, offset + length)
                    },
                }
                await playSeekableMedia(media as any, reader as any, controller.signal)
                if (short) assert.equal(source.readyState, "ended")
                requested.length = 0
                media.currentTime = short ? 4.2 : 42
                media.dispatchEvent(new Event("seeking"))
                for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
                assert.ok(requested.includes(index.segments[4].offset), "Must request the keyframe at 40 seconds")
                assert.ok(!requested.includes(index.segments[0].offset))
                assert.ok(!requested.includes(index.segments[1].offset))
                if (short) {
                    let error: unknown
                    media.addEventListener("tglfs:media-error", (event) => {
                        error = (event as CustomEvent).detail
                    })
                    failRead = true
                    media.currentTime = 2.2
                    media.dispatchEvent(new Event("seeking"))
                    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
                    assert.match(String(error), /Network interrupted/)
                    assert.equal(revoked, 1)
                }
                controller.abort()
                assert.equal(revoked, 1)
            } finally {
                globalThis.MediaSource = priorSource
                URL.createObjectURL = priorCreate
                URL.revokeObjectURL = priorRevoke
            }
        },
    )

test(
    "the actual append-only Mediabunny WebM writer produces bounded seekable unknown-size clusters",
    { skip: !hasFfmpeg, timeout: 10000 },
    async () => {
        const mb = await import("mediabunny")
        const input = new mb.Input({ source: new mb.BufferSource(fixture("webm")), formats: [mb.WEBM] })
        try {
            const track = await input.getPrimaryVideoTrack()
            assert.ok(track)
            const config = await track.getDecoderConfig()
            assert.ok(config)
            const chunks: Uint8Array[] = []
            const source = new mb.EncodedVideoPacketSource("vp9")
            const output = new mb.Output({
                format: new mb.WebMOutputFormat({ appendOnly: true, minimumClusterDuration: 1 }),
                target: new mb.AppendOnlyStreamTarget(
                    new WritableStream<Uint8Array>({
                        write(bytes) {
                            chunks.push(bytes.slice())
                        },
                    }),
                ),
            })
            output.addVideoTrack(source, { frameRate: 12 })
            await output.start()
            let first = true
            for await (const packet of new mb.EncodedPacketSink(track).packets()) {
                await source.add(packet, first ? { decoderConfig: config } : undefined)
                first = false
            }
            await output.finalize()
            const bytes = Uint8Array.from(Buffer.concat(chunks))
            const indexer = new MediaStreamIndexer("webm")
            for (let offset = 0; offset < bytes.length; offset += 13)
                indexer.append(bytes.subarray(offset, offset + 13))
            const index = indexer.finish(6)
            assert.ok(index.segments.length >= 3)
            for (const segment of index.segments) {
                assert.deepEqual(bytes.slice(segment.offset, segment.offset + 4), Uint8Array.of(0x1f, 0x43, 0xb6, 0x75))
                let mask = 128,
                    length = 1
                const start = segment.offset + 4
                while (!(bytes[start] & mask)) {
                    mask >>= 1
                    length++
                }
                assert.equal(bytes[start] & (mask - 1), mask - 1)
                for (let i = 1; i < length; i++) assert.equal(bytes[start + i], 255)
            }
            const f = blockFixture()
            const record = await uploadSeekableMedia(f.client, {
                ...f.options,
                name: "browser.preview.webm",
                stream: stream(bytes),
                password: "browser password",
                container: "webm",
                duration: 6,
                blockSize: 65536,
            })
            const reader = await openBlockFile(f.client, {
                ...f.options,
                data: record.data,
                password: "browser password",
            })
            assert.deepEqual(new Uint8Array(await new Response(reader.stream()).arrayBuffer()), bytes)
            const truncated = new MediaStreamIndexer("webm")
            truncated.append(bytes.subarray(0, bytes.length - 1))
            assert.throws(() => truncated.finish(6), /cannot be indexed/)
        } finally {
            input.dispose()
        }
    },
)
