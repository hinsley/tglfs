import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { downloadFileCard, inspectFileFromEncryptedParts, restoreFileFromEncryptedParts } from "../src/download.js"
import { CliError } from "../src/errors.js"
import { inspectFileCard } from "../src/file-ops.js"
import { getGramJs } from "../src/gramjs.js"
import { makeMp4Previewable } from "../src/make-previewable.js"
import { createVerifiedFileCardPlaintextStream } from "../src/plaintext-stream.js"
import { validateDownloadableFileCard } from "../src/protocol.js"
import { createTarStream } from "../src/shared/archive.js"
import { encodeArchiveStream } from "../src/shared/archive-format.js"
import { openRemoteArchive } from "../src/shared/archive-transfer.js"
import { parseFileCardMessage, serializeFileCardMessage } from "../src/shared/file-cards.js"
import { createFileCardV4Data } from "../src/shared/protocol/file-card-v4.js"
import { uploadPaths } from "../src/upload.js"

async function bytesOf(stream: ReadableStream<Uint8Array>) {
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

class MemoryTelegram {
    readonly stored = new Map<number, Uint8Array>()
    readonly parts = new Map<string, Map<number, Uint8Array>>()
    readonly cards: any[] = []
    readonly requests: any[] = []
    private nextId = 100

    private document(id: number) {
        const { Api } = getGramJs()
        return {
            id,
            media: new Api.MessageMediaDocument({
                document: new Api.Document({
                    id: BigInt(id) as any,
                    accessHash: 1n as any,
                    fileReference: Buffer.alloc(0),
                    date: 0,
                    mimeType: "application/octet-stream",
                    size: BigInt(this.stored.get(id)!.length) as any,
                    dcId: 1,
                    attributes: [],
                }),
            }),
        }
    }

    async getMessages(_peer: string, options: any) {
        if (options.ids) return options.ids.map((id: number) => this.stored.has(id) ? this.document(id) : undefined)
        return this.cards
    }

    async sendMessage(_peer: string, options: { message: string }) {
        const card = { id: this.nextId++, date: 1_700_000_000, message: options.message }
        this.cards.push(card)
        return card
    }

    async sendFile(_peer: string, options: { file: any }) {
        const id = this.nextId++
        const parts = this.parts.get(options.file.id.toString())!
        const bytes = Buffer.concat(Array.from(parts.entries()).sort(([left], [right]) => left - right).map(([, value]) => value))
        this.stored.set(id, Uint8Array.from(bytes))
        return { id }
    }

    async invoke(request: any) {
        const { Api } = getGramJs()
        this.requests.push(request)
        if (request instanceof Api.upload.SaveBigFilePart) {
            const id = request.fileId.toString()
            const parts = this.parts.get(id) ?? new Map()
            parts.set(request.filePart, Uint8Array.from(request.bytes))
            this.parts.set(id, parts)
            return true
        }
        if (request instanceof Api.upload.GetFile) {
            const bytes = this.stored.get(Number(request.location.id.toString()))!
            const offset = Number(request.offset.toString())
            return { bytes: bytes.subarray(offset, offset + request.limit) }
        }
        if (request instanceof Api.messages.DeleteMessages) {
            for (const id of request.id) this.stored.delete(id)
            return true
        }
        throw new Error(`Unexpected request: ${request.className}`)
    }
}

const fixturePromise = (async () => {
    const payload = new TextEncoder().encode("CLI indexed archive fixture.\n".repeat(100))
    const tar = await bytesOf(createTarStream([{
        name: "nested/fixture.txt", size: payload.length, lastModified: 1_700_000_000_000,
        stream: () => new Blob([payload]).stream(),
    }]))
    const chunks: Uint8Array[] = []
    const encoded = await encodeArchiveStream(new Blob([tar]).stream(), { password: "secret" }, async (bytes) => {
        chunks.push(bytes)
    })
    const ciphertext = Uint8Array.from(Buffer.concat(chunks))
    const data = createFileCardV4Data({
        version: 4, name: "fixture.tar", ufid: encoded.ufid, size: encoded.size,
        IV: "", chunks: [1], uploadComplete: true, archive: encoded.storage,
    })
    return { tar, ciphertext, data }
})()

async function clientForFixture() {
    const fixture = await fixturePromise
    const client = new MemoryTelegram()
    client.stored.set(1, fixture.ciphertext)
    client.cards.push({ id: 2, date: 1_700_000_000, message: serializeFileCardMessage(fixture.data) })
    return { ...fixture, client }
}

test("v4 CLI downloads restore and verify the exact original tar", async () => {
    const fixture = await clientForFixture()
    const directory = await mkdtemp(join(tmpdir(), "tglfs-archive-download-"))
    const output = join(directory, "restored.tar")
    try {
        const progress: number[] = []
        const result = await downloadFileCard(fixture.client as any, fixture.data, "secret", output, false, ({ bytesWritten }) => progress.push(bytesWritten))
        assert.deepEqual(Uint8Array.from(await readFile(output)), fixture.tar)
        assert.equal(result.bytesWritten, fixture.tar.length)
        assert.equal(progress.at(-1), fixture.tar.length)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("v4 CLI downloads preserve the destination when authentication fails", async () => {
    const fixture = await clientForFixture()
    const corrupted = fixture.ciphertext.slice()
    corrupted[0] ^= 1
    fixture.client.stored.set(1, corrupted)
    const directory = await mkdtemp(join(tmpdir(), "tglfs-archive-failure-"))
    const output = join(directory, "existing.tar")
    await writeFile(output, "Keep this existing file")
    try {
        await assert.rejects(downloadFileCard(fixture.client as any, fixture.data, "secret", output, true))
        assert.equal(await readFile(output, "utf8"), "Keep this existing file")
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("v4 CLI cards reject the legacy and raw encrypted-parts pipelines", async () => {
    const fixture = await clientForFixture()
    async function* parts() { yield fixture.ciphertext }
    await assert.rejects(
        downloadFileCard(fixture.client as any, fixture.data, "secret", "unused.tar", false, undefined, "legacy"),
        (error: unknown) => error instanceof CliError && error.code === "unsupported_file_protocol",
    )
    await assert.rejects(
        inspectFileFromEncryptedParts(fixture.data, "secret", parts(), "current"),
        (error: unknown) => error instanceof CliError && error.code === "unsupported_file_protocol",
    )
    const directory = await mkdtemp(join(tmpdir(), "tglfs-archive-raw-"))
    try {
        await assert.rejects(
            restoreFileFromEncryptedParts(fixture.data, "secret", join(directory, "unused.tar"), parts()),
            (error: unknown) => error instanceof CliError && error.code === "unsupported_file_protocol",
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
    assert.equal(fixture.client.requests.length, 0)
})

test("v4 CLI inspect identifies indexed archives and probes their exact UFID", async () => {
    const fixture = await clientForFixture()
    const skipped = await inspectFileCard(fixture.client as any, fixture.data.ufid)
    assert.equal(skipped.format, "indexed-archive")
    assert.equal(skipped.probe, undefined)
    assert.equal(fixture.client.requests.length, 0)
    const result = await inspectFileCard(fixture.client as any, fixture.data.ufid, { probe: true, password: "secret" })
    assert.equal(result.probe?.mode, "indexed-archive")
    assert.equal(result.probe?.computedUfid, fixture.data.ufid)
    assert.equal(result.probe?.bytesWritten, fixture.tar.length)
})

test("v4 CLI validation requires the archive descriptor while allowing its empty IV sentinel", async () => {
    const { data } = await fixturePromise
    assert.doesNotThrow(() => validateDownloadableFileCard(data))
    assert.throws(() => validateDownloadableFileCard({ ...data, archive: { ...data.archive, version: 2 } } as any), /malformed or unsupported/)
    assert.throws(() => validateDownloadableFileCard({ ...data, version: 5 } as any), /unsupported/)
})

test("the generic CLI plaintext reader dispatches v4 archives and refuses unsupported pipelines", async () => {
    const fixture = await clientForFixture()
    const progress: number[] = []
    const plaintext = await createVerifiedFileCardPlaintextStream(
        fixture.client as any, fixture.data, "secret", "current", ({ bytesWritten }) => progress.push(bytesWritten),
    )
    assert.deepEqual(await bytesOf(plaintext), fixture.tar)
    assert.equal(progress.at(-1), fixture.tar.length)
    await assert.rejects(
        createVerifiedFileCardPlaintextStream(fixture.client as any, fixture.data, "secret", "legacy"),
        (error: unknown) => error instanceof CliError && error.code === "unsupported_file_protocol",
    )
    await assert.rejects(
        createVerifiedFileCardPlaintextStream(fixture.client as any, { ...fixture.data, version: 5 } as any, "secret"),
        (error: unknown) => error instanceof CliError && error.code === "invalid_file_card",
    )
})

test("make-previewable refuses a v4 archive renamed with an MP4 extension before reading remote data", async () => {
    const fixture = await clientForFixture()
    await assert.rejects(
        makeMp4Previewable(fixture.client as any, {
            msgId: 2, date: 1_700_000_000, data: { ...fixture.data, name: "renamed-archive.mp4" },
        }, { sourcePassword: "secret", uploadPassword: "", chunkSize: 1024 * 1024 }),
        (error: unknown) => error instanceof CliError && error.code === "invalid_media" && /archive records/.test(error.message),
    )
    assert.equal(fixture.client.requests.length, 0)
    assert.equal(fixture.client.cards.length, 1)
})

test("CLI batches and direct tar uploads write browsable v4 cards", async () => {
    const { Api, getFileInfo } = getGramJs()
    const directory = await mkdtemp(join(tmpdir(), "tglfs-archive-upload-"))
    const first = join(directory, "one.txt")
    const second = join(directory, "two.txt")
    const direct = join(directory, "existing.tar")
    const fixture = await fixturePromise
    await writeFile(first, "first")
    await writeFile(second, "second")
    await writeFile(direct, fixture.tar)
    try {
        for (const paths of [[first, second], [direct]]) {
            const client = new MemoryTelegram()
            const result = await uploadPaths(client as any, { paths, chunkSize: 1024 * 1024, password: "" })
            const data = parseFileCardMessage(client.cards[0].message)!
            assert.equal(data.version, 4)
            const reader = await openRemoteArchive(client as any, { Api, getFileInfo, record: { msgId: result.msgId, date: result.date, data }, password: "" })
            assert.equal(reader.index.entries.length, paths.length === 1 ? 1 : 2)
            assert.equal(reader.index.ufid, result.ufid)
            if (paths.length === 1) assert.deepEqual(await bytesOf(reader.stream()), fixture.tar)
        }
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
