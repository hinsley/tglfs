import type { FileCardData } from "./file-cards.js"

export function getMediaPreviewUpgradeCapability(data: FileCardData): {
    supported: boolean
    current: boolean
    reason: string
} {
    if (![1, 2, 3, 5].includes(data.version))
        return { supported: false, current: false, reason: "This file protocol cannot be upgraded as media." }
    if (!data.uploadComplete || (data.version === 5 && data.content.archive) || !/\.(mp4|webm)$/i.test(data.name))
        return { supported: false, current: false, reason: "Select a complete MP4 or WebM file." }
    if (data.version === 5 && data.mediaPreview)
        return { supported: false, current: true, reason: "This media already has an encrypted seek index." }
    return {
        supported: true,
        current: false,
        reason: "Create a seekable preview copy while keeping the original and its password.",
    }
}
export function seekableMediaCopyName(name: string) {
    return name.replace(/\.(mp4|webm)$/i, ".seekable.$1")
}
