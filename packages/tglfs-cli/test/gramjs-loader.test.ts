import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

test("importing the web Telegram helper under Node does not emit the GramJS localStorage warning", async () => {
    const moduleUrl = new URL("../../../src/telegram.ts", import.meta.url).href
    const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `await import(${JSON.stringify(moduleUrl)}); console.log("ok")`,
        ],
        {
            cwd: new URL("..", import.meta.url),
            env: {
                ...process.env,
                NODE_NO_WARNINGS: "0",
            },
        },
    )

    assert.match(stdout, /\bok\b/)
    assert.doesNotMatch(stderr, /localstorage-file/i)
})

test("web folder listing filters tokenized parent search false positives", async () => {
    const { listFolderRecords } = await import("../../../src/telegram.ts")
    const now = "2026-05-14T12:00:00.000Z"
    const calls: any[] = []
    const makeFolderMessage = (id: number, name: string, folderId: string, parentFolderId: string, rootId = "folder-parent") => ({
        id,
        date: 1700000000 + id,
        message: `tglfs:folder\n${JSON.stringify({
            type: "tglfs:folder",
            version: 2,
            folderId,
            parentFolderId,
            rootId,
            name,
            path: name,
            createdAt: now,
            updatedAt: now,
            deleted: false,
        })}`,
    })
    const client = {
        async getMessages(_: string, options: any) {
            calls.push(options)
            if (options.maxId === 0) {
                return [
                    makeFolderMessage(30, "Parent", "folder-parent", "folder-parent"),
                    makeFolderMessage(20, "Grandchild", "folder-grandchild", "folder-child"),
                ]
            }
            if (options.maxId === 20) {
                return [
                    makeFolderMessage(15, "Child A", "folder-child-a", "folder-parent"),
                    makeFolderMessage(10, "Child B", "folder-child-b", "folder-parent"),
                ]
            }
            return []
        },
    } as any

    const records = await listFolderRecords(client, { parentFolderId: "folder-parent", limit: 2 })

    assert.deepEqual(records.map((record) => record.data.name), ["Child A", "Child B"])
    assert.deepEqual(calls.map((call) => call.maxId), [0, 20])
})
