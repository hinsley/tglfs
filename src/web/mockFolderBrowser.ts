import { serializeFileCardMessage } from "../../packages/tglfs-cli/src/shared/file-cards"
import {
    TGLFS_FOLDER_MANIFEST_TYPE,
    TGLFS_FOLDER_TYPE,
    TGLFS_FOLDER_ENTRIES_MIME_TYPE,
    createTglfsFolder,
    createTglfsFolderManifest,
    serializeTglfsFolderManifestMessage,
    serializeTglfsFolderMessage,
    toLegacyTglfsFolderManifest,
} from "../../packages/tglfs-cli/src/folders"
import { FILE_CARD_PREFIX } from "../../packages/tglfs-cli/src/shared/file-cards"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import { createMockPreviewFixtures } from "./mockPreviewFixtures"
import { createMockArchiveFixtures } from "./mockArchiveFixtures"

const TELEGRAM_TEXT_MESSAGE_LIMIT = 4096

type MockRecord = {
    id: number
    date: number
    editDate?: number
    message: string
    media?: unknown
}

/** `InputFileLocation` subclass id: GramJS `getFileInfo` passes such objects through as the download location. */
const INPUT_FILE_LOCATION_SUBCLASS_ID = 354669666
const UPLOAD_PART_SIZE = 512 * 1024

function now(offsetSeconds = 0) {
    return new Date(Date.UTC(2026, 4, 2, 17, 0, offsetSeconds)).toISOString()
}

async function fileText(file: any) {
    if (typeof file === "string") return file
    if (typeof file?.text === "function") return file.text()
    if (typeof file?.__mockText === "string") return file.__mockText
    if (file?.buffer instanceof ArrayBuffer) {
        return new TextDecoder().decode(new Uint8Array(file.buffer))
    }
    if (ArrayBuffer.isView(file?.buffer)) {
        return new TextDecoder().decode(new Uint8Array(file.buffer.buffer, file.buffer.byteOffset, file.buffer.byteLength))
    }
    return ""
}

const rootFolder = createTglfsFolder({
    folderId: "mock-folder-root",
    parentFolderId: TGLFS_ROOT_PARENT_ID,
    rootId: "mock-root",
    name: "Synced Docs",
    path: "",
    now: now(1),
})

const projectsFolder = createTglfsFolder({
    folderId: "mock-folder-projects",
    parentFolderId: rootFolder.folderId,
    rootId: "mock-root",
    name: "Projects",
    path: "Projects",
    now: now(2),
})

const rootManifest = createTglfsFolderManifest({
    folderId: rootFolder.folderId,
    rootId: "mock-root",
    path: "",
    now: now(3),
    entries: {
        Projects: {
            entryId: "mock-entry-projects",
            name: "Projects",
            path: "Projects",
            kind: "folder",
            folderId: projectsFolder.folderId,
            deleted: false,
            updatedAt: now(4),
        },
        "remote.txt": {
            entryId: "mock-entry-remote",
            name: "remote.txt",
            path: "remote.txt",
            kind: "file",
            ufid: "mock-ufid-remote",
            size: 42,
            mtimeMs: Date.parse(now(5)),
            mode: 0o644,
            deleted: false,
            updatedAt: now(5),
        },
    },
})

const projectsManifest = createTglfsFolderManifest({
    folderId: projectsFolder.folderId,
    rootId: "mock-root",
    path: "Projects",
    now: now(6),
    entries: {
        "plan.md": {
            entryId: "mock-entry-plan",
            name: "plan.md",
            path: "Projects/plan.md",
            kind: "file",
            ufid: "mock-ufid-plan",
            size: 2048,
            mtimeMs: Date.parse(now(7)),
            mode: 0o644,
            deleted: false,
            updatedAt: now(7),
        },
    },
})

