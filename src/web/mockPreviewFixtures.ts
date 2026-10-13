/**
 * Mock-mode only (`?mock=folder-browser` on localhost): real encrypted blobs for previewable fixtures.
 *
 * The blobs are produced exactly like the uploader produces them — gzip, then AES-CTR in ENCRYPTION_CHUNK_SIZE
 * slices with a PBKDF2 key from the (empty) password and a random salt + counter stored as the card's IV — so the
 * real preview/download pipeline decrypts them. File cards are written with the shared serializer; nothing here
 * defines or changes a record format.
 */
import { parseFileCardMessage, serializeFileCardMessage } from "../../packages/tglfs-cli/src/shared/file-cards"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import { deriveAESKeyFromPassword, ENCRYPTION_CHUNK_SIZE, incrementCounter64By } from "./encryption"

/** GramJS' constructor id family for InputFileLocation; getFileInfo() passes such objects straight through. */
export const MOCK_INPUT_FILE_LOCATION_SUBCLASS = 354669666

type CardRecord = { id: number; date: number; message: string }
type ChunkRecord = { id: number; date: number; message: string; bytes: Uint8Array }

type Fixture = {
    cardId: number
    chunkId: number
    date?: number
    /** Only for new cards; existing cards keep their name/ufid/parent. */
    name?: string
    ufid?: string
    parentFolderId?: string
    content: () => Uint8Array
}

const encoder = new TextEncoder()
const text = (value: string) => () => encoder.encode(value)

const README = `# TGLFS demo files

Welcome to the **mock folder browser**. Everything here is *fake*, but these previews decrypt real
encrypted blobs — the same way files from Telegram do.

## What you can try

- Drag a file onto a folder (or a breadcrumb) to move it
- Press **F2** to rename in place, or click the name of a selected file again
- On a phone: swipe a row left for *More* / *Delete*, right for *Move*
- Pull the list down to refresh

### Supported previews

| Type | Extensions | Notes |
|:-----|:-----------|------:|
| Text & code | \`.txt\` \`.log\` \`.ts\` \`.py\` … | line numbers |
| Markdown | \`.md\` | rendered safely |
| CSV / TSV | \`.csv\` \`.tsv\` | first 500 rows |
| PDF | \`.pdf\` | built-in viewer |

> Files are encrypted in your browser before they reach Telegram.
> Previews decrypt into memory only.

1. Pick a file
2. Press <kbd>Enter</kbd> (raw HTML like <script>alert(1)</script> is shown as text)
3. Use ← → to flip through

\`\`\`ts
const answer: number = 42
console.log(\`The answer is \${answer}\`)
\`\`\`

- [x] Encrypt on upload
- [ ] Learn to fly

Links stay safe: [project page](https://github.com/), and [this one](javascript:alert(1)) is not a link.
Images never load: ![tracking pixel](https://example.com/pixel.png)

---

*Last updated May 2026.*
`

const PLAN = `# Project plan

## Milestones

1. **Prototype** — folder browser, uploads, previews
2. **Beta** — sync roots, conflict handling
3. **1.0** — polish and docs

## Open questions

- Should previews support \`.docx\`? (Probably not — too heavy.)
- ~~Store thumbnails in Telegram~~ Decided: no.

> "Make it work, make it right, make it fast."
`

const LOOSE = `TGLFS loose file
================

This plain-text file lives at the top level ("All files").
It has a few lines so the viewer can show line numbers,

    indented text,
\ttabs,
and a very long line that should soft-wrap nicely inside the viewer instead of forcing a horizontal scrollbar — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

Unicode works too: café, naïve, 東京, 🚀
`

const REMOTE = `remote.txt — synced from another machine.
Last sync: 2026-05-02 17:00 UTC
`

