import assert from "node:assert/strict"
import test from "node:test"

import { deriveAESKeyFromPassword, ENCRYPTION_CHUNK_SIZE, incrementCounter, incrementCounter64By } from "../src/crypto.js"
import { computeUfidFromBytes } from "../src/ufid.js"
import { createTarStream, computeTarSize } from "../src/shared/archive.js"
import {
    createTelegramArchiveRangeReader,
    getArchiveUpgradeCapability,
    openRemoteArchive,
    upgradeArchive,
    uploadIndexedArchive,
} from "../src/shared/archive-transfer.js"
import { DOWNLOAD_PART_SIZE, UPLOAD_PART_SIZE } from "../src/shared/constants.js"
import { parseFileCardMessage } from "../src/shared/file-cards.js"
import type { FileCardData, FileCardRecord } from "../src/shared/file-cards.js"

const FakeApi = {
    upload: {
        GetFile: class GetFile { constructor(readonly args: any) {} },
        SaveBigFilePart: class SaveBigFilePart { constructor(readonly args: any) {} },
    },
    messages: {
        DeleteMessages: class DeleteMessages { constructor(readonly args: any) {} },
    },
    InputFileBig: class InputFileBig { constructor(readonly args: any) {} },
}

async function collect(stream: ReadableStream<Uint8Array>) {
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function tarBytes(files: { name: string; bytes: Uint8Array }[]) {
    const entries = files.map((file) => ({ name: file.name, size: file.bytes.length, lastModified: 1700000000000, stream: () => new Blob([file.bytes]).stream() }))
    const result = await collect(createTarStream(entries))
    assert.equal(result.length, computeTarSize(entries))
    return result
}

function telegramFixture() {
    const documents = new Map<number, Uint8Array>()
    const uploads = new Map<string, Uint8Array[]>()
    const cards: { id: number; message: string }[] = []
    const reads: { id: number; offset: number; limit: number }[] = []
    const lookups: number[][] = []
    const deleted: number[] = []
    let nextId = 100
    let corruptNewReads = false
    let throwPublication = false
    let onSendFile: (() => void) | undefined
    const client = {
        async getMessages(_peer: string, options: { ids: number[] }) {
            lookups.push([...options.ids])
            return [...options.ids].reverse().map((id) => documents.has(id) ? { id, media: { document: { id, size: documents.get(id)!.length } } } : undefined).filter(Boolean)
        },
        async invoke(request: any) {
            if (request instanceof FakeApi.upload.SaveBigFilePart) {
                const id = String(request.args.fileId)
                const parts = uploads.get(id) ?? []
                parts[request.args.filePart] = Uint8Array.from(request.args.bytes)
                uploads.set(id, parts)
                return true
            }
            if (request instanceof FakeApi.upload.GetFile) {
                const { location, offset, limit } = request.args
                reads.push({ id: location.id, offset, limit })
                assert.equal(offset % DOWNLOAD_PART_SIZE, 0)
                assert.equal(limit, DOWNLOAD_PART_SIZE)
                const bytes = documents.get(location.id)!.slice(offset, offset + limit)
                if (corruptNewReads && location.id >= 100 && offset === 0 && bytes.length > 0) bytes[0] ^= 1
                return { bytes }
            }
            if (request instanceof FakeApi.messages.DeleteMessages) {
                deleted.push(...request.args.id)
                for (const id of request.args.id) documents.delete(id)
                return true
            }
            throw new Error("Unexpected Telegram request")
        },
        async sendFile(_peer: string, options: { file: any }) {
            const parts = uploads.get(String(options.file.args.id))!
            const data = new Uint8Array(parts.reduce((total, bytes) => total + bytes.length, 0))
            let offset = 0
            for (const part of parts) { data.set(part, offset); offset += part.length }
            const id = nextId++
            documents.set(id, data)
            onSendFile?.()
            return { id }
        },
        async sendMessage(_peer: string, options: { message: string }) {
            const id = nextId++
            cards.push({ id, message: options.message })
            if (throwPublication) throw new Error("Publication response lost")
            return { id, date: 1700000000 }
        },
    }
    return {
        client, documents, cards, reads, lookups, deleted,
        options: { Api: FakeApi, getFileInfo: (media: any) => ({ location: { id: media.document.id } }), chunkSize: UPLOAD_PART_SIZE },
        corruptReads() { corruptNewReads = true },
        losePublicationResponse() { throwPublication = true },
        onSendFile(callback: () => void) { onSendFile = callback },
    }
}

async function originalArchive(fixture: ReturnType<typeof telegramFixture>, bytes: Uint8Array, password: string, version: 1 | 2 | 3 = 3, mode: "current" | "legacy" = "current", splitAt?: number): Promise<FileCardRecord> {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    let counter = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const key = await deriveAESKeyFromPassword(password, salt)
    const compressed = await collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")))
    const header = new Uint8Array(32)
    header.set(salt); header.set(counter, 16)
    const encrypted = new Uint8Array(compressed.length)
    for (let offset = 0; offset < compressed.length; offset += ENCRYPTION_CHUNK_SIZE) {
        const part = compressed.subarray(offset, offset + ENCRYPTION_CHUNK_SIZE)
        encrypted.set(new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, part)), offset)
        counter = mode === "legacy" ? incrementCounter(counter) : incrementCounter64By(counter, Math.ceil(part.length / 16))
    }
    fixture.documents.set(11, splitAt ? encrypted.slice(0, splitAt) : encrypted)
    if (splitAt) fixture.documents.set(12, encrypted.slice(splitAt))
    return { msgId: 7, date: 1700000000, data: {
        type: "tglfs:file", version, name: "original.tar", ufid: await computeUfidFromBytes(bytes), size: bytes.length,
        uploadComplete: true, chunks: splitAt ? [11, 12] : [11], IV: Buffer.from(header).toString("base64"),
        ...(version === 3 ? { parentFolderId: "folder-123" } : {}),
    } as FileCardData }
}

