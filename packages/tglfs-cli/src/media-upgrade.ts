import type { TelegramClient } from "telegram/client/TelegramClient.js"
import { getGramJs } from "./gramjs.js"
import { createVerifiedFileCardPlaintextStream } from "./plaintext-stream.js"
import { getMediaPreviewUpgradeCapability, seekableMediaCopyName } from "./shared/media-preview.js"
import { uploadSeekableMedia } from "./shared/media-upload.js"
import type { FileCardRecord } from "./types.js"

export async function upgradeMediaPreview(
    client: TelegramClient,
    source: FileCardRecord,
    options: { password: string; signal?: AbortSignal; onProgress?: (bytes: number) => void },
) {
    const capability = getMediaPreviewUpgradeCapability(source.data)
    if (!capability.supported) throw new Error(capability.reason)
    const { Api, getFileInfo } = getGramJs()
    const stream = await createVerifiedFileCardPlaintextStream(client, source.data, options.password)
    return uploadSeekableMedia(client as any, {
        Api,
        getFileInfo,
        name: seekableMediaCopyName(source.data.name),
        stream,
        password: options.password,
        container: /\.webm$/i.test(source.data.name) ? "webm" : "mp4",
        parentFolderId: "parentFolderId" in source.data ? source.data.parentFolderId : undefined,
        source: {
            type: "tglfs:media-source",
            version: 1,
            messageId: source.msgId,
            fileVersion: source.data.version,
            ufid: source.data.ufid,
        },
        expectedSize: source.data.size,
        expectedUfid: source.data.ufid,
        signal: options.signal,
        onBytes: options.onProgress,
    })
}
