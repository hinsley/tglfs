import "./mp4Previewable"
import { PreviewModal as CorePreviewModal } from "./previewCore"
import type { PreviewEntry } from "./previewCore"

const LEGACY_FIXED_MP4_MIME = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'

function extension(name: string): string {
    const parts = name.toLowerCase().split(".")
    return parts.length > 1 ? parts.pop() ?? "" : ""
}

export class PreviewModal extends CorePreviewModal {
    constructor(client: any) {
        super(client)
        const original = (this as any).getStreamMimeType?.bind(this)
        ;(this as any).getStreamMimeType = (name: string, type: "video" | "audio") => {
            const ext = extension(name)
            if (type === "video" && (ext === "mp4" || ext === "m4v" || ext === "mov")) {
                // Prefer the generic MP4 byte-stream declaration so the initialization segment identifies
                // the actual tracks. The old fixed declaration is retained only for browsers that require it;
                // converted fallback files deliberately use that AVC Baseline/AAC profile pair.
                for (const candidate of ["video/mp4", LEGACY_FIXED_MP4_MIME]) {
                    if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(candidate)) return candidate
                }
                return null
            }
            return original?.(name, type) ?? null
        }
    }
}

export type { PreviewEntry }
