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

const TELEGRAM_TEXT_MESSAGE_LIMIT = 4096

type MockRecord = {
    id: number
    date: number
    message: string
    media?: string
}

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

export function createMockFolderBrowserSession() {
    const mutableFileCards = fileCards.map((record) => ({ ...record }))
    const mutableFolderRecords = folderRecords.map((record) => ({ ...record }))
    const mutableFolderManifestRecords = folderManifestRecords.map((record) => ({ ...record }))
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
    let nextMessageId = Math.max(
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
    const removeIds = (ids: number[]) => {
        for (const records of [mutableFileCards, mutableFolderRecords, mutableFolderManifestRecords]) {
            for (const id of ids) {
                const index = records.findIndex((record) => record.id === id)
                if (index !== -1) records.splice(index, 1)
            }
        }
    }

    const client = {
        async getMessages(_peer: string, options: { ids?: number[]; search?: string; limit?: number; maxId?: number; offsetId?: number }) {
            if (Array.isArray(options.ids)) {
                const ids = new Set(options.ids)
                return allRecords().filter((record) => ids.has(record.id))
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
            return record?.media ?? ""
        },
        async invoke(request: any) {
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
                    record.date = Math.floor(Date.now() / 1000)
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