for (const password of ["", "archive password"]) {
    test(`indexed archive upload verifies remote bytes before publishing with ${password ? "a password" : "an empty password"}`, async () => {
        const fixture = telegramFixture()
        const payload = new TextEncoder().encode("Private member contents")
        const bytes = await tarBytes([{ name: "private.txt", bytes: payload }])
        const phases: string[] = []
        const result = await uploadIndexedArchive(fixture.client, {
            ...fixture.options, password, source: { name: "fixture.tar", size: bytes.length, stream: () => new Blob([bytes]).stream() },
            onProgress(progress) { phases.push(progress.phase) },
        })
        assert.equal(result.data.version, 4)
        assert.equal(result.data.ufid, await computeUfidFromBytes(bytes))
        assert.equal(fixture.cards.length, 1)
        assert.ok(fixture.reads.length > 0)
        assert.deepEqual(parseFileCardMessage(fixture.cards[0].message), result.data)
        assert.ok(phases.includes("verifying"))
        const reader = await openRemoteArchive(fixture.client, { ...fixture.options, record: result, password })
        assert.deepEqual(await collect(reader.stream()), bytes)
        assert.deepEqual(await collect(reader.entryStream(reader.index.entries[0].id)), payload)
        assert.equal(fixture.deleted.length, 0)
        if (password) await assert.rejects(() => openRemoteArchive(fixture.client, { ...fixture.options, record: result, password: "wrong" }), /password|damaged/)
        await assert.rejects(() => openRemoteArchive(fixture.client, { ...fixture.options, record: { ...result, data: { ...result.data, ufid: "0".repeat(64) } }, password }), /does not match/)
    })
}

