import assert from "node:assert/strict"
import test from "node:test"

import { serializeFileCardMessage } from "../src/shared/file-cards.js"
import { transferFileCard, unsendFileCard } from "../src/shared/telegram-files.js"

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
