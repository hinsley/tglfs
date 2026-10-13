/**
 * Pure text helpers for document previews: a small, safe Markdown subset renderer, a CSV/TSV parser and text
 * decoding. No DOM access, so node tests can import this module.
 *
 * Markdown safety model: every piece of source text is HTML-escaped before it reaches the output; the renderer only
 * ever emits a fixed set of tags/attributes it builds itself. Raw HTML in the source is shown as text. Link targets
 * are limited to http(s) and mailto (anything else renders as plain text). Images are never loaded — previews are of
 * private, decrypted files, and fetching remote images would leak that the file is being viewed — so they render as
 * a link chip instead.
 */

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
}

export function escapeText(value: string): string {
    return value.replace(/[&<>"']/g, (char) => ESCAPES[char])
}

/** Returns a safe href for a Markdown link target, or null when the scheme is not allowed. */
export function sanitizeLinkUrl(raw: string): string | null {
    // Browsers ignore embedded whitespace/control characters in schemes ("java\nscript:"), so strip them first.
    const url = raw.trim().replace(/[\u0000- \u007f-\u009f]+/g, "")
    if (!url) return null
    if (/^https?:\/\/[^/]/i.test(url)) return url
    if (/^mailto:[^/]/i.test(url)) return url
    return null
}

const MAX_BLOCK_DEPTH = 12

type BlockOptions = { tight?: boolean }

function isBlank(line: string) {
    return /^\s*$/.test(line)
}

function leadingIndent(line: string) {
    let width = 0
    for (const char of line) {
        if (char === " ") width++
        else if (char === "\t") width += 4 - (width % 4)
        else break
    }
    return width
}

function stripIndent(line: string, amount: number) {
    let width = 0
    let index = 0
    while (index < line.length && width < amount) {
        const char = line[index]
        if (char === " ") width++
        else if (char === "\t") width += 4 - (width % 4)
        else break
        index++
    }
    return line.slice(index)
}

type FenceOpen = { char: string; length: number; lang: string }

function matchFenceOpen(line: string): FenceOpen | null {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!match) return null
    const info = match[2].trim()
    if (match[1][0] === "`" && info.includes("`")) return null
    const lang = (info.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z0-9_+#-]/g, "").slice(0, 32)
    return { char: match[1][0], length: match[1].length, lang }
}

function isFenceClose(line: string, fence: FenceOpen) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
    return !!match && match[1][0] === fence.char && match[1].length >= fence.length
}

function matchHeading(line: string) {
    const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/)
    if (!match) return null
    const text = (match[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "")
    return { level: match[1].length, text }
}

function isThematicBreak(line: string) {
    return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)
}

function isBlockquote(line: string) {
    return /^ {0,3}>/.test(line)
}

type ListMarker = { indent: number; marker: string; ordered: boolean; start: number; contentIndent: number; content: string }

function matchListItem(line: string): ListMarker | null {
    const match = line.match(/^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/)
    if (!match) return null
    const indent = match[1].length
    const marker = match[2]
    const spaces = match[3] ? leadingIndent(match[3]) : 1
    const content = match[4] ?? ""
    const ordered = /\d/.test(marker)
    // Content indented 5+ spaces past the marker is an indented code block inside the item; keep one space.
    const gap = spaces >= 5 ? 1 : Math.max(1, spaces)
    return {
        indent,
        marker,
        ordered,
        start: ordered ? Number.parseInt(marker, 10) : 1,
        contentIndent: indent + marker.length + gap,
        content: spaces >= 5 ? `${" ".repeat(spaces - 1)}${content}` : content,
    }
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

function splitTableRow(line: string): string[] {
    let row = line.trim()
    if (row.startsWith("|")) row = row.slice(1)
    if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1)
    const cells: string[] = []
    let current = ""
    for (let index = 0; index < row.length; index++) {
        const char = row[index]
        if (char === "\\" && row[index + 1] === "|") {
            current += "|"
            index++
        } else if (char === "|") {
            cells.push(current.trim())
            current = ""
        } else {
            current += char
        }
    }
    cells.push(current.trim())
    return cells
}

function isTableStart(lines: string[], index: number) {
    const header = lines[index]
    const delimiter = lines[index + 1]
    if (delimiter === undefined || !header.includes("|") || !TABLE_DELIMITER.test(delimiter)) return false
    if (!delimiter.includes("|") && !delimiter.includes("-")) return false
    return splitTableRow(header).length === splitTableRow(delimiter).length
}

