import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath, symlink, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HelperStore } from "../src/helper/store.js"
import { HelperQueue } from "../src/helper/queue.js"
import { createHelperServer } from "../src/helper/server.js"
import { createJobExecutor } from "../src/helper/executor.js"
import { browseFiles, openSources, safeDownloadName, selectedSources } from "../src/helper/files.js"
import {
    parseHelperConfig,
    parseHelperJob,
    parseHelperProcess,
    type HelperConfig,
    type HelperJob,
} from "../src/helper/protocol.js"
import {
    helperPairingCode,
    helperRequest,
    openHelperPassword,
    parseHelperPairing,
    requestSignature,
    responseSignature,
    sealHelperPassword,
} from "../src/shared/helper-wire.js"
import { gramBlockFixture } from "./helpers/block-fixture.js"
import { openBlockFile } from "../src/shared/block-transfer.js"
import { parseFileCardMessage } from "../src/shared/file-cards.js"

const fixture = <T>(name: string): Promise<T> =>
    readFile(new URL(`./fixtures/helper/${name}-v1.json`, import.meta.url), "utf8").then(JSON.parse)
const uploadJob = async (changes: Partial<HelperJob> = {}): Promise<HelperJob> => ({
    ...(await fixture<HelperJob>("job")),
    id: randomUUID(),
    status: "queued",
    uploadSessionId: undefined,
    ...changes,
})
const configIn = (path: string): HelperConfig => ({
    type: "tglfs:helper-config",
    version: 1,
    port: 27386,
    token: randomBytes(32).toString("base64url"),
    origins: ["https://tglfs.vercel.app"],
    uploadRoots: [path],
    downloadDir: join(path, "downloads"),
})
async function temporary() {
    return realpath(await mkdtemp(join(tmpdir(), "tglfs-helper-test-")))
}
async function waitFor(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 1500; i++) {
        if (await check()) return
        await new Promise((r) => setTimeout(r, 10))
    }
    assert.fail("Timed out waiting for helper state")
}

test("helper v1 serialized records round trip, refusing future versions, malformed data and unknown fields", async () => {
    for (const [name, parser] of [
        ["job", parseHelperJob],
        ["config", parseHelperConfig],
        ["process", parseHelperProcess],
    ] as const) {
        const value = await fixture<any>(name)
        assert.deepEqual(parser(JSON.parse(JSON.stringify(value))), value)
        for (const version of [undefined, 0, 2, "1"]) assert.throws(() => parser({ ...value, version }))
        assert.throws(() => parser({ ...value, futureField: true }), /cannot be edited/)
        assert.throws(() => parser({ ...value, type: "other" }))
    }
    const job = await uploadJob()
    assert.throws(() => parseHelperJob({ ...job, sources: [{ ...job.sources![0], password: "must refuse" }] }))
    assert.throws(() => parseHelperJob({ ...job, size: -1 }))
    assert.throws(() => parseHelperJob({ ...job, result: { ufid: "x", msgId: -1 } }))
    assert.throws(() => parseHelperConfig({ ...configIn("/x"), origins: ["http://evil.test"] }))
})

test("pairing fixes the destination to loopback and separately encrypts empty and nonempty passwords", async () => {
    const config = configIn("/x")
    assert.deepEqual(parseHelperPairing(helperPairingCode(config)), { port: config.port, token: config.token })
    for (const value of [
        "https://evil.test",
        helperPairingCode(config).replace(":1:", ":2:"),
        `tglfs-helper:1:80:${config.token}`,
    ])
        assert.throws(() => parseHelperPairing(value))
    for (const password of ["", "sëcret 🔒 password"]) {
        const secret = await sealHelperPassword(password, config.token, "request")
        assert.equal(await openHelperPassword(secret, config.token, "request"), password)
        assert.equal(JSON.stringify(secret).includes("password"), false)
        await assert.rejects(openHelperPassword(secret, config.token, "another-request"))
        await assert.rejects(openHelperPassword(secret, randomBytes(32).toString("base64url"), "request"))
        await assert.rejects(openHelperPassword({ ...secret, version: 2 } as any, config.token, "request"))
    }
    await assert.rejects(
        helperRequest(config, "/v1/status", undefined, {
            fetch: async () => new Response('{"type":"tglfs:helper-response","version":1,"ok":true}'),
        }),
        /authenticated/,
    )
    const forged: typeof fetch = async (_url, init) => {
        const body = JSON.stringify({ type: "tglfs:helper-response", version: 2, ok: true })
        return new Response(body, {
            headers: {
                "X-TGLFS-Signature": await responseSignature(
                    config.token,
                    (init!.headers as any)["X-TGLFS-Nonce"],
                    200,
                    body,
                ),
            },
        })
    }
    await assert.rejects(helperRequest(config, "/v1/status", undefined, { fetch: forged }), /version/)
})

