/** Identify the container from its bytes and replay the inspected prefix. */
export async function identifyVideoStream(source: ReadableStream<Uint8Array>) {
    const reader = source.getReader()
    const prefix: Uint8Array[] = []
    const header = new Uint8Array(8)
    let length = 0, index = 0
    try {
        while (length < header.length) {
            const { value, done } = await reader.read()
            if (done) throw new Error("The video container header is truncated.")
            if (!value.length) continue
            prefix.push(value)
            const count = Math.min(value.length, header.length - length)
            header.set(value.subarray(0, count), length)
            length += count
        }
        const ebml = header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3
        const box = String.fromCharCode(...header.subarray(4, 8))
        if (!ebml && !["ftyp", "moov", "mdat", "free", "skip", "wide"].includes(box)) throw new Error("Unsupported video container. Only MP4/MOV/M4V and MKV/WebM are accepted.")
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (index < prefix.length) return controller.enqueue(prefix[index++])
                try {
                    const result = await reader.read()
                    if (result.done) { reader.releaseLock(); controller.close() }
                    else controller.enqueue(result.value)
                } catch (error) { try { reader.releaseLock() } catch {}; controller.error(error) }
            },
            async cancel(reason) { try { await reader.cancel(reason) } finally { try { reader.releaseLock() } catch {} } },
        })
        return { stream, container: ebml ? "webm" as const : "mp4" as const }
    } catch (error) {
        await reader.cancel(error).catch(() => {})
        reader.releaseLock()
        throw error
    }
}
