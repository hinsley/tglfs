import { opendir, stat } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

import { CliError, EXIT_CODES } from "./errors.js"

const EXCLUDED_NAMES = new Set([
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    ".tglfs-sync",
])

export type LocalSyncFile = {
    path: string
    absolutePath: string
    size: number
    mtimeMs: number
    mode: number
}

export function normalizeRelativeSyncPath(rootPath: string, filePath: string) {
    const relativePath = relative(resolve(rootPath), resolve(filePath)).split(sep).join("/")
    if (
        relativePath === "" ||
        relativePath.startsWith("../") ||
        relativePath === ".." ||
        relativePath.startsWith("/") ||
        /^[A-Za-z]:\//.test(relativePath)
    ) {
        throw new CliError("invalid_sync_path", `Path escapes the sync root: ${filePath}.`, EXIT_CODES.GENERAL_ERROR)
    }
    return relativePath
}

async function walk(rootPath: string, currentPath: string, results: LocalSyncFile[]) {
    const dir = await opendir(currentPath)
    for await (const entry of dir) {
        if (EXCLUDED_NAMES.has(entry.name)) {
            continue
        }
        const absolutePath = resolve(currentPath, entry.name)
        if (entry.isDirectory()) {
            await walk(rootPath, absolutePath, results)
            continue
        }
        if (!entry.isFile()) {
            continue
        }
        const stats = await stat(absolutePath)
        results.push({
            path: normalizeRelativeSyncPath(rootPath, absolutePath),
            absolutePath,
            size: stats.size,
            mtimeMs: Math.floor(stats.mtimeMs),
            mode: stats.mode & 0o777,
        })
    }
}

export async function scanSyncFolder(folderPath: string): Promise<LocalSyncFile[]> {
    const rootPath = resolve(folderPath)
    const stats = await stat(rootPath)
    if (!stats.isDirectory()) {
        throw new CliError("invalid_sync_root", `Sync path must be a directory: ${rootPath}.`, EXIT_CODES.GENERAL_ERROR)
    }
    const results: LocalSyncFile[] = []
    await walk(rootPath, rootPath, results)
    results.sort((a, b) => a.path.localeCompare(b.path))
    return results
}
