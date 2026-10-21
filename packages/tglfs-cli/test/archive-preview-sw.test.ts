import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import vm from "node:vm"

const source = await readFile(new URL("../../../public/service-worker.js", import.meta.url), "utf8")

function worker(downloadOnly = false) {
    const handlers = new Map<string, (event: any) => void>()
    const context = vm.createContext({
        self: {
            location: { origin: "https://tglfs.test" },
            addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, handler) },
            clients: { get: async (id: string) => id === "owner" ? { id } : null },
        },
        Response, Request, URL, ReadableStream, Uint8Array, setTimeout, clearTimeout, console,
    })
    vm.runInContext(source, context)
    const ranges: Array<{ offset: number; length: number }> = []
    const messages: any[] = []
    const port = {
        onmessage: null as ((event: any) => void) | null,
        closed: false,
        start() {},
        close() { this.closed = true },
        postMessage(data: any) {
            messages.push(data)
            if (data.type !== "read") return
            ranges.push({ offset: data.offset, length: data.length })
            const bytes = new Uint8Array(data.length)
            for (let index = 0; index < bytes.length; index++) bytes[index] = (data.offset + index) % 256
            queueMicrotask(() => port.onmessage?.({ data: { id: data.id, bytes } }))
        },
    }
    const token = "a".repeat(32)
    handlers.get("message")!({ data: { type: "REGISTER_ARCHIVE_MEMBER", token, size: 1024 * 1024, name: "x\"\r\n.txt", mime: "video/mp4", downloadOnly }, source: { id: "owner" }, ports: [port] })
    async function fetchMember(options: { range?: string; method?: string; token?: string; clientId?: string; resultingClientId?: string; download?: boolean } = {}) {
        let response!: Promise<Response>
        const request = new Request(`https://tglfs.test/archive-member/${options.token ?? token}${options.download ? "?download=1" : ""}`, {
            method: options.method || "GET", headers: options.range ? { Range: options.range } : {},
        })
        handlers.get("fetch")!({ request, clientId: options.clientId ?? "owner", resultingClientId: options.resultingClientId, respondWith(value: Promise<Response>) { response = value } })
        return response
    }
    return { context, ranges, port, messages, fetchMember }
}

test("archive range parsing supports explicit, open and suffix ranges and refuses malformed input", () => {
    const { context } = worker()
    const range = (value: string | null, size: number) => JSON.parse(JSON.stringify(vm.runInContext(`parseArchiveRange(${JSON.stringify(value)}, ${size})`, context)))
    assert.deepEqual(range("bytes=10-19", 100), { start: 10, end: 19, partial: true })
    assert.deepEqual(range("bytes=90-", 100), { start: 90, end: 99, partial: true })
    assert.deepEqual(range("bytes=-20", 100), { start: 80, end: 99, partial: true })
    assert.deepEqual(range("bytes=-200", 100), { start: 0, end: 99, partial: true })
    assert.deepEqual(range(null, 0), { start: 0, end: -1, partial: false })
    for (const value of ["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=0-1,5-6", "bytes=-", "bytes=9007199254740992-"]) assert.equal(range(value, 100), null)
    assert.equal(range("bytes=0-0", 0), null)
})

test("member requests fetch only requested bytes with 206 and no plaintext caching", async () => {
    const { fetchMember, ranges } = worker()
    const response = await fetchMember({ range: "bytes=400-499" })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get("Content-Range"), "bytes 400-499/1048576")
    assert.equal(response.headers.get("Cache-Control"), "no-store, private")
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff")
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from({ length: 100 }, (_, index) => (400 + index) % 256))
    assert.deepEqual(ranges, [{ offset: 400, length: 100 }])
})

test("HEAD and invalid ranges do not fetch member data", async () => {
    const { fetchMember, ranges } = worker()
    const head = await fetchMember({ method: "HEAD", range: "bytes=-5" })
    assert.equal(head.status, 206)
    assert.equal(head.headers.get("Content-Length"), "5")
    assert.equal(await head.text(), "")
    const invalid = await fetchMember({ range: "bytes=1048576-" })
    assert.equal(invalid.status, 416)
    assert.equal(invalid.headers.get("Content-Range"), "bytes */1048576")
    assert.deepEqual(ranges, [])
})