const fileCards = [
    {
        id: 501,
        date: 1777741208,
        message: serializeFileCardMessage({
            name: "loose-global.txt",
            ufid: "mock-ufid-loose",
            size: 128,
            uploadComplete: true,
            chunks: [1501],
            IV: "mock-iv",
            parentFolderId: TGLFS_ROOT_PARENT_ID,
        }),
    },
    {
        id: 502,
        date: 1777741205,
        message: serializeFileCardMessage({
            name: "remote.txt",
            ufid: "mock-ufid-remote",
            size: 42,
            uploadComplete: true,
            chunks: [1502],
            IV: "mock-iv",
            parentFolderId: rootFolder.folderId,
        }),
    },
    {
        id: 503,
        date: 1777741207,
        message: serializeFileCardMessage({
            name: "plan.md",
            ufid: "mock-ufid-plan",
            size: 2048,
            uploadComplete: true,
            chunks: [1503],
            IV: "mock-iv",
            parentFolderId: projectsFolder.folderId,
        }),
    },
    {
        id: 504,
        date: 1777741209,
        message: serializeFileCardMessage({
            name: "Vacation photos 2025 - Lisbon sunset over the river.jpg",
            ufid: "mock-ufid-extra-0",
            size: 4823117,
            uploadComplete: true,
            chunks: [1504],
            IV: "mock-iv",
            parentFolderId: TGLFS_ROOT_PARENT_ID,
        }),
    },
    {
        id: 505,
        date: 1777741210,
        message: serializeFileCardMessage({
            name: "Quarterly report.pdf",
            ufid: "mock-ufid-extra-1",
            size: 913442,
            uploadComplete: true,
            chunks: [1505],
            IV: "mock-iv",
            parentFolderId: TGLFS_ROOT_PARENT_ID,
        }),
    },
    {
        id: 506,
        date: 1777741211,
        message: serializeFileCardMessage({
            name: "Home movie.mp4",
            ufid: "mock-ufid-extra-2",
            size: 734003200,
            uploadComplete: true,
            chunks: [1506],
            IV: "mock-iv",
            parentFolderId: TGLFS_ROOT_PARENT_ID,
        }),
    },
    {
        id: 507,
        date: 1777741212,
        message: serializeFileCardMessage({
            name: "project-backup.tar.gz",
            ufid: "mock-ufid-extra-3",
            size: 2147483648,
            uploadComplete: false,
            chunks: [1507],
            IV: "mock-iv",
            parentFolderId: TGLFS_ROOT_PARENT_ID,
        }),
    },
    {
        id: 508,
        date: 1777741213,
        message: serializeFileCardMessage({
            name: "Podcast episode 42.mp3",
            ufid: "mock-ufid-extra-4",
            size: 58720256,
            uploadComplete: true,
            chunks: [1508],
            IV: "mock-iv",
            parentFolderId: TGLFS_ROOT_PARENT_ID,
        }),
    },
]

const folderRecords = [
    {
        id: 601,
        date: 1777741201,
        message: serializeTglfsFolderMessage(rootFolder),
    },
    {
        id: 602,
        date: 1777741202,
        message: serializeTglfsFolderMessage(projectsFolder),
    },
]

const folderManifestRecords = [
    {
        id: 701,
        date: 1777741203,
        message: serializeTglfsFolderManifestMessage(toLegacyTglfsFolderManifest(rootManifest)),
    },
    {
        id: 702,
        date: 1777741206,
        message: serializeTglfsFolderManifestMessage(toLegacyTglfsFolderManifest(projectsManifest)),
    },
]

/* ----------------------------------------------------------- History fixtures */
// A folder with a realistic history for the folder time-machine view. It predates folder-entry
// compaction, so its legacy v1 manifest still carries tombstones. Times are UTC.

const at = (iso: string) => new Date(iso).toISOString()
const atSec = (iso: string) => Math.floor(Date.parse(iso) / 1000)

const clientWorkFolder = {
    ...createTglfsFolder({
        folderId: "mock-folder-client-work",
        parentFolderId: TGLFS_ROOT_PARENT_ID,
        rootId: "mock-folder-client-work",
        name: "Client Work",
        path: "",
        now: at("2026-04-20T09:15:00Z"),
    }),
    updatedAt: at("2026-05-08T12:00:00Z"),
}

const archiveFolder = createTglfsFolder({
    folderId: "mock-folder-archive",
    parentFolderId: TGLFS_ROOT_PARENT_ID,
    rootId: "mock-folder-archive",
    name: "Archive",
    path: "",
    now: at("2026-04-18T08:30:00Z"),
})

const draftsFolder = {
    ...createTglfsFolder({
        folderId: "mock-folder-drafts",
        parentFolderId: clientWorkFolder.folderId,
        rootId: clientWorkFolder.folderId,
        name: "Drafts",
        path: "Drafts",
        now: at("2026-04-21T14:05:00Z"),
    }),
    // Renamed on 5 May; the previous name is not recorded anywhere.
    updatedAt: at("2026-05-05T09:00:00Z"),
}

