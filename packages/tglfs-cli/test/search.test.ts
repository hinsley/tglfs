import assert from "node:assert/strict"
import test from "node:test"

import { formatSearchResultsTable, searchFileCards } from "../src/search.js"

test("searchFileCards returns an empty success window for no matches", async () => {
    const calls: any[] = []
    const client = {
        async getMessages(_: string, options: unknown) {
            calls.push(options)
            return []
        },
    } as any

    const result = await searchFileCards(client, {
        limit: 5,
        query: "missing",
        sort: "name_asc",
    })

    assert.deepEqual(calls, [
        {
            search: "tglfs:file missing",
            limit: 5,
            addOffset: 0,
            minId: 0,
            maxId: 0,
            waitTime: 0,
        },
    ])
    assert.deepEqual(result, {
        peer: "me",
        query: "missing",
        sort: "name_asc",
        limit: 5,
        offsetId: undefined,
        nextOffsetId: undefined,
        hasMore: false,
        results: [],
    })
})

test("searchFileCards keeps a raw cursor but sorts the visible window", async () => {
    const client = {
        async getMessages(_: string, options: unknown) {
            assert.deepEqual(options, {
                search: "tglfs:file",
                limit: 2,
                addOffset: 0,
                minId: 0,
                maxId: 99,
                waitTime: 0,
            })
            return [
                {
                    id: 40,
                    date: 40,
                    message: 'tglfs:file\n{"name":"zeta.txt","ufid":"u2","size":200,"uploadComplete":true,"chunks":[2],"IV":"b"}',
                },
                {
                    id: 39,
                    date: 39,
                    message: 'tglfs:file\n{"name":"alpha.txt","ufid":"u1","size":100,"uploadComplete":false,"chunks":[1],"IV":"a"}',
                },
            ]
        },
    } as any

    const result = await searchFileCards(client, {
        limit: 2,
        offsetId: 99,
        sort: "name_asc",
    })

    assert.deepEqual(
        result.results.map((record) => record.data.name),
        ["alpha.txt", "zeta.txt"],
    )
    assert.equal(result.hasMore, true)
    assert.equal(result.nextOffsetId, 39)
})

test("searchFileCards can query a non-default peer mailbox", async () => {
    const calls: Array<{ peer: string; options: unknown }> = []
    const client = {
        async getMessages(peer: string, options: unknown) {
            calls.push({ peer, options })
            return []
        },
    } as any

    const result = await searchFileCards(client, {
        peer: "friend123",
        query: "design",
        limit: 3,
    })

    assert.equal(result.peer, "friend123")
    assert.deepEqual(calls, [
        {
            peer: "friend123",
            options: {
                search: "tglfs:file design",
                limit: 3,
                addOffset: 0,
                minId: 0,
                maxId: 0,
                waitTime: 0,
            },
        },
    ])
})

test("plain search output renders a table and next-page hint", () => {
    const text = formatSearchResultsTable({
        query: "project docs",
        sort: "name_asc",
        limit: 2,
        nextOffsetId: 39,
        hasMore: true,
        results: [
            {
                msgId: 40,
                date: 1700000000,
                data: { name: "alpha.txt", ufid: "u1", size: 100, uploadComplete: false, chunks: [1], IV: "a" },
            },
            {
                msgId: 41,
                date: 1700000100,
                data: { name: "zeta.txt", ufid: "u2", size: 200, uploadComplete: true, chunks: [2], IV: "b" },
            },
        ],
    })

    assert.match(text, /^Name\s+Size\s+Date\s+UFID\s+Status/m)
    assert.match(text, /alpha\.txt/)
    assert.match(text, /Incomplete/)
    assert.match(text, /Next page: tglfs search 'project docs' --limit 2 --offset-id 39 --sort name_asc/)
})

test("plain search output includes --peer in peer next-page hints", () => {
    const text = formatSearchResultsTable({
        peer: "friend123",
        query: "",
        sort: "date_desc",
        limit: 5,
        nextOffsetId: 123,
        hasMore: true,
        results: [
            {
                msgId: 40,
                date: 1700000000,
                data: { name: "alpha.txt", ufid: "u1", size: 100, uploadComplete: true, chunks: [1], IV: "a" },
            },
        ],
    })

    assert.match(text, /Next page: tglfs search --peer 'friend123' --limit 5 --offset-id 123/)
})

test("plain search output reports empty result sets without error text", () => {
    assert.equal(
        formatSearchResultsTable({
            query: "",
            sort: "date_desc",
            limit: 50,
            hasMore: false,
            results: [],
        }),
        "No TGLFS files found.",
    )
})
