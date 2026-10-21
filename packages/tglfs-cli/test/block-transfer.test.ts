import assert from "node:assert/strict"
import test from "node:test"
import { openBlockFile, uploadResumableFile } from "../src/shared/block-transfer.js"
import { asArchiveReader, base64, collect, hashBytes, jsonBytes, parseJson } from "../src/shared/block-format.js"
import { resumeBlockDownload } from "../src/shared/block-download.js"
import { createTarStream, computeTarSize } from "../src/shared/archive.js"
import { parseFileCardMessage, serializeFileCardMessage } from "../src/shared/file-cards.js"
import { deleteFileCardMessages, transferFileCard } from "../src/shared/telegram-files.js"
import { blockFixture, FakeApi } from "./helpers/block-fixture.js"
import type { FileCardV5Data } from "../src/shared/protocol/file-card-v5.js"

const blockSize = 65536
function source(bytes: Uint8Array, reads: number[] = [], fingerprint = "source-fixture", archive = false) {
    return {
        name: archive ? "private.tar" : "source.bin",
        size: bytes.length,
        fingerprint,
        archive,
        slice(start: number, end: number) {
            reads.push(start)
            return new Blob([bytes.slice(start, end)]).stream()
        },
    }
}
async function uploaded(password = "", size = blockSize * 3 + 91) {
    const fixture = blockFixture()
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + (i >> 7)) % 256)
    const record = await uploadResumableFile(fixture.client, {
        ...fixture.options,
        source: source(bytes),
        password,
        blockSize,
    })
    assert.equal(record.data.version, 5)
    return { fixture, bytes, record, data: record.data as FileCardV5Data }
}
for (const password of ["", "secret password"]) {
    test(`v5 roundtrips and authenticated random access (${password ? "protected" : "empty password"})`, async () => {
        const { fixture, bytes, data } = await uploaded(password)
        const reader = await openBlockFile(fixture.client, { ...fixture.options, data, password })
        fixture.reads.length = 0
        assert.deepEqual(
            await reader.readRange(blockSize * 2 + 8, 30),
            bytes.slice(blockSize * 2 + 8, blockSize * 2 + 38),
        )
        const map = parseJson(fixture.documents.get(data.chunks[0])!)
        assert.deepEqual([...new Set(fixture.reads)], [map.messages[2]])
        assert.deepEqual(await collect(reader.stream(), bytes.length), bytes)
        await assert.rejects(
            openBlockFile(fixture.client, { ...fixture.options, data, password: `${password}wrong` }),
            /password|corrupt/,
        )
        fixture.documents.get(map.messages[0])![0] ^= 1
        const fresh = await openBlockFile(fixture.client, { ...fixture.options, data, password })
        await assert.rejects(fresh.readBlock(0), /password|corrupt/)
    })
}
test("interrupted upload resumes without reading completed source blocks", async () => {
    const fixture = blockFixture()
    const bytes = new Uint8Array(blockSize * 4 + 1).fill(42)
    const reads: number[] = []
    fixture.controls.failBlock = 2
    await assert.rejects(
        uploadResumableFile(fixture.client, {
            ...fixture.options,
            source: source(bytes, reads),
            password: "p",
            blockSize,
        }),
        /Transfer ID/,
    )
    assert.equal(fixture.blockSends, 2)
    reads.length = 0
    fixture.controls.failBlock = -1
    const record = await uploadResumableFile(fixture.client, {
        ...fixture.options,
        source: source(bytes, reads),
        password: "p",
        blockSize,
    })
    assert.deepEqual(reads, [blockSize * 2, blockSize * 3, blockSize * 4])
    assert.equal(fixture.blockSends, 5)
    assert.deepEqual(
        await collect(
            (
                await openBlockFile(fixture.client, {
                    ...fixture.options,
                    data: record.data as FileCardV5Data,
                    password: "p",
                })
            ).stream(),
            bytes.length,
        ),
        bytes,
    )
    assert.equal(fixture.deletes.length, 0)
})
test("lost block and publication acknowledgements are recovered without duplicate blocks", async () => {
    const fixture = blockFixture()
    const bytes = new Uint8Array(blockSize * 2 + 1).fill(9)
    fixture.controls.lostBlockAck = 1
    await assert.rejects(
        uploadResumableFile(fixture.client, { ...fixture.options, source: source(bytes), password: "", blockSize }),
        /acknowledgement/,
    )
    fixture.controls.lostBlockAck = -1
    fixture.controls.lostPublication = true
    await assert.rejects(
        uploadResumableFile(fixture.client, { ...fixture.options, source: source(bytes), password: "", blockSize }),
        /publication/,
    )
    fixture.controls.lostPublication = false
    const reads: number[] = []
    const record = await uploadResumableFile(fixture.client, {
        ...fixture.options,
        source: source(bytes, reads),
        password: "",
        blockSize,
    })
    assert.equal(record.data.version, 5)
    assert.equal(fixture.blockSends, 3)
    assert.deepEqual(reads, [])
})
test("resume refuses a changed unfinished block and an explicit wrong password", async () => {
    const fixture = blockFixture()
    const bytes = new Uint8Array(blockSize * 2).fill(8)
    fixture.controls.failBlock = 1
    await assert.rejects(
        uploadResumableFile(fixture.client, { ...fixture.options, source: source(bytes), password: "p", blockSize }),
    )
    const session = JSON.parse(fixture.messages[0].message)
    const resumeId = session.content.id
    fixture.controls.failBlock = -1
    bytes[blockSize] = 9
    await assert.rejects(
        uploadResumableFile(fixture.client, { ...fixture.options, source: source(bytes), password: "p", resumeId }),
        /source changed/,
    )
    await assert.rejects(
        uploadResumableFile(fixture.client, { ...fixture.options, source: source(bytes), password: "wrong", resumeId }),
        /password|corrupt/,
    )
    assert.equal(fixture.blockSends, 1)
})
test("v5 empty file has an explicit UFID and no data blocks", async () => {
    const { fixture, data } = await uploaded("", 0)
    assert.equal(data.ufid, await hashBytes(new Uint8Array()))
    const reader = await openBlockFile(fixture.client, { ...fixture.options, data, password: "" })
    assert.deepEqual(await collect(reader.stream(), 0), new Uint8Array())
})
test("ranged tar source skips completed members, retains long names and encrypted directory", async () => {
    const reads: number[] = []
    const entries = [0, 1, 2].map((i) => ({
        name: `${i}-` + "long".repeat(30),
        size: blockSize,
        lastModified: 1000,
        stream: () => new Blob([new Uint8Array(blockSize).fill(i)]).stream(),
        range(start: number, end: number) {
            reads.push(i)
            return new Blob([new Uint8Array(end - start).fill(i)]).stream()
        },
    }))
    const full = await collect(createTarStream(entries), computeTarSize(entries))
    reads.length = 0
    const offset = full.length - blockSize
    assert.deepEqual(await collect(createTarStream(entries, offset, full.length), full.length), full.slice(offset))
    assert.deepEqual(reads, [2])
    const fixture = blockFixture()
    const record = await uploadResumableFile(fixture.client, {
        ...fixture.options,
        source: source(full, [], "tar", true),
        password: "private",
        blockSize,
    })
    for (const document of fixture.documents.values())
        assert.equal(new TextDecoder().decode(document).includes(entries[0].name), false)
    const reader = asArchiveReader(
        await openBlockFile(fixture.client, {
            ...fixture.options,
            data: record.data as FileCardV5Data,
            password: "private",
        }),
    )
    assert.equal(reader.index.entries.length, 3)
    assert.deepEqual(
        await collect(reader.entryStream(reader.index.entries[2].id), blockSize),
        new Uint8Array(blockSize).fill(2),
    )
})
function memoryDestination() {
    let bytes = new Uint8Array()
    let saved: any = null
    let checkpoints = 0
    let failAfter = -1
    return {
        get bytes() {
            return bytes
        },
        get state() {
            return saved
        },
        set state(value: any) {
            saved = value
        },
        failAt(n: number) {
            failAfter = n
        },
        async load() {
            return saved
        },
        async size() {
            return bytes.length
        },
        async read(offset: number, length: number) {
            return bytes.slice(offset, offset + length)
        },
        async write(offset: number, chunk: Uint8Array) {
            if (checkpoints === failAfter) throw new Error("Disk interrupted")
            const next = new Uint8Array(Math.max(bytes.length, offset + chunk.length))
            next.set(bytes)
            next.set(chunk, offset)
            bytes = next
        },
        async checkpoint(state: any, size: number) {
            bytes = bytes.slice(0, size)
            saved = structuredClone(state)
            checkpoints++
        },
    }
}
test("download resumes with local prefix verification and no repeated network blocks", async () => {
    const { fixture, bytes, data } = await uploaded("p")
    const reader = await openBlockFile(fixture.client, { ...fixture.options, data, password: "p" })
    const destination = memoryDestination()
    destination.failAt(3)
    await assert.rejects(resumeBlockDownload(reader, destination), /Disk interrupted/)
    assert.equal(destination.state.completedBlocks, 2)
    fixture.reads.length = 0
    destination.failAt(-1)
    const restarted = await openBlockFile(fixture.client, { ...fixture.options, data, password: "p" })
    fixture.reads.length = 0
    await resumeBlockDownload(restarted, destination)
    assert.deepEqual(destination.bytes, bytes)
    const map = parseJson(fixture.documents.get(data.chunks[0])!)
    assert.equal(fixture.reads.includes(map.messages[0]), false)
    assert.equal(fixture.reads.includes(map.messages[1]), false)
})
test("download refuses corrupted prefix, future state, mismatched identity, and unowned data", async () => {
    const { fixture, data } = await uploaded()
    const reader = await openBlockFile(fixture.client, { ...fixture.options, data, password: "" })
    const destination = memoryDestination()
    destination.failAt(2)
    await assert.rejects(resumeBlockDownload(reader, destination))
    destination.bytes[0] ^= 1
    const readCount = fixture.reads.length
    await assert.rejects(resumeBlockDownload(reader, destination), /changed or corrupted/)
    assert.equal(fixture.reads.length, readCount)
    destination.state = { ...destination.state, version: 2 }
    await assert.rejects(resumeBlockDownload(reader, destination), /unsupported/)
    destination.state = { ...destination.state, version: 1, contentId: "another" }
    await assert.rejects(resumeBlockDownload(reader, destination), /different file/)
    destination.state = null
    await assert.rejects(resumeBlockDownload(reader, destination), /no matching/)
})
test("v5 parser preserves unknown fields and refuses future or malformed durable metadata", async () => {
    const { fixture, data } = await uploaded()
    const extra = { ...data, futureOptional: { hello: 1 } }
    assert.deepEqual(
        (parseFileCardMessage(serializeFileCardMessage(extra)) as any).futureOptional,
        extra.futureOptional,
    )
    for (const change of [
        { version: 6 },
        { content: { ...data.content, version: 2 } },
        { chunks: [2, 3] },
        { IV: "wrong" },
        { content: { ...data.content, salt: "bad" } },
        { uploadComplete: false },
    ])
        assert.equal(parseFileCardMessage(`tglfs:file\n${JSON.stringify({ ...data, ...change })}`), null)
    const map = parseJson(fixture.documents.get(data.chunks[0])!)
    map.version = 2
    fixture.documents.set(data.chunks[0], jsonBytes(map))
    fixture.messages.find((m) => m.id === data.chunks[0]).media.document.size = jsonBytes(map).length
    await assert.rejects(
        openBlockFile(fixture.client, { ...fixture.options, data, password: "" }),
        /Unsupported|malformed/,
    )
})
test("forwarding remaps public block references without a password and deleting reaches every block", async () => {
    const { fixture, data, record, bytes } = await uploaded("secret")
    const originalDocs = [...fixture.documents.keys()]
    const forwarded = await transferFileCard(fixture.client, {
        Api: FakeApi as any,
        record,
        targetPeer: "friend",
        batchDelayMs: 0,
    })
    const reader = await openBlockFile(fixture.client, {
        ...fixture.options,
        peer: "friend",
        data: forwarded.data as FileCardV5Data,
        password: "secret",
    })
    assert.deepEqual(await collect(reader.stream(), bytes.length), bytes)
    await deleteFileCardMessages(fixture.client, {
        Api: FakeApi as any,
        data: forwarded.data,
        msgId: forwarded.msgId,
        peer: "friend",
    })
    for (const id of originalDocs) assert.equal(fixture.documents.has(id), true)
    const originalReader = await openBlockFile(fixture.client, { ...fixture.options, data, password: "secret" })
    assert.deepEqual(await originalReader.readBlock(0), bytes.slice(0, blockSize))
})

