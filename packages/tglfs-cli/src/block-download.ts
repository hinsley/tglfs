import { constants } from "node:fs"
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { TelegramClient } from "telegram/client/TelegramClient.js"
import { getGramJs } from "./gramjs.js"
import { openBlockFile } from "./shared/block-transfer.js"
import { resumeBlockDownload } from "./shared/block-download.js"
import type { FileCardV5Data } from "./shared/protocol/file-card-v5.js"
import type { DownloadProgress, DownloadResult } from "./download.js"

export async function downloadResumableFile(
    client: TelegramClient,
    data: FileCardV5Data,
    password: string,
    outputPath: string,
    overwrite: boolean,
    onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
    const target = resolve(outputPath)
    await mkdir(dirname(target), { recursive: true })
    const part = `${target}.tglfs-${data.content.id}.part`
    const journal = `${part}.json`
    const lockPath = `${part}.lock`
    // A lock is kept until this process closes the partial file and checkpoint.
    let lock: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 2 && !lock; attempt++) {
        try {
            lock = await open(lockPath, "wx", 0o600)
            await lock.writeFile(JSON.stringify({ type: "tglfs:download-lock", version: 1, pid: process.pid }))
        } catch (error: any) {
            if (error?.code !== "EEXIST" || attempt !== 0) throw error
            const previous = JSON.parse(await readFile(lockPath, "utf8"))
            if (
                previous.type !== "tglfs:download-lock" ||
                previous.version !== 1 ||
                !Number.isSafeInteger(previous.pid) ||
                previous.pid <= 0
            )
                throw new Error("Unsupported download lock. The partial file was preserved.")
            try {
                process.kill(previous.pid, 0)
                throw new Error("This download is already running.")
            } catch (e: any) {
                if (e?.code !== "ESRCH") throw e
            }
            await rm(lockPath)
        }
    }
    if (!lock) throw new Error("The download could not be locked.")
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
        const { Api, getFileInfo } = getGramJs()
        const reader = await openBlockFile(client as any, { Api, getFileInfo, data, password })
        let saved: unknown | null = null
        try {
            saved = JSON.parse(await readFile(journal, "utf8"))
        } catch (e: any) {
            if (e?.code !== "ENOENT") throw e
        }
        if (saved === null) {
            try {
                file = await open(part, "wx+", 0o600)
            } catch (error: any) {
                if (error?.code !== "EEXIST") throw error
                file = await open(part, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
                if ((await file.stat()).size !== 0)
                    throw new Error(
                        "The partial download has no checkpoint. Choose another destination to preserve it.",
                    )
            }
        } else {
            file = await open(part, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
        }
        await resumeBlockDownload(
            reader,
            {
                async load() {
                    return saved
                },
                async size() {
                    return (await file!.stat()).size
                },
                async read(offset, length) {
                    const b = new Uint8Array(length)
                    const result = await file!.read(b, 0, length, offset)
                    return b.subarray(0, result.bytesRead)
                },
                async write(offset, bytes) {
                    let done = 0
                    while (done < bytes.length) {
                        const result = await file!.write(bytes, done, bytes.length - done, offset + done)
                        if (!result.bytesWritten) throw new Error("The partial download could not be written.")
                        done += result.bytesWritten
                    }
                },
                async checkpoint(state, size) {
                    await file!.truncate(size)
                    await file!.sync()
                    const temporary = `${journal}.${process.pid}.tmp`
                    const f = await open(temporary, "w", 0o600)
                    try {
                        await f.writeFile(JSON.stringify(state))
                        await f.sync()
                    } finally {
                        await f.close()
                    }
                    await rename(temporary, journal)
                },
            },
            { onProgress: (bytesWritten) => onProgress?.({ bytesWritten, totalBytes: data.size }) },
        )
        await file.close()
        file = undefined
        if (overwrite) await rename(part, target)
        else {
            await link(part, target)
            await rm(part)
        }
        await rm(journal)
        return { outputPath, bytesWritten: data.size, name: data.name, ufid: data.ufid }
    } finally {
        await file?.close()
        await lock.close()
        await rm(lockPath, { force: true })
    }
}
