export function isMp4FileName(name: string): boolean {
    return /\.mp4$/i.test(name.trim())
}

export function getPreviewableMp4Name(name: string): string {
    const trimmed = name.trim()
    if (!isMp4FileName(trimmed)) {
        throw new Error(`Not an MP4 file name: ${name}`)
    }

    const base = trimmed.slice(0, -4)
    const numbered = base.match(/^(.*)\.previewable-(\d+)$/i)
    if (numbered) {
        const next = Number(numbered[2]) + 1
        return `${numbered[1]}.previewable-${next}.mp4`
    }
    if (/\.previewable$/i.test(base)) {
        return `${base}-2.mp4`
    }
    return `${base}.previewable.mp4`
}
