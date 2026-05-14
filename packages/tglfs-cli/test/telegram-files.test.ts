import assert from "node:assert/strict"
import test from "node:test"

import { serializeFileCardMessage } from "../src/shared/file-cards.js"
import { countFileCards, listFileCards, transferFileCard, unsendFileCard } from "../src/shared/telegram-files.js"

const FakeApi = {
    messages: {
        EditMessage: class EditMessage {
            constructor(readonly args: any) {}
        },
        DeleteMessages: class DeleteMessages {
            constructor(readonly args: any) {}
        },
        ForwardMessages: class ForwardMessages {
            constructor(readonly args: any) {}
        },
    },
}

test("listFileCards can scope a page to a parent folder", async () => {
    const calls: unknown[] = []
    const client = {
        async getMessages(_: string, options: unknown) {
            calls.push(options)
            return [
                {
                    id: 10,
                    date: 1700000000,
                    message: serializeFileCardMessage({
                        name: "nested.txt",
                        ufid: "ufid-nested",
                        size: 10,
                        uploadComplete: true,
                        chunks: [1],
                        IV: "iv",
                        parentFolderId: "folder-1",
                    }),
                },
            ]
        },
    } as any

    const results = await listFileCards(client, { parentFolderId: "folder-1", query: "nested", limit: 25, offsetId: 99 })

    assert.deepEqual(calls[0], {
        search: 'tglfs:file "parentFolderId":"folder-1" nested',
        limit: 25,
        addOffset: 0,
        minId: 0,
        maxId: 99,
        waitTime: 0,
    })
    assert.equal(results[0]?.data.parentFolderId, "folder-1")
})

test("listFileCards filters tokenized parent search false positives", async () => {
    const calls: any[] = []
    const makeMessage = (id: number, name: string, ufid: string, parentFolderId: string) => ({
        id,
        date: 1700000000 + id,
        message: serializeFileCardMessage({
            name,
            ufid,
            size: id,
            uploadComplete: true,
            chunks: [id],
            IV: "iv",
            parentFolderId,
        }),
    })
    const client = {
        async getMessages(_: string, options: any) {
            calls.push(options)
            if (options.maxId === 0) {
                return [
                    makeMessage(30, "wrong.txt", "ufid-wrong", "folder-other"),
                    makeMessage(20, "right-a.txt", "ufid-right-a", "folder-1"),
                ]
            }
            if (options.maxId === 20) {
                return [makeMessage(10, "right-b.txt", "ufid-right-b", "folder-1")]
            }
            return []
        },
    } as any

    const results = await listFileCards(client, { parentFolderId: "folder-1", limit: 2 })

    assert.deepEqual(results.map((record) => record.data.name), ["right-a.txt", "right-b.txt"])
    assert.deepEqual(calls.map((call) => call.maxId), [0, 20])
})

test("countFileCards uses Telegram count-only search", async () => {
    const calls: unknown[] = []
    const client = {
        async getMessages(_: string, options: unknown) {
            calls.push(options)
            const result: any[] = []
            result.total = 123
            return result
        },
    } as any

    const total = await countFileCards(client, { parentFolderId: "folder-1", query: "nested" })

    assert.equal(total, 123)
    assert.deepEqual(calls[0], {
        search: 'tglfs:file "parentFolderId":"folder-1" nested',
        limit: 0,
        addOffset: 0,
        minId: 0,
        maxId: 0,
        waitTime: 0,
    })
})

test("transferFileCard forwards chunks, rewrites chunk ids, and writes a new file card", async () => {
    const forwards: any[] = []
    const sentMessages: Array<{ peer: string; message: string }> = []
    let nextForwardId = 900
    const client = {
        async invoke(request: any) {
            forwards.push(request.args)
            return {
                updates: [{ id: nextForwardId++ }],
            }
        },
        async sendMessage(peer: string, options: { message: string }) {
            sentMessages.push({ peer, message: options.message })
            return {
                id: 777,
                date: 1700000000,
            }
        },
    } as any

    const result = await transferFileCard(client, {
        Api: FakeApi as any,
        record: {
            msgId: 10,
            date: 1699999999,
            data: {
                name: "demo.txt",
                ufid: "ufid-1",
                size: 4,
                uploadComplete: true,
                chunks: [1, 2],
                IV: "abcd",
            },
        },
        sourcePeer: "me",
        targetPeer: "friend123",
        silent: true,
    })

    assert.deepEqual(
        forwards.map((forward) => ({ fromPeer: forward.fromPeer, toPeer: forward.toPeer, id: forward.id, silent: forward.silent })),
        [
            { fromPeer: "me", toPeer: "friend123", id: [1], silent: true },
            { fromPeer: "me", toPeer: "friend123", id: [2], silent: true },
        ],
    )
    assert.equal(sentMessages[0]?.peer, "friend123")
    assert.equal(
        sentMessages[0]?.message,
        serializeFileCardMessage({
            name: "demo.txt",
            ufid: "ufid-1",
            size: 4,
            uploadComplete: true,
            chunks: [900, 901],
            IV: "abcd",
        }),
    )
    assert.deepEqual(result.data.chunks, [900, 901])
})

test("unsendFileCard deletes chunk messages in batches before deleting the file card", async () => {
    const deleteCalls: any[] = []
    const client = {
        async invoke(request: any) {
            deleteCalls.push(request.args.id)
            return true
        },
    } as any

    await unsendFileCard(client, {
        Api: FakeApi as any,
        peer: "friend123",
        record: {
            msgId: 999,
            date: 1700000000,
            data: {
                name: "big.bin",
                ufid: "ufid-big",
                size: 55,
                uploadComplete: true,
                chunks: Array.from({ length: 55 }, (_, index) => index + 1),
                IV: "abcd",
            },
        },
    })

    assert.equal(deleteCalls.length, 3)
    assert.equal(deleteCalls[0].length, 50)
    assert.equal(deleteCalls[1].length, 5)
    assert.deepEqual(deleteCalls[2], [999])
})