function salesCsv() {
    const regions = ["North", "South", "East", "West", "Central"]
    const products = ["Storage Pro", "Storage Lite", "Team Vault", "Archive+"]
    const rows = ["Month,Region,Product,Units,Revenue (USD),Notes"]
    let seed = 7
    const random = () => {
        seed = (seed * 9301 + 49297) % 233280
        return seed / 233280
    }
    for (let month = 1; month <= 12; month++) {
        for (const region of regions) {
            const product = products[Math.floor(random() * products.length)]
            const units = 20 + Math.floor(random() * 480)
            const revenue = (units * (9.99 + Math.floor(random() * 40))).toFixed(2)
            const note = random() > 0.85 ? `"Promo, ""spring"" bundle"` : ""
            rows.push(`2026-${String(month).padStart(2, "0")},${region},${product},${units},${revenue},${note}`)
        }
    }
    return encoder.encode(`${rows.join("\n")}\n`)
}

const SETTINGS = JSON.stringify({
    version: 3,
    theme: "system",
    upload: { chunkSizeMiB: 2048, compress: true, encryption: "AES-CTR-256" },
    previews: { textLimitMiB: 5, csvRows: 500, markdown: { images: "never-load", rawHtml: "escaped" } },
    shortcuts: { rename: "F2", search: "/", undo: "Ctrl+Z" },
    recent: ["README.md", "sales-2026.csv", "Quarterly report.pdf"],
})

