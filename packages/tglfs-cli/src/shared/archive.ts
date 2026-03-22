export type ArchiveEntry = {
    name: string
    size: number
    lastModified: number
    stream(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

export function computeTarSize(files: ArchiveEntry[]): number {
    const block = 512
    let total = 0
    for (const file of files) {
        const dataSize = Math.ceil(file.size / block) * block
        total += block + dataSize
    }
    total += block * 2
    return total
}

export function defaultArchiveName(now = new Date()): string {
    const pad2 = (value: number) => value.toString().padStart(2, "0")
    return `files_${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(
        now.getHours(),
    )}${pad2(now.getMinutes())}${pad2(now.getSeconds())}.tar`
}

export function createTarStream(files: ArchiveEntry[]): ReadableStream<Uint8Array> {
    async function* generate(): AsyncGenerator<Uint8Array> {
        const block = 512
        const textEncoder = new TextEncoder()

        const writeString = (buf: Uint8Array, offset: number, value: string, length: number) => {
            const bytes = textEncoder.encode(value)
            const copied = Math.min(bytes.length, length)
            buf.set(bytes.subarray(0, copied), offset)
            for (let index = offset + copied; index < offset + length; index += 1) {
                buf[index] = 0
            }
        }

        const writeOctal = (buf: Uint8Array, offset: number, value: number, length: number) => {
            const octal = value.toString(8)
            writeString(buf, offset, octal.padStart(length - 1, "0") + "\0", length)
        }

        for (const file of files) {
            const header = new Uint8Array(block)
            writeString(header, 0, file.name.slice(0, 100), 100)
            writeString(header, 100, "0000777\0", 8)
            writeString(header, 108, "0000000\0", 8)
            writeString(header, 116, "0000000\0", 8)
            writeOctal(header, 124, file.size, 12)
            writeOctal(header, 136, Math.floor(file.lastModified / 1000) || Math.floor(Date.now() / 1000), 12)
            for (let index = 148; index < 156; index += 1) {
                header[index] = 32
            }
            header[156] = "0".charCodeAt(0)
            writeString(header, 257, "ustar\0", 6)
            writeString(header, 263, "00", 2)
            writeString(header, 265, "user", 32)
            writeString(header, 297, "group", 32)
            writeString(header, 329, "\0", 8)
            writeString(header, 337, "\0", 8)

            let checksum = 0
            for (let index = 0; index < block; index += 1) {
                checksum += header[index]
            }
            const checksumString = checksum.toString(8).padStart(6, "0")
            for (let index = 0; index < 6; index += 1) {
                header[148 + index] = checksumString.charCodeAt(index)
            }
            header[154] = 0
            header[155] = 32

            yield header

            const reader = (await file.stream()).getReader()
            let totalRead = 0
            while (true) {
                const { done, value } = await reader.read()
                if (done) {
                    break
                }
                if (value && value.length > 0) {
                    yield value
                    totalRead += value.length
                }
            }

            const padding = (block - (totalRead % block)) % block
            if (padding > 0) {
                yield new Uint8Array(padding)
            }
        }

        yield new Uint8Array(block)
        yield new Uint8Array(block)
    }

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const chunk of generate()) {
                    controller.enqueue(chunk)
                }
            } catch (error) {
                controller.error(error)
                return
            }
            controller.close()
        },
    })
}
