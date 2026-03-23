import assert from "node:assert/strict"
import test from "node:test"

import { detectFileMode, formatDeleteConfirmation, inspectFileCard } from "../src/file-ops.js"
import { serializeFileCardMessage } from "../src/shared/file-cards.js"

test("detectFileMode falls back to the legacy probe when the current probe throws", async () => {
    const calls: string[] = []
    const result = await detectFileMode({ size: 8, ufid: "ufid-123" }, async (mode) => {
        calls.push(mode)
        if (mode === "current") {
            throw new Error("current failed")
        }
        return {
            bytesWritten: 8,
            computedUfid: "ufid-123",
        }
    })

    assert.deepEqual(calls, ["current", "legacy"])
    assert.equal(result.probe?.mode, "legacy")
    assert.equal(result.probe?.computedUfid, "ufid-123")
})

test("detectFileMode returns the current probe immediately when it matches", async () => {
    const calls: string[] = []
    const result = await detectFileMode({ size: 4, ufid: "ufid-456" }, async (mode) => {
        calls.push(mode)
        return {
            bytesWritten: 4,
            computedUfid: "ufid-456",
        }
    })

    assert.deepEqual(calls, ["current"])
    assert.equal(result.probe?.mode, "current")
})

test("inspectFileCard skips the expensive format probe unless explicitly requested", async () => {
    const fileCard = {
        name: "report.pdf",
        ufid: "ufid-skip-probe",
        size: 1234,
        uploadComplete: true,
        chunks: [111],
        IV: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }

    const client = {
        async getMessages(peer: string, options: any) {
            if (options?.ids) {
                return [
                    {
                        id: 111,
                        className: "Message",
                        media: {
                            document: {
                                size: 256,
                            },
                        },
                    },
                ]
            }

            return [
                {
                    id: 42,
                    date: 1_710_000_000,
                    message: serializeFileCardMessage(fileCard),
                },
            ]
        },
    }

    const result = await inspectFileCard(client as any, fileCard.ufid)

    assert.equal(result.format, "unknown")
    assert.equal(result.probe, undefined)
    assert.equal(result.probeError, "Format probe skipped. Re-run with --probe to verify current vs legacy format.")
})

test("formatDeleteConfirmation includes file names and UFIDs", () => {
    const message = formatDeleteConfirmation([
        {
            msgId: 10,
            date: 1_710_000_000,
            data: {
                name: "report.pdf",
                ufid: "ufid-a",
                size: 1536,
                uploadComplete: true,
                chunks: [1],
                IV: "iv-a",
            },
        },
        {
            msgId: 11,
            date: 1_710_000_001,
            data: {
                name: "notes.txt",
                ufid: "ufid-b",
                size: 42,
                uploadComplete: true,
                chunks: [2],
                IV: "iv-b",
            },
        },
    ])

    assert.match(message, /Delete 2 file\(s\) from Saved Messages\?/)
    assert.match(message, /report\.pdf/)
    assert.match(message, /notes\.txt/)
    assert.match(message, /ufid-a/)
    assert.match(message, /ufid-b/)
})
