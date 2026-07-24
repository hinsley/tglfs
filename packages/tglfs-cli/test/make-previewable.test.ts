import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildPreviewableFfmpegPlan } from "../src/ffmpeg-plan.ts"
import {
    createMp4DurationPatchTransform,
    inspectMp4Prefix,
    patchMp4MovieDuration,
    probeMp4Stream,
} from "../src/mp4-preview.ts"

function u32(value: number) {
    return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}
function concat(...parts: Uint8Array[]) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) { result.set(part, offset); offset += part.length }
    return result
}
function box(type: string, payload = new Uint8Array()) {
    return concat(u32(payload.length + 8), new TextEncoder().encode(type), payload)
}
function mvhd(duration = 10_000, timescale = 1000) {
    return box("mvhd", concat(Uint8Array.of(0, 0, 0, 0), u32(0), u32(0), u32(timescale), u32(duration)))
}
function trak(handler: "vide" | "soun", sampleEntry: string) {
    const hdlr = box("hdlr", concat(Uint8Array.of(0, 0, 0, 0), u32(0), new TextEncoder().encode(handler)))
    const entry = handler === "vide"
        ? box(sampleEntry, concat(new Uint8Array(78), box("avcC", Uint8Array.of(1, 100, 0, 31))))
        : box(sampleEntry)
    const stsd = box("stsd", concat(Uint8Array.of(0, 0, 0, 0), u32(1), entry))
    return box("trak", box("mdia", concat(hdlr, box("minf", box("stbl", stsd)))))
}
function movie(video = "avc1", audio = "mp4a") {
    return box("moov", concat(mvhd(), trak("vide", video), trak("soun", audio), box("mvex")))
}
async function readAll(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
    }
    return concat(...chunks)
}

const ftyp = box("ftyp")
const mdat = box("mdat", Uint8Array.of(1, 2, 3, 4))

test("metadata placement and primary codecs are detected", () => {
    const front = inspectMp4Prefix(concat(ftyp, movie(), mdat))
    assert.equal(front.placement, "front-loaded")
    assert.equal(front.metadata?.durationSeconds, 10)
    assert.equal(front.metadata?.videoCodec, "avc1")
    assert.equal(front.metadata?.videoAvcProfile, 100)
    assert.equal(front.metadata?.audioCodec, "mp4a")

    assert.equal(inspectMp4Prefix(concat(ftyp, mdat, movie())).placement, "trailing")
    assert.equal(inspectMp4Prefix(concat(ftyp, movie().subarray(0, 20))).placement, "unknown")
})

test("probe replays every byte after inspecting the prefix", async () => {
    const bytes = concat(ftyp, movie(), mdat)
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes.subarray(0, 7))
            controller.enqueue(bytes.subarray(7, 31))
            controller.enqueue(bytes.subarray(31))
            controller.close()
        },
    })
    const result = await probeMp4Stream(source)
    assert.equal(result.placement, "front-loaded")
    assert.deepEqual(await readAll(result.stream), bytes)
})

test("duration patching works before media data is complete", async () => {
    const source = concat(ftyp, movie(), mdat)
    const patched = patchMp4MovieDuration(source, 123.456)
    assert.equal(inspectMp4Prefix(patched).metadata?.durationSeconds, 123.456)

    const transformed = await readAll(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(source.subarray(0, 13))
            controller.enqueue(source.subarray(13, source.length - 2))
            controller.enqueue(source.subarray(source.length - 2))
            controller.close()
        },
    }).pipeThrough(createMp4DurationPatchTransform(42.25)))
    assert.equal(inspectMp4Prefix(transformed).metadata?.durationSeconds, 42.25)
})

test("FFmpeg plan copies AVC/AAC and selectively transcodes incompatible tracks", () => {
    const copied = buildPreviewableFfmpegPlan("pipe:0", {
        durationSeconds: 10,
        hasVideo: true,
        hasAudio: true,
        videoCodec: "avc1",
        videoAvcProfile: 100,
        audioCodec: "mp4a",
    })
    assert.equal(copied.videoMode, "copy")
    assert.equal(copied.audioMode, "copy")
    assert.ok(copied.args.includes("+empty_moov+default_base_moof+frag_keyframe"))

    const transcoded = buildPreviewableFfmpegPlan("input.mp4", {
        durationSeconds: 10,
        hasVideo: true,
        hasAudio: true,
        videoCodec: "hvc1",
        videoAvcProfile: null,
        audioCodec: "ac-3",
    })
    assert.equal(transcoded.videoMode, "transcode")
    assert.equal(transcoded.audioMode, "transcode")
    assert.ok(transcoded.args.includes("libx264"))
    assert.ok(transcoded.args.includes("aac"))
})

test("CLI package routes make-previewable through the existing published entrypoint", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
    const router = await readFile(resolve(root, "src/direct-command-router.ts"), "utf8")
    const hooks = await readFile(resolve(root, "src/test-hooks.ts"), "utf8")
    const command = await readFile(resolve(root, "src/make-previewable-cli.ts"), "utf8")
    const conversion = await readFile(resolve(root, "src/make-previewable.ts"), "utf8")
    const upload = await readFile(resolve(root, "src/generated-upload.ts"), "utf8")
    const man = await readFile(resolve(root, "man/tglfs-make-previewable.1"), "utf8")

    assert.equal(pkg.bin.tglfs, "dist/cli.js")
    assert.ok(pkg.man.includes("./man/tglfs-make-previewable.1"))
    assert.match(hooks, /direct-command-router/)
    assert.match(router, /args\.indexOf\("make-previewable"\)/)
    assert.match(command, /TGLFS_MAKE_PREVIEWABLE_SOURCE_PASSWORD/)
    assert.match(conversion, /probeMp4Stream/)
    assert.match(conversion, /stageSource/)
    assert.match(conversion, /uploadGeneratedCurrentFormatStream/)
    assert.match(upload, /UfidAccumulator/)
    assert.match(upload, /uploadComplete:\s*true/)
    assert.match(man, /moov/)
})
