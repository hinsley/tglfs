export type ArchiveEntry = {
    name: string
    size: number
    lastModified: number
    range?(start: number, end: number): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
    stream(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

export function computeTarSize(files: ArchiveEntry[]): number {
    const block = 512
    let total = 0
    for (const file of files) {
        const dataSize = Math.ceil(file.size / block) * block
        total += block + dataSize
        const nameBytes = new TextEncoder().encode(file.name)
        if (nameBytes.length > 100) total += block + Math.ceil((nameBytes.length + 1) / block) * block
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

export function createTarStream(files: ArchiveEntry[], start = 0, end = computeTarSize(files)): ReadableStream<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > computeTarSize(files)) throw new Error("The requested tar source range is invalid.")
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null
    async function* generate(): AsyncGenerator<Uint8Array> {
        const block = 512
        let position = 0
        function* segment(bytes: Uint8Array) {
            const from = Math.max(0, start - position)
            const to = Math.min(bytes.length, end - position)
            position += bytes.length
            if (to > from) yield bytes.subarray(from, to)
        }
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

        const createHeader = (name: string, size: number, modifiedTime: number, kind: string) => {
            const header = new Uint8Array(block)
            writeString(header, 0, name, 100)
            writeString(header, 100, "0000777\0", 8)
            writeString(header, 108, "0000000\0", 8)
            writeString(header, 116, "0000000\0", 8)
            writeOctal(header, 124, size, 12)
            writeOctal(header, 136, modifiedTime, 12)
            for (let index = 148; index < 156; index += 1) {
                header[index] = 32
            }
            header[156] = kind.charCodeAt(0)
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
            return header
        }

        for (const file of files) {
            if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 0o77777777777) throw new Error("The archive source size cannot be represented safely in tar.")
            const nameBytes = textEncoder.encode(file.name)
            const modifiedTime = Math.floor(file.lastModified / 1000) || Math.floor(Date.now() / 1000)
            if (nameBytes.length > 100) {
                yield* segment(createHeader("././@LongLink", nameBytes.length + 1, modifiedTime, "L"))
                const longName = new Uint8Array(Math.ceil((nameBytes.length + 1) / block) * block)
                longName.set(nameBytes)
                yield* segment(longName)
            }
            yield* segment(createHeader(nameBytes.length > 100 ? "file" : file.name, file.size, modifiedTime, "0"))

            const from = Math.max(0, start - position)
            const to = Math.min(file.size, end - position)
            if (to > from) {
                if (from > 0 && !file.range) throw new Error("This source cannot seek to a resumed archive member.")
                const reader = (await (file.range ? file.range(from, to) : file.stream())).getReader()
                activeReader = reader
                let read = 0
                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) break
                        read += value.length
                        if (read > to - from) throw new Error("An archive source changed size while being read.")
                        yield value
                    }
                    if (read !== to - from) throw new Error("An archive source changed size while being read.")
                } finally {
                    await reader.cancel().catch(() => {})
                    reader.releaseLock()
                    activeReader = null
                }
            }
            position += file.size
            const padding = (block - (file.size % block)) % block
            if (padding > 0) {
                yield* segment(new Uint8Array(padding))
            }
        }

        yield* segment(new Uint8Array(block))
        yield* segment(new Uint8Array(block))
    }

    const iterator = generate()
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next()
                if (done) controller.close()
                else controller.enqueue(value)
            } catch (error) {
                controller.error(error)
            }
        },
        async cancel() {
            await activeReader?.cancel().catch(() => {})
            await iterator.return(undefined)
        },
    }, { highWaterMark: 0 })
}
