import { UfidAccumulator } from "../ufid.js"
import { finishUfid, hashBytes } from "./block-format.js"
import type { BlockReader } from "./block-format.js"

export type DownloadState = {
    type: "tglfs:download-state"
    version: 1
    contentId: string
    ufid: string
    size: number
    blockSize: number
    completedBlocks: number
}
export type ResumeDestination = {
    load(): Promise<unknown | null>
    size(): Promise<number>
    read(offset: number, length: number): Promise<Uint8Array>
    write(offset: number, bytes: Uint8Array): Promise<void>
    checkpoint(state: DownloadState, size: number): Promise<void>
}
export function validateDownloadState(value: unknown, reader: BlockReader): DownloadState {
    const s = value as DownloadState
    if (
        !s ||
        s.type !== "tglfs:download-state" ||
        s.version !== 1 ||
        s.contentId !== reader.content.id ||
        s.ufid !== reader.plan.ufid ||
        s.size !== reader.plan.size ||
        s.blockSize !== reader.content.blockSize ||
        !Number.isSafeInteger(s.completedBlocks) ||
        s.completedBlocks < 0 ||
        s.completedBlocks > reader.plan.hashes.length
    )
        throw new Error("The saved download belongs to a different file or an unsupported checkpoint version.")
    return s
}
export async function resumeBlockDownload(
    reader: BlockReader,
    destination: ResumeDestination,
    options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
): Promise<void> {
    const abort = () => {
        if (options.signal?.aborted)
            throw new DOMException("Download interrupted. Download the same file again to resume.", "AbortError")
    }
    const saved = await destination.load()
    let state: DownloadState =
        saved === null
            ? {
                  type: "tglfs:download-state",
                  version: 1,
                  contentId: reader.content.id,
                  ufid: reader.plan.ufid,
                  size: reader.plan.size,
                  blockSize: reader.content.blockSize,
                  completedBlocks: 0,
              }
            : validateDownloadState(saved, reader)
    const committed = Math.min(state.completedBlocks * state.blockSize, state.size)
    if (saved === null && (await destination.size()) !== 0)
        throw new Error("The selected partial file has no matching download checkpoint.")
    if ((await destination.size()) < committed) throw new Error("The saved download is shorter than its checkpoint.")
    const ufid = new UfidAccumulator()
    for (let i = 0; i < state.completedBlocks; i++) {
        abort()
        const offset = i * state.blockSize
        const length = Math.min(state.blockSize, state.size - offset)
        const bytes = await destination.read(offset, length)
        if (bytes.length !== length || (await hashBytes(bytes)) !== reader.plan.hashes[i])
            throw new Error("The saved download was changed or corrupted. Choose another destination to start again.")
        await ufid.update(bytes)
        options.onProgress?.(offset + length)
    }
    await destination.checkpoint(state, committed)
    for (let i = state.completedBlocks; i < reader.plan.hashes.length; i++) {
        abort()
        const bytes = await reader.readBlock(i)
        abort()
        await destination.write(i * state.blockSize, bytes)
        await ufid.update(bytes)
        state = { ...state, completedBlocks: i + 1 }
        await destination.checkpoint(state, Math.min(state.completedBlocks * state.blockSize, state.size))
        options.onProgress?.(Math.min(state.completedBlocks * state.blockSize, state.size))
    }
    if ((await finishUfid(ufid, state.size)) !== state.ufid)
        throw new Error("The download failed its final UFID verification.")
}
