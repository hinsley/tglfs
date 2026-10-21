import { constants } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import { join } from "node:path"
import { connectAuthorizedClient, persistAndDisconnectClient } from "../auth.js"
import { downloadFileCard } from "../download.js"
import { downloadResumableFile } from "../block-download.js"
import { getGramJs } from "../gramjs.js"
import { parseFileCardMessage } from "../shared/file-cards.js"
import { createTarStream } from "../shared/archive.js"
import { finishUfid, hashBytes, jsonBytes } from "../shared/block-format.js"
import { UfidAccumulator } from "../ufid.js"
import { openBlockFile, uploadResumableFile } from "../shared/block-transfer.js"
import { openSources, safeDownloadName, within } from "./files.js"
import type { HelperConfig } from "./protocol.js"
import type { JobExecutor } from "./queue.js"
export async function helperIdentity() {
    const state = await connectAuthorizedClient()
    try {
        const me = await state.client.getMe()
        return String(me.id)
    } finally {
        await persistAndDisconnectClient(state.client, state.session)
    }
}
export function createJobExecutor(
    config: HelperConfig,
    dependencies: {
        connect?: typeof connectAuthorizedClient
        disconnect?: typeof persistAndDisconnectClient
        blockSize?: number
    } = {},
): JobExecutor {
    return async (job, options) => {
        const state = await (dependencies.connect ?? connectAuthorizedClient)()
        const client = state.client
        const abort = () => {
            void client.destroy().catch(() => {})
        }
        options.signal.addEventListener("abort", abort, { once: true })
        try {
            options.signal.throwIfAborted()
            if (String((await client.getMe()).id) !== job.accountId)
                throw new Error("The helper Telegram account changed.")
            if (job.direction === "upload") {
                const source = await openSources(config, job.sources!)
                try {
                    const { Api, getFileInfo } = getGramJs()
                    const single = source.entries.length === 1
                    const record = await uploadResumableFile(client as any, {
                        Api,
                        getFileInfo,
                        password: options.password,
                        signal: options.signal,
                        parentFolderId: job.parentFolderId,
                        resumeId: job.uploadSessionId,
                        onSession: options.session,
                        blockSize: dependencies.blockSize,
                        source: {
                            name: job.name,
                            size: job.size,
                            archive: !single || /\.tar$/i.test(job.name),
                            fingerprint: await hashBytes(
                                jsonBytes(source.entries.map((e) => [e.name, e.size, e.lastModified])),
                            ),
                            slice: (start, end) =>
                                single
                                    ? source.entries[0].range(start, end)
                                    : createTarStream(source.entries, start, end),
                        },
                        onProgress: (p) =>
                            options.progress(
                                p.phase === "reading" ? "Preparing" : "Uploading",
                                p.bytesProcessed,
                                p.totalBytes,
                            ),
                    })
                    return { msgId: record.msgId, ufid: record.data.ufid }
                } finally {
                    await source.close()
                }
            }
            const messages = await client.getMessages("me", { ids: [job.messageId!] })
            const card = parseFileCardMessage(messages[0]?.message || "")
            if (
                !card ||
                !card.uploadComplete ||
                card.ufid !== job.ufid ||
                card.version !== job.fileVersion ||
                card.size !== job.size
            )
                throw new Error("The requested download record changed or is unsupported.")
            const root = await realpath(config.downloadDir),
                directory = join(root, job.id)
            await mkdir(directory, { mode: 0o700 }).catch((e: any) => {
                if (e.code !== "EEXIST") throw e
            })
            if ((await lstat(directory)).isSymbolicLink() || !within(root, await realpath(directory)))
                throw new Error("The download destination is not safe.")
            const output = join(directory, safeDownloadName(job.name))
            if (output !== job.outputPath) throw new Error("The saved download destination does not match its job.")
            if (card.version === 5) {
                let existing: Awaited<ReturnType<typeof open>> | undefined
                try {
                    existing = await open(
                        output,
                        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
                    )
                } catch (error: any) {
                    if (error.code !== "ENOENT") throw error
                }
                if (existing) {
                    try {
                        const info = await existing.stat()
                        if (!info.isFile() || info.size !== card.size)
                            throw new Error("The existing download differs from the requested file. It was preserved.")
                        const { Api, getFileInfo } = getGramJs()
                        await openBlockFile(client as any, {
                            Api,
                            getFileInfo,
                            data: card,
                            password: options.password,
                            signal: options.signal,
                        })
                        const ufid = new UfidAccumulator()
                        let position = 0
                        while (position < info.size) {
                            options.signal.throwIfAborted()
                            const bytes = new Uint8Array(Math.min(256 * 1024, info.size - position))
                            const result = await existing.read(bytes, 0, bytes.length, position)
                            if (!result.bytesRead) throw new Error("The existing download changed. It was preserved.")
                            await ufid.update(bytes.subarray(0, result.bytesRead))
                            position += result.bytesRead
                            options.progress("Checking saved download", position, info.size)
                        }
                        if ((await finishUfid(ufid, info.size)) !== card.ufid)
                            throw new Error("The existing download changed. It was preserved.")
                        return { ufid: card.ufid, outputPath: output }
                    } finally {
                        await existing.close()
                    }
                }
            }
            const progress = (p: { bytesWritten: number; totalBytes: number }) => {
                options.signal.throwIfAborted()
                options.progress("Downloading", p.bytesWritten, p.totalBytes)
            }
            const result =
                card.version === 5
                    ? await downloadResumableFile(
                          client,
                          card,
                          options.password,
                          output,
                          false,
                          progress,
                          options.signal,
                      )
                    : await downloadFileCard(client, card, options.password, output, false, progress)
            return { ufid: result.ufid, outputPath: result.outputPath }
        } finally {
            options.signal.removeEventListener("abort", abort)
            await (dependencies.disconnect ?? persistAndDisconnectClient)(client, state.session).catch(() => {})
        }
    }
}
