import { requestChoice } from "./dialogs"
import { getGramJs } from "../gramjs"
import type { FileCardV5Data } from "../../packages/tglfs-cli/src/shared/protocol/file-card-v5"
import { openBlockFile } from "../../packages/tglfs-cli/src/shared/block-transfer"
import { resumeBlockDownload } from "../../packages/tglfs-cli/src/shared/block-download"
import type { DownloadState } from "../../packages/tglfs-cli/src/shared/block-download"

type SavedDownload = { type: "tglfs:browser-download"; version: 1; handle: any; state: DownloadState }
async function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("tglfs-downloads", 1)
        request.onupgradeneeded = () => request.result.createObjectStore("downloads")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}
async function savedDownload(id: string, operation: "get" | "put" | "delete", value?: SavedDownload): Promise<any> {
    const db = await database()
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction("downloads", operation === "get" ? "readonly" : "readwrite")
            const store = transaction.objectStore("downloads")
            const request =
                operation === "get" ? store.get(id) : operation === "put" ? store.put(value, id) : store.delete(id)
            let result: any
            request.onsuccess = () => {
                result = request.result
            }
            transaction.oncomplete = () => resolve(result)
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
        })
    } finally {
        db.close()
    }
}
const active = new Set<string>()
export async function prepareResumableDownload(
    data: FileCardV5Data,
): Promise<
    ((client: any, password: string, signal: AbortSignal, progress: (bytes: number) => void) => Promise<void>) | null
> {
    const picker = (window as any).showSaveFilePicker
    if (typeof picker !== "function") return null
    if (!navigator.locks)
        throw new Error(
            "This browser cannot safely lock resumable downloads. Use Chrome, Edge, or the TGLFS command line.",
        )
    const saved = (await savedDownload(data.content.id, "get")) as SavedDownload | undefined
    if (saved && (saved.type !== "tglfs:browser-download" || saved.version !== 1))
        throw new Error("This saved download uses an unsupported version.")
    let reuse = !!saved
    if (saved) {
        const choice = await requestChoice({
            title: "Resume download?",
            message: data.name,
            icon: "download",
            choices: [
                { label: "Resume", value: "resume" },
                { label: "Choose another file", value: "new" },
            ],
        })
        if (choice === null) throw new DOMException("Download cancelled.", "AbortError")
        reuse = choice === "resume"
    }
    let handle = reuse ? saved?.handle : undefined
    if (handle) {
        if (
            (await handle.queryPermission({ mode: "readwrite" })) !== "granted" &&
            (await handle.requestPermission({ mode: "readwrite" })) !== "granted"
        )
            throw new Error("Permission is required to resume this download.")
    } else {
        handle = await picker.call(window, { suggestedName: data.name })
        if ((await handle.getFile()).size !== 0)
            throw new Error("Choose an empty destination for a new resumable download.")
    }
    return async (client, password, signal, progress) => {
        const run = async () => {
            if (active.has(data.content.id)) throw new Error("This download is already running.")
            active.add(data.content.id)
            let writable: any
            try {
                // Reload the checkpoint after taking the lock because another tab may have advanced it.
                const latest = (await savedDownload(data.content.id, "get")) as SavedDownload | undefined
                if (
                    latest &&
                    (latest.type !== "tglfs:browser-download" ||
                        latest.version !== 1 ||
                        !(await latest.handle.isSameEntry(saved?.handle ?? handle)))
                )
                    throw new Error("The saved download destination changed. Start the download again.")
                const { Api, getFileInfo } = await getGramJs()
                const reader = await openBlockFile(client, { Api, getFileInfo, data, password, signal })
                await resumeBlockDownload(
                    reader,
                    {
                        async load() {
                            return reuse ? latest?.state ?? null : null
                        },
                        async size() {
                            return (await handle.getFile()).size
                        },
                        async read(offset, length) {
                            return new Uint8Array(
                                await (await handle.getFile()).slice(offset, offset + length).arrayBuffer(),
                            )
                        },
                        async write(offset, bytes) {
                            writable ??= await handle.createWritable({ keepExistingData: true })
                            await writable.write({ type: "write", position: offset, data: bytes })
                        },
                        async checkpoint(state, size) {
                            writable ??= await handle.createWritable({ keepExistingData: true })
                            await writable.truncate(size)
                            await writable.close()
                            writable = undefined
                            await savedDownload(data.content.id, "put", {
                                ...latest,
                                type: "tglfs:browser-download",
                                version: 1,
                                handle,
                                state,
                            })
                        },
                    },
                    { signal, onProgress: progress },
                )
                await savedDownload(data.content.id, "delete")
            } finally {
                await writable?.abort().catch(() => {})
                active.delete(data.content.id)
            }
        }
        if (navigator.locks)
            await navigator.locks.request(`tglfs-download-${data.content.id}`, { ifAvailable: true }, async (lock) => {
                if (!lock) throw new Error("This download is running in another tab.")
                await run()
            })
        else await run()
    }
}
