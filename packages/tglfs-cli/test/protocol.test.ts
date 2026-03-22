import assert from "node:assert/strict"
import test from "node:test"

import { CliError } from "../src/errors.js"
import { parseFileCardMessage, validateDownloadableFileCard } from "../src/protocol.js"

test("valid file card messages parse successfully", () => {
    const message =
        'tglfs:file\n{"name":"demo.txt","ufid":"abcd","size":4,"uploadComplete":true,"chunks":[1,2],"IV":"YWJjZA=="}'

    const parsed = parseFileCardMessage(message)
    assert.ok(parsed)
    assert.equal(parsed?.name, "demo.txt")
})

test("incomplete file cards are rejected for downloads", () => {
    assert.throws(
        () =>
            validateDownloadableFileCard({
                name: "demo.txt",
                ufid: "abcd",
                size: 4,
                uploadComplete: false,
                chunks: [1],
                IV: "YWJjZA==",
            }),
        (error: unknown) => error instanceof CliError && error.code === "invalid_file_card",
    )
})
