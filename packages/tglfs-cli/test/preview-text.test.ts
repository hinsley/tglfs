import assert from "node:assert/strict"
import { test } from "node:test"

import {
    decodeTextBytes,
    detectDelimiter,
    escapeText,
    parseDelimited,
    prettyJson,
    renderInline,
    renderMarkdown,
    sanitizeLinkUrl,
    splitLines,
} from "../../../src/web/textRender.ts"
import {
    detectPreviewType,
    isPreviewableFileName,
    isPreviewTooLarge,
    isTextPreviewType,
    previewFormatLabel,
    TEXT_PREVIEW_MAX_BYTES,
} from "../../../src/web/previewTypes.ts"

/* -------------------------------------------------------------- File types */

test("detectPreviewType keeps the existing media types", () => {
    assert.equal(detectPreviewType("photo.JPG"), "image")
    assert.equal(detectPreviewType("logo.svg"), "image")
    assert.equal(detectPreviewType("clip.mp4"), "video")
    assert.equal(detectPreviewType("song.flac"), "audio")
})

test("detectPreviewType recognizes documents, text and code", () => {
    assert.equal(detectPreviewType("Quarterly report.pdf"), "pdf")
    assert.equal(detectPreviewType("README.md"), "markdown")
    assert.equal(detectPreviewType("notes.markdown"), "markdown")
    assert.equal(detectPreviewType("sales.csv"), "csv")
    assert.equal(detectPreviewType("sales.TSV"), "csv")
    assert.equal(detectPreviewType("package.json"), "json")
    assert.equal(detectPreviewType("server.ts"), "code")
    assert.equal(detectPreviewType("index.html"), "code")
    assert.equal(detectPreviewType("notes.txt"), "text")
    assert.equal(detectPreviewType("app.log"), "text")
    assert.equal(detectPreviewType("LICENSE"), "text")
    assert.equal(detectPreviewType("Makefile"), "text")
    assert.equal(detectPreviewType(".gitignore"), "code")
})

test("detectPreviewType refuses binary and unknown formats", () => {
    for (const name of ["archive.zip", "backup.tar.gz", "document.docx", "sheet.xlsx", "noext", "photo.heic", "a.exe"]) {
        assert.equal(detectPreviewType(name), "unsupported", name)
        assert.equal(isPreviewableFileName(name), false, name)
    }
})

test("text previews are capped by size while media is not", () => {
    assert.equal(isTextPreviewType("markdown"), true)
    assert.equal(isTextPreviewType("image"), false)
    assert.equal(isTextPreviewType("pdf"), false)
    assert.equal(isPreviewTooLarge("text", TEXT_PREVIEW_MAX_BYTES), false)
    assert.equal(isPreviewTooLarge("text", TEXT_PREVIEW_MAX_BYTES + 1), true)
    assert.equal(isPreviewTooLarge("video", 10 * 1024 * 1024 * 1024), false)
    assert.equal(isPreviewTooLarge("pdf", 1024), false)
    assert.equal(previewFormatLabel("x.tsv", "csv"), "TSV")
    assert.equal(previewFormatLabel("x.py", "code"), "PY")
})

/* ---------------------------------------------------------- Markdown safety */

test("markdown escapes raw HTML instead of rendering it", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">')
    assert.ok(!html.includes("<script"), html)
    assert.ok(!html.includes("<img"), html)
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), html)
    assert.ok(html.includes("onerror=&quot;alert(1)&quot;"), html)
})