/** True when `line` would start a new block and therefore ends a paragraph. */
function interruptsParagraph(line: string) {
    if (matchFenceOpen(line) || matchHeading(line) || isThematicBreak(line) || isBlockquote(line)) return true
    const item = matchListItem(line)
    // Like CommonMark: only non-empty bullets and lists starting at 1 interrupt a paragraph.
    return !!item && item.content.trim() !== "" && (!item.ordered || item.start === 1)
}

function renderBlocks(lines: string[], depth: number, options: BlockOptions = {}): string {
    const out: string[] = []
    let index = 0
    while (index < lines.length) {
        const line = lines[index]
        if (isBlank(line)) {
            index++
            continue
        }

        const fence = matchFenceOpen(line)
        if (fence) {
            const body: string[] = []
            index++
            while (index < lines.length && !isFenceClose(lines[index], fence)) {
                body.push(lines[index])
                index++
            }
            index++
            const langClass = fence.lang ? ` class="language-${fence.lang}"` : ""
            out.push(`<pre class="md-code"><code${langClass}>${escapeText(body.join("\n"))}</code></pre>`)
            continue
        }

        if (leadingIndent(line) >= 4) {
            const body: string[] = []
            while (index < lines.length && (isBlank(lines[index]) || leadingIndent(lines[index]) >= 4)) {
                body.push(stripIndent(lines[index], 4))
                index++
            }
            while (body.length && isBlank(body[body.length - 1])) body.pop()
            out.push(`<pre class="md-code"><code>${escapeText(body.join("\n"))}</code></pre>`)
            continue
        }

        const heading = matchHeading(line)
        if (heading) {
            out.push(`<h${heading.level}>${renderInline(heading.text)}</h${heading.level}>`)
            index++
            continue
        }

        if (isThematicBreak(line)) {
            out.push("<hr>")
            index++
            continue
        }

        if (isBlockquote(line)) {
            const inner: string[] = []
            while (index < lines.length && !isBlank(lines[index])) {
                const current = lines[index]
                if (isBlockquote(current)) {
                    inner.push(current.replace(/^ {0,3}> ?/, ""))
                } else if (interruptsParagraph(current)) {
                    break
                } else {
                    inner.push(current)
                }
                index++
            }
            out.push(depth >= MAX_BLOCK_DEPTH
                ? `<blockquote><p>${renderInline(inner.join("\n"))}</p></blockquote>`
                : `<blockquote>${renderBlocks(inner, depth + 1)}</blockquote>`)
            continue
        }

        const item = matchListItem(line)
        if (item) {
            const parsed = parseList(lines, index)
            index = parsed.next
            out.push(renderList(parsed, depth))
            continue
        }

        if (isTableStart(lines, index)) {
            const header = splitTableRow(lines[index])
            const aligns = splitTableRow(lines[index + 1]).map((cell) => {
                const left = cell.startsWith(":")
                const right = cell.endsWith(":")
                return left && right ? "center" : right ? "right" : left ? "left" : ""
            })
            index += 2
            const rows: string[][] = []
            while (index < lines.length && !isBlank(lines[index]) && lines[index].includes("|")) {
                rows.push(splitTableRow(lines[index]))
                index++
            }
            const cell = (tag: "th" | "td", text: string, column: number) => {
                const align = aligns[column]
                return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${renderInline(text)}</${tag}>`
            }
            const head = `<tr>${header.map((text, column) => cell("th", text, column)).join("")}</tr>`
            const body = rows
                .map((row) => `<tr>${header.map((_, column) => cell("td", row[column] ?? "", column)).join("")}</tr>`)
                .join("")
            out.push(`<div class="md-table-wrap"><table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`)
            continue
        }

        // Paragraph (with setext heading detection).
        const paragraph: string[] = [line]
        index++
        let setext = 0
        while (index < lines.length && !isBlank(lines[index])) {
            const current = lines[index]
            if (/^ {0,3}=+[ \t]*$/.test(current)) {
                setext = 1
                index++
                break
            }
            if (/^ {0,3}-+[ \t]*$/.test(current)) {
                setext = 2
                index++
                break
            }
            if (interruptsParagraph(current) || isTableStart(lines, index)) break
            paragraph.push(current)
            index++
        }
        const inline = renderInline(paragraph.map((part) => part.replace(/^[ \t]+/, "")).join("\n"))
        if (setext) {
            out.push(`<h${setext}>${inline}</h${setext}>`)
        } else {
            out.push(options.tight ? inline : `<p>${inline}</p>`)
        }
    }
    return out.join(options.tight ? "\n" : "")
}

type ParsedList = { ordered: boolean; start: number; items: string[][]; loose: boolean; next: number }

function parseList(lines: string[], start: number): ParsedList {
    const first = matchListItem(lines[start])!
    const items: string[][] = []
    let index = start
    let loose = false
    const skipBlanks = (from: number) => {
        let peek = from
        while (peek < lines.length && isBlank(lines[peek])) peek++
        return peek
    }
    while (index < lines.length) {
        const item = matchListItem(lines[index])
        if (!item || item.ordered !== first.ordered) break
        const itemLines = [item.content]
        index++
        while (index < lines.length) {
            const current = lines[index]
            if (isBlank(current)) {
                // A blank line continues the item only when indented content follows it.
                const peek = skipBlanks(index)
                if (peek < lines.length && leadingIndent(lines[peek]) >= item.contentIndent) {
                    for (let blank = index; blank < peek; blank++) itemLines.push("")
                    loose = true
                    index = peek
                    continue
                }
                break
            }
            if (leadingIndent(current) >= item.contentIndent) {
                itemLines.push(stripIndent(current, item.contentIndent))
                index++
                continue
            }
            if (!matchListItem(current) && !interruptsParagraph(current) && leadingIndent(current) < 4) {
                // Lazy paragraph continuation.
                itemLines.push(current.trim())
                index++
                continue
            }
            break
        }
        items.push(itemLines)
        if (index < lines.length && isBlank(lines[index])) {
            // Blank lines between items of the same list make it loose; anything else ends the list.
            const peek = skipBlanks(index)
            const next = peek < lines.length ? matchListItem(lines[peek]) : null
            if (!next || next.ordered !== first.ordered) break
            loose = true
            index = peek
        }
    }
    return { ordered: first.ordered, start: first.start, items, loose, next: index }
}

function renderList(list: ParsedList, depth: number): string {
    const tag = list.ordered ? "ol" : "ul"
    const startAttr = list.ordered && list.start !== 1 ? ` start="${list.start}"` : ""
    const items = list.items.map((itemLines) => {
        let lines = itemLines
        let task = ""
        const taskMatch = lines[0]?.match(/^\[([ xX])\][ \t]+(.*)$/)
        if (taskMatch) {
            task = `<span class="md-task${taskMatch[1] === " " ? "" : " is-done"}" aria-hidden="true"></span>`
            lines = [taskMatch[2], ...lines.slice(1)]
        }
        const body = depth >= MAX_BLOCK_DEPTH
            ? renderInline(lines.join("\n"))
            : renderBlocks(lines, depth + 1, { tight: !list.loose })
        return `<li${task ? ' class="md-task-item"' : ""}>${task}${body}</li>`
    })
    return `<${tag}${startAttr}>${items.join("")}</${tag}>`
}

const PLACEHOLDER = /\u0000(\d+)\u0000/g

/** Renders inline Markdown (code spans, links, emphasis, strikethrough, line breaks) to safe HTML. */
export function renderInline(source: string): string {
    const slots: string[] = []
    const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`
    let text = source.replace(/\u0000/g, "�")

    // Code spans first: nothing inside them is interpreted.
    text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
        const trimmed = /^ [\s\S]* $/.test(code) && code.trim() ? code.slice(1, -1) : code
        return hold(`<code>${escapeText(trimmed.replace(/\n/g, " "))}</code>`)
    })
    // Backslash escapes.
    text = text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_, char: string) => hold(escapeText(char)))
    // Images never load; show them as a link (or a plain label when the URL isn't allowed).
    text = text.replace(/!\[([^\]\n]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, (_, alt: string, url: string) => {
        const label = `<span class="md-img-label">${escapeText(alt || "Image")}</span>`
        const href = sanitizeLinkUrl(url)
        return hold(href
            ? `<a class="md-img" href="${escapeText(href)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
            : `<span class="md-img">${label}</span>`)
    })
    // Inline links.
    text = text.replace(/\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, (_, label: string, url: string) => {
        const href = sanitizeLinkUrl(url)
        const inner = renderInline(label)
        return hold(href
            ? `<a href="${escapeText(href)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`
            : inner)
    })
    // Autolinks: <https://…> and bare URLs.
    text = text.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (match, url: string) => {
        const href = sanitizeLinkUrl(url)
        return href ? hold(`<a href="${escapeText(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeText(url)}</a>`) : match
    })
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"']*[^\s<>"'.,:;!?)\]])/gi, (match, lead: string, url: string) => {
        const href = sanitizeLinkUrl(url)
        return href
            ? `${lead}${hold(`<a href="${escapeText(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeText(url)}</a>`)}`
            : match
    })

    let html = escapeText(text)
    html = html
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
        .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, "<em>$1</em>")
        .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
        .replace(/(?: {2,}|\\)\n/g, "<br>\n")
    // Placeholders can nest (a link label holding a code span), so restore until none are left.
    for (let pass = 0; pass < 4 && PLACEHOLDER.test(html); pass++) {
        PLACEHOLDER.lastIndex = 0
        html = html.replace(PLACEHOLDER, (_, slot: string) => slots[Number(slot)] ?? "")
    }
    PLACEHOLDER.lastIndex = 0
    return html
}

