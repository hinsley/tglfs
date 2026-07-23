import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import {
    getPreviewableMp4Name,
    isMp4FileName,
} from "../../../src/web/mp4PreviewableName.ts"

const testDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDir, "../../..")

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

test("Preview registers desktop and mobile MP4 conversion actions", async () => {
    const previewSource = await readFile(resolve(repositoryRoot, "src/web/preview.ts"), "utf8")
    const actionSource = await readFile(resolve(repositoryRoot, "src/web/mp4Previewable.ts"), "utf8")
    assert.match(previewSource, /import "\.\/mp4Previewable"/)
    assert.match(actionSource, /browserActionMakeMp4Previewable/)
    assert.match(actionSource, /actionMakeMp4PreviewableItem/)
})

test("MP4 conversion emits bounded fragmented MP4 and preserves the source", async () => {
    const remuxSource = await readFile(resolve(repositoryRoot, "src/web/videoRemux.ts"), "utf8")
    const actionSource = await readFile(resolve(repositoryRoot, "src/web/mp4Previewable.ts"), "utf8")
    const previewSource = await readFile(resolve(repositoryRoot, "src/web/preview.ts"), "utf8")
    const argsSource = await readFile(resolve(repositoryRoot, "src/web/videoTranscodeArgs.ts"), "utf8")

    assert.match(argsSource, /\+empty_moov\+default_base_moof\+frag_keyframe/)
    assert.match(argsSource, /"-frag_duration",\s*"2000000"/)
    assert.match(argsSource, /"libx264"/)
    assert.match(remuxSource, /markVideoPreviewReady/)
    assert.doesNotMatch(remuxSource, /\+faststart/)

    assert.match(actionSource, /downloadFileCardToTemporaryFile/)
    assert.match(actionSource, /Telegram\.fileUpload/)
    assert.doesNotMatch(actionSource, /deleteFileCard|DeleteMessages/)
    assert.match(previewSource, /LEGACY_FIXED_MP4_MIME/)
    assert.match(previewSource, /generic\n.*video\/mp4|generic MP4|generic.*video\/mp4/is)
})
