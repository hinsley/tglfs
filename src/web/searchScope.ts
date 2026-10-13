// Search scope ("This folder" / "Everywhere") for the top-bar search, plus folder-location labels for results
// that come from other folders. No DOM access at module load and no Telegram import (callers pass a fetcher),
// so the pure parts are testable from Node.
import type { TglfsFolder } from "../../packages/tglfs-cli/src/folders"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import { escapeHtml } from "./dialogs"
import { icon } from "./icons"

export type SearchScope = "folder" | "everywhere"

const SCOPE_KEYS = {
    root: "tglfs.browser.searchScope.root",
    folder: "tglfs.browser.searchScope.folder",
}

/**
 * Default scope: at the All files root, "This folder" would only search loose top-level items, so search
 * defaults to everywhere there; inside a folder it stays in that folder. The last explicit choice is
 * remembered separately for the two situations.
 */
export function defaultSearchScope(atRoot: boolean): SearchScope {
    return atRoot ? "everywhere" : "folder"
}

export function readSearchScope(atRoot: boolean): SearchScope {
    try {
        const value = localStorage.getItem(atRoot ? SCOPE_KEYS.root : SCOPE_KEYS.folder)
        if (value === "folder" || value === "everywhere") return value
    } catch {}
    return defaultSearchScope(atRoot)
}

export function writeSearchScope(atRoot: boolean, scope: SearchScope) {
    try {
        localStorage.setItem(atRoot ? SCOPE_KEYS.root : SCOPE_KEYS.folder, scope)
    } catch {}
}

/* ------------------------------------------------------------ Locations */

/**
 * "All files" for the root; otherwise folder names joined with "›". Deep trails keep the first and the last
 * two folders ("Photos › … › 2024 › Lisbon").
 */
export function formatLocation(names: readonly string[], maxParts = 3) {
    if (names.length === 0) return "All files"
    if (names.length <= maxParts) return names.join(" › ")
    return [names[0], "…", ...names.slice(-(maxParts - 1))].join(" › ")
}

export type FolderLookup = (folderId: string) => TglfsFolder | undefined

const MAX_TRAIL_DEPTH = 32

/**
 * Resolves a folder id to the names of its folder trail (root first), walking parent links. Uses folders the
 * browser already knows, then `fetch` (a Telegram lookup), and memoizes per folder id until `clear()`.
 */
export function createLocationResolver(options: {
    known: FolderLookup
    fetch: (folderId: string) => Promise<TglfsFolder | null>
}) {
    // Lookups (the network part) are memoized individually and never wait on each other, so a corrupt
    // parent cycle can't deadlock; trails are walked iteratively with a visited set.
    const lookups = new Map<string, Promise<TglfsFolder | null>>()
    const settled = new Map<string, string[] | null>()

    const lookup = (folderId: string): Promise<TglfsFolder | null> => {
        const known = options.known(folderId)
        if (known) return Promise.resolve(known)
        let pending = lookups.get(folderId)
        if (!pending) {
            pending = options.fetch(folderId).catch(() => null)
            lookups.set(folderId, pending)
        }
        return pending
    }

    const resolve = async (folderId: string): Promise<string[] | null> => {
        if (!folderId || folderId === TGLFS_ROOT_PARENT_ID) return []
        if (settled.has(folderId)) return settled.get(folderId)!
        const names: string[] = []
        const seen = new Set<string>()
        let current: string | undefined = folderId
        while (current && current !== TGLFS_ROOT_PARENT_ID && !seen.has(current) && seen.size < MAX_TRAIL_DEPTH) {
            seen.add(current)
            const folder = await lookup(current)
            if (!folder) {
                if (current === folderId) {
                    settled.set(folderId, null)
                    return null
                }
                break
            }
            names.unshift(folder.name)
            current = folder.parentFolderId
        }
        settled.set(folderId, names)
        return names
    }

    /** Walks folders the browser already knows without any request; undefined when the chain has a gap. */
    const knownTrail = (folderId: string): string[] | undefined => {
        const names: string[] = []
        const seen = new Set<string>()
        let current: string | undefined = folderId
        while (current && current !== TGLFS_ROOT_PARENT_ID) {
            if (seen.has(current) || seen.size >= MAX_TRAIL_DEPTH) break
            seen.add(current)
            const folder = options.known(current)
            if (!folder) return undefined
            names.unshift(folder.name)
            current = folder.parentFolderId
        }
        return names
    }

    return {
        trail: (folderId: string) => resolve(folderId),
        /**
         * The trail when it is available without waiting (memoized, or every folder already known);
         * undefined while it still needs a request, null when the folder no longer exists.
         */
        cached(folderId: string): string[] | null | undefined {
            if (!folderId || folderId === TGLFS_ROOT_PARENT_ID) return []
            if (settled.has(folderId)) return settled.get(folderId)
            return knownTrail(folderId)
        },
        clear() {
            lookups.clear()
            settled.clear()
        },
    }
}

export type LocationResolver = ReturnType<typeof createLocationResolver>

/* ------------------------------------------------------------ Scope bar */

export function renderSearchScopeBar(
    bar: HTMLElement,
    options: { query: string; atRoot: boolean; folderName: string | null; scope: SearchScope },
) {
    if (!options.query) {
        bar.setAttribute("hidden", "")
        bar.innerHTML = ""
        return
    }
    const hereLabel = options.atRoot ? "Top level" : "This folder"
    const hereTitle = options.atRoot ? "Only items directly in All files" : `Only inside ${options.folderName ?? "this folder"}`
    const button = (scope: SearchScope, label: string, iconName: "folder" | "globe", title: string) => `
        <button type="button" class="fx-scope-btn${options.scope === scope ? " is-active" : ""}" role="radio"
            aria-checked="${options.scope === scope}" data-search-scope="${scope}" title="${escapeHtml(title)}">
            ${icon(iconName)}<span>${escapeHtml(label)}</span>
        </button>`
    bar.innerHTML = `
        <span class="fx-scopebar-label">Results for <strong>“${escapeHtml(options.query)}”</strong></span>
        <div class="fx-scope" role="radiogroup" aria-label="Search scope">
            ${button("folder", hereLabel, "folder", hereTitle)}
            ${button("everywhere", "Everywhere", "globe", "Search all folders")}
        </div>`
    bar.removeAttribute("hidden")
}

/** Inline HTML for a result's location ("in Synced Docs › Projects"); `pending` renders a shimmer. */
export function locationHtml(label: string | null, pending = false) {
    if (pending) return `<span class="fx-loc is-pending"><span class="fx-skel fx-skel-line"></span></span>`
    return `<span class="fx-loc">${icon("folder")}<span class="fx-loc-text">${escapeHtml(label ?? "Unknown folder")}</span></span>`
}
