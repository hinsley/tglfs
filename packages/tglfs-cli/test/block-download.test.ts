import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { downloadFileCard } from "../src/download.js"
import { uploadResumableFile } from "../src/shared/block-transfer.js"
import type { FileCardV5Data } from "../src/shared/protocol/file-card-v5.js"
import { gramBlockFixture } from "./helpers/block-fixture.js"

async function fixtureFile() {
    const { fixture, client } = await gramBlockFixture()
    const bytes = new Uint8Array(65536 * 3 + 1).fill(19)
    const record = await uploadResumableFile(fixture.client, {
        ...fixture.options,
        blockSize: 65536,
        source: {
            name: "file.bin",
            size: bytes.length,
            fingerprint: "test",
            archive: false,
            slice: (a, b) => new Blob([bytes.slice(a, b)]).stream(),
        },
        password: "p",
    })
    const data = record.data as FileCardV5Data
    const map = JSON.parse(new TextDecoder().decode(fixture.documents.get(data.chunks[0])))
    return { fixture, client, bytes, data, map }
}
test("CLI resumes a durable partial after network failure and preserves an existing output until success", async () => {
    const { fixture, client, bytes, data, map } = await fixtureFile()
    const directory = await mkdtemp(join(tmpdir(), "tglfs-download-"))
    const target = join(directory, "result.bin")
    try {
        await writeFile(target, "original destination")
        fixture.controls.failRead = map.messages[2]
        await assert.rejects(downloadFileCard(client as any, data, "p", target, true), /Network interrupted/)
        assert.equal(await readFile(target, "utf8"), "original destination")
        const part = `${target}.tglfs-${data.content.id}.part`
        assert.equal((await readFile(part)).length, 65536 * 2)
        assert.equal(JSON.parse(await readFile(`${part}.json`, "utf8")).completedBlocks, 2)
        fixture.controls.failRead = -1
        fixture.reads.length = 0
        await downloadFileCard(client as any, data, "p", target, true)
        assert.deepEqual(new Uint8Array(await readFile(target)), bytes)
        assert.equal(fixture.reads.includes(map.messages[0]), false)
        assert.equal(fixture.reads.includes(map.messages[1]), false)
        await assert.rejects(readFile(part), { code: "ENOENT" })
        await assert.rejects(readFile(`${part}.json`), { code: "ENOENT" })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
test("CLI refuses future checkpoints and changed local bytes without discarding partial data", async () => {
    const { fixture, client, data, map } = await fixtureFile()
    const directory = await mkdtemp(join(tmpdir(), "tglfs-checkpoint-"))
    const target = join(directory, "result.bin")
    try {
        fixture.controls.failRead = map.messages[1]
        await assert.rejects(downloadFileCard(client as any, data, "p", target))
        const part = `${target}.tglfs-${data.content.id}.part`
        const state = JSON.parse(await readFile(`${part}.json`, "utf8"))
        fixture.controls.failRead = -1
        await writeFile(`${part}.json`, JSON.stringify({ ...state, version: 2 }))
        await assert.rejects(downloadFileCard(client as any, data, "p", target), /unsupported checkpoint/)
        assert.equal((await readFile(part)).length, 65536)
        await writeFile(`${part}.json`, JSON.stringify(state))
        const original = await readFile(part)
        original[10] ^= 1
        await writeFile(part, original)
        await assert.rejects(downloadFileCard(client as any, data, "p", target), /changed or corrupted/)
        assert.deepEqual(await readFile(part), original)
        await assert.rejects(readFile(target), { code: "ENOENT" })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
test("CLI refuses active download locks and never replaces output without overwrite", async () => {
    const { client, data } = await fixtureFile()
    const directory = await mkdtemp(join(tmpdir(), "tglfs-lock-"))
    const target = join(directory, "result.bin")
    try {
        const part = `${target}.tglfs-${data.content.id}.part`
        const lock = `${part}.lock`
        await writeFile(lock, JSON.stringify({ type: "tglfs:download-lock", version: 1, pid: process.pid }))
        await assert.rejects(downloadFileCard(client as any, data, "p", target), /already running/)
        await rm(lock)
        await writeFile(lock, JSON.stringify({ type: "tglfs:download-lock", version: 2, pid: process.pid }))
        await assert.rejects(downloadFileCard(client as any, data, "p", target), /Unsupported download lock/)
        await rm(lock)
        await writeFile(target, "keep me")
        await assert.rejects(downloadFileCard(client as any, data, "p", target), { code: "EEXIST" })
        assert.equal(await readFile(target, "utf8"), "keep me")
        assert.equal((await readFile(part)).length, data.size)
        await downloadFileCard(client as any, data, "p", target, true)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
