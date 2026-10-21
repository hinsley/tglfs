import { readFile } from "node:fs/promises"
import { HelperStore } from "../../src/helper/store.js"
import { HelperQueue } from "../../src/helper/queue.js"
import { createHelperServer } from "../../src/helper/server.js"
import { createJobExecutor } from "../../src/helper/executor.js"
import { helperPairingCode } from "../../src/shared/helper-wire.js"
import { gramBlockFixture } from "./block-fixture.js"
import type { HelperConfig } from "../../src/helper/protocol.js"

// This process uses disposable files and an in-memory Telegram substitute.
const config: HelperConfig = JSON.parse(await readFile(process.argv[2], "utf8"))
const store = new HelperStore(process.argv[3])
await store.initialize()
const { client: gramClient } = await gramBlockFixture()
const client = {
    ...gramClient,
    async getMe() {
        return { id: 123 }
    },
    async destroy() {},
}
const execute = createJobExecutor(config, {
    connect: async () => ({ client, session: {} }) as any,
    disconnect: async () => {},
    blockSize: 65536,
})
const queue = new HelperQueue(store, "123", async (job, options) => {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Number(process.argv[4] ?? 500))
        options.signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                reject(options.signal.reason)
            },
            { once: true },
        )
    })
    return execute(job, options)
})
await queue.initialize()
let server: ReturnType<typeof createHelperServer>
const stop = async () => {
    server.close()
    await queue.stop()
    server.closeAllConnections()
}
server = createHelperServer(config, queue, { stop: () => void stop() })
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
process.stdout.write(`${helperPairingCode({ ...config, port: (server.address() as any).port })}\n`)
process.once("SIGTERM", () => void stop())