// Deleted on 4 May together with its subfolder; the records (and the files inside) still exist.
const oldExportsFolder = {
    ...createTglfsFolder({
        folderId: "mock-folder-old-exports",
        parentFolderId: clientWorkFolder.folderId,
        rootId: clientWorkFolder.folderId,
        name: "Old exports",
        path: "Old exports",
        now: at("2026-04-22T08:00:00Z"),
    }),
    deleted: true,
    updatedAt: at("2026-05-04T12:00:00Z"),
}

const oldExportsCsvFolder = {
    ...createTglfsFolder({
        folderId: "mock-folder-old-exports-csv",
        parentFolderId: oldExportsFolder.folderId,
        rootId: clientWorkFolder.folderId,
        name: "csv",
        path: "Old exports/csv",
        now: at("2026-04-22T08:10:00Z"),
    }),
    deleted: true,
    updatedAt: at("2026-05-04T12:00:00Z"),
}

// A top-level folder that was deleted (visible in the root "All files" history).
const tempFolder = {
    ...createTglfsFolder({
        folderId: "mock-folder-temp",
        parentFolderId: TGLFS_ROOT_PARENT_ID,
        rootId: "mock-folder-temp",
        name: "Temp",
        path: "",
        now: at("2026-04-19T16:00:00Z"),
    }),
    deleted: true,
    updatedAt: at("2026-04-27T10:30:00Z"),
}

function historyFileEntry(name: string, ufid: string, size: number, movedAt: string, options: { deleted?: string } = {}) {
    return {
        entryId: `mock-entry-${ufid}`,
        name,
        path: name,
        kind: "file" as const,
        ufid,
        size,
        mtimeMs: Date.parse(movedAt),
        mode: 0o644,
        deleted: !!options.deleted,
        updatedAt: at(options.deleted ?? movedAt),
    }
}

const clientWorkManifest = createTglfsFolderManifest({
    folderId: clientWorkFolder.folderId,
    rootId: clientWorkFolder.folderId,
    path: "",
    now: at("2026-04-20T09:15:00Z"),
    entries: {
        Drafts: {
            entryId: "mock-entry-drafts",
            name: "Drafts",
            path: "Drafts",
            kind: "folder",
            folderId: draftsFolder.folderId,
            deleted: false,
            updatedAt: at("2026-05-05T09:00:00Z"),
        },
        "Old exports": {
            entryId: "mock-entry-old-exports",
            name: "Old exports",
            path: "Old exports",
            kind: "folder",
            folderId: oldExportsFolder.folderId,
            deleted: true,
            updatedAt: at("2026-05-04T12:00:00Z"),
        },
        // Moved in from All files on 25 April.
        "Invoice March.pdf": historyFileEntry("Invoice March.pdf", "mock-ufid-history-invoice", 184320, "2026-04-25T16:40:00Z"),
        // Moved in on 26 April and renamed to "Meeting notes.txt" later (the entry keeps the old name).
        "Notes.txt": historyFileEntry("Notes.txt", "mock-ufid-history-notes", 3412, "2026-04-26T08:05:00Z"),
        // Deleted on 3 May; its file card and chunks are gone.
        "Moodboard.jpg": historyFileEntry("Moodboard.jpg", "mock-ufid-history-moodboard", 2457600, "2026-04-22T11:00:00Z", { deleted: "2026-05-03T10:12:00Z" }),
        // Moved to Archive on 6 May; its file card still exists there.
        "Contract draft.docx": historyFileEntry("Contract draft.docx", "mock-ufid-history-contract", 48211, "2026-04-23T09:30:00Z", { deleted: "2026-05-06T18:00:00Z" }),
    },
})
clientWorkManifest.updatedAt = at("2026-05-06T18:00:00Z")

const oldExportsManifest = createTglfsFolderManifest({
    folderId: oldExportsFolder.folderId,
    rootId: clientWorkFolder.folderId,
    path: "Old exports",
    now: at("2026-04-22T08:00:00Z"),
    entries: {
        csv: {
            entryId: "mock-entry-old-exports-csv",
            name: "csv",
            path: "Old exports/csv",
            kind: "folder",
            folderId: oldExportsCsvFolder.folderId,
            deleted: true,
            updatedAt: at("2026-05-04T12:00:00Z"),
        },
    },
})
oldExportsManifest.updatedAt = at("2026-05-04T12:00:00Z")

