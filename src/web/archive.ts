export function computeTarSize(files: File[]): number {
    const block = 512
    let total = 0
    for (const f of files) {
        const fileSize = f.size
        const dataSize = Math.ceil(fileSize / block) * block
        total += block /* header */ + dataSize
    }
    // Two 512-byte zero blocks at the end of the archive.
    total += block * 2
    return total
}

export function defaultArchiveName(): string {
    const d = new Date()
    const pad2 = (n: number) => n.toString().padStart(2, "0")
    const name = `files_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(
        d.getMinutes(),
    )}${pad2(d.getSeconds())}.tar`
    return name
}

export function createTarStream(files: File[]): ReadableStream<Uint8Array> {
    async function* generate(): AsyncGenerator<Uint8Array> {
        const block = 512
        const textEncoder = new TextEncoder()

        const writeString = (buf: Uint8Array, offset: number, str: string, length: number) => {
            const bytes = textEncoder.encode(str)
            const n = Math.min(bytes.length, length)
            buf.set(bytes.subarray(0, n), offset)
            // Zero-fill remainder.
            for (let i = offset + n; i < offset + length; i++) buf[i] = 0
        }

        const writeOctal = (buf: Uint8Array, offset: number, value: number, length: number) => {
            const oct = value.toString(8)
            const str = oct.padStart(length - 1, "0") + "\0"
            writeString(buf, offset, str, length)
        }

        const writeChecksum = (buf: Uint8Array) => {
            let sum = 0
            for (let i = 0; i < block; i++) sum += buf[i]
            const str = sum.toString(8).padStart(6, "0")
            // checksum field at 148..155: 6 digits, NUL, space.
            for (let i = 0; i < 6; i++) buf[148 + i] = str.charCodeAt(i)
            buf[148 + 6] = 0
            buf[148 + 7] = 32
        }

        for (const f of files) {
            // Header.
            const header = new Uint8Array(block)
            // name (100)
            writeString(header, 0, f.name.slice(0, 100), 100)
            // mode (8)
            writeString(header, 100, "0000777\0", 8)
            // uid (8), gid (8)
            writeString(header, 108, "0000000\0", 8)
            writeString(header, 116, "0000000\0", 8)
            // size (12)
            writeOctal(header, 124, f.size, 12)
            // mtime (12) seconds.
            writeOctal(header, 136, Math.floor(f.lastModified / 1000) || Math.floor(Date.now() / 1000), 12)
            // chksum (8) - fill with spaces for computation.
            for (let i = 148; i < 156; i++) header[i] = 32
            // typeflag (1)
            header[156] = "0".charCodeAt(0)
            // linkname (100) empty
            // magic (6) + version (2)
            writeString(header, 257, "ustar\0", 6)
            writeString(header, 263, "00", 2)
            // uname (32), gname (32)
            writeString(header, 265, "user", 32)
            writeString(header, 297, "group", 32)
            // devmajor (8), devminor (8)
            writeString(header, 329, "\0", 8)
            writeString(header, 337, "\0", 8)
            // prefix (155) left empty.

            // Now compute and write checksum.
            // Temporarily, checksum field already spaces, compute sum of all bytes.
            let sum = 0
            for (let i = 0; i < block; i++) sum += header[i]
            const chk = sum
            const chkStr = chk.toString(8).padStart(6, "0")
            for (let i = 0; i < 6; i++) header[148 + i] = chkStr.charCodeAt(i)
            header[148 + 6] = 0
            header[148 + 7] = 32

            yield header

            // File data.
            const reader = f.stream().getReader()
            let totalRead = 0
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value && value.length > 0) {
                    yield value
                    totalRead += value.length
                }
            }
            const padding = (block - (totalRead % block)) % block
            if (padding) {
                yield new Uint8Array(padding)
            }
        }
        // End of archive: two 512-byte zero blocks.
        yield new Uint8Array(block)
        yield new Uint8Array(block)
    }

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const chunk of generate()) {
                    controller.enqueue(chunk)
                }
            } catch (e) {
                controller.error(e)
                return
            }
            controller.close()
        },
    })
}
