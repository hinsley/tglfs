import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { EXIT_CODES } from "../src/errors.js"

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const runtimeFixture = resolve(fixtureDir, "fixtures/automation-runtime.mjs")
const runnerFixture = resolve(fixtureDir, "fixtures/run-cli-with-runtime.mjs")
const workspaceRoot = resolve(fixtureDir, "..", "..")

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ["--import", "tsx", runnerFixture, runtimeFixture, ...args], {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: { ...process.env, ...env },
    })
}

test("status --json prints a concrete JSON result to stdout", () => {
    const result = runCli(["status", "--json"])

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
    assert.notEqual(result.stdout.trim(), "")

    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.authorized, true)
    assert.equal(payload.identity.firstName, "Test")
})

test("search --json prints an empty JSON result set instead of silence", () => {
    const result = runCli(["search", "query", "--json"])

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
    assert.notEqual(result.stdout.trim(), "")

    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.query, "query")
    assert.deepEqual(payload.results, [])
})

test("upload --json defaults to an unencrypted upload and returns a verifiable success payload", async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "tglfs-cli-upload-"))
    const inputPath = resolve(tempDir, "file.png")
    await writeFile(inputPath, "fixture")

    const result = runCli(["upload", inputPath, "--json"])

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
    assert.notEqual(result.stdout.trim(), "")

    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.ufid, "test-ufid-123")
    assert.equal(payload.name, "file.png")
    assert.equal(payload.messageId, 321)
    assert.equal(payload.msgId, 321)
})

test("login --json fails loudly with a nonzero exit code when required input is missing", async () => {
    const tempHome = await mkdtemp(resolve(tmpdir(), "tglfs-cli-home-"))
    const result = runCli(["login", "--json"], {
        HOME: tempHome,
        TGLFS_PHONE: "",
        TGLFS_LOGIN_CODE: "",
        TGLFS_2FA_PASSWORD: "",
    })

    assert.equal(result.status, EXIT_CODES.INTERACTIVE_REQUIRED)
    assert.equal(result.stdout, "")
    assert.notEqual(result.stderr.trim(), "")

    const payload = JSON.parse(result.stderr)
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, "interactive_required")
})
