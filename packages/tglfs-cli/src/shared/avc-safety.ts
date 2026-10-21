class Bits {
    offset = 0
    constructor(readonly bytes: Uint8Array) {}
    read(count = 1) {
        if (count > 32 || this.offset + count > this.bytes.length * 8) throw new Error("Truncated AVC sequence metadata.")
        let result = 0
        for (let i = 0; i < count; i++, this.offset++) result = result * 2 + ((this.bytes[this.offset >> 3] >> (7 - (this.offset & 7))) & 1)
        return result
    }
    ue() {
        let zeros = 0
        while (!this.read()) if (++zeros > 24) throw new Error("Invalid AVC sequence metadata.")
        return 2 ** zeros - 1 + this.read(zeros)
    }
}

function checkSps(nal: Uint8Array) {
    if ((nal[0] & 31) !== 7) throw new Error("The AVC configuration has no valid SPS.")
    const rbsp: number[] = []
    for (let i = 1; i < nal.length; i++) {
        if (nal[i] === 3 && i >= 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue
        rbsp.push(nal[i])
    }
    const bits = new Bits(Uint8Array.from(rbsp))
    const profile = bits.read(8)
    bits.read(16)
    bits.ue()
    if (profile === 100) {
        if (bits.ue() !== 1 || bits.ue() !== 0 || bits.ue() !== 0) throw new Error("Only 8-bit 4:2:0 AVC is supported.")
        bits.read()
        if (bits.read()) throw new Error("Custom AVC scaling matrices are not supported in strict conversion.")
    } else if (![66, 77, 88].includes(profile)) throw new Error("Unsupported AVC profile.")
    bits.ue()
    const order = bits.ue()
    if (order === 0) bits.ue()
    else if (order === 1) {
        bits.read(); bits.ue(); bits.ue()
        const cycle = bits.ue()
        if (cycle > 256) throw new Error("Invalid AVC picture-order cycle.")
        for (let i = 0; i < cycle; i++) bits.ue()
    } else if (order !== 2) throw new Error("Invalid AVC picture order.")
    bits.ue(); bits.read(); bits.ue(); bits.ue()
    if (!bits.read()) throw new Error("Interlaced AVC is refused to preserve its presentation.")
}

/** Inspect every SPS in an AVC configuration before decoding source frames. */
export function validateProgressiveAvc(description: ArrayBuffer | ArrayBufferView | undefined) {
    if (!description) throw new Error("AVC sequence metadata is required for strict streaming conversion.")
    const bytes = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description)
    if (bytes.length < 8 || bytes.length > 65536 || bytes[0] !== 1) throw new Error("Invalid AVC decoder configuration.")
    const count = bytes[5] & 31
    if (!count) throw new Error("AVC sequence metadata is missing.")
    let offset = 6
    for (let i = 0; i < count; i++) {
        if (offset + 2 > bytes.length) throw new Error("Truncated AVC configuration.")
        const size = bytes[offset] * 256 + bytes[offset + 1]
        offset += 2
        if (!size || offset + size > bytes.length) throw new Error("Truncated AVC sequence metadata.")
        checkSps(bytes.subarray(offset, offset + size))
        offset += size
    }
}
