import assert from "node:assert/strict"
import test from "node:test"

import { serializeFileCardMessage } from "../src/shared/file-cards.js"
import { DuplicateUfidError, uploadCurrentFormatSource } from "../src/shared/upload.js"
import { computeUfidFromBytes } from "../src/ufid.js"

const FakeApi = {
    messages: {
        EditMessage: class EditMessage {
            constructor(readonly args: any) {}
        },
    },
    upload: {
        SaveBigFilePart: class SaveBigFilePart {
            constructor(readonly args: any) {}
        },
    },
    InputFileBig: class InputFileBig {
        constructor(readonly args: any) {}
    },
}

test("uploadCurrentFormatSource uploads a small source and finalizes the file card", async () => {
    const bytes = new TextEncoder().encode("Upload fixture payload.\n".repeat(64))
    const invocations: any[] = []
    const chunkMessages: any[] = []
    const sentMessages: any[] = []

    const client = {
        async getMessages() {
            return []
        },
        async sendMessage(peer: string, options: { message: string }) {
            sentMessages.push({ peer, message: options.message })
            return { id: 100, date: 1700000000, peerId: peer }
        },
        async sendFile(peer: string, options: { file: any }) {
            chunkMessages.push({ peer, file: options.file })
            return { id: 200 + chunkMessages.length }
        },
        async invoke(request: any) {
            invocations.push(request)
            return true
        },
    } as any

    const result = await uploadCurrentFormatSource(client, {
        Api: FakeApi as any,
        chunkSize: 2 * 1024 * 1024,
        password: "",
        source: {
            name: "fixture.txt",
            size: bytes.length,
            stream() {
                return new Blob([bytes]).stream()
            },
        },
    })

    assert.equal(sentMessages.length, 1)
    assert.match(sentMessages[0].message, /^tglfs:file\n/)
    assert.equal(chunkMessages.length, 1)
    assert.ok(invocations.length >= 2)
    assert.equal(result.data.name, "fixture.txt")
    assert.equal(result.data.size, bytes.length)
    assert.equal(result.data.uploadComplete, true)
    assert.deepEqual(result.data.chunks, [201])
})

test("uploadCurrentFormatSource rejects duplicate UFIDs before uploading parts", async () => {
    const bytes = new TextEncoder().encode("Duplicate UFID upload fixture.")
    const ufid = await computeUfidFromBytes(bytes)
    let sendMessageCalled = false

    const client = {
        async getMessages() {
            return [
                {
                    id: 11,
                    date: 1700000000,
                    message: serializeFileCardMessage({
                        name: "fixture.txt",
                        ufid,
                        size: bytes.length,
                        uploadComplete: true,
                        chunks: [1],
                        IV: "abcd",
                    }),
                },
            ]
        },
        async sendMessage() {
            sendMessageCalled = true
            return { id: 1, date: 1, peerId: "me" }
        },
        async sendFile() {
            return { id: 2 }
        },
        async invoke() {
            return true
        },
    } as any

    await assert.rejects(
        () =>
            uploadCurrentFormatSource(client, {
                Api: FakeApi as any,
                chunkSize: 2 * 1024 * 1024,
                password: "",
                source: {
                    name: "fixture.txt",
                    size: bytes.length,
                    stream() {
                        return new Blob([bytes]).stream()
                    },
                },
            }),
        (error: unknown) => error instanceof DuplicateUfidError && error.ufid === ufid,
    )
    assert.equal(sendMessageCalled, false)
})