/** A small, valid one-page PDF (Type 1 base fonts, a heading, text and a bar chart). */
function quarterlyReportPdf() {
    const bars = [
        { label: "Jan", value: 120 },
        { label: "Feb", value: 165 },
        { label: "Mar", value: 140 },
        { label: "Apr", value: 210 },
        { label: "May", value: 248 },
        { label: "Jun", value: 232 },
    ]
    const ops: string[] = [
        "0.96 0.97 0.98 rg 0 0 612 792 re f",
        "0.10 0.54 0.83 rg 0 742 612 50 re f",
        "BT /F1 20 Tf 1 1 1 rg 56 760 Td (TGLFS - Quarterly report) Tj ET",
        "BT /F2 11 Tf 0.29 0.33 0.40 rg 56 712 Td (Q2 2026 storage summary - generated for the mock folder browser) Tj ET",
        "BT /F1 13 Tf 0.07 0.09 0.15 rg 56 670 Td (Highlights) Tj ET",
        "BT /F2 11 Tf 0.29 0.33 0.40 rg 56 648 Td 16 TL",
        "(- Stored 1.2 TiB across 18,450 encrypted chunks) Tj T*",
        "(- Median upload throughput up 31% after streaming encryption) Tj T*",
        "(- Zero plaintext ever left the browser) Tj ET",
        "BT /F1 13 Tf 0.07 0.09 0.15 rg 56 570 Td (Monthly uploads \\(GiB\\)) Tj ET",
        "0.80 0.83 0.87 RG 0.8 w 56 300 m 556 300 l S",
    ]
    bars.forEach((bar, index) => {
        const x = 76 + index * 80
        const height = bar.value
        ops.push(`0.10 0.54 0.83 rg ${x} 300 48 ${height} re f`)
        ops.push(`BT /F2 10 Tf 0.29 0.33 0.40 rg ${x + 12} 284 Td (${bar.label}) Tj ET`)
        ops.push(`BT /F1 10 Tf 0.07 0.09 0.15 rg ${x + 12} ${306 + height} Td (${bar.value}) Tj ET`)
    })
    ops.push("BT /F2 9 Tf 0.54 0.58 0.65 rg 56 60 Td (Confidential - decrypted locally for preview) Tj ET")
    const stream = ops.join("\n")
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    let pdf = "%PDF-1.4\n"
    const offsets: number[] = []
    objects.forEach((body, index) => {
        offsets.push(pdf.length)
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return encoder.encode(pdf)
}

const FIXTURES: Fixture[] = [
    { cardId: 501, chunkId: 1501, content: text(LOOSE) },
    { cardId: 502, chunkId: 1502, content: text(REMOTE) },
    { cardId: 503, chunkId: 1503, content: text(PLAN) },
    { cardId: 505, chunkId: 1505, content: quarterlyReportPdf },
    { cardId: 509, chunkId: 1509, date: 1777741214, name: "README.md", ufid: "mock-ufid-readme", parentFolderId: TGLFS_ROOT_PARENT_ID, content: text(README) },
    { cardId: 510, chunkId: 1510, date: 1777741190, name: "sales-2026.csv", ufid: "mock-ufid-sales", parentFolderId: TGLFS_ROOT_PARENT_ID, content: salesCsv },
    { cardId: 511, chunkId: 1511, date: 1777741180, name: "settings.json", ufid: "mock-ufid-settings", parentFolderId: TGLFS_ROOT_PARENT_ID, content: text(SETTINGS) },
]

/** A card too large for a text preview (no blob needed: the preview refuses before downloading). */
const TOO_LARGE_CARD = { cardId: 512, date: 1777741170, name: "server.log", ufid: "mock-ufid-server-log", size: 7_812_345 }

async function gzip(bytes: Uint8Array) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

function bytesToBase64(bytes: Uint8Array) {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

async function encrypt(plain: Uint8Array, key: CryptoKey, initialCounter: Uint8Array) {
    const compressed = await gzip(plain)
    const out = new Uint8Array(compressed.length)
    let counter = new Uint8Array(initialCounter)
    for (let offset = 0; offset < compressed.length; offset += ENCRYPTION_CHUNK_SIZE) {
        const slice = compressed.subarray(offset, offset + ENCRYPTION_CHUNK_SIZE)
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, slice))
        out.set(encrypted, offset)
        counter = new Uint8Array(incrementCounter64By(counter, Math.ceil(slice.length / 16)))
    }
    return out
}

export async function createMockPreviewFixtures(target: { fileCards: CardRecord[]; chunkRecords: ChunkRecord[] }) {
    if (typeof crypto === "undefined" || !crypto.subtle || typeof CompressionStream === "undefined") return
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const key = await deriveAESKeyFromPassword("", salt)
    for (const fixture of FIXTURES) {
        const plain = fixture.content()
        const counter = crypto.getRandomValues(new Uint8Array(16))
        const iv = new Uint8Array(32)
        iv.set(salt, 0)
        iv.set(counter, 16)
        const bytes = await encrypt(plain, key, counter)
        const existing = target.fileCards.find((record) => record.id === fixture.cardId)
        const existingData = existing ? parseFileCardMessage(existing.message) : null
        const message = serializeFileCardMessage({
            name: existingData?.name ?? fixture.name ?? `fixture-${fixture.cardId}`,
            ufid: existingData?.ufid ?? fixture.ufid ?? `mock-ufid-${fixture.cardId}`,
            size: plain.length,
            uploadComplete: true,
            chunks: [fixture.chunkId],
            IV: bytesToBase64(iv),
            parentFolderId: (existingData && "parentFolderId" in existingData ? existingData.parentFolderId : undefined)
                ?? fixture.parentFolderId
                ?? TGLFS_ROOT_PARENT_ID,
        })
        if (existing) {
            existing.message = message
        } else {
            target.fileCards.push({ id: fixture.cardId, date: fixture.date ?? 1777741200, message })
        }
        target.chunkRecords.push({ id: fixture.chunkId, date: fixture.date ?? 1777741200, message: "", bytes })
    }
    if (!target.fileCards.some((record) => record.id === TOO_LARGE_CARD.cardId)) {
        target.fileCards.push({
            id: TOO_LARGE_CARD.cardId,
            date: TOO_LARGE_CARD.date,
            message: serializeFileCardMessage({
                name: TOO_LARGE_CARD.name,
                ufid: TOO_LARGE_CARD.ufid,
                size: TOO_LARGE_CARD.size,
                uploadComplete: true,
                chunks: [1512],
                IV: "mock-iv",
                parentFolderId: TGLFS_ROOT_PARENT_ID,
            }),
        })
    }
}
