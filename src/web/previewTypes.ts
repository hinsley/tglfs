/**
 * File-type detection for the preview modal. Pure (no DOM), shared by the browser ("Preview" actions) and the
 * preview modal, and covered by node tests.
 */

export type PreviewFileType =
    | "image"
    | "video"
    | "audio"
    | "pdf"
    | "markdown"
    | "csv"
    | "json"
    | "code"
    | "text"
    | "unsupported"

/** Document previews decrypt the whole file into memory, so they are capped. */
export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024
export const PDF_PREVIEW_MAX_BYTES = 64 * 1024 * 1024
/** Markdown above this size is shown as plain text (the renderer is linear-ish, but keep it snappy). */
export const MARKDOWN_RENDER_MAX_BYTES = 1024 * 1024
export const CSV_PREVIEW_MAX_ROWS = 500

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"])
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"])
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"])
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"])
const CSV_EXTS = new Set(["csv", "tsv"])
const JSON_EXTS = new Set(["json", "jsonc", "json5", "geojson", "webmanifest", "ipynb"])
const CODE_EXTS = new Set([
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "pyw", "go", "rs", "c", "h", "cc", "cpp", "cxx", "hpp",
    "hh", "java", "kt", "kts", "scala", "swift", "m", "mm", "rb", "php", "pl", "pm", "lua", "r", "dart", "cs", "fs",
    "vb", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "html", "htm", "xhtml", "xml", "xsl", "css", "scss",
    "sass", "less", "vue", "svelte", "yml", "yaml", "toml", "ini", "cfg", "conf", "properties", "gradle", "cmake",
    "mk", "dockerfile", "tf", "hcl", "proto", "graphql", "gql", "diff", "patch", "env", "gitignore", "gitattributes",
    "editorconfig", "nix", "zig", "ex", "exs", "erl", "hs", "elm", "clj", "lisp", "el", "vim", "asm", "s",
])
const TEXT_EXTS = new Set(["txt", "text", "log", "rst", "adoc", "asciidoc", "org", "tex", "bib", "srt", "vtt", "nfo"])
/** Common extensionless text files. */
const TEXT_NAMES = new Set([
    "readme", "license", "licence", "copying", "authors", "contributors", "changelog", "changes", "notice", "todo",
    "makefile", "dockerfile", "containerfile", "procfile", "gemfile", "rakefile", "vagrantfile", "jenkinsfile",
    "brewfile", "justfile", ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".bashrc", ".zshrc",
    ".profile", ".vimrc",
])

export function getFileExtension(name: string): string {
    const parts = name.toLowerCase().split(".")
    if (parts.length < 2) return ""
    return parts.pop() ?? ""
}

export function detectPreviewType(name: string): PreviewFileType {
    const ext = getFileExtension(name)
    if (IMAGE_EXTS.has(ext)) return "image"
    if (VIDEO_EXTS.has(ext)) return "video"
    if (AUDIO_EXTS.has(ext)) return "audio"
    if (ext === "pdf") return "pdf"
    if (MARKDOWN_EXTS.has(ext)) return "markdown"
    if (CSV_EXTS.has(ext)) return "csv"
    if (JSON_EXTS.has(ext)) return "json"
    if (CODE_EXTS.has(ext)) return "code"
    if (TEXT_EXTS.has(ext)) return "text"
    const base = name.trim().toLowerCase().split("/").pop() ?? ""
    if (TEXT_NAMES.has(base)) return "text"
    // "README", "LICENSE.old" style names without a meaningful extension.
    const stem = base.replace(/\.[^.]*$/, "")
    if (!ext && TEXT_NAMES.has(stem)) return "text"
    return "unsupported"
}

/** Types rendered by decrypting the whole file to memory and showing it as text. */
export function isTextPreviewType(type: PreviewFileType): type is "markdown" | "csv" | "json" | "code" | "text" {
    return type === "markdown" || type === "csv" || type === "json" || type === "code" || type === "text"
}

export function isPreviewableFileName(name: string): boolean {
    return detectPreviewType(name) !== "unsupported"
}

/** Size cap for in-memory previews; null when the type streams (video/audio) or has no cap (images). */
export function previewSizeLimit(type: PreviewFileType): number | null {
    if (isTextPreviewType(type)) return TEXT_PREVIEW_MAX_BYTES
    if (type === "pdf") return PDF_PREVIEW_MAX_BYTES
    return null
}

export function isPreviewTooLarge(type: PreviewFileType, size: number): boolean {
    const limit = previewSizeLimit(type)
    return limit !== null && Number.isFinite(size) && size > limit
}

/** Short label for the language/format chip in the document viewer. */
export function previewFormatLabel(name: string, type: PreviewFileType): string {
    const ext = getFileExtension(name)
    switch (type) {
        case "markdown":
            return "Markdown"
        case "csv":
            return ext === "tsv" ? "TSV" : "CSV"
        case "json":
            return "JSON"
        case "pdf":
            return "PDF"
        case "code":
            return ext ? ext.toUpperCase() : "Code"
        default:
            return "Text"
    }
}
