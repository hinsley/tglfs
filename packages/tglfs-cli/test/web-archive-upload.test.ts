import assert from "node:assert/strict"
import test from "node:test"

import { getGramJs } from "../src/gramjs.js"
import { parseFileCardMessage } from "../src/shared/file-cards.js"
import { openRemoteArchive } from "../src/shared/archive-transfer.js"
import { sendTransferDocument } from "../src/shared/block-transfer.js"
import { UPLOAD_PART_SIZE } from "../src/shared/constants.js"
import { begin, __resetTransfersForTests } from "../../../src/web/transfers.ts"

class MemoryTelegram {
    cards = new Map<number, string>()
    chunks = new Map<number, Uint8Array>()
    parts = new Map<string, Uint8Array[]>()
    nextId = 100

    async getMessages(_peer: string, options: any) {
        if (!options.ids) return [...this.cards].map(([id, message]) => ({ id, message, date: id }))
        const { Api } = getGramJs()
        return options.ids.map((id: number) => this.chunks.has(id) ? {
            id,
            media: new Api.MessageMediaDocument({ document: new Api.Document({
                id: BigInt(id), accessHash: 1n, fileReference: Buffer.alloc(0), date: 0,
                mimeType: "application/octet-stream", size: this.chunks.get(id)!.length,
                dcId: 1, attributes: [],
            } as any) }),
        } : { id, message: this.cards.get(id), date: id })
    }

    async invoke(request: any) {
        if (request.className === "upload.SaveBigFilePart") {
            request.getBytes()
            const key = request.fileId.toString()
            const parts = this.parts.get(key) ?? []
            parts[request.filePart] = Uint8Array.from(request.bytes)
            this.parts.set(key, parts)
            return true
        }
        if (request.className === "upload.GetFile") {
            const bytes = this.chunks.get(Number(request.location.id.toString()))!
            const offset = Number(request.offset.toString())
            return { bytes: bytes.slice(offset, offset + request.limit) }
        }
        if (request.className === "messages.EditMessage") {
            this.cards.set(request.id, request.message)
            return true
        }
        if (request.className === "messages.DeleteMessages") {
            for (const id of request.id) this.chunks.delete(id)
            return true
        }
        throw new Error(`Unexpected request ${request.className}`)
    }

    async sendFile(_peer: string, options: any) {
        const id = this.nextId++
        this.chunks.set(id, Uint8Array.from(Buffer.concat(this.parts.get(options.file.id.toString())!)))
        return { id }
    }

    async sendMessage(_peer: string, options: { message: string }) {
        const id = this.nextId++
        this.cards.set(id, options.message)
        return { id, date: id, peerId: "me" }
    }
}

test("transfer documents serialize multipart byte slices with GramJS", async () => {
    const { Api, getFileInfo } = getGramJs()
    const client = new MemoryTelegram()
    const padded = Uint8Array.from({ length: UPLOAD_PART_SIZE + 37 + 18 }, (_, index) => index % 251)
    const bytes = padded.subarray(9, padded.length - 9)

    const sent = await sendTransferDocument(client, { Api, getFileInfo }, bytes, "parts.bin")

    assert.deepEqual(client.chunks.get(sent.id), bytes)
    assert.deepEqual([...client.parts.values()][0].map((part) => part.length), [UPLOAD_PART_SIZE, 37])
})

test("queued web uploads write v5 for both archives and ordinary files", async () => {
    const originalWindow = (globalThis as any).window
    const refreshedParents: string[] = []
    const { Api, getFileInfo } = getGramJs()
    const { runFileUploadJob, updateFileCardParent } = await import("../../../src/telegram.ts")
    ;(globalThis as any).window = {
        crypto: globalThis.crypto,
        dispatchEvent(event: any) { refreshedParents.push(event.tglfsParentFolderId); return true },
    }
    try {
        const config = { apiId: 1, apiHash: "test", phone: "test", chunkSize: 512 * 1024 }
        const files = [
            new File(["one"], "one.txt", { lastModified: 1700000000000 }),
            new File(["two"], "two.txt", { lastModified: 1700000000000 }),
        ]
        const client = new MemoryTelegram()
        const transfer = begin({ direction: "upload", name: "batch.tar", queue: false })
        const result = await runFileUploadJob(client as any, config, {
            files, password: "private", parentFolderId: "folder-42", archiveName: "batch.tar",
        }, transfer)
        assert.equal(result.data.version, 5)
        assert.equal(result.parentFolderId, "folder-42")
        assert.equal(parseFileCardMessage(client.cards.get(result.msgId)!)?.version, 5)
        const archive = await openRemoteArchive(client, { Api, getFileInfo, record: {
            msgId: result.msgId, date: 0, data: result.data,
        }, password: "private" })
        assert.deepEqual(archive.index.entries.map((entry) => entry.path), ["one.txt", "two.txt"])
        assert.equal(await new Response(archive.entryStream("1")).text(), "two")
        assert.equal(transfer.snapshot().ufid, result.data.ufid)

        const ordinaryClient = new MemoryTelegram()
        const ordinaryTransfer = begin({ direction: "upload", name: "one.txt", queue: false })
        const ordinary = await runFileUploadJob(ordinaryClient as any, config, {
            files: [files[0]], password: "", parentFolderId: "folder-42",
        }, ordinaryTransfer)
        assert.equal(ordinary.data.version, 5)
        assert.equal(ordinary.data.uploadComplete, true)
        const moved = await updateFileCardParent(ordinaryClient as any, ordinary.msgId, "me", ordinary.data, "another-folder")
        assert.equal(moved.version, 5)
        assert.deepEqual((moved as any).content, (ordinary.data as any).content)
        assert.deepEqual(moved.chunks, ordinary.data.chunks)
        assert.equal(parseFileCardMessage(ordinaryClient.cards.get(ordinary.msgId)!)?.version, 5)
        assert.deepEqual(refreshedParents, ["folder-42", "folder-42"])
    } finally {
        __resetTransfersForTests()
        if (originalWindow === undefined) delete (globalThis as any).window
        else (globalThis as any).window = originalWindow
    }
})
