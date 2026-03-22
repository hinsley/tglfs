import assert from "node:assert/strict"
import test from "node:test"

import { storePaths } from "../src/store.js"

test("store paths use the plain tglfs app name without the nodejs suffix", () => {
    assert.match(storePaths.configFile, /tglfs/i)
    assert.match(storePaths.sessionFile, /tglfs/i)
    assert.doesNotMatch(storePaths.configFile, /tglfs-nodejs/i)
    assert.doesNotMatch(storePaths.sessionFile, /tglfs-nodejs/i)
})
