import assert from "node:assert/strict"
import test from "node:test"

import {
    buildTelegramLoginUrl,
    createQrMatrix,
    getLogoModuleRange,
    renderQrSvg,
    toBase64Url,
} from "../../../src/web/qrCode.ts"

test("login tokens are encoded as unpadded base64url", () => {
    assert.equal(toBase64Url(new Uint8Array([0xfb, 0xff, 0xbf])), "-_-_")
    assert.equal(toBase64Url(new Uint8Array([0x01])), "AQ")
    assert.equal(toBase64Url(new Uint8Array([])), "")
})

test("Telegram QR login URL wraps the token in tg://login", () => {
    const token = new Uint8Array(32).map((_, index) => index * 7)
    const url = buildTelegramLoginUrl(token)
    assert.match(url, /^tg:\/\/login\?token=[A-Za-z0-9_-]{43}$/)
    const encoded = url.slice("tg://login?token=".length)
    const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    assert.deepEqual(new Uint8Array(decoded), token)
})

test("QR matrix uses the requested error correction and has finder patterns", () => {
    const url = buildTelegramLoginUrl(new Uint8Array(32).fill(255))
    const matrix = createQrMatrix(url, "Q")
    // 60 bytes at level Q fits version 5 (37x37 modules).
    assert.equal(matrix.size, 37)
    for (const [row, col] of [[0, 0], [0, matrix.size - 1], [matrix.size - 1, 0]]) {
        assert.equal(matrix.isDark(row, col), true)
    }
    assert.equal(matrix.isDark(1, 1), false)
    assert.equal(matrix.isDark(3, 3), true)
})

test("logo area stays centered, odd-sized and small enough for level Q recovery", () => {
    for (const size of [21, 25, 29, 33, 37, 41, 45, 57]) {
        const range = getLogoModuleRange(size, 0.22)
        assert.ok(range)
        const [start, end] = range
        const span = end - start
        assert.equal(span % 2, 1)
        assert.equal(start, size - end)
        // Level Q restores ~25% of codewords; keep the cleared area well below that.
        assert.ok((span * span) / (size * size) <= 0.0625, `logo too large for ${size}`)
    }
    assert.ok((getLogoModuleRange(37, 0.9)?.[1] ?? 0) - (getLogoModuleRange(37, 0.9)?.[0] ?? 0) <= Math.round(37 * 0.25))
    assert.equal(getLogoModuleRange(9, 0.22), null)
})

test("rendered SVG is self-contained with a quiet zone and a centered logo", () => {
    const url = buildTelegramLoginUrl(new Uint8Array(32).fill(7))
    const svg = renderQrSvg(url, { logoHref: "/icons/TGLFS%20logo%20192.png", title: "Sign in <QR>" })
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 43 43"/)
    assert.match(svg, /<title>Sign in &lt;QR&gt;<\/title>/)
    assert.match(svg, /<image href="\/icons\/TGLFS%20logo%20192\.png"/)
    assert.doesNotMatch(svg, /tg:\/\/login/, "the token must not be embedded as text")

    const noLogo = renderQrSvg(url)
    assert.doesNotMatch(noLogo, /<image/)
    assert.match(noLogo, /aria-hidden="true"/)
})
