import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"

import { uploadResumableFile } from "../src/shared/block-transfer.js"
import { gramBlockFixture } from "./helpers/block-fixture.js"

const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../../../src/", import.meta.url)),
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
})
after(() => server.close())
const { PreviewModal } = await server.ssrLoadModule("/web/previewCore.ts")

const documents = [
    { name: "report.PDF", mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4\n%\xff\xfe\n%%EOF\n") },
    { name: "image.png", mime: "image/png", bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64")) },
]

for (const password of ["", "private"])
    for (const document of documents)
        test(`v5 ${document.name} preview serves its content type and original bytes (${password ? "protected" : "empty password"})`, async () => {
            const { fixture, client } = await gramBlockFixture()
            const record = await uploadResumableFile(fixture.client, {
                ...fixture.options,
                source: {
                    name: document.name,
                    size: document.bytes.length,
                    fingerprint: document.name,
                    archive: false,
                    slice: (start, end) => new Blob([document.bytes.slice(start, end)]).stream(),
                },
                password,
            })
            const preview = Object.create(PreviewModal.prototype) as any
            preview.client = client
            const blob = await preview.downloadToMemory(record.data, password, () => {}, new AbortController().signal)
            const url = URL.createObjectURL(blob)
            try {
                const response = await fetch(url)
                assert.equal(response.headers.get("Content-Type"), document.mime)
                assert.deepEqual(new Uint8Array(await response.arrayBuffer()), document.bytes)
            } finally {
                URL.revokeObjectURL(url)
            }
        })
