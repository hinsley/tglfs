// Local QR rendering for Telegram QR login. The login token never leaves the
// browser: the matrix is computed here and drawn as inline SVG.
import qrcode from "qrcode-generator"

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H"

export type QrMatrix = {
    size: number
    isDark: (row: number, col: number) => boolean
}

export type QrSvgOptions = {
    /** Error-correction level. Defaults to "Q" (~25% recovery) so a centered logo still scans. */
    level?: QrErrorCorrectionLevel
    /** Quiet zone in modules around the code. */
    margin?: number
    /** Image drawn in the center of the code; the modules underneath are cleared. */
    logoHref?: string
    /** Logo plate width as a fraction of the module count (clamped to a safe maximum). */
    logoRatio?: number
    foreground?: string
    background?: string
    /** Accessible name for the SVG. */
    title?: string
}

/** Largest logo plate we allow, as a fraction of the symbol width (~6% of the area). */
const MAX_LOGO_RATIO = 0.25

/** Encodes bytes as unpadded base64url, the format Telegram expects in `tg://login?token=`. */
export function toBase64Url(bytes: Uint8Array): string {
    let binary = ""
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Builds the deep link a logged-in Telegram app accepts from a `auth.loginToken` token. */
export function buildTelegramLoginUrl(token: Uint8Array): string {
    return `tg://login?token=${toBase64Url(token)}`
}

export function createQrMatrix(text: string, level: QrErrorCorrectionLevel = "Q"): QrMatrix {
    const qr = qrcode(0, level)
    qr.addData(text, "Byte")
    qr.make()
    return {
        size: qr.getModuleCount(),
        isDark: (row, col) => qr.isDark(row, col),
    }
}

function escapeXml(value: string) {
    return value.replace(/[<>&"']/g, (char) =>
        char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === "&" ? "&amp;" : char === '"' ? "&quot;" : "&#39;",
    )
}

/** Returns the [start, end) module range of the centered logo area, or null when there is no logo. */
export function getLogoModuleRange(size: number, logoRatio: number): [number, number] | null {
    const ratio = Math.min(Math.max(logoRatio, 0), MAX_LOGO_RATIO)
    let span = Math.round(size * ratio)
    if (span < 3) {
        return null
    }
    // Keep the plate centered on whole modules (module counts are always odd).
    if (span % 2 === 0) {
        span -= 1
    }
    const start = (size - span) / 2
    return [start, start + span]
}

function isFinderModule(size: number, row: number, col: number) {
    const inTop = row < 7
    const inLeft = col < 7
    const inBottom = row >= size - 7
    const inRight = col >= size - 7
    return (inTop && inLeft) || (inTop && inRight) || (inBottom && inLeft)
}

function finderPath(x: number, y: number) {
    // Outer 7x7 ring (rounded) with a 5x5 hole, then a rounded 3x3 eye.
    const outer = roundedRectPath(x, y, 7, 7, 1.9)
    const hole = roundedRectPath(x + 1, y + 1, 5, 5, 1.1, true)
    const eye = roundedRectPath(x + 2, y + 2, 3, 3, 0.9)
    return `${outer}${hole}${eye}`
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number, counterClockwise = false) {
    const right = x + w
    const bottom = y + h
    if (counterClockwise) {
        return (
            `M${x + r} ${y}A${r} ${r} 0 0 0 ${x} ${y + r}V${bottom - r}A${r} ${r} 0 0 0 ${x + r} ${bottom}` +
            `H${right - r}A${r} ${r} 0 0 0 ${right} ${bottom - r}V${y + r}A${r} ${r} 0 0 0 ${right - r} ${y}Z`
        )
    }
    return (
        `M${x + r} ${y}H${right - r}A${r} ${r} 0 0 1 ${right} ${y + r}V${bottom - r}` +
        `A${r} ${r} 0 0 1 ${right - r} ${bottom}H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
    )
}

/**
 * Renders a QR code as a self-contained SVG string. Data modules are merged into
 * horizontal runs (crisp at any size); the three finder patterns are drawn with
 * soft corners, and an optional logo sits on a plate in the middle.
 */
export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
    const level = options.level ?? "Q"
    const margin = options.margin ?? 3
    const foreground = options.foreground ?? "#0f1720"
    const background = options.background ?? "#ffffff"
    const matrix = createQrMatrix(text, level)
    const { size } = matrix
    const logoRange = options.logoHref ? getLogoModuleRange(size, options.logoRatio ?? 0.24) : null
    const inLogo = (row: number, col: number) =>
        !!logoRange && row >= logoRange[0] && row < logoRange[1] && col >= logoRange[0] && col < logoRange[1]

    let modules = ""
    for (let row = 0; row < size; row += 1) {
        let col = 0
        while (col < size) {
            if (!matrix.isDark(row, col) || isFinderModule(size, row, col) || inLogo(row, col)) {
                col += 1
                continue
            }
            const start = col
            while (col < size && matrix.isDark(row, col) && !isFinderModule(size, row, col) && !inLogo(row, col)) {
                col += 1
            }
            modules += `M${start + margin} ${row + margin}h${col - start}v1h${start - col}Z`
        }
    }

    const finders =
        finderPath(margin, margin) + finderPath(margin + size - 7, margin) + finderPath(margin, margin + size - 7)

    const total = size + margin * 2
    let logo = ""
    if (logoRange && options.logoHref) {
        const [start, end] = logoRange
        const span = end - start
        const inset = 0.55
        const x = start + margin + inset
        const imageSize = span - inset * 2
        const radius = imageSize * 0.24
        logo =
            `<clipPath id="tglfs-qr-logo-clip"><rect x="${x}" y="${x}" width="${imageSize}" height="${imageSize}" rx="${radius}"/></clipPath>` +
            `<image href="${escapeXml(options.logoHref)}" x="${x}" y="${x}" width="${imageSize}" height="${imageSize}" ` +
            `preserveAspectRatio="xMidYMid slice" clip-path="url(#tglfs-qr-logo-clip)"/>`
    }

    const title = options.title ? `<title>${escapeXml(options.title)}</title>` : ""
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" class="auth-qr-svg" ` +
        `role="img"${options.title ? "" : ' aria-hidden="true"'}>` +
        title +
        `<rect width="${total}" height="${total}" fill="${background}"/>` +
        `<path d="${modules}" fill="${foreground}" shape-rendering="crispEdges"/>` +
        `<path d="${finders}" fill="${foreground}" fill-rule="evenodd"/>` +
        logo +
        `</svg>`
    )
}