test("helper reads only granted regular files, refuses traversal/symlinks and detects changes before resuming", async () => {
    const path = await temporary(),
        outside = await temporary()
    try {
        const config = configIn(path)
        await writeFile(join(path, "a.txt"), "hello")
        await writeFile(join(outside, "secret"), "private")
        await symlink(join(outside, "secret"), join(path, "link"))
        await symlink(outside, join(path, "escape"))
        const listing = await browseFiles(config, "root0", "")
        assert.deepEqual(
            listing.entries.map((e) => e.name),
            ["a.txt"],
        )
        for (const name of ["../secret", "/secret", "link", "escape/secret", "..\\secret"])
            await assert.rejects(selectedSources(config, "root0", [name]))
        await assert.rejects(selectedSources(config, "root1", ["a.txt"]))
        if (process.platform !== "win32") {
            const { spawnSync } = await import("node:child_process")
            const fifo = join(path, "pipe")
            assert.equal(spawnSync("mkfifo", [fifo]).status, 0)
            await assert.rejects(selectedSources(config, "root0", ["pipe"]), /regular files/)
        }
        const sources = await selectedSources(config, "root0", ["a.txt"])
        const opened = await openSources(config, sources)
        assert.equal(await new Response(opened.entries[0].range(1, 4)).text(), "ell")
        await opened.close()
        await writeFile(join(path, "a.txt"), "changed")
        await assert.rejects(openSources(config, sources), /changed/)
        assert.equal(safeDownloadName("../../escape.mov"), ".._.._escape.mov")
        assert.equal(safeDownloadName("CON"), "download")
    } finally {
        await rm(path, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
    }
})

test("queue retries are idempotent, passwords are absent from disk, and restart requires unlocking", async () => {
    const path = await temporary(),
        password = "not written anywhere 🔒"
    try {
        const store = new HelperStore(path)
        await store.initialize()
        let runs = 0
        const queue = new HelperQueue(store, "123", async (_job, options) => {
            runs++
            assert.equal(options.password, password)
            await options.session("b".repeat(32))
            return { ufid: "finished" }
        })
        await queue.initialize()
        const job = await uploadJob()
        await Promise.all([queue.add(structuredClone(job), password), queue.add(structuredClone(job), password)])
        await queue.idle()
        await queue.add(structuredClone(job), password)
        assert.equal(runs, 1)
        assert.equal(queue.list()[0].status, "done")
        const content = await readFile(join(path, "jobs", `${job.id}.json`), "utf8")
        assert.equal(content.includes(password), false)
        assert.equal(content.includes('"password"'), false)
        assert.equal((await stat(join(path, "jobs", `${job.id}.json`))).mode & 0o777, 0o600)
        const interrupted = await uploadJob({ status: "running" })
        await store.saveJob(interrupted)
        const restarted = new HelperQueue(store, "123", async (_job, options) => {
            assert.equal(options.password, "")
            return { ufid: "resumed" }
        })
        await restarted.initialize()
        assert.equal(restarted.list().find((j) => j.id === interrupted.id)?.status, "needs-password")
        await restarted.idle()
        assert.equal(restarted.list().find((j) => j.id === interrupted.id)?.status, "needs-password")
        await restarted.unlock(interrupted.id, "")
        await restarted.idle()
        assert.equal(restarted.list().find((j) => j.id === interrupted.id)?.status, "done")
        await assert.rejects(
            new HelperQueue(store, "999", async () => ({ ufid: "x" })).initialize(),
            /another Telegram account/,
        )
        await assert.rejects(queue.add({ ...job, name: "different" }, password), /already used/)
        await store.saveJob(await uploadJob())
        const futurePath = join(path, "jobs", `${randomUUID()}.json`)
        const future = { ...(await uploadJob()), version: 2 }
        await writeFile(futurePath, JSON.stringify(future))
        await assert.rejects(new HelperQueue(store, "123", async () => ({ ufid: "x" })).initialize())
        assert.deepEqual(JSON.parse(await readFile(futurePath, "utf8")), JSON.parse(JSON.stringify(future)))
    } finally {
        await rm(path, { recursive: true, force: true })
    }
})

test("stopping aborts an active job and clears queued passwords without cancelling recoverable jobs", async () => {
    const path = await temporary()
    try {
        const store = new HelperStore(path)
        await store.initialize()
        let active = false
        const queue = new HelperQueue(store, "123", async (_job, { signal }) => {
            active = true
            await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
            throw new Error("unreachable")
        })
        await queue.initialize()
        await queue.add(await uploadJob(), "pw")
        await waitFor(() => active)
        await queue.add(await uploadJob(), "pw")
        await queue.stop()
        assert.deepEqual(
            queue.list().map((j) => j.status),
            ["needs-password", "needs-password"],
        )
        await assert.rejects(queue.add(await uploadJob(), "pw"), /stopping/)
    } finally {
        await rm(path, { recursive: true, force: true })
    }
})

test("HTTP control authenticates both directions, refuses origins/replays/account mismatch and survives control disconnect", async () => {
    const path = await temporary(),
        config = configIn(path),
        password = "private password"
    const store = new HelperStore(join(path, "queue"))
    await store.initialize()
    await writeFile(join(path, "upload.txt"), "hello")
    let finish!: () => void,
        started = false,
        executions = 0
    const wait = new Promise<void>((resolve) => {
        finish = resolve
    })
    const queue = new HelperQueue(store, "123", async (_job, options) => {
        started = true
        executions++
        assert.equal(options.password, password)
        await wait
        return { ufid: "done" }
    })
    await queue.initialize()
    const server = createHelperServer(config, queue)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as any).port,
        pair = { ...config, port }
    const url = `http://127.0.0.1:${port}`
    try {
        const get = await helperRequest(pair, "/v1/status")
        assert.equal(get.accountId, "123")
        assert.equal((await fetch(`${url}/v1/status`, { headers: { Origin: "https://evil.test" } })).status, 403)
        assert.equal((await fetch(`${url}/v1/status`)).status, 401)
        const preflight = await fetch(`${url}/v1/status`, {
            method: "OPTIONS",
            headers: {
                Origin: config.origins[0],
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-tglfs-signature,x-tglfs-nonce,x-tglfs-time,content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        })
        assert.equal(preflight.status, 204)
        assert.equal(preflight.headers.get("Access-Control-Allow-Private-Network"), "true")
        const nonce = randomBytes(16).toString("hex"),
            time = String(Date.now()),
            signature = await requestSignature(config.token, "GET", "/v1/status", time, nonce, "")
        const headers = { "X-TGLFS-Nonce": nonce, "X-TGLFS-Time": time, "X-TGLFS-Signature": signature }
        assert.equal((await fetch(`${url}/v1/status`, { headers })).status, 200)
        assert.equal((await fetch(`${url}/v1/status`, { headers })).status, 401)
        await assert.rejects(
            helperRequest(pair, "/v1/browse", {
                type: "tglfs:helper-request",
                version: 1,
                accountId: "999",
                rootId: "root0",
                path: "",
            }),
            /account/,
        )
        const id = randomUUID(),
            body = {
                type: "tglfs:helper-request",
                version: 1,
                accountId: "123",
                id,
                direction: "upload",
                rootId: "root0",
                files: ["upload.txt"],
                parentFolderId: "root",
                secret: await sealHelperPassword(password, config.token, id),
            }
        const controller = new AbortController()
        await helperRequest(pair, "/v1/jobs", body, { signal: controller.signal })
        controller.abort()
        await waitFor(() => started)
        assert.equal(queue.list()[0].status, "running")
        await helperRequest(pair, "/v1/jobs", body)
        assert.equal(executions, 1)
        finish()
        await queue.idle()
        assert.equal(queue.list()[0].status, "done")
        const status = await helperRequest(pair, "/v1/status")
        assert.equal(status.jobs[0].sources, undefined)
        assert.equal(JSON.stringify(status).includes(password), false)
        await helperRequest(pair, "/v1/jobs", body)
        assert.equal(executions, 1)
    } finally {
        finish()
        await queue.stop()
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
        })
        await rm(path, { recursive: true, force: true })
    }
})