test("whole-member responses read bounded pieces and closed previews return 410", async () => {
    const { fetchMember, ranges, port } = worker()
    const response = await fetchMember()
    assert.equal(response.status, 200)
    assert.equal((await response.arrayBuffer()).byteLength, 1024 * 1024)
    assert.equal(ranges.length, 4)
    assert.ok(ranges.every(({ length }) => length <= 256 * 1024))
    port.onmessage!({ data: { type: "close" } })
    assert.equal(port.closed, true)
    assert.equal((await fetchMember()).status, 410)
    assert.equal((await fetchMember({ token: "unknown" })).status, 410)
})

test("member response rejects short reads instead of emitting unverifiable lengths", async () => {
    const { fetchMember, port } = worker()
    port.postMessage = (data: any) => {
        if (data.type === "read") queueMicrotask(() => port.onmessage?.({ data: { id: data.id, bytes: new Uint8Array(1), length: 1 } }))
    }
    const response = await fetchMember({ range: "bytes=0-9" })
    await assert.rejects(response.arrayBuffer(), /Invalid archive preview response/)
})

test("member URLs refuse another tab and allow a child created by the owner", async () => {
    const { fetchMember, ranges } = worker()
    assert.equal((await fetchMember({ clientId: "another-tab" })).status, 403)
    assert.equal((await fetchMember({ clientId: "" })).status, 403)
    assert.deepEqual(ranges, [])
    assert.equal((await fetchMember({ method: "HEAD", resultingClientId: "pdf-child" })).status, 200)
    assert.equal((await fetchMember({ method: "HEAD", clientId: "pdf-child" })).status, 200)
    assert.equal((await fetchMember({ method: "HEAD", clientId: "another-tab", resultingClientId: "untrusted-child" })).status, 403)
    assert.equal((await fetchMember({ method: "HEAD", clientId: "untrusted-child" })).status, 403)
})

test("a partial attachment response does not signal completion of the whole download", async () => {
    const { fetchMember, messages } = worker()
    const partial = await fetchMember({ range: "bytes=0-9", download: true })
    assert.equal(partial.status, 206)
    assert.equal((await partial.arrayBuffer()).byteLength, 10)
    assert.equal(messages.filter((message) => message.type === "download-complete").length, 0)
    const complete = await fetchMember({ download: true })
    assert.equal((await complete.arrayBuffer()).byteLength, 1024 * 1024)
    assert.equal(messages.filter((message) => message.type === "download-complete").length, 1)
    assert.match(complete.headers.get("Content-Disposition")!, /^attachment; filename\*=UTF-8''x%22%0D%0A.txt$/)
})

test("owner-authorized download tokens allow one full ownerless navigation and refuse reuse", async () => {
    const { fetchMember, ranges } = worker(true)
    assert.equal((await fetchMember({ clientId: "", download: true, range: "bytes=0-9" })).status, 403)
    assert.equal((await fetchMember({ clientId: "", download: true, method: "HEAD" })).status, 403)
    assert.equal((await fetchMember({ clientId: "another-tab", download: true })).status, 403)
    assert.equal((await fetchMember({ clientId: "" })).status, 403)
    assert.deepEqual(ranges, [])
    const response = await fetchMember({ clientId: "", download: true })
    assert.equal(response.status, 200)
    assert.equal((await response.arrayBuffer()).byteLength, 1024 * 1024)
    assert.equal((await fetchMember({ clientId: "", download: true })).status, 403)
})

test("download completion is sent with the final bytes without requiring another pull", async () => {
    const { fetchMember, messages } = worker(true)
    const response = await fetchMember({ clientId: "", download: true })
    const reader = response.body!.getReader()
    for (let part = 0; part < 4; part++) {
        const result = await reader.read()
        assert.equal(result.done, false)
        assert.equal(result.value!.byteLength, 256 * 1024)
    }
    assert.equal(messages.filter((message) => message.type === "download-complete").length, 1)
    assert.equal((await reader.read()).done, true)
})