test("upgrade preserves each supported old file card and its encrypted source document", async () => {
    for (const version of [1, 2, 3] as const) {
        const fixture = telegramFixture()
        const bytes = await tarBytes([{ name: "a.txt", bytes: new TextEncoder().encode("Keep the original") }])
        const source = await originalArchive(fixture, bytes, "secret", version)
        const originalData = structuredClone(source)
        const originalBytes = fixture.documents.get(11)!.slice()
        const result = await upgradeArchive(fixture.client, { ...fixture.options, source, password: "secret" })
        assert.equal(result.data.version, 4)
        assert.equal(result.data.ufid, source.data.ufid)
        assert.deepEqual(source, originalData)
        assert.deepEqual(fixture.documents.get(11), originalBytes)
        assert.deepEqual(fixture.deleted, [])
        assert.equal("upgradedFrom" in result.data && result.data.upgradedFrom?.messageId, source.msgId)
        assert.equal("upgradedFrom" in result.data && result.data.upgradedFrom?.fileVersion, version)
        assert.equal("parentFolderId" in result.data && result.data.parentFolderId, version === 3 ? "folder-123" : "tglfs-root")
    }
})

test("wrong source password and source UFID mismatch never publish a replacement", async () => {
    const fixture = telegramFixture()
    const bytes = await tarBytes([{ name: "a.txt", bytes: new TextEncoder().encode("Keep me") }])
    const source = await originalArchive(fixture, bytes, "secret")
    await assert.rejects(() => upgradeArchive(fixture.client, { ...fixture.options, source, password: "wrong" }))
    assert.equal(fixture.cards.length, 0)
    await assert.rejects(() => upgradeArchive(fixture.client, { ...fixture.options, source: { ...source, data: { ...source.data, ufid: "0".repeat(64) } }, password: "secret" }), /UFID/)
    assert.equal(fixture.cards.length, 0)
    assert.ok(fixture.documents.has(11))
    assert.ok(!fixture.deleted.includes(11))
})

test("failed remote verification cleans only newly created upload chunks", async () => {
    const fixture = telegramFixture()
    const bytes = await tarBytes([{ name: "a.txt", bytes: new TextEncoder().encode("Keep me") }])
    const source = await originalArchive(fixture, bytes, "secret")
    fixture.corruptReads()
    await assert.rejects(() => upgradeArchive(fixture.client, { ...fixture.options, source, password: "secret" }), /password|damaged/)
    assert.equal(fixture.cards.length, 0)
    assert.ok(fixture.deleted.length > 0)
    assert.ok(fixture.deleted.every((id) => id >= 100))
    assert.ok(fixture.documents.has(11))
})

test("cancelling an upgrade preserves its source and never publishes an incomplete card", async () => {
    const fixture = telegramFixture()
    const bytes = await tarBytes([{ name: "a.txt", bytes: new TextEncoder().encode("Keep me") }])
    const source = await originalArchive(fixture, bytes, "")
    const abort = new AbortController()
    fixture.onSendFile(() => abort.abort())
    await assert.rejects(() => upgradeArchive(fixture.client, { ...fixture.options, source, password: "", signal: abort.signal }), /cancel/)
    assert.equal(fixture.cards.length, 0)
    assert.ok(fixture.documents.has(11))
    assert.ok(!fixture.deleted.includes(11))
    assert.equal(fixture.lookups.filter((ids) => ids.includes(11)).length, 1)
})

test("an uncertain final publication preserves verified new chunks", async () => {
    const fixture = telegramFixture()
    const bytes = await tarBytes([{ name: "a.txt", bytes: new TextEncoder().encode("Keep me") }])
    fixture.losePublicationResponse()
    await assert.rejects(() => uploadIndexedArchive(fixture.client, {
        ...fixture.options, password: "", source: { name: "fixture.tar", size: bytes.length, stream: () => new Blob([bytes]).stream() },
    }), /Publication response lost/)
    assert.equal(fixture.cards.length, 1)
    assert.equal(fixture.deleted.length, 0)
    assert.ok(fixture.documents.size > 0)
})