/** Renders a Markdown document to safe HTML (see the module comment for the supported subset). */
export function renderMarkdown(source: string): string {
    const normalized = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "�")
    return renderBlocks(normalized.split("\n"), 0)
}

/* ------------------------------------------------------------------ CSV */

export type DelimitedTable = {
    rows: string[][]
    /** Total number of records in the file (including the header). */
    totalRows: number
    truncated: boolean
    columns: number
}

export function detectDelimiter(text: string, fileName = ""): string {
    if (/\.tsv$/i.test(fileName)) return "\t"
    const firstLine = text.slice(0, 4096).split(/\r?\n/, 1)[0] ?? ""
    const unquoted = firstLine.replace(/"[^"]*"/g, "")
    const counts: Array<[string, number]> = [",", ";", "\t", "|"].map((char) => [char, unquoted.split(char).length - 1])
    counts.sort((a, b) => b[1] - a[1])
    return counts[0][1] > 0 ? counts[0][0] : ","
}

/**
 * RFC 4180-style parser (quoted fields, doubled quotes, CR/LF/CRLF line endings). Keeps the first `maxRows`
 * records and only counts the rest.
 */
export function parseDelimited(text: string, delimiter = ",", maxRows = Number.POSITIVE_INFINITY, maxColumns = 200): DelimitedTable {
    const rows: string[][] = []
    let row: string[] = []
    let field = ""
    let inQuotes = false
    let totalRows = 0
    let columns = 0
    let fieldStarted = false
    const source = text.replace(/^﻿/, "")
    const pushField = () => {
        if (row.length < maxColumns) row.push(field)
        field = ""
        fieldStarted = false
    }
    const pushRow = () => {
        pushField()
        totalRows++
        if (rows.length < maxRows) {
            rows.push(row)
            columns = Math.max(columns, row.length)
        }
        row = []
    }
    for (let index = 0; index < source.length; index++) {
        const char = source[index]
        if (inQuotes) {
            if (char === '"') {
                if (source[index + 1] === '"') {
                    field += '"'
                    index++
                } else {
                    inQuotes = false
                }
            } else {
                field += char
            }
            continue
        }
        if (char === '"' && !fieldStarted && field === "") {
            inQuotes = true
            fieldStarted = true
        } else if (char === delimiter) {
            pushField()
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && source[index + 1] === "\n") index++
            pushRow()
        } else {
            field += char
            fieldStarted = true
        }
    }
    if (field !== "" || fieldStarted || row.length > 0) pushRow()
    return { rows, totalRows, truncated: totalRows > rows.length, columns }
}

/* ----------------------------------------------------------------- Text */

export type DecodedText = { text: string; binary: boolean; encoding: string }

/** Decodes file bytes as text (UTF-8, or UTF-16 with a BOM). Flags content that looks binary. */
export function decodeTextBytes(bytes: Uint8Array): DecodedText {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), binary: false, encoding: "UTF-16" }
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), binary: false, encoding: "UTF-16" }
    }
    const sample = bytes.subarray(0, 8192)
    let suspicious = 0
    for (const byte of sample) {
        if (byte === 0) return { text: "", binary: true, encoding: "binary" }
        if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) suspicious++
    }
    if (sample.length > 0 && suspicious / sample.length > 0.1) return { text: "", binary: true, encoding: "binary" }
    const text = new TextDecoder("utf-8").decode(bytes)
    return { text, binary: false, encoding: "UTF-8" }
}

export function splitLines(text: string): string[] {
    const lines = text.split(/\r\n|\n|\r/)
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
    return lines
}

/** Pretty-prints JSON when it parses; returns null otherwise. */
export function prettyJson(text: string): string | null {
    try {
        return JSON.stringify(JSON.parse(text.replace(/^﻿/, "")), null, 2)
    } catch {
        return null
    }
}
