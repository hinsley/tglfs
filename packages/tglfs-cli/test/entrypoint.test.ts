import assert from "node:assert/strict"
import { mkdtemp, symlink } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const runtimeFixtureUrl = pathToFileURL(resolve(fixtureDir, "fixtures/automation-runtime.mjs")).href
const cliSourcePath = resolve(fixtureDir, "..", "src", "cli.ts")
const workspaceRoot = resolve(fixtureDir, "..", "..")

function runCliByPath(entryPath: string, args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", "--import", runtimeFixtureUrl, entryPath, ...args], {
        cwd: workspaceRoot,
        encoding: "utf8",
    })
}

test("direct source CLI invocation still executes the entrypoint", () => {
    const result = runCliByPath(cliSourcePath, ["status"])

    assert.equal(result.status, 0)
    assert.match(result.stdout, /Authorized as Test\./)
    assert.equal(result.stderr, "")
})

test("symlinked source CLI invocation executes the entrypoint and prints JSON output", async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "tglfs-entrypoint-"))
    const symlinkPath = resolve(tempDir, "tglfs.ts")
    await symlink(cliSourcePath, symlinkPath)

    const result = runCliByPath(symlinkPath, ["status", "--json"])

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
    assert.notEqual(result.stdout.trim(), "")

    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.authorized, true)
    assert.equal(payload.identity.firstName, "Test")
})