test("range downloads respect Telegram boundaries across differently sized documents", async () => {
    const fixture = telegramFixture()
    const first = new Uint8Array(DOWNLOAD_PART_SIZE + 100).map((_, i) => i % 251)
    const second = new Uint8Array(2000).fill(99)
    fixture.documents.set(11, first)
    fixture.documents.set(12, second)
    const reader = await createTelegramArchiveRangeReader(fixture.client, [11, 12], fixture.options)
    const expected = new Uint8Array(first.length + second.length)
    expected.set(first); expected.set(second, first.length)
    const ranges = await Promise.all([
        reader.readRange(DOWNLOAD_PART_SIZE - 10, 220),
        reader.readRange(0, 30),
        reader.readRange(first.length + 100, 200),
    ])
    assert.deepEqual(ranges[0], expected.slice(DOWNLOAD_PART_SIZE - 10, DOWNLOAD_PART_SIZE + 210))
    assert.deepEqual(ranges[1], expected.slice(0, 30))
    assert.deepEqual(ranges[2], expected.slice(first.length + 100, first.length + 300))
    await assert.rejects(() => reader.readRange(-1, 1), /invalid/)
    await assert.rejects(() => reader.readRange(expected.length, 1), /invalid/)
})

test("upgrade capability explicitly refuses unknown versions, incomplete uploads, and other archive types", () => {
    const data = { version: 3, uploadComplete: true, name: "fixture.tar" } as FileCardData
    assert.equal(getArchiveUpgradeCapability(data).supported, true)
    assert.equal(getArchiveUpgradeCapability({ ...data, version: 99 } as unknown as FileCardData).supported, false)
    assert.equal(getArchiveUpgradeCapability({ ...data, uploadComplete: false }).supported, false)
    assert.equal(getArchiveUpgradeCapability({ ...data, name: "fixture.tar.gz" }).supported, false)
})

test("browsing a small member downloads only its blocks and the index", async () => {
    const fixture = telegramFixture()
    const payload = new TextEncoder().encode("Small private member")
    const other = new Uint8Array(3 * DOWNLOAD_PART_SIZE)
    let state = 123456789
    for (let i = 0; i < other.length; i += 1) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5
        other[i] = state & 255
    }
    const bytes = await tarBytes([{ name: "tiny.txt", bytes: payload }, { name: "large.bin", bytes: other }])
    const result = await uploadIndexedArchive(fixture.client, {
        ...fixture.options, password: "private", source: { name: "fixture.tar", size: bytes.length, stream: () => new Blob([bytes]).stream() },
    })
    fixture.reads.length = 0
    const reader = await openRemoteArchive(fixture.client, { ...fixture.options, record: result, password: "private" })
    const entry = reader.index.entries.find((item) => item.path === "tiny.txt")!
    assert.deepEqual(await collect(reader.entryStream(entry.id)), payload)
    const fetched = fixture.reads.reduce((total, read) => total + Math.min(read.limit, fixture.documents.get(read.id)!.length - read.offset), 0)
    const stored = [...fixture.documents.values()].reduce((total, document) => total + document.length, 0)
    assert.ok(fetched < stored / 2, `Preview fetched ${fetched} of ${stored} stored bytes`)
})

test("a progress display error cannot remove or prevent a verified archive", async () => {
    const fixture = telegramFixture()
    const bytes = await tarBytes([{ name: "a.txt", bytes: new Uint8Array([1, 2, 3]) }])
    const result = await uploadIndexedArchive(fixture.client, {
        ...fixture.options, password: "", source: { name: "fixture.tar", size: bytes.length, stream: () => new Blob([bytes]).stream() },
        onProgress() { throw new Error("Display failed") },
    })
    assert.equal(result.data.uploadComplete, true)
    assert.equal(fixture.cards.length, 1)
    assert.equal(fixture.deleted.length, 0)
})

function randomPayload(length: number) {
    const bytes = new Uint8Array(length)
    let state = 987654321
    for (let i = 0; i < bytes.length; i += 1) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5
        bytes[i] = state & 255
    }
    return bytes
}

