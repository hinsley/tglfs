import { basename, join } from "node:path"

import { CLI_FAIL_ON_PROMPT_SYMBOL, CLI_RUNTIME_OVERRIDE_SYMBOL } from "../../src/test-hooks.ts"
import { storePaths } from "../../src/store.ts"

// Missing-input tests must not inherit a real login from HOME or XDG settings.
const testStoreRoot = process.env.TGLFS_TEST_STORE_ROOT
if (testStoreRoot) {
    const configDir = join(testStoreRoot, "config")
    const dataDir = join(testStoreRoot, "data")
    Object.assign(storePaths, {
        configDir, dataDir,
        configFile: join(configDir, "config.json"),
        sessionFile: join(dataDir, "session.txt"),
    })
}

globalThis[CLI_FAIL_ON_PROMPT_SYMBOL] = true
globalThis[CLI_RUNTIME_OVERRIDE_SYMBOL] = {
    async connectAuthorizedClient() {
        return {
            client: { kind: "fake-client" },
            config: { chunkSize: 2 * 1024 * 1024 },
            session: { kind: "fake-session" },
        }
    },
    async persistAndDisconnectClient() {},
    async status() {
        return {
            configured: true,
            sessionPresent: true,
            authorized: true,
            phone: "+15555550123",
            identity: {
                id: "123",
                firstName: "Test",
                username: "test-user",
            },
            paths: {
                configDir: "/tmp/tglfs-config",
                dataDir: "/tmp/tglfs-data",
                configFile: "/tmp/tglfs-config/config.json",
                sessionFile: "/tmp/tglfs-data/session.txt",
            },
        }
    },
    async searchFileCards(_client, options = {}) {
        return {
            peer: options.peer ?? "me",
            query: options.query ?? "",
            sort: options.sort ?? "date_desc",
            limit: options.limit ?? 50,
            offsetId: options.offsetId,
            nextOffsetId: undefined,
            hasMore: false,
            results: [],
        }
    },
    async uploadPaths(_client, options) {
        if (options.password !== "") {
            throw new Error(`Expected an empty upload password, received ${JSON.stringify(options.password)}.`)
        }

        return {
            name: basename(options.paths[0]),
            ufid: "test-ufid-123",
            size: 123,
            msgId: 321,
            date: 1700000000,
            chunks: [322],
            sourcePaths: options.paths,
            archived: options.paths.length > 1,
        }
    },
}
