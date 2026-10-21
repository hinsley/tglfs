import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

import {
    buildFileCardSearchQuery,
    buildFileCardParentSearchQuery,
    buildFileCardUfidLookupQuery,
    FILE_CARD_CURRENT_VERSION,
    FILE_CARD_ARCHIVE_VERSION,
    createFileCardData,
    createFileCardV4Data,
    extractFileCardRecords,
    FILE_CARD_SEARCH_SORT_VALUES,
    formatFileCardDate,
    formatFileCardSize,
    parseFileCardMessage,
    serializeFileCardMessage,
    sortFileCardRecords,
} from "../src/shared/file-cards.js"
import { TGLFS_ROOT_PARENT_ID } from "../src/shared/constants.js"
import { renameFileCardMessage, transferFileCard, writeFileCardMessage } from "../src/shared/telegram-files.js"

test("blank and nonblank file-card search queries match web behavior", () => {
    assert.equal(buildFileCardSearchQuery(), "tglfs:file")
    assert.equal(buildFileCardSearchQuery(" theorydesign "), "tglfs:file theorydesign")
    assert.equal(
        buildFileCardParentSearchQuery("folder-1", " theorydesign "),
        'tglfs:file "parentFolderId":"folder-1" theorydesign',
    )
    assert.equal(
        buildFileCardUfidLookupQuery(" abcd "),
        'tglfs:file "ufid":"abcd"',
    )
})

test("extractFileCardRecords skips malformed search results", () => {
    const results = extractFileCardRecords([
        {
            id: 11,
            date: 1700000000,
            message: 'tglfs:file\n{"name":"ok.txt","ufid":"abcd","size":4,"uploadComplete":true,"chunks":[1],"IV":"YWJjZA=="}',
        },
        {
            id: 12,
            date: 1700000001,
            message: 'tglfs:file\n{"name":"broken"',
        },
        {
            id: 13,
            date: 1700000002,
            message: "hello world",
        },
    ])

    assert.deepEqual(results, [
        {
            msgId: 11,
            date: 1700000000,
            data: parseFileCardMessage('tglfs:file\n{"name":"ok.txt","ufid":"abcd","size":4,"uploadComplete":true,"chunks":[1],"IV":"YWJjZA=="}'),
        },
    ])
})

test("unversioned file cards read as v1 records", () => {
    const parsed = parseFileCardMessage(
        'tglfs:file\n{"name":"v1.txt","ufid":"u1","size":10,"uploadComplete":true,"chunks":[1],"IV":"iv"}',
    )

    assert.deepEqual(parsed, {
        type: "tglfs:file",
        version: 1,
        name: "v1.txt",
        ufid: "u1",
        size: 10,
        uploadComplete: true,
        chunks: [1],
        IV: "iv",
    })
})

test("new file-card serialization writes explicit current protocol metadata", () => {
    const message = serializeFileCardMessage({
        name: "current.txt",
        ufid: "u2",
        size: 20,
        uploadComplete: true,
        chunks: [2],
        IV: "iv",
    })

    assert.equal(FILE_CARD_CURRENT_VERSION, 3)
    assert.match(message, /^tglfs:file\n/)
    assert.deepEqual(JSON.parse(message.substring(message.indexOf("{"))), {
        type: "tglfs:file",
        version: 3,
        name: "current.txt",
        ufid: "u2",
        size: 20,
        uploadComplete: true,
        chunks: [2],
        IV: "iv",
        parentFolderId: TGLFS_ROOT_PARENT_ID,
    })
})

test("current file-card serialization writes explicit parent folder refs", () => {
    const message = serializeFileCardMessage({
        name: "nested.txt",
        ufid: "u-nested",
        size: 30,
        uploadComplete: true,
        chunks: [3],
        IV: "iv",
        parentFolderId: "folder-1",
    })

    assert.deepEqual(JSON.parse(message.substring(message.indexOf("{"))), {
        type: "tglfs:file",
        version: 3,
        name: "nested.txt",
        ufid: "u-nested",
        size: 30,
        uploadComplete: true,
        chunks: [3],
        IV: "iv",
        parentFolderId: "folder-1",
    })
})