test("legacy cipher archives upgrade after one current-pipeline failure across attachment boundaries", async () => {
    const fixture = telegramFixture()
    const bytes = await tarBytes([{ name: "large.bin", bytes: randomPayload(2 * ENCRYPTION_CHUNK_SIZE + 333) }])
    const source = await originalArchive(fixture, bytes, "legacy password", 3, "legacy", UPLOAD_PART_SIZE + 123)
    assert.ok([...fixture.documents.values()].reduce((total, value) => total + value.length, 0) > ENCRYPTION_CHUNK_SIZE)
    const original = structuredClone(source)
    const first = fixture.documents.get(11)!.slice()
    const second = fixture.documents.get(12)!.slice()
    const result = await upgradeArchive(fixture.client, { ...fixture.options, source, password: "legacy password" })
    assert.equal(fixture.lookups.filter((ids) => ids.includes(11)).length, 2)
    assert.equal(fixture.cards.length, 1)
    assert.ok(fixture.deleted.length > 0)
    assert.ok(fixture.deleted.every((id) => id >= 100))
    assert.deepEqual(source, original)
    assert.deepEqual(fixture.documents.get(11), first)
    assert.deepEqual(fixture.documents.get(12), second)
    const reader = await openRemoteArchive(fixture.client, { ...fixture.options, record: result, password: "legacy password" })
    assert.deepEqual(await collect(reader.stream()), bytes)
    assert.equal(result.data.ufid, source.data.ufid)
    assert.equal("upgradedFrom" in result.data && result.data.upgradedFrom?.fileVersion, 3)
})

test("legacy fallback is not attempted after transport, missing-source, cleanup, or publication failure", async () => {
    const bytes = await tarBytes([{ name: "small.txt", bytes: new TextEncoder().encode("Keep the source") }])
    const missing = telegramFixture()
    const missingSource = await originalArchive(missing, bytes, "")
    missing.documents.delete(11)
    await assert.rejects(() => upgradeArchive(missing.client, { ...missing.options, source: missingSource, password: "" }), /missing/)
    assert.equal(missing.lookups.length, 1)

    const network = telegramFixture()
    const networkSource = await originalArchive(network, bytes, "")
    let calls = 0
    network.client.getMessages = async () => { calls += 1; throw new Error("Network unavailable") }
    await assert.rejects(() => upgradeArchive(network.client, { ...network.options, source: networkSource, password: "" }), /Network unavailable/)
    assert.equal(calls, 1)

    const publication = telegramFixture()
    const publicationSource = await originalArchive(publication, bytes, "")
    publication.losePublicationResponse()
    await assert.rejects(() => upgradeArchive(publication.client, { ...publication.options, source: publicationSource, password: "" }), /Publication response lost/)
    assert.equal(publication.lookups.filter((ids) => ids.includes(11)).length, 1)
    assert.equal(publication.cards.length, 1)
    assert.deepEqual(publication.deleted, [])

    const cleanup = telegramFixture()
    const largeBytes = await tarBytes([{ name: "large.bin", bytes: randomPayload(2 * ENCRYPTION_CHUNK_SIZE + 333) }])
    const cleanupSource = await originalArchive(cleanup, largeBytes, "", 2, "legacy")
    const invoke = cleanup.client.invoke
    cleanup.client.invoke = async (request) => {
        if (request instanceof FakeApi.messages.DeleteMessages) throw new Error("Cleanup denied")
        return invoke(request)
    }
    await assert.rejects(() => upgradeArchive(cleanup.client, { ...cleanup.options, source: cleanupSource, password: "" }), /could not be removed/)
    assert.equal(cleanup.lookups.filter((ids) => ids.includes(11)).length, 1)
    assert.equal(cleanup.cards.length, 0)
    assert.ok(cleanup.documents.has(11))
})

test("a wrong password cannot publish through either cipher pipeline", async () => {
    const fixture = telegramFixture()
    const bytes = await tarBytes([{ name: "small.txt", bytes: new Uint8Array([1, 2, 3]) }])
    const source = await originalArchive(fixture, bytes, "right")
    await assert.rejects(() => upgradeArchive(fixture.client, { ...fixture.options, source, password: "wrong" }))
    assert.equal(fixture.lookups.filter((ids) => ids.includes(11)).length, 2)
    assert.equal(fixture.cards.length, 0)
    assert.ok(fixture.documents.has(11))
})
