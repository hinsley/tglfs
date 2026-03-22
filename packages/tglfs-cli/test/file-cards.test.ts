import assert from "node:assert/strict"
import test from "node:test"

import {
    buildFileCardSearchQuery,
    buildFileCardUfidLookupQuery,
    extractFileCardRecords,
    FILE_CARD_SEARCH_SORT_VALUES,
    formatFileCardDate,
    formatFileCardSize,
    parseFileCardMessage,
    sortFileCardRecords,
} from "../src/shared/file-cards.js"

test("blank and nonblank file-card search queries match web behavior", () => {
    assert.equal(buildFileCardSearchQuery(), "tglfs:file")
    assert.equal(buildFileCardSearchQuery(" theorydesign "), "tglfs:file theorydesign")
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
