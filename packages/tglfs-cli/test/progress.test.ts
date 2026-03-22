import assert from "node:assert/strict"
import test from "node:test"

import { createByteProgressReporter, renderProgressLine } from "../src/progress.js"

test("progress lines render percentages and byte counts", () => {
    const line = renderProgressLine("Downloading", 512, 1024, 10)

    assert.match(line, /^Downloading \[[#-]{10}\] 50% 512 B \/ 1\.0 KiB$/)
})

test("TTY progress reporters render an updating line and finish with a newline", () => {
    const writes: string[] = []
    const reporter = createByteProgressReporter({
        label: "Downloading",
        totalBytes: 1024,
        enabled: true,
        stream: {
            isTTY: true,
            columns: 120,
            write(chunk: string) {
                writes.push(chunk)
                return true
            },
        },
    })

    reporter.update(0)
    reporter.update(1024)
    reporter.complete()

    assert.equal(writes.length, 3)
    assert.match(writes[0], /^\rDownloading /)
    assert.match(writes[1], /^\rDownloading /)
    assert.equal(writes[2], "\n")
})
