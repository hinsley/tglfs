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