test("future session, checkpoint, receipt, and encrypted plan versions refuse resume", async () => {
    const { blockKey, unseal, seal } = await import("../src/shared/block-format.js")
    const fixture = blockFixture()
    const bytes = new Uint8Array(blockSize * 2).fill(7)
    fixture.controls.failBlock = 1
    await assert.rejects(
        uploadResumableFile(fixture.client, { ...fixture.options, source: source(bytes), password: "p", blockSize }),
    )
    const sessionMessage = fixture.messages.find((m) => JSON.parse(m.message).type === "tglfs:upload-session")
    const session = JSON.parse(sessionMessage.message)
    const resumeId = session.content.id
    const options = { ...fixture.options, source: source(bytes), password: "p", resumeId }
    fixture.controls.failBlock = -1
    sessionMessage.message = JSON.stringify({ ...session, version: 2 })
    await assert.rejects(uploadResumableFile(fixture.client, options), /Unsupported upload-session/)
    sessionMessage.message = JSON.stringify(session)
    const blockMessage = fixture.messages.find((m) => JSON.parse(m.message).type === "tglfs:upload-block")
    const cp = JSON.parse(blockMessage.message)
    blockMessage.message = JSON.stringify({ ...cp, version: 2 })
    await assert.rejects(uploadResumableFile(fixture.client, options), /Unsupported or malformed upload checkpoint/)
    const key = await blockKey("p", session.content)
    const receipt = parseJson(await unseal(cp.payload, key, session.content, "receipt:0"))
    blockMessage.message = JSON.stringify({
        ...cp,
        payload: await seal(jsonBytes({ ...receipt, version: 2 }), key, session.content, "receipt:0"),
    })
    await assert.rejects(uploadResumableFile(fixture.client, options), /checkpoint does not match/)
    blockMessage.message = JSON.stringify(cp)
    const original = fixture.documents.get(sessionMessage.id)!
    const plan = parseJson(await unseal(parseJson(original), key, session.content, "plan"))
    const future = jsonBytes(await seal(jsonBytes({ ...plan, version: 2 }), key, session.content, "plan"))
    fixture.documents.set(sessionMessage.id, future)
    sessionMessage.media.document.size = future.length
    await assert.rejects(uploadResumableFile(fixture.client, options), /Unsupported or malformed upload plan/)
    assert.equal(fixture.blockSends, 1)
})
test("future encrypted manifest and tar directory versions fail closed", async () => {
    const { blockKey, unseal, seal, validatePlan } = await import("../src/shared/block-format.js")
    const { fixture, data } = await uploaded("p")
    const key = await blockKey("p", data.content)
    const map = parseJson(fixture.documents.get(data.chunks[0])!)
    const manifest = parseJson(await unseal(map.payload, key, data.content, "manifest"))
    map.payload = await seal(jsonBytes({ ...manifest, version: 2 }), key, data.content, "manifest")
    const future = jsonBytes(map)
    fixture.documents.set(data.chunks[0], future)
    fixture.messages.find((m) => m.id === data.chunks[0]).media.document.size = future.length
    await assert.rejects(
        openBlockFile(fixture.client, { ...fixture.options, data, password: "p" }),
        /Unsupported block-manifest/,
    )
    assert.throws(
        () =>
            validatePlan(
                { ...manifest.plan, directory: { type: "tglfs:tar-directory", version: 2, entries: [] } },
                { ...data.content, archive: true },
            ),
        /Unsupported archive directory/,
    )
})
test("concurrent range requests reuse one bounded decrypted block cache", async () => {
    const { fixture, data, bytes } = await uploaded()
    const reader = await openBlockFile(fixture.client, { ...fixture.options, data, password: "" })
    fixture.reads.length = 0
    const ranges = await Promise.all([reader.readRange(1, 30), reader.readRange(100, 80), reader.readRange(90, 60)])
    assert.deepEqual(ranges, [bytes.slice(1, 31), bytes.slice(100, 180), bytes.slice(90, 150)])
    assert.equal(fixture.reads.length, 1)
})

test("content descriptor property order and preserved optional fields do not change authentication", async () => {
    const { fixture, data, bytes } = await uploaded("p")
    const c = data.content
    const reordered = {
        archive: c.archive,
        blockSize: c.blockSize,
        salt: c.salt,
        id: c.id,
        version: c.version,
        type: c.type,
        optionalFutureField: { preserved: true },
    }
    const reader = await openBlockFile(fixture.client, {
        ...fixture.options,
        data: { ...data, content: reordered },
        password: "p",
    })
    assert.deepEqual(await collect(reader.stream(), bytes.length), bytes)
})