test("markdown only links to http(s) and mailto targets", () => {
    const unsafe = [
        "[x](javascript:alert(1))",
        "[x](JaVaScRiPt:alert(1))",
        "[x](java\tscript:alert(1))",
        "[x](data:text/html;base64,PHNjcmlwdD4=)",
        "[x](vbscript:msgbox)",
        "[x](javascript&#58;alert(1))",
        "[x](//evil.example/path)",
        "[x](relative/page.md)",
    ]
    for (const source of unsafe) {
        const html = renderMarkdown(source)
        assert.ok(!/href=/.test(html), `${source} -> ${html}`)
        assert.ok(!/<a\b/.test(html), `${source} -> ${html}`)
        if (!source.includes("\t")) assert.equal(html, "<p>x</p>", source)
    }
    const safe = renderMarkdown('[docs](https://example.com/a?b=1&c="2") and <mailto:me@example.com>')
    assert.ok(safe.includes('href="https://example.com/a?b=1&amp;c=&quot;2&quot;"'), safe)
    assert.ok(safe.includes('rel="noopener noreferrer nofollow"'), safe)
    assert.ok(safe.includes('href="mailto:me@example.com"'), safe)
})

test("markdown link labels and attributes cannot break out of the tag", () => {
    const html = renderMarkdown('[<b onclick="x">hi</b>](https://example.com/"onmouseover="alert(1))')
    assert.ok(!html.includes("<b"), html)
    assert.ok(!/"onmouseover=/.test(html), html)
})

test("markdown images are never loaded", () => {
    const html = renderMarkdown("![diagram](https://tracker.example/pixel.png)")
    assert.ok(!html.includes("<img"), html)
    assert.ok(html.includes('class="md-img"'), html)
    assert.ok(html.includes("diagram"), html)
    const unsafe = renderMarkdown("![x](javascript:alert(1))")
    assert.ok(!unsafe.includes("href"), unsafe)
})

test("markdown code keeps its content literal and escaped", () => {
    const html = renderMarkdown("Use `<b>**not bold**</b>` here\n\n```html\n<div onclick=\"x\">*hi*</div>\n```")
    assert.ok(html.includes("<code>&lt;b&gt;**not bold**&lt;/b&gt;</code>"), html)
    assert.ok(html.includes('<pre class="md-code"><code class="language-html">&lt;div onclick=&quot;x&quot;&gt;*hi*&lt;/div&gt;</code></pre>'), html)
    const weirdLang = renderMarkdown('```"><script>\nx\n```')
    assert.ok(!weirdLang.includes("<script"), weirdLang)
})

test("markdown NUL bytes cannot forge internal placeholders", () => {
    const html = renderMarkdown("before \u00000\u0000 after `code`")
    assert.ok(!html.includes("\u0000"), html)
    assert.ok(html.includes("<code>code</code>"), html)
})

/* ------------------------------------------------------ Markdown structure */

test("markdown renders headings, emphasis, lists, quotes and rules", () => {
    const html = renderMarkdown([
        "# Title",
        "",
        "Some **bold**, *italic*, __strong__, _em_ and ~~gone~~ text.",
        "snake_case_name stays",
        "",
        "- one",
        "- two",
        "  - nested",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted *text*",
        "",
        "---",
        "",
        "- [ ] todo",
        "- [x] done",
        "",
        "Setext",
        "======",
    ].join("\n"))
    assert.ok(html.includes("<h1>Title</h1>"), html)
    assert.ok(html.includes("<strong>bold</strong>"), html)
    assert.ok(html.includes("<em>italic</em>"), html)
    assert.ok(html.includes("<strong>strong</strong>"), html)
    assert.ok(html.includes("<em>em</em>"), html)
    assert.ok(html.includes("<del>gone</del>"), html)
    assert.ok(html.includes("snake_case_name stays"), html)
    assert.ok(html.includes("<ul><li>one</li><li>two\n<ul><li>nested</li></ul></li></ul>"), html)
    assert.ok(html.includes("<ol><li>first</li><li>second</li></ol>"), html)
    assert.ok(html.includes("<blockquote><p>quoted <em>italic</em></p></blockquote>".replace("italic", "text")), html)
    assert.ok(html.includes("<hr>"), html)
    assert.ok(html.includes('<span class="md-task" aria-hidden="true"></span>todo'), html)
    assert.ok(html.includes('<span class="md-task is-done" aria-hidden="true"></span>done'), html)
    assert.ok(html.includes("<h1>Setext</h1>"), html)
})

test("markdown renders pipe tables with alignment", () => {
    const html = renderMarkdown("| Name | Size |\n|:-----|-----:|\n| a.txt | 1 KB |\n| b \\| c | 2 KB |")
    assert.ok(html.includes('<th style="text-align:left">Name</th>'), html)
    assert.ok(html.includes('<td style="text-align:right">1 KB</td>'), html)
    assert.ok(html.includes("<td style=\"text-align:left\">b | c</td>"), html)
})

test("markdown ordered lists keep their start number and loose lists use paragraphs", () => {
    assert.ok(renderMarkdown("3. three\n4. four").startsWith('<ol start="3">'))
    const loose = renderMarkdown("- a\n\n- b")
    assert.equal(loose, "<ul><li><p>a</p></li><li><p>b</p></li></ul>")
})

test("markdown handles pathological nesting without blowing the stack", () => {
    const deep = `${">".repeat(5000)} deep`
    const html = renderMarkdown(deep)
    assert.ok(html.includes("deep"))
    const list = Array.from({ length: 200 }, (_, depth) => `${"  ".repeat(depth)}- level ${depth}`).join("\n")
    assert.ok(renderMarkdown(list).includes("level 199"))
})

test("inline rendering autolinks bare URLs without trailing punctuation", () => {
    const html = renderInline("See https://example.com/docs. Done")
    assert.ok(html.includes('<a href="https://example.com/docs"'), html)
    assert.ok(html.endsWith(". Done"), html)
    assert.equal(escapeText(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;")
    assert.equal(sanitizeLinkUrl(" https://ok.example "), "https://ok.example")
    assert.equal(sanitizeLinkUrl("https:evil"), null)
})

/* -------------------------------------------------------------------- CSV */

test("CSV parser handles quotes, escaped quotes, newlines in fields and CRLF", () => {
    const table = parseDelimited('name,note\r\n"Smith, J","said ""hi"""\r\nplain,"two\nlines"\r\n', ",")
    assert.deepEqual(table.rows, [
        ["name", "note"],
        ["Smith, J", 'said "hi"'],
        ["plain", "two\nlines"],
    ])
    assert.equal(table.totalRows, 3)
    assert.equal(table.truncated, false)
    assert.equal(table.columns, 2)
})

test("CSV parser keeps the first rows and counts the rest", () => {
    const text = Array.from({ length: 1000 }, (_, index) => `${index},value ${index}`).join("\n")
    const table = parseDelimited(text, ",", 10)
    assert.equal(table.rows.length, 10)
    assert.equal(table.totalRows, 1000)
    assert.equal(table.truncated, true)
})

test("delimiter detection prefers tabs for TSV and the most common separator otherwise", () => {
    assert.equal(detectDelimiter("a,b\n1,2", "x.tsv"), "\t")
    assert.equal(detectDelimiter("a;b;c\n1;2;3", "x.csv"), ";")
    assert.equal(detectDelimiter('"a;b",c,d\n', "x.csv"), ",")
    assert.equal(detectDelimiter("single", "x.csv"), ",")
})

/* ------------------------------------------------------------------- Text */

test("text decoding flags binary content and handles BOMs", () => {
    assert.equal(decodeTextBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])).binary, true)
    const utf8 = decodeTextBytes(new TextEncoder().encode("﻿héllo"))
    assert.equal(utf8.binary, false)
    assert.equal(utf8.text, "héllo")
    const utf16 = decodeTextBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))
    assert.equal(utf16.text, "hi")
    assert.deepEqual(splitLines("a\r\nb\nc\n"), ["a", "b", "c"])
    assert.deepEqual(splitLines(""), [""])
    assert.equal(prettyJson('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}')
    assert.equal(prettyJson("{nope"), null)
})