const archiveManifest = createTglfsFolderManifest({
    folderId: archiveFolder.folderId,
    rootId: archiveFolder.folderId,
    path: "",
    now: at("2026-04-18T08:30:00Z"),
    entries: {
        "Contract draft.docx": historyFileEntry("Contract draft.docx", "mock-ufid-history-contract", 48211, "2026-05-06T18:00:00Z"),
    },
})
archiveManifest.updatedAt = at("2026-05-06T18:00:00Z")

function historyCard(id: number, uploadedAt: string, name: string, ufid: string, size: number, parentFolderId: string) {
    return {
        id,
        date: atSec(uploadedAt),
        message: serializeFileCardMessage({
            name,
            ufid,
            size,
            uploadComplete: true,
            chunks: [id + 1000],
            IV: "mock-iv",
            parentFolderId,
        }),
    }
}

const historyFileCards = [
    historyCard(401, "2026-03-31T10:00:00Z", "Invoice March.pdf", "mock-ufid-history-invoice", 184320, clientWorkFolder.folderId),
    historyCard(402, "2026-04-20T09:20:00Z", "Brief.pdf", "mock-ufid-history-brief", 1048576, clientWorkFolder.folderId),
    historyCard(403, "2026-04-22T09:00:00Z", "export-01.csv", "mock-ufid-history-export", 20480, oldExportsFolder.folderId),
    historyCard(404, "2026-04-22T09:05:00Z", "2026-04.csv", "mock-ufid-history-export-csv", 8192, oldExportsCsvFolder.folderId),
    historyCard(405, "2026-04-23T09:00:00Z", "Contract draft.docx", "mock-ufid-history-contract", 48211, archiveFolder.folderId),
    historyCard(406, "2026-04-26T08:00:00Z", "Meeting notes.txt", "mock-ufid-history-notes", 3412, clientWorkFolder.folderId),
    historyCard(407, "2026-04-29T15:20:00Z", "Homepage v2.png", "mock-ufid-history-homepage", 734003, draftsFolder.folderId),
    historyCard(408, "2026-05-08T12:00:00Z", "Final deliverable.zip", "mock-ufid-history-final", 52428800, clientWorkFolder.folderId),
    historyCard(409, "2026-04-19T16:30:00Z", "scratch.txt", "mock-ufid-history-scratch", 512, tempFolder.folderId),
]

const historyFolderRecords = [
    { id: 410, date: atSec(archiveFolder.createdAt), message: serializeTglfsFolderMessage(archiveFolder) },
    { id: 411, date: atSec(tempFolder.createdAt), message: serializeTglfsFolderMessage(tempFolder) },
    { id: 412, date: atSec(clientWorkFolder.createdAt), message: serializeTglfsFolderMessage(clientWorkFolder) },
    { id: 413, date: atSec(draftsFolder.createdAt), message: serializeTglfsFolderMessage(draftsFolder) },
    { id: 414, date: atSec(oldExportsFolder.createdAt), message: serializeTglfsFolderMessage(oldExportsFolder) },
    { id: 415, date: atSec(oldExportsCsvFolder.createdAt), message: serializeTglfsFolderMessage(oldExportsCsvFolder) },
]

const historyFolderManifestRecords = [
    { id: 420, date: atSec(archiveFolder.createdAt), message: serializeTglfsFolderManifestMessage(toLegacyTglfsFolderManifest(archiveManifest)) },
    { id: 421, date: atSec(clientWorkFolder.createdAt), message: serializeTglfsFolderManifestMessage(toLegacyTglfsFolderManifest(clientWorkManifest)) },
    { id: 422, date: atSec(oldExportsFolder.createdAt), message: serializeTglfsFolderManifestMessage(toLegacyTglfsFolderManifest(oldExportsManifest)) },
]

function quotedValue(search: string, key: string) {
    const match = search.match(new RegExp(`"${key}":"([^"]+)"`))
    return match?.[1]
}

function textMatches(message: string, search: string) {
    const parts = search.split(/\s+/).filter(Boolean)
    const extraTerms = parts.slice(1).filter((term) => !term.includes("\":\""))
    return extraTerms.every((term) => message.toLowerCase().includes(term.toLowerCase()))
}

function usePaginationFixture() {
    if (typeof window === "undefined") return false
    const url = new URL(window.location.href)
    return url.searchParams.get("run")?.includes("pagination") ?? false
}

