import { Buffer } from "buffer"
import { serializeFileCardMessage } from "../../packages/tglfs-cli/src/shared/file-cards"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import { createTarStream } from "../../packages/tglfs-cli/src/shared/archive"
import { encodeArchiveStream } from "../../packages/tglfs-cli/src/shared/archive-format"
import { deriveAESKeyFromPassword } from "../../packages/tglfs-cli/src/crypto"
import { computeUfidFromStream } from "../../packages/tglfs-cli/src/ufid"

type CardRecord = { id: number; date: number; message: string }
type ChunkRecord = CardRecord & { bytes: Uint8Array }

export async function createMockArchiveFixtures(options: { fileCards: CardRecord[]; chunkRecords: ChunkRecord[] }) {
    const filler = new Uint8Array(3 * 1024 * 1024)
    for (let offset = 0; offset < filler.length; offset += 65536) crypto.getRandomValues(filler.subarray(offset, offset + 65536))
    const contents = [
        { name: "readme.txt", bytes: new TextEncoder().encode("Archive preview fixture. Only selected contents should be fetched.\n") },
        { name: "notes/settings.json", bytes: new TextEncoder().encode('{"private":true,"preview":"works"}\n') },
        { name: "notes/sample.png", bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64")) },
        { name: "bulk/filler.bin", bytes: filler },
    ]
    const entries = contents.map(({ name, bytes }) => ({ name, size: bytes.length, lastModified: 1777741300000, stream: () => new Blob([bytes]).stream() }))
    const tar = new Uint8Array(await new Response(createTarStream(entries)).arrayBuffer())
    for (const [ordinal, password] of ["", "archive-test"].entries()) {
        const blocks: Uint8Array[] = []
        const encoded = await encodeArchiveStream(new Blob([tar]).stream(), { password }, async (bytes) => { blocks.push(bytes.slice()) })
        const stored = new Uint8Array(await new Blob(blocks).arrayBuffer())
        const chunks: number[] = []
        for (let offset = 0; offset < stored.length; offset += 2 * 1024 * 1024) {
            const id = 2000 + ordinal * 10 + chunks.length
            options.chunkRecords.push({ id, date: 1777741300, message: "", bytes: stored.slice(offset, offset + 2 * 1024 * 1024) })
            chunks.push(id)
        }
        options.fileCards.push({ id: 1600 + ordinal, date: 1777741300 + ordinal, message: serializeFileCardMessage({
            type: "tglfs:file", version: 4, name: ordinal ? "locked-preview.tar" : "open-preview.tar", ufid: encoded.ufid,
            size: tar.length, uploadComplete: true, chunks, IV: "", archive: encoded.storage, parentFolderId: TGLFS_ROOT_PARENT_ID,
        }) })
    }
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const counter = crypto.getRandomValues(new Uint8Array(16))
    const iv = new Uint8Array(32)
    iv.set(salt)
    iv.set(counter, 16)
    const key = await deriveAESKeyFromPassword("", salt)
    const compressed = await new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, compressed))
    options.chunkRecords.push({ id: 2030, date: 1777741300, message: "", bytes: encrypted })
    options.fileCards.push({ id: 1602, date: 1777741302, message: serializeFileCardMessage({
        name: "original-preview.tar", ufid: await computeUfidFromStream(new Blob([tar]).stream()), size: tar.length,
        uploadComplete: true, chunks: [2030], IV: Buffer.from(iv).toString("base64"), parentFolderId: TGLFS_ROOT_PARENT_ID,
    }) })
}
