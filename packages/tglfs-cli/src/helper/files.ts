import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import type { HelperConfig, HelperSource } from "./protocol.js"
export function within(root: string, path: string) {
    const part = relative(root, path)
    return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
}
export async function selectedPath(config: HelperConfig, rootId: unknown, part: unknown): Promise<string> {
    if (
        typeof rootId !== "string" ||
        !/^root[0-9]+$/.test(rootId) ||
        typeof part !== "string" ||
        part.includes("\0") ||
        part.includes("\\") ||
        isAbsolute(part) ||
        part.split("/").includes("..")
    )
        throw new Error("Invalid helper file selection.")
    const root = config.uploadRoots[Number(rootId.slice(4))]
    if (!root) throw new Error("This upload folder has not been granted to the helper.")
    const canonicalRoot = await realpath(root),
        candidate = resolve(canonicalRoot, part)
    if (!within(canonicalRoot, candidate) || (await lstat(candidate)).isSymbolicLink())
        throw new Error("Symbolic links and paths outside the granted folder are refused.")
    const canonical = await realpath(candidate)
    if (!within(canonicalRoot, canonical)) throw new Error("This path leaves the granted upload folder.")
    return canonical
}
export async function browseFiles(config: HelperConfig, rootId: unknown, part: unknown) {
    const path = await selectedPath(config, rootId, part)
    if (!(await lstat(path)).isDirectory()) throw new Error("Choose a folder to browse.")
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.length > 10000) throw new Error("This folder has too many entries. Choose a smaller upload folder.")
    return {
        rootId,
        path: part,
        entries: entries
            .filter((e) => !e.isSymbolicLink() && (e.isFile() || e.isDirectory()))
            .map((e) => ({ name: e.name, kind: e.isDirectory() ? "directory" : "file" }))
            .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    }
}
export async function selectedSources(config: HelperConfig, rootId: unknown, files: unknown): Promise<HelperSource[]> {
    if (!Array.isArray(files) || !files.length || files.length > 1000 || new Set(files).size !== files.length)
        throw new Error("Choose between one and 1000 different files.")
    const sources: HelperSource[] = []
    for (const part of files) {
        const path = await selectedPath(config, rootId, part),
            file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        try {
            const stat = await file.stat()
            if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error("Choose regular files for upload.")
            sources.push({
                path,
                name: files.length === 1 ? basename(path) : String(part),
                size: stat.size,
                modified: Math.floor(stat.mtimeMs) || 1000,
            })
        } finally {
            await file.close()
        }
    }
    return sources
}
export async function openSources(config: HelperConfig, sources: HelperSource[]) {
    const handles = new Set<Awaited<ReturnType<typeof open>>>()
    let closed = false
    async function openSource(source: HelperSource) {
        if (closed) throw new Error("The upload source was closed.")
        const path = await realpath(source.path)
        if (!config.uploadRoots.some((root) => within(root, path)))
            throw new Error("The upload source is outside the helper's granted folders.")
        if ((await lstat(source.path)).isSymbolicLink()) throw new Error("Symbolic link upload sources are refused.")
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        try {
            const stat = await handle.stat()
            if (!stat.isFile() || stat.size !== source.size || (Math.floor(stat.mtimeMs) || 1000) !== source.modified)
                throw new Error("An upload source changed. Select the unchanged original to resume.")
            if (closed) throw new Error("The upload source was closed.")
            handles.add(handle)
            return handle
        } catch (error) {
            await handle.close()
            throw error
        }
    }
    async function closeHandle(handle: Awaited<ReturnType<typeof open>>) {
        handles.delete(handle)
        await handle.close()
    }
    for (const source of sources) await closeHandle(await openSource(source))
    function range(source: HelperSource, start: number, end: number) {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.size)
            throw new Error("Invalid upload range.")
        let position = start,
            handle: Awaited<ReturnType<typeof open>> | undefined
        const close = async () => {
            if (handle) {
                const current = handle
                handle = undefined
                await closeHandle(current)
            }
        }
        return new ReadableStream<Uint8Array>(
            {
                async pull(controller) {
                    try {
                        if (closed) throw new Error("The upload source was closed.")
                        if (position === end) {
                            await close()
                            controller.close()
                            return
                        }
                        handle ??= await openSource(source)
                        const bytes = new Uint8Array(Math.min(256 * 1024, end - position))
                        const result = await handle.read(bytes, 0, bytes.length, position)
                        if (!result.bytesRead) throw new Error("The upload source became shorter.")
                        position += result.bytesRead
                        controller.enqueue(bytes.subarray(0, result.bytesRead))
                    } catch (error) {
                        await close()
                        controller.error(error)
                    }
                },
                cancel: close,
            },
            { highWaterMark: 0 },
        )
    }
    return {
        entries: sources.map((source) => ({
            name: source.name,
            size: source.size,
            lastModified: source.modified,
            stream: () => range(source, 0, source.size),
            range: (start: number, end: number) => range(source, start, end),
        })),
        async close() {
            closed = true
            await Promise.all([...handles].map(closeHandle))
        },
    }
}
export function safeDownloadName(name: string) {
    const value = name
        .replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 180)
    if (!value || /^\.+$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) return "download"
    return value
}