/** `?mock=folder-browser&slow=1` adds artificial latency to upload parts and chunk downloads so transfer UI states can be inspected. */
function mockTransferDelayMs() {
    if (typeof window === "undefined") return 0
    const url = new URL(window.location.href)
    return url.searchParams.get("slow") === "1" ? 220 : 0
}

function sleep(ms: number) {
    return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

export function createMockFolderBrowserSession() {
    const transferDelayMs = mockTransferDelayMs()
    const mutableFileCards: MockRecord[] = [...fileCards, ...historyFileCards].map((record) => ({ ...record }))
    const mutableFolderRecords: MockRecord[] = [...folderRecords, ...historyFolderRecords].map((record) => ({ ...record }))
    const mutableFolderManifestRecords: MockRecord[] = [...folderManifestRecords, ...historyFolderManifestRecords].map((record) => ({ ...record }))
    if (usePaginationFixture()) {
        const sinkFolder = createTglfsFolder({
            folderId: "mock-folder-pagination-sink",
            parentFolderId: TGLFS_ROOT_PARENT_ID,
            rootId: "mock-folder-pagination-sink",
            name: "Pagination Sink",
            path: "",
            now: now(20),
        })
        const sinkEntries = Object.fromEntries(
            Array.from({ length: 105 }, (_, index) => {
                const n = String(index + 1).padStart(3, "0")
                const name = `hidden-page-${n}.txt`
                const ufid = `mock-ufid-hidden-page-${n}`
                mutableFileCards.push({
                    id: 3000 - index,
                    date: 1777741400 + index,
                    message: serializeFileCardMessage({
                        name,
                        ufid,
                        size: 64,
                        uploadComplete: true,
                        chunks: [2500 + index],
                        IV: "mock-iv",
                        parentFolderId: sinkFolder.folderId,
                    }),
                })
                return [name, {
                    entryId: `mock-entry-hidden-page-${n}`,
                    name,
                    path: name,
                    kind: "file" as const,
                    ufid,
                    size: 64,
                    mtimeMs: Date.parse(now(21)),
                    mode: 0o644,
                    deleted: false,
                    updatedAt: now(21),
                }]
            }),
        )
        const sinkManifest = createTglfsFolderManifest({
            folderId: sinkFolder.folderId,
            rootId: sinkFolder.rootId,
            path: "",
            now: now(21),
            entries: sinkEntries,
        })
        mutableFolderRecords.push({
            id: 801,
            date: 1777741220,
            message: serializeTglfsFolderMessage(sinkFolder),
        })
        mutableFolderManifestRecords.push({
            id: 901,
            date: 1777741221,
            message: serializeTglfsFolderManifestMessage(toLegacyTglfsFolderManifest(sinkManifest)),
        })
    }
    // New messages start above every fixture id, including the seeded preview chunks (15xx).
    let nextMessageId = Math.max(
        3001,
        ...mutableFileCards.map((record) => record.id),
        ...mutableFolderRecords.map((record) => record.id),
        ...mutableFolderManifestRecords.map((record) => record.id),
    ) + 1

    const allRecords = () => [
        ...mutableFileCards,
        ...mutableFolderRecords,
        ...mutableFolderManifestRecords,
    ] as MockRecord[]
    const mutableRecordsForMessage = (message: string) => {
        if (message.startsWith(TGLFS_FOLDER_MANIFEST_TYPE)) return mutableFolderManifestRecords
        if (message.startsWith(TGLFS_FOLDER_TYPE)) return mutableFolderRecords
        if (message.startsWith(FILE_CARD_PREFIX)) return mutableFileCards
        return mutableFileCards
    }
    // Chunk documents uploaded through upload.SaveBigFilePart + InputFileBig, stored byte-for-byte so uploads,
    // resumed uploads and previews of uploaded files round-trip like they do against Telegram.
    const uploadParts = new Map<string, Map<number, Uint8Array>>()
    const chunkRecords: MockRecord[] = []
    const chunkBytes = new Map<number, Uint8Array>()
    // Real encrypted (empty password) blobs for the text/Markdown/CSV/JSON/PDF fixtures so previews decrypt for real.
    const ready = (async () => {
        const seeded: Array<{ id: number; date: number; message: string; bytes: Uint8Array }> = []
        await createMockPreviewFixtures({ fileCards: mutableFileCards, chunkRecords: seeded })
        if (new URL(window.location.href).searchParams.get("run") === "archive") {
            await createMockArchiveFixtures({ fileCards: mutableFileCards, chunkRecords: seeded })
        }
        for (const chunk of seeded) {
            chunkRecords.push({
                id: chunk.id,
                date: chunk.date,
                message: chunk.message,
                media: {
                    SUBCLASS_OF_ID: INPUT_FILE_LOCATION_SUBCLASS_ID,
                    __mockChunkId: chunk.id,
                    document: { size: chunk.bytes.length, attributes: [{ fileName: `chunk-${chunk.id}` }] },
                },
            })
            chunkBytes.set(chunk.id, chunk.bytes)
        }
    })().catch((error) => {
        console.warn("Mock preview fixtures unavailable", error)
    })
    const findMessage = (id: number) =>
        allRecords().find((record) => record.id === id) ?? chunkRecords.find((record) => record.id === id)
    const assembleBigFile = (file: { id: unknown; parts: number }) => {
        const key = String(file.id)
        const parts = uploadParts.get(key)
        const pieces: Uint8Array[] = []
        for (let index = 0; index < file.parts; index++) {
            const part = parts?.get(index)
            if (!part) throw new Error(`400: FILE_PART_${index}_MISSING (caused by messages.SendMedia)`)
            if (index < file.parts - 1 && part.length !== UPLOAD_PART_SIZE) {
                throw new Error("400: FILE_PART_SIZE_INVALID (caused by messages.SendMedia)")
            }
            pieces.push(part)
        }
        uploadParts.delete(key)
        const size = pieces.reduce((total, piece) => total + piece.length, 0)
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const piece of pieces) {
            bytes.set(piece, offset)
            offset += piece.length
        }
        return bytes
    }
    const removeIds = (ids: number[]) => {
        for (const id of ids) {
            const index = chunkRecords.findIndex((record) => record.id === id)
            if (index !== -1) chunkRecords.splice(index, 1)
            chunkBytes.delete(id)
        }
        for (const records of [mutableFileCards, mutableFolderRecords, mutableFolderManifestRecords]) {
            for (const id of ids) {
                const index = records.findIndex((record) => record.id === id)
                if (index !== -1) records.splice(index, 1)
            }
        }
    }

    const client = {
        async getMessages(_peer: string, options: { ids?: number[]; search?: string; limit?: number; maxId?: number; offsetId?: number }) {
            await ready
            if (Array.isArray(options.ids)) {
                // Like GramJS: one entry per requested id, in order, `undefined` for missing messages.
                return options.ids.map((id) => findMessage(id))
            }
            const search = options.search ?? ""
            const limit = options.limit ?? 50
            const maxId = options.maxId ?? options.offsetId ?? 0
            let records: Array<{ id: number; date: number; message: string }> = []

            if (search.startsWith("tglfs:folder-manifest")) {
                const folderId = quotedValue(search, "folderId")
                records = folderId
                    ? mutableFolderManifestRecords.filter((record) => record.message.includes(`"folderId":"${folderId}"`))
                    : mutableFolderManifestRecords
            } else if (search.startsWith("tglfs:folder")) {
                const folderId = quotedValue(search, "folderId")
                const parentFolderId = quotedValue(search, "parentFolderId")
                records = folderId
                    ? mutableFolderRecords.filter((record) => record.message.includes(`"folderId":"${folderId}"`))
                    : parentFolderId
                        ? mutableFolderRecords.filter((record) =>
                            record.message.includes(`"parentFolderId":"${parentFolderId}"`) &&
                            textMatches(record.message, search),
                        )
                    : mutableFolderRecords.filter((record) => textMatches(record.message, search))
            } else if (search.startsWith("tglfs:file")) {
                const ufid = quotedValue(search, "ufid")
                const parentFolderId = quotedValue(search, "parentFolderId")
                records = ufid
                    ? mutableFileCards.filter((record) => record.message.includes(`"ufid":"${ufid}"`))
                    : parentFolderId
                        ? mutableFileCards.filter((record) =>
                            record.message.includes(`"parentFolderId":"${parentFolderId}"`) &&
                            textMatches(record.message, search),
                        )
                    : mutableFileCards.filter((record) => textMatches(record.message, search))
            }

            const sorted = records
                .filter((record) => maxId === 0 || record.id < maxId)
                .sort((a, b) => b.id - a.id)
            if (limit === 0) {
                const result: Array<{ id: number; date: number; message: string }> = []
                ;(result as any).total = sorted.length
                return result
            }
            const page = sorted.slice(0, limit)
            return page
        },
        async sendMessage(_peer: string, options: { message: string }) {
            if (options.message.length > TELEGRAM_TEXT_MESSAGE_LIMIT) {
                throw new Error("400: MESSAGE_TOO_LONG (caused by messages.SendMessage)")
            }
            const record = {
                id: nextMessageId++,
                date: Math.floor(Date.now() / 1000),
                message: options.message,
            }
            mutableRecordsForMessage(options.message).push(record)
            return { ...record, peerId: "me" }
        },
        async sendFile(_peer: string, options: { caption?: string; message?: string; file: any }) {
            await sleep(transferDelayMs)
            if (typeof options.file?.parts === "number" && options.file?.id !== undefined) {
                // InputFileBig: a TGLFS chunk document assembled from the uploaded parts.
                const bytes = assembleBigFile(options.file)
                const id = nextMessageId++
                const record: MockRecord = {
                    id,
                    date: Math.floor(Date.now() / 1000),
                    message: "",
                    media: {
                        SUBCLASS_OF_ID: INPUT_FILE_LOCATION_SUBCLASS_ID,
                        __mockChunkId: id,
                        document: { size: bytes.length, attributes: [{ fileName: options.file.name }] },
                    },
                }
                chunkRecords.push(record)
                chunkBytes.set(id, bytes)
                return { ...record, peerId: "me" }
            }
            const message = options.caption ?? options.message ?? ""
            if (message.length > TELEGRAM_TEXT_MESSAGE_LIMIT) {
                throw new Error("400: MESSAGE_TOO_LONG (caused by messages.SendMedia)")
            }
            const record = {
                id: nextMessageId++,
                date: Math.floor(Date.now() / 1000),
                message,
                media: await fileText(options.file),
            }
            mutableRecordsForMessage(message).push(record)
            return { ...record, peerId: "me" }
        },
        async uploadFile(options: { file: any }) {
            return {
                name: options.file?.name ?? "folder-entries.json",
                mimeType: options.file?.type ?? TGLFS_FOLDER_ENTRIES_MIME_TYPE,
                __mockText: await fileText(options.file),
            }
        },
        async downloadMedia(message: MockRecord) {
            const record = allRecords().find((candidate) => candidate.id === message.id)
            return typeof record?.media === "string" ? record.media : ""
        },
        async invoke(request: any) {
            await ready
            if (typeof request?.filePart === "number") {
                // upload.SaveBigFilePart
                await sleep(transferDelayMs)
                const key = String(request.fileId)
                const parts = uploadParts.get(key) ?? new Map<number, Uint8Array>()
                parts.set(request.filePart, new Uint8Array(request.bytes))
                uploadParts.set(key, parts)
                return true
            }
            if (request?.location && typeof request.location.__mockChunkId === "number") {
                // upload.GetFile on a chunk document.
                await sleep(transferDelayMs)
                const bytes = chunkBytes.get(request.location.__mockChunkId)
                if (!bytes) throw new Error("400: FILE_REFERENCE_EXPIRED (caused by upload.GetFile)")
                const offset = Number(request.offset)
                return { bytes: bytes.slice(offset, offset + request.limit) }
            }
            const ids = Array.isArray(request?.id) ? request.id : []
            if (ids.length > 0 && typeof request?.message !== "string") {
                removeIds(ids)
                return { updates: [] }
            }
            if (typeof request?.id === "number" && typeof request?.message === "string") {
                if (request.message.length > TELEGRAM_TEXT_MESSAGE_LIMIT) {
                    throw new Error("400: MESSAGE_TOO_LONG (caused by messages.EditMessage)")
                }
                const record = allRecords().find((candidate) => candidate.id === request.id)
                if (record) {
                    record.message = request.message
                    const uploadedFile = request.media?.file
                    if (typeof uploadedFile?.__mockText === "string") {
                        record.media = uploadedFile.__mockText
                    }
                    // Like Telegram, an edit keeps the original message date and sets editDate.
                    record.editDate = Math.floor(Date.now() / 1000)
                }
                return { updates: [{ id: request.id }] }
            }
            return { updates: [] }
        },
        async disconnect() {},
        async logOut() {},
    }

    const config = {
        apiId: 0,
        apiHash: "mock",
        chunkSize: 2 * 1024 * 1024,
        phone: "mock-folder-browser",
    }

    return { client, config }
}
