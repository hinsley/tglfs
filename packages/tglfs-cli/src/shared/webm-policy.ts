export const WEBM_MIN_SSIM = 0.98
export const WEBM_CACHE_BYTES = 32 * 1024 * 1024
export const WEBM_REFERENCE_BYTES = 64 * 1024 * 1024

export type QualityClip = { start: number; end: number; ssim: number; frames?: number }
export type WebmQualityReport = {
    metric: "SSIM luma"
    threshold: number
    clips: QualityClip[]
    scope: "Sampled clips only; not a guarantee for every frame or audio quality."
}

export function isWebmSourceName(name: string) {
    return /\.(mp4|mov|m4v|mkv|webm)$/i.test(name.trim())
}

export function webmCopyName(name: string) {
    if (!isWebmSourceName(name)) throw new Error("Supported sources are MP4, MOV, M4V, MKV and WebM.")
    return name.trim().replace(/\.[^.]+$/, "") + ".preview.webm"
}

export function sampleWindows(duration: number): { start: number; end: number }[] {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("A finite positive video duration is required.")
    if (duration < 0.3) return [{ start: 0, end: duration }]
    const length = Math.min(1, duration / 3)
    return [0, (duration - length) / 2, duration - length].map(start => ({ start, end: start + length }))
}

export function qualityReport(clips: QualityClip[]): WebmQualityReport {
    if (!clips.length || clips.some(clip => !Number.isFinite(clip.ssim) || clip.ssim < WEBM_MIN_SSIM || clip.ssim > 1 || clip.frames === 0)) {
        throw new Error(`WebM sample quality failed: every sampled clip must have luma SSIM >= ${WEBM_MIN_SSIM}. No new file card was published.`)
    }
    return { metric: "SSIM luma", threshold: WEBM_MIN_SSIM, clips, scope: "Sampled clips only; not a guarantee for every frame or audio quality." }
}

/** Compare full-resolution luma in 8 by 8 pixel windows. */
export function lumaSsim(reference: Uint8Array, decoded: Uint8Array, width: number, height: number) {
    if (reference.length !== width * height || decoded.length !== reference.length || width <= 0 || height <= 0) {
        throw new Error("Quality frames have different or invalid dimensions.")
    }
    let sum = 0
    let blocks = 0
    const c1 = (0.01 * 255) ** 2
    const c2 = (0.03 * 255) ** 2
    for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
        let a = 0, b = 0, aa = 0, bb = 0, ab = 0, count = 0
        for (let row = y; row < Math.min(y + 8, height); row++) for (let col = x; col < Math.min(x + 8, width); col++) {
            const r = reference[row * width + col], d = decoded[row * width + col]
            a += r; b += d; aa += r * r; bb += d * d; ab += r * d; count++
        }
        a /= count; b /= count
        const va = Math.max(0, aa / count - a * a), vb = Math.max(0, bb / count - b * b)
        sum += ((2 * a * b + c1) * (2 * (ab / count - a * b) + c2)) / ((a * a + b * b + c1) * (va + vb + c2))
        blocks++
    }
    return Math.min(1, sum / blocks)
}

export function validateWebmDimensions(width: number, height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 4096 || height > 4096 || width * height > 4096 * 2304) {
        throw new Error("This video exceeds the bounded conversion limit of 4096 pixels per side and 4096 × 2304 pixels per frame.")
    }
}
