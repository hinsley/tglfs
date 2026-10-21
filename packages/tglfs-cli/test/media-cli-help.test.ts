import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
for (const args of [
    ["make-previewable", "--help"],
    ["help", "make-previewable"],
    ["--no-interactive", "make-previewable", "--help"],
]) {
    test(`MP4 CLI help exits normally: ${args.join(" ")}`, () => {
        const result = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { encoding: "utf8" })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /--source-password/)
        assert.doesNotMatch(result.stdout, /\n\s+--password(?:\s|\-)/)
        assert.doesNotMatch(result.stdout, /TGLFS_MAKE_PREVIEWABLE_PASSWORD/)
        assert.match(result.stdout, /always uses the source password/)
        assert.doesNotMatch(result.stderr, /unsettled top-level await/)
    })
}
test("root help includes the versioned media upgrade action", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", entry, "--help"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /upgrade-media-preview/)
    assert.match(result.stdout, /make-previewable/)
})
