import { Buffer } from "buffer"
import { jsonBytes, MAX_METADATA_SIZE, parseJson, validateBlockMap } from "./block-format.js"
import type { BlockMap } from "./block-format.js"
import type { FileCardV5Data } from "./protocol/file-card-v5.js"

type MapClient = {
    getMessages(peer: string, options: any): Promise<any[]>
    downloadMedia?(message: any, options?: any): Promise<any>
}
export async function loadFileBlockMap(client: MapClient, data: FileCardV5Data, peer = "me"): Promise<BlockMap> {
    if (!client.downloadMedia) throw new Error("This client cannot read the file's block map safely.")
    const messages = await client.getMessages(peer, { ids: data.chunks })
    const message = messages.find((m) => m.id === data.chunks[0])
    const size = Number(message?.media?.document?.size)
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_METADATA_SIZE)
        throw new Error("The file block map is missing or exceeds its permitted size.")
    const bytes = await client.downloadMedia(message, {})
    if (!(bytes instanceof Uint8Array) || bytes.length !== size)
        throw new Error("The file block map could not be read completely.")
    return validateBlockMap(parseJson(bytes), data.content)
}
export async function storedFileMessageIds(
    client: MapClient,
    data: { version?: number; chunks: number[] },
    peer = "me",
): Promise<number[]> {
    if (data.version !== 5) return data.chunks.slice()
    const map = await loadFileBlockMap(client, data as FileCardV5Data, peer)
    if (map.messages.includes(data.chunks[0])) throw new Error("The file block map references itself.")
    return [...map.messages, ...data.chunks]
}
export function blockMapUploadFile(map: BlockMap): Buffer {
    const bytes = Buffer.from(jsonBytes(map))
    if (bytes.length > MAX_METADATA_SIZE) throw new Error("The updated block map exceeds its permitted size.")
    ;(bytes as any).name = `${map.id}.block-map`
    return bytes
}
