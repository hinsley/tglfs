// The small surface browser.ts exposes to optional UI modules (command palette, storage summary, paste to
// upload). Those modules receive these hooks at init instead of importing browser.ts, which keeps the
// dependency one-way.
import type { FileCardData } from "../types/models"
import type { TglfsFolder } from "../../packages/tglfs-cli/src/folders"
import type { IconName } from "./icons"

export type HookFileRecord = { msgId: number; date: number; data: FileCardData }
export type HookFolderRecord = { msgId: number; date: number; data: TglfsFolder }

export type HookAction = {
    key: string
    label: string
    icon: IconName
    hint?: string
    danger?: boolean
    disabled?: boolean
    run: () => void | Promise<void>
}

export type SortOption = { value: string; label: string }

export interface BrowserHooks {
    getClient(): any
    isBrowserVisible(): boolean
    getCurrentFolder(): TglfsFolder | null
    /** Folders seen in this session (visited or listed), newest knowledge wins. */
    getKnownFolders(): TglfsFolder[]
    getKnownFolder(folderId: string): TglfsFolder | undefined
    /** Actions for the current selection (same list as the selection bar), plus a short description of it. */
    getSelection(): { count: number; label: string; actions: HookAction[] }
    uploadFiles(files?: File[]): void
    createFolder(): Promise<void>
    receiveFile(): Promise<void>
    getViewMode(): "list" | "grid"
    setViewMode(mode: "list" | "grid"): void
    getSortOptions(): SortOption[]
    getSort(): string
    setSort(value: string): void
    goHome(): Promise<void>
    goUp(): Promise<void>
    openFolder(record: HookFolderRecord): Promise<void>
    /** Opens a folder by id (cache first, then Telegram). Resolves false when it no longer exists. */
    openFolderById(folderId: string): Promise<boolean>
    /** Opens the file's folder, selects the file and scrolls it into view. Resolves false when it is gone. */
    revealFile(ref: { msgId: number; ufid: string; parentFolderId?: string }): Promise<boolean>
    /** Runs the top-bar search across all folders. */
    searchEverywhere(query: string): void
    focusSearch(): void
}
