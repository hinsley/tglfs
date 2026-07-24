import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import {
    inspectMp4MetadataPlacement,
    probeMp4MetadataPlacement,
} from "../../../src/web/mp4MetadataPlacement.ts"

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

test("MP4 metadata placement distinguishes streamable and trailing-moov layouts", () => {
    const ftyp = box("ftyp")
    const moov = box("moov", box("mvhd"))
    const mdat = box("mdat", Uint8Array.of(1, 2, 3))

    assert.equal(inspectMp4MetadataPlacement(concat(ftyp, moov, mdat)), "front-loaded")
    assert.equal(inspectMp4MetadataPlacement(concat(ftyp, mdat, moov)), "trailing")
    assert.equal(inspectMp4MetadataPlacement(concat(ftyp, moov.subarray(0, 6))), "unknown")
})

test("metadata probing replays every inspected byte into the selected conversion path", async () => {
    const bytes = concat(box("ftyp"), box("moov"), box("mdat", Uint8Array.of(7, 8, 9)))
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes.subarray(0, 7))
            controller.enqueue(bytes.subarray(7, 19))
            controller.enqueue(bytes.subarray(19))
            controller.close()
        },
    })

    const result = await probeMp4MetadataPlacement(source)
    assert.equal(result.placement, "front-loaded")
    assert.deepEqual(await readAll(result.stream), bytes)
})

test("front-loaded MP4 conversion is append-only while trailing metadata retains OPFS fallback", async () => {
    const actionSource = await readFile(resolve(repositoryRoot, "src/web/mp4Previewable.ts"), "utf8")
    const downloadSource = await readFile(resolve(repositoryRoot, "src/web/tglfsDownloadSource.ts"), "utf8")
    const conversionSource = await readFile(resolve(repositoryRoot, "src/web/streamingMp4Conversion.ts"), "utf8")
    const uploadSource = await readFile(resolve(repositoryRoot, "src/web/generatedUpload.ts"), "utf8")

    assert.match(actionSource, /probeMp4MetadataPlacement/)
    assert.match(actionSource, /placement === "front-loaded"/)
    assert.match(actionSource, /runStreamingPath/)
    assert.match(actionSource, /runStagedPath/)
    assert.match(actionSource, /allowMemoryFallback: false/)
    assert.doesNotMatch(actionSource, /downloadFileCardToTemporaryFile/)

    assert.match(downloadSource, /createFileCardPlaintextStream/)
    assert.match(downloadSource, /stagePlaintextStreamToTemporaryFile/)
    assert.match(conversionSource, /ReadableStreamSource/)
    assert.match(conversionSource, /AppendOnlyStreamTarget/)
    assert.match(conversionSource, /fastStart: "fragmented"/)
    assert.match(conversionSource, /minimumFragmentDuration: 2/)

    assert.match(uploadSource, /UfidAccumulator/)
    assert.match(uploadSource, /CompressionStream\("gzip"\)/)
    assert.match(uploadSource, /lookupFileCardByUfid/)
    assert.match(uploadSource, /uploadComplete: true/)
    assert.match(uploadSource, /pending-\$\{uploadToken\}/)
})