test("unsupported future file-card versions are refused instead of guessed", () => {
    assert.equal(
        parseFileCardMessage(
            'tglfs:file\n{"type":"tglfs:file","version":5,"name":"future.txt","ufid":"u3","size":30,"uploadComplete":true,"chunks":[3],"IV":"iv","parentFolderId":"folder-1"}',
        ),
        null,
    )
    assert.equal(
        parseFileCardMessage(
            'tglfs:file\n{"type":"tglfs:file","version":1,"name":"typed-v1.txt","ufid":"u5","size":50,"uploadComplete":true,"chunks":[5],"IV":"iv"}',
        ),
        null,
    )
    assert.equal(
        parseFileCardMessage(
            'tglfs:file\n{"version":1,"name":"partial.txt","ufid":"u4","size":40,"uploadComplete":true,"chunks":[4],"IV":"iv"}',
        ),
        null,
    )
})

test("shared sort helpers cover the browser and CLI sort values", () => {
    assert.deepEqual(FILE_CARD_SEARCH_SORT_VALUES, [
        "date_desc",
        "date_asc",
        "name_asc",
        "name_desc",
        "size_desc",
        "size_asc",
    ])

    const records = [
        {
            msgId: 2,
            date: 20,
            data: { name: "b.txt", ufid: "u2", size: 20, uploadComplete: true, chunks: [2], IV: "b" },
        },
        {
            msgId: 1,
            date: 10,
            data: { name: "a.txt", ufid: "u1", size: 10, uploadComplete: false, chunks: [1], IV: "a" },
        },
    ]

    sortFileCardRecords(records, "name_asc")
    assert.deepEqual(
        records.map((record) => record.data.name),
        ["a.txt", "b.txt"],
    )

    sortFileCardRecords(records, "size_desc")
    assert.deepEqual(
        records.map((record) => record.data.size),
        [20, 10],
    )
})