test("native executor streams encrypted uploads and downloads with the same password and preserves originals", async () => {
    const path = await temporary(),
        config = configIn(path)
    const { fixture: remote, client: gramClient } = await gramBlockFixture()
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
    const store = new HelperStore(join(path, "queue"))
    await store.initialize()
    await mkdir(config.downloadDir)
    try {
        const original = randomBytes(200_001)
        await writeFile(join(path, "source.bin"), original)
        const sources = await selectedSources(config, "root0", ["source.bin"])
        const queue = new HelperQueue(store, "123", execute)
        await queue.initialize()
        const upload = await uploadJob({ sources, name: "source.bin", size: original.length, total: original.length })
        remote.controls.failBlock = 1
        await queue.add(upload, "same-password")
        await queue.idle()
        assert.equal(queue.list()[0].status, "failed")
        assert.ok(queue.list()[0].uploadSessionId)
        const sent = remote.blockSends
        const resumed = new HelperQueue(store, "123", execute)
        await resumed.initialize()
        await resumed.unlock(upload.id, "wrong-password")
        await resumed.idle()
        assert.equal(remote.blockSends, sent)
        assert.equal(resumed.list()[0].status, "failed")
        remote.controls.failBlock = -1
        await resumed.unlock(upload.id, "same-password")
        await resumed.idle()
        const result = resumed.list()[0]
        assert.equal(result.status, "done", result.error)
        assert.equal(remote.blockSends, 4)
        assert.deepEqual(await readFile(join(path, "source.bin")), original)
        const data = parseFileCardMessage(remote.messages.find((m) => m.id === result.result?.msgId)!.message)! as any
        const reader = await openBlockFile(remote.client, { ...remote.options, data, password: "same-password" })
        assert.equal(reader.plan.size, original.length)
        await assert.rejects(openBlockFile(remote.client, { ...remote.options, data, password: "changed-password" }))
        const id = randomUUID(),
            outputPath = join(config.downloadDir, id, "source.bin")
        const download: HelperJob = {
            type: "tglfs:helper-job",
            version: 1,
            id,
            accountId: "123",
            direction: "download",
            name: "source.bin",
            size: data.size,
            total: data.size,
            bytes: 0,
            status: "queued",
            phase: "Queued",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ufid: data.ufid,
            fileVersion: 5,
            messageId: result.result!.msgId,
            outputPath,
        }
        const map = JSON.parse(new TextDecoder().decode(remote.documents.get(data.chunks[0])))
        remote.controls.failRead = map.messages[1]
        await resumed.add(download, "same-password")
        await resumed.idle()
        assert.equal(resumed.list().find((j) => j.id === id)?.status, "failed")
        assert.equal((await readFile(`${outputPath}.tglfs-${data.content.id}.part`)).length, 65536)
        remote.controls.failRead = -1
        remote.reads.length = 0
        const resumedDownload = new HelperQueue(store, "123", execute)
        await resumedDownload.initialize()
        await resumedDownload.unlock(id, "same-password")
        await resumedDownload.idle()
        assert.equal(resumedDownload.list().find((j) => j.id === id)?.status, "done")
        assert.equal(remote.reads.includes(map.messages[0]), false)
        assert.deepEqual(await readFile(outputPath), original)
        const execution = { signal: new AbortController().signal, progress() {}, async session() {} }
        await assert.rejects(execute(download, { ...execution, password: "wrong-password" }))
        remote.reads.length = 0
        assert.deepEqual(await execute(download, { ...execution, password: "same-password" }), {
            ufid: data.ufid,
            outputPath,
        })
        assert.equal(
            remote.reads.some((id) => map.messages.includes(id)),
            false,
        )
        await writeFile(outputPath, original.subarray(1))
        await assert.rejects(execute(download, { ...execution, password: "same-password" }), /preserved/)
        assert.deepEqual(await readFile(outputPath), original.subarray(1))
        assert.equal(remote.deletes.length, 0)
        await assert.rejects(
            execute(
                { ...download, id: randomUUID(), outputPath: join(path, "outside.bin") },
                { password: "same-password", signal: new AbortController().signal, progress() {}, async session() {} },
            ),
            /destination/,
        )
    } finally {
        await rm(path, { recursive: true, force: true })
    }
})

