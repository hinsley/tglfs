import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { CliError, EXIT_CODES } from "./errors.js"
import { storePaths } from "./store.js"

export type SyncLedgerFileStats = {
    ufid: string
    size: number
    mtimeMs: number
    deleted?: boolean
}

export type SyncLedgerRoot = {
    rootId: string
    rootName: string
    folderPath: string
    manifestMsgId?: number
    lastManifestHash?: string
    lastSyncedFiles: Record<string, SyncLedgerFileStats>
}

export type SyncLedger = {
    version: 1
    roots: Record<string, SyncLedgerRoot>
}

export const syncStorePaths = {
    get ledgerFile() {
        return process.env.TGLFS_SYNC_LEDGER_FILE || join(storePaths.dataDir, "sync-roots.json")
    },
}

function emptyLedger(): SyncLedger {
    return {
        version: 1,
        roots: {},
    }
}

function isLedger(value: unknown): value is SyncLedger {
    return Boolean(value) && typeof value === "object" && (value as Partial<SyncLedger>).version === 1
}

export async function loadSyncLedger(): Promise<SyncLedger> {
    try {
        const raw = await readFile(syncStorePaths.ledgerFile, "utf8")
        const parsed = JSON.parse(raw)
        if (!isLedger(parsed)) {
            throw new CliError("invalid_sync_ledger", "Stored sync ledger is invalid.", EXIT_CODES.GENERAL_ERROR)
        }
        return {
            version: 1,
            roots: parsed.roots ?? {},
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return emptyLedger()
        }
        throw error
    }
}

export async function saveSyncLedger(ledger: SyncLedger) {
    await mkdir(dirname(syncStorePaths.ledgerFile), { recursive: true })
    await writeFile(syncStorePaths.ledgerFile, JSON.stringify(ledger, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
    })
}

export function resolveLedgerRoot(ledger: SyncLedger, folderOrRootId: string): SyncLedgerRoot | null {
    const direct = ledger.roots[folderOrRootId]
    if (direct) {
        return direct
    }
    const absolutePath = resolve(folderOrRootId)
    return Object.values(ledger.roots).find((root) => resolve(root.folderPath) === absolutePath) ?? null
}