test("shared file-card formatters match browser conventions", () => {
    assert.equal(formatFileCardSize(1536), "1.50 KiB")
    assert.match(formatFileCardDate(1700000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

function protocolFixture(name: string) {
    return readFileSync(new URL(`./fixtures/protocol/file-card-${name}.txt`, import.meta.url), "utf8").trim()
}

test("serialized fixtures retain each supported version and unknown fields during metadata edits", () => {
    for (const version of [1, 2, 3, 4, 5]) {
        const message = protocolFixture(`v${version}`)
        const parsed = parseFileCardMessage(message)
        assert.ok(parsed, `v${version} fixture must parse`)
        assert.equal(parsed.version, version)
        const serialized = serializeFileCardMessage({ ...parsed, name: "renamed.tar" })
        const reread = parseFileCardMessage(serialized)
        assert.ok(reread)
        assert.equal(reread.version, version)
        assert.equal(reread.name, "renamed.tar")
        assert.deepEqual((reread as any).fixtureExtension, { keep: true })
        if (version === 1) {
            const stored = JSON.parse(serialized.substring(serialized.indexOf("{")))
            assert.equal(stored.type, undefined)
            assert.equal(stored.version, undefined)
        }
        if (reread.version === 4) {
            assert.deepEqual((reread.archive as any).fixtureStorageExtension, { keep: true })
            assert.deepEqual((reread.upgradedFrom as any).fixtureSourceExtension, { keep: true })
            assert.deepEqual(reread.archive, (parsed as any).archive)
        }
    }
})

test("v4 archive creation preserves the archive protocol while ordinary file creation stays v3", () => {
    assert.equal(FILE_CARD_ARCHIVE_VERSION, 4)
    assert.equal(FILE_CARD_CURRENT_VERSION, 3)
    const parsed = parseFileCardMessage(protocolFixture("v4"))
    assert.ok(parsed && parsed.version === 4)
    assert.deepEqual(createFileCardData(parsed), parsed)
    const { parentFolderId: _parent, ...withoutParent } = parsed
    const created = createFileCardV4Data(withoutParent)
    assert.equal(created.parentFolderId, TGLFS_ROOT_PARENT_ID)
    assert.equal(created.version, 4)
    assert.equal(created.IV, "")
    assert.deepEqual(created.archive, parsed.archive)
})

test("future and malformed serialized archive fixtures fail closed", () => {
    assert.equal(parseFileCardMessage(protocolFixture("future")), null)
    assert.equal(parseFileCardMessage(protocolFixture("malformed")), null)
    assert.throws(() => serializeFileCardMessage({ version: 6 } as any), /Unsupported/)
    assert.throws(() => createFileCardData({ version: 6 } as any), /Unsupported/)
    const v4 = parseFileCardMessage(protocolFixture("v4"))
    assert.ok(v4 && v4.version === 4)
    assert.throws(() => createFileCardV4Data({ ...v4, version: 5 } as any), /Unsupported/)
})

test("v4 rejects invalid archive metadata, unsupported embedded protocols, and unsafe numbers", () => {
    const parsed = parseFileCardMessage(protocolFixture("v4"))
    assert.ok(parsed && parsed.version === 4)
    const candidates = [
        { ...parsed, IV: "not-unused" },
        { ...parsed, chunks: [] },
        { ...parsed, chunks: [104, 104] },
        { ...parsed, chunks: [-1] },
        { ...parsed, chunks: [1.5] },
        { ...parsed, size: Number.MAX_SAFE_INTEGER + 1 },
        { ...parsed, size: -1 },
        { ...parsed, parentFolderId: " " },
        { ...parsed, archive: { ...parsed.archive, version: 2 } },
        { ...parsed, archive: { ...parsed.archive, type: "other" } },
        { ...parsed, archive: { ...parsed.archive, salt: "invalid" } },
        { ...parsed, archive: { ...parsed.archive, noncePrefix: "invalid" } },
        { ...parsed, archive: { ...parsed.archive, indexOffset: -1 } },
        { ...parsed, archive: { ...parsed.archive, indexLength: 0 } },
        { ...parsed, archive: { ...parsed.archive, storedSize: 1 } },
        { ...parsed, archive: { ...parsed.archive, blockSize: 8 * 1024 * 1024 } },
        { ...parsed, upgradedFrom: { ...parsed.upgradedFrom, version: 2 } },
        { ...parsed, upgradedFrom: { ...parsed.upgradedFrom, messageId: 0 } },
        { ...parsed, upgradedFrom: { ...parsed.upgradedFrom, fileVersion: 0 } },
        { ...parsed, upgradedFrom: { ...parsed.upgradedFrom, peer: "" } },
    ]
    for (const candidate of candidates) {
        assert.equal(parseFileCardMessage(`tglfs:file\n${JSON.stringify(candidate)}`), null)
    }
    assert.equal(parseFileCardMessage(`tglfs:file\n${JSON.stringify({ ...parsed, upgradedFrom: undefined })}`)?.version, 4)
    assert.equal(parseFileCardMessage(`tglfs:file\n${JSON.stringify({
        ...parsed,
        upgradedFrom: { ...parsed.upgradedFrom, fileVersion: 9 },
    })}`)?.version, 4)
})

test("archive metadata edits and transfers retain v4 encryption metadata and unknown fields", async () => {
    const data = parseFileCardMessage(protocolFixture("v4"))
    assert.ok(data && data.version === 4)
    const requests: any[] = []
    const messages: string[] = []
    const Api = {
        messages: {
            EditMessage: class { constructor(readonly args: any) {} },
            DeleteMessages: class { constructor(readonly args: any) {} },
            ForwardMessages: class { constructor(readonly args: any) {} },
        },
    }
    const client = {
        async getMessages() { return [] },
        async invoke(request: any) {
            requests.push(request.args)
            return { updates: [{ id: 204 }] }
        },
        async sendMessage(_peer: string, options: { message: string }) {
            messages.push(options.message)
            return { id: 205, date: 2 }
        },
    }
    await renameFileCardMessage(client, { Api, msgId: 104, data, newName: "renamed.tar" })
    const renamed = parseFileCardMessage(requests[0].message)
    assert.ok(renamed && renamed.version === 4)
    assert.equal(renamed.name, "renamed.tar")
    assert.deepEqual(renamed.archive, data.archive)
    assert.deepEqual((renamed as any).fixtureExtension, { keep: true })

    const transferred = await transferFileCard(client, {
        Api,
        record: { msgId: 104, date: 1, data },
        targetPeer: "other-chat",
    })
    const reread = parseFileCardMessage(messages[0])
    assert.ok(reread && reread.version === 4)
    assert.deepEqual(reread.chunks, [204])
    assert.deepEqual(reread.archive, data.archive)
    assert.deepEqual(reread.upgradedFrom, data.upgradedFrom)
    assert.deepEqual((reread as any).fixtureExtension, { keep: true })
    assert.equal(transferred.data.version, 4)

    const callsBefore = requests.length + messages.length
    await assert.rejects(() => writeFileCardMessage(client, {
        Api,
        msgId: 104,
        data: { ...data, version: 6 } as any,
    }), /Unsupported/)
    assert.equal(requests.length + messages.length, callsBefore)
})
