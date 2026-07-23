import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import {
    parseFfmpegDurationSeconds,
    readMp4MovieDurationSeconds,
    writeMp4MovieDuration,
} from "../../../src/web/mp4Fragment.ts"
import {
    getBufferedAheadSeconds,
    getMp4BufferLimits,
    getMp4EvictionRange,
    MP4_BUFFER_AHEAD_HIGH_WATER_SECONDS,
} from "../../../src/web/mp4BufferPolicy.ts"
import {
    getPreviewableMp4Name,
    isMp4FileName,
} from "../../../src/web/mp4PreviewableName.ts"

const testDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDir, "../../..")

function uint32(value: number) {
    return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function concat(...arrays: Uint8Array[]) {
    const output = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0))
    let offset = 0
    for (const array of arrays) {
        output.set(array, offset)
        offset += array.length
    }
    return output
}

function box(type: string, payload = new Uint8Array()) {
    return concat(uint32(payload.length + 8), new TextEncoder().encode(type), payload)
}

function minimalFragmentedMp4() {
    const mvhd = box("mvhd", concat(
        Uint8Array.of(0, 0, 0, 0),
        uint32(0),
        uint32(0),
        uint32(1000),
        uint32(0),
    ))
    return concat(
        box("ftyp"),
        box("moov", concat(mvhd, box("mvex"))),
        box("moof"),
        box("mdat", Uint8Array.of(1)),
    )
}

function ranges(...values: Array<[number, number]>) {
    return {
        length: values.length,
        start(index: number) { return values[index][0] },
        end(index: number) { return values[index][1] },
    }
}

test("MP4 preview conversion action only accepts the final MP4 extension", () => {
    assert.equal(isMp4FileName("movie.mp4"), true)
    assert.equal(isMp4FileName("movie.MP4"), true)
    assert.equal(isMp4FileName("movie.mp4.txt"), false)
    assert.equal(isMp4FileName("movie.m4v"), false)
})

test("MP4 preview conversion generates a distinct copy name", () => {
    assert.equal(getPreviewableMp4Name("movie.mp4"), "movie.previewable.mp4")
    assert.equal(getPreviewableMp4Name("movie.previewable.mp4"), "movie.previewable-2.mp4")
    assert.equal(getPreviewableMp4Name("movie.previewable-2.mp4"), "movie.previewable-3.mp4")
    assert.throws(() => getPreviewableMp4Name("movie.webm"), /Not an MP4/)
})

test("FFmpeg duration parsing and mvhd patching produce a finite movie duration", () => {
    assert.equal(parseFfmpegDurationSeconds("Duration: 01:02:03.456, start: 0.000000"), 3723.456)
    assert.equal(parseFfmpegDurationSeconds("Duration: N/A"), null)

    const patched = writeMp4MovieDuration(minimalFragmentedMp4(), 123.456)
    assert.equal(readMp4MovieDurationSeconds(patched), 123.456)
})

test("MP4 buffer policy limits forward buffering and finds safe old ranges to evict", () => {
    const buffered = ranges([0, 8], [10, 42])
    assert.equal(getBufferedAheadSeconds(buffered, 12), 30)
    assert.ok(getBufferedAheadSeconds(buffered, 12) >= MP4_BUFFER_AHEAD_HIGH_WATER_SECONDS)
    assert.deepEqual(getMp4BufferLimits(120 * 1024 * 1024, 12), { highWaterSeconds: 4.8, lowWaterSeconds: 2.4 })
    assert.deepEqual(getMp4EvictionRange(ranges([0, 80]), 65, 30, 5), { start: 0, end: 35 })
    assert.equal(getMp4EvictionRange(ranges([0, 20]), 20, 30, 5), null)
})

test("Preview registers desktop and mobile MP4 conversion actions", async () => {
    const previewSource = await readFile(resolve(repositoryRoot, "src/web/preview.ts"), "utf8")
    const actionSource = await readFile(resolve(repositoryRoot, "src/web/mp4Previewable.ts"), "utf8")
    assert.match(previewSource, /import "\.\/mp4Previewable"/)
    assert.match(actionSource, /browserActionMakeMp4Previewable/)
    assert.match(actionSource, /actionMakeMp4PreviewableItem/)
})

test("MP4 conversion writes duration metadata and Preview applies bounded MSE backpressure", async () => {
    const remuxSource = await readFile(resolve(repositoryRoot, "src/web/videoRemux.ts"), "utf8")
    const actionSource = await readFile(resolve(repositoryRoot, "src/web/mp4Previewable.ts"), "utf8")
    const previewSource = await readFile(resolve(repositoryRoot, "src/web/preview.ts"), "utf8")
    const fragmentSource = await readFile(resolve(repositoryRoot, "src/web/mp4Fragment.ts"), "utf8")
    const argsSource = await readFile(resolve(repositoryRoot, "src/web/videoTranscodeArgs.ts"), "utf8")

    assert.match(argsSource, /\+empty_moov\+default_base_moof\+frag_keyframe/)
    assert.match(argsSource, /"-frag_duration",\s*"2000000"/)
    assert.match(argsSource, /"libx264"/)
    assert.match(remuxSource, /markVideoPreviewReady/)
    assert.match(remuxSource, /writeMp4MovieDuration/)
    assert.match(remuxSource, /parseFfmpegDurationSeconds/)
    assert.doesNotMatch(remuxSource, /\+faststart/)

    assert.match(actionSource, /downloadFileCardToTemporaryFile/)
    assert.match(actionSource, /Telegram\.fileUpload/)
    assert.doesNotMatch(actionSource, /deleteFileCard|DeleteMessages/)
    assert.match(previewSource, /LEGACY_FIXED_MP4_MIME/)
    assert.match(previewSource, /QuotaExceededError/)
    assert.match(previewSource, /waitForMp4BufferCapacity/)
    assert.match(previewSource, /sourceBuffer\.mode = "segments"/)
    assert.match(fragmentSource, /Number\.isFinite\(video\.duration\)/)
})
