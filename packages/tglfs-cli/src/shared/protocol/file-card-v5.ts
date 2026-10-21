import { isBlockContent } from "../block-format.js"
import type { BlockContent } from "../block-format.js"
import { TGLFS_ROOT_PARENT_ID } from "../constants.js"
import { FILE_CARD_TYPE } from "./file-card-v1.js"
import type { FileCardV1StoredData } from "./file-card-v1.js"

export type MediaPreview = {
    type: "tglfs:media-preview"
    version: 1
    container: "mp4" | "webm"
    seeking: "byte-range"
    source?: { type: "tglfs:media-source"; version: 1; messageId: number; fileVersion: number; ufid: string }
}
function validMediaPreview(m: MediaPreview): boolean {
    return (
        !!m &&
        m.type === "tglfs:media-preview" &&
        m.version === 1 &&
        ["mp4", "webm"].includes(m.container) &&
        m.seeking === "byte-range" &&
        (m.source === undefined ||
            (!!m.source &&
                m.source.type === "tglfs:media-source" &&
                m.source.version === 1 &&
                Number.isSafeInteger(m.source.messageId) &&
                m.source.messageId > 0 &&
                Number.isSafeInteger(m.source.fileVersion) &&
                m.source.fileVersion > 0 &&
                typeof m.source.ufid === "string" &&
                !!m.source.ufid.trim()))
    )
}
export type FileCardV5Data = FileCardV1StoredData & {
    type: typeof FILE_CARD_TYPE
    version: 5
    IV: ""
    parentFolderId: string
    content: BlockContent
    mediaPreview?: MediaPreview
}
export type FileCardV5Input = Omit<FileCardV5Data, "type" | "version" | "parentFolderId"> & {
    type?: typeof FILE_CARD_TYPE
    version?: 5
    parentFolderId?: string
}
export function normalizeFileCardV5Data(value: unknown): FileCardV5Data | null {
    const c = value as FileCardV5Data
    if (
        !c ||
        c.type !== FILE_CARD_TYPE ||
        c.version !== 5 ||
        typeof c.name !== "string" ||
        !c.name.trim() ||
        !/^[a-f0-9]{64}$/.test(c.ufid) ||
        !Number.isSafeInteger(c.size) ||
        c.size < 0 ||
        c.uploadComplete !== true ||
        c.IV !== "" ||
        typeof c.parentFolderId !== "string" ||
        !c.parentFolderId.trim() ||
        !Array.isArray(c.chunks) ||
        c.chunks.length !== 1 ||
        !Number.isSafeInteger(c.chunks[0]) ||
        c.chunks[0] <= 0 ||
        !isBlockContent(c.content) ||
        (c.mediaPreview !== undefined && (!validMediaPreview(c.mediaPreview) || c.content.archive))
    )
        return null
    return { ...c, chunks: c.chunks.slice(), content: { ...c.content } }
}
export function createFileCardV5Data(data: FileCardV5Input): FileCardV5Data {
    const result = normalizeFileCardV5Data({
        ...data,
        type: data.type ?? FILE_CARD_TYPE,
        version: data.version ?? 5,
        parentFolderId: data.parentFolderId ?? TGLFS_ROOT_PARENT_ID,
    })
    if (!result) throw new Error("Malformed or unsupported file-card protocol version 5.")
    return result
}
