// Naming for files pasted from the clipboard. Pure (no DOM): safe to import from Node tests.

const MIME_EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/svg+xml": "svg",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/avif": "avif",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/html": "html",
    "text/csv": "csv",
    "application/json": "json",
    "application/zip": "zip",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
}

/**
 * Browsers give clipboard bitmaps placeholder names ("image.png" in Chromium and Firefox, sometimes an empty
 * name). Those get a descriptive, timestamped name; real file names (files copied in a file manager) are kept.
 */
export function isPlaceholderClipboardName(name: string, type: string) {
    const trimmed = name.trim()
    if (!trimmed) return true
    if (!type.startsWith("image/")) return false
    return /^image(\.[a-z0-9]+)?$/i.test(trimmed)
}

export function extensionForMimeType(type: string) {
    const base = type.split(";")[0].trim().toLowerCase()
    if (MIME_EXTENSIONS[base]) return MIME_EXTENSIONS[base]
    const subtype = base.split("/")[1]
    return subtype && /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : ""
}

function pad(value: number) {
    return String(value).padStart(2, "0")
}

/** "2026-10-13 14.05" in local time (dots instead of colons keep the name valid on every OS). */
export function formatPasteTimestamp(date: Date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`
}

function splitName(name: string) {
    const dot = name.lastIndexOf(".")
    return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" }
}

/**
 * Names for a batch of pasted files: placeholder names become "Pasted image 2026-10-13 14.05.png" (or
 * "Pasted file …" for non-images), and duplicates within the batch get " (2)", " (3)"… before the extension.
 */
export function namePastedFiles(files: ReadonlyArray<{ name: string; type: string }>, now: Date): string[] {
    const stamp = formatPasteTimestamp(now)
    const used = new Set<string>()
    return files.map((file) => {
        let name = file.name.trim()
        if (isPlaceholderClipboardName(file.name, file.type)) {
            const ext = extensionForMimeType(file.type) || (file.type.startsWith("image/") ? "png" : "")
            const label = file.type.startsWith("image/") ? "Pasted image" : "Pasted file"
            name = `${label} ${stamp}${ext ? `.${ext}` : ""}`
        }
        let candidate = name
        const { stem, ext } = splitName(name)
        for (let n = 2; used.has(candidate.toLowerCase()); n++) {
            candidate = `${stem} (${n})${ext}`
        }
        used.add(candidate.toLowerCase())
        return candidate
    })
}

export function describePastedUpload(count: number) {
    return count === 1 ? "Uploading pasted file…" : `Uploading ${count} pasted files…`
}
