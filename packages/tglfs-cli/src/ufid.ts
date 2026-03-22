const UFID_CHUNK_SIZE = 64 * 1024

function toHex(bytes: Uint8Array) {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
}

async function digestChunk(rolling: Uint8Array, chunk: Uint8Array): Promise<Uint8Array> {
    const toHash = new Uint8Array(rolling.length + chunk.length)
    toHash.set(rolling, 0)
    toHash.set(chunk, rolling.length)
    const digest = await globalThis.crypto.subtle.digest("SHA-256", toHash.buffer)
    return new Uint8Array(digest)
}

export class UfidAccumulator {
    private rolling = new Uint8Array(0)
    private pending = new Uint8Array(0)

    async update(chunk: Uint8Array) {
        if (chunk.length === 0) {
            return
        }

        const combined = new Uint8Array(this.pending.length + chunk.length)
        combined.set(this.pending, 0)
        combined.set(chunk, this.pending.length)

        let offset = 0
        while (offset + UFID_CHUNK_SIZE <= combined.length) {
            const piece = combined.subarray(offset, offset + UFID_CHUNK_SIZE)
            this.rolling = await digestChunk(this.rolling, piece)
            offset += UFID_CHUNK_SIZE
        }

        this.pending = combined.slice(offset)
    }

    async digest(): Promise<string> {
        if (this.pending.length > 0) {
            const padded = new Uint8Array(UFID_CHUNK_SIZE)
            padded.set(this.pending, 0)
            this.rolling = await digestChunk(this.rolling, padded)
            this.pending = new Uint8Array(0)
        }

        return toHex(this.rolling)
    }
}

export async function computeUfidFromBytes(bytes: Uint8Array) {
    const accumulator = new UfidAccumulator()
    await accumulator.update(bytes)
    return accumulator.digest()
}