test("a detached helper completes after its separate browser control process exits", async () => {
    const { spawn } = await import("node:child_process")
    const path = await temporary(),
        config = configIn(path)
    await mkdir(config.downloadDir)
    await writeFile(join(path, "video.bin"), randomBytes(160_000))
    const configPath = join(path, "config.json")
    await writeFile(configPath, JSON.stringify(config))
    const child = spawn(
        process.execPath,
        [
            "--import",
            "tsx",
            new URL("./helpers/helper-process.ts", import.meta.url).pathname,
            configPath,
            join(path, "queue"),
            "700",
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    let error = ""
    child.stderr!.on("data", (data) => {
        error += data
    })
    let pairing = ""
    child.stdout!.on("data", (data) => {
        pairing += data
    })
    let pair: ReturnType<typeof parseHelperPairing> | undefined
    try {
        await waitFor(() => pairing.includes("\n"))
        pair = parseHelperPairing(pairing.trim())
        const id = randomUUID()
        const body = {
            type: "tglfs:helper-request",
            version: 1,
            accountId: "123",
            id,
            direction: "upload",
            rootId: "root0",
            files: ["video.bin"],
            parentFolderId: "root",
            secret: await sealHelperPassword("process-password", pair.token, id),
        }
        const wirePath = new URL("../src/shared/helper-wire.ts", import.meta.url).href
        const control = spawn(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                `import {helperRequest} from ${JSON.stringify(wirePath)}; await helperRequest(${JSON.stringify(pair)}, "/v1/jobs", ${JSON.stringify(body)});`,
            ],
            { stdio: "ignore" },
        )
        const code = await new Promise((resolve) => control.once("exit", resolve))
        assert.equal(code, 0)
        assert.equal((await helperRequest(pair, "/v1/status")).jobs[0].status, "running")
        await waitFor(async () => (await helperRequest(pair!, "/v1/status")).jobs[0].status === "done")
        const serialized = await readFile(join(path, "queue", "jobs", `${id}.json`), "utf8")
        assert.equal(serialized.includes("process-password"), false)
        assert.equal(error, "")
        assert.equal((await stat(join(path, "video.bin"))).size, 160_000)
    } finally {
        if (pair)
            await helperRequest(pair, "/v1/stop", { type: "tglfs:helper-request", version: 1, accountId: "123" }).catch(
                () => {},
            )
        child.kill("SIGTERM")
        await new Promise<void>((resolve) => {
            if (child.exitCode !== null) resolve()
            else child.once("exit", () => resolve())
        })
        await rm(path, { recursive: true, force: true })
    }
})

test("helper cancellation stops an active transfer while allowing the next queued job to finish", async () => {
    const path = await temporary()
    try {
        const store = new HelperStore(path)
        await store.initialize()
        let active = false
        const first = await uploadJob(),
            next = await uploadJob()
        const queue = new HelperQueue(store, "123", async (job, { signal }) => {
            if (job.id === first.id) {
                active = true
                await new Promise((_, reject) =>
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                )
            }
            return { ufid: "done" }
        })
        await queue.initialize()
        await queue.add(first, "one")
        await waitFor(() => active)
        await queue.add(next, "two")
        await queue.cancel(first.id)
        await queue.idle()
        assert.equal(queue.list().find((j) => j.id === first.id)?.status, "cancelled")
        assert.equal(queue.list().find((j) => j.id === next.id)?.status, "done")
    } finally {
        await rm(path, { recursive: true, force: true })
    }
})

test("control response size is bounded before decoding an untrusted endpoint", async () => {
    let cancelled = false
    const forged: typeof fetch = async () =>
        new Response(
            new ReadableStream({
                pull(controller) {
                    controller.enqueue(new Uint8Array(1024 * 1024))
                },
                cancel() {
                    cancelled = true
                },
            }),
        )
    await assert.rejects(helperRequest(configIn("/x"), "/v1/status", undefined, { fetch: forged }), /size limit/)
    assert.equal(cancelled, true)
})

test("native multi-file upload creates a browsable encrypted archive with an empty password", async () => {
    const path = await temporary(),
        config = configIn(path)
    const { fixture: remote, client: gramClient } = await gramBlockFixture()
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
    try {
        await mkdir(join(path, "sub"))
        await writeFile(join(path, "a.txt"), "one")
        await writeFile(join(path, "sub", "a.txt"), "two")
        const sources = await selectedSources(config, "root0", ["a.txt", "sub/a.txt"])
        const { computeTarSize } = await import("../src/shared/archive.js")
        const size = computeTarSize(
            sources.map((s) => ({
                name: s.name,
                size: s.size,
                lastModified: s.modified,
                stream() {
                    throw new Error("unused")
                },
            })),
        )
        const job = await uploadJob({ name: "batch.tar", sources, size, total: size })
        const result = await execute(job, {
            password: "",
            signal: new AbortController().signal,
            progress() {},
            async session() {},
        })
        const data = parseFileCardMessage(remote.messages.find((m) => m.id === result.msgId)!.message)! as any
        const reader = await openBlockFile(remote.client, { ...remote.options, data, password: "" })
        assert.deepEqual(
            reader.plan.directory!.entries.map((e) => e.path),
            ["a.txt", "sub/a.txt"],
        )
        await assert.rejects(openBlockFile(remote.client, { ...remote.options, data, password: "other" }))
        assert.equal(remote.deletes.length, 0)
    } finally {
        await rm(path, { recursive: true, force: true })
    }
})

test("helper CLI help includes native grants, pairing, recovery and destination controls", async () => {
    const { spawnSync } = await import("node:child_process")
    for (const args of [
        ["helper", "--help"],
        ["helper", "start", "--help"],
        ["helper", "stop", "--help"],
    ]) {
        const result = spawnSync(
            process.execPath,
            ["--import", "tsx", new URL("../src/cli.ts", import.meta.url).pathname, ...args],
            { encoding: "utf8" },
        )
        assert.equal(result.status, 0)
        assert.equal(result.stderr, "")
        if (args.includes("start")) {
            assert.match(result.stdout, /--upload-root/)
            assert.match(result.stdout, /--download-dir/)
            assert.match(result.stdout, /--origin/)
            assert.match(result.stdout, /--foreground/)
        } else if (!args.includes("stop")) {
            assert.match(result.stdout, /pair/)
            assert.match(result.stdout, /status/)
            assert.match(result.stdout, /stop/)
            assert.match(result.stdout, /password/)
        }
    }
})

test("daemon lifecycle preserves recoverable jobs, rejects a second process and refuses future locks", async () => {
    const { runHelperDaemon } = await import("../src/helper/daemon.js")
    const { createServer } = await import("node:net")
    const socket = createServer()
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
    const port = (socket.address() as any).port
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    const path = await temporary(),
        config = { ...configIn(path), port }
    const store = new HelperStore(join(path, "queue"))
    await store.saveConfig(config)
    await writeFile(join(path, "upload.txt"), "test")
    let running: Promise<void> | undefined,
        active = false
    const dependencies = {
        identity: async () => "123",
        executor:
            () =>
            async (_job: HelperJob, { signal }: any) => {
                active = true
                await new Promise((_, reject) =>
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                )
                return { ufid: "unused" }
            },
    }
    try {
        running = runHelperDaemon(store.directory, dependencies)
        await waitFor(async () => {
            try {
                await helperRequest(config, "/v1/status")
                return true
            } catch {
                return false
            }
        })
        await assert.rejects(runHelperDaemon(store.directory, dependencies), /already running/)
        const id = randomUUID()
        await helperRequest(config, "/v1/jobs", {
            type: "tglfs:helper-request",
            version: 1,
            accountId: "123",
            id,
            direction: "upload",
            rootId: "root0",
            files: ["upload.txt"],
            parentFolderId: "root",
            secret: await sealHelperPassword("", config.token, id),
        })
        await waitFor(() => active)
        await helperRequest(config, "/v1/stop", { type: "tglfs:helper-request", version: 1, accountId: "123" })
        await running
        running = undefined
        assert.equal((await store.jobs())[0].status, "needs-password")
        await assert.rejects(readFile(join(store.directory, "process.json")), { code: "ENOENT" })
        const lock = { type: "tglfs:helper-process", version: 2, pid: process.pid }
        await writeFile(join(store.directory, "process.json"), JSON.stringify(lock))
        await assert.rejects(runHelperDaemon(store.directory, dependencies), /Unsupported/)
        assert.deepEqual(JSON.parse(await readFile(join(store.directory, "process.json"), "utf8")), lock)
    } finally {
        if (running) {
            await helperRequest(config, "/v1/stop", {
                type: "tglfs:helper-request",
                version: 1,
                accountId: "123",
            }).catch(() => {})
            await running
        }
        await rm(path, { recursive: true, force: true })
    }
})

test("a queue storage failure clears passwords and requires a restart instead of silently continuing", async () => {
    const path = await temporary()
    try {
        const store = new HelperStore(path)
        await store.initialize()
        const save = store.saveJob.bind(store)
        let writes = 0,
            executed = false
        store.saveJob = async (job) => {
            if (++writes === 2) throw new Error("Sensitive filesystem details")
            await save(job)
        }
        const queue = new HelperQueue(store, "123", async () => {
            executed = true
            return { ufid: "unused" }
        })
        await queue.initialize()
        const job = await uploadJob()
        await queue.add(job, "private-password")
        await queue.idle()
        assert.equal(executed, false)
        assert.equal(queue.list()[0].status, "needs-password")
        assert.match(queue.list()[0].error!, /restart/)
        assert.equal(JSON.stringify(queue.list()).includes("Sensitive filesystem details"), false)
        await assert.rejects(queue.unlock(job.id, "private-password"))
        assert.equal((await store.jobs())[0].status, "queued")
    } finally {
        await rm(path, { recursive: true, force: true })
    }
})

test("empty files retain the v5 UFID through upload, download and completed-output recovery", async () => {
    const path = await temporary(),
        config = configIn(path)
    const { fixture: remote, client: gramClient } = await gramBlockFixture()
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
    })
    const options = { password: "", signal: new AbortController().signal, progress() {}, async session() {} }
    try {
        await mkdir(config.downloadDir)
        await writeFile(join(path, "empty.txt"), "")
        const sources = await selectedSources(config, "root0", ["empty.txt"])
        const upload = await execute(await uploadJob({ name: "empty.txt", size: 0, total: 0, sources }), options)
        const card = parseFileCardMessage(remote.messages.find((m) => m.id === upload.msgId)!.message)! as any
        const id = randomUUID(),
            outputPath = join(config.downloadDir, id, "empty.txt")
        const job: HelperJob = {
            type: "tglfs:helper-job",
            version: 1,
            id,
            accountId: "123",
            direction: "download",
            name: "empty.txt",
            size: 0,
            total: 0,
            bytes: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: "queued",
            phase: "Queued",
            messageId: upload.msgId,
            ufid: card.ufid,
            fileVersion: 5,
            outputPath,
        }
        assert.equal((await execute(job, options)).ufid, card.ufid)
        assert.equal((await execute(job, options)).ufid, card.ufid)
        assert.equal((await stat(outputPath)).size, 0)
    } finally {
        await rm(path, { recursive: true, force: true })
    }
})
