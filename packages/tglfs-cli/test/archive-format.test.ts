import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { computeTarSize, createTarStream } from "../src/shared/archive.js"
import {
    encodeArchiveStream, openArchive, isArchiveStorageDescriptor,
    type ArchiveStorageDescriptor,
} from "../src/shared/archive-format.js"
import { computeUfidFromBytes } from "../src/ufid.js"

const encoder = new TextEncoder()

async function bytesOf(stream: ReadableStream<Uint8Array>) {
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

function streamOf(bytes: Uint8Array, chunkSize = 7919) {
    let offset = 0
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset === bytes.length) return controller.close()
            const end = Math.min(offset + chunkSize, bytes.length)
            controller.enqueue(bytes.subarray(offset, end))
            offset = end
        },
    }, { highWaterMark: 0 })
}

async function tarOf(files: { name: string; bytes: Uint8Array }[]) {
    return bytesOf(createTarStream(files.map((file) => ({
        name: file.name, size: file.bytes.length, lastModified: 1700000000000,
        stream: () => streamOf(file.bytes),
    }))))
}

async function encode(bytes: Uint8Array, password = "", blockSize = 1024) {
    const parts: Uint8Array[] = []
    const result = await encodeArchiveStream(streamOf(bytes), { password, blockSize }, async (part) => { parts.push(part) })
    const ciphertext = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) {
        ciphertext.set(part, offset)
        offset += part.length
    }
    return { ...result, ciphertext }
}

function memoryRead(ciphertext: Uint8Array) {
    return async (offset: number, length: number) => ciphertext.slice(offset, offset + length)
}

function checksum(header: Uint8Array) {
    header.fill(32, 148, 156)
    const sum = header.reduce((sum, byte) => sum + byte, 0)
    header.set(encoder.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148)
}

async function rewriteIndex(encoded: Awaited<ReturnType<typeof encode>>, change: (index: any) => void) {
    const storage = { ...encoded.storage }
    const material = await globalThis.crypto.subtle.importKey("raw", encoder.encode(""), "PBKDF2", false, ["deriveKey"])
    const key = await globalThis.crypto.subtle.deriveKey({ name: "PBKDF2", salt: Buffer.from(storage.salt, "base64"), iterations: 600000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
    const index = structuredClone(encoded.index)
    change(index)
    const compressed = await bytesOf(new Blob([encoder.encode(JSON.stringify(index))]).stream().pipeThrough(new CompressionStream("gzip")))
    storage.indexLength = compressed.length + 16
    storage.storedSize = storage.indexOffset + storage.indexLength
    const iv = new Uint8Array(12)
    iv.set(Buffer.from(storage.noncePrefix, "base64"))
    new DataView(iv.buffer).setUint32(8, 0xffffffff, false)
    const aad = encoder.encode(JSON.stringify([storage.type, storage.version, storage.archiveId, storage.salt, storage.noncePrefix, storage.blockSize, "index", storage.indexOffset, storage.indexLength, storage.storedSize]))
    const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, compressed))
    const ciphertext = new Uint8Array(storage.storedSize)
    ciphertext.set(encoded.ciphertext.subarray(0, storage.indexOffset))
    ciphertext.set(encrypted, storage.indexOffset)
    return { storage, ciphertext }
}

test("indexed archives reconstruct the exact tar and preserve the content UFID", async () => {
    const original = await tarOf([{ name: "one.txt", bytes: encoder.encode("one") }, { name: "two.txt", bytes: encoder.encode("two") }])
    const encoded = await encode(original, "private")
    assert.equal(isArchiveStorageDescriptor(encoded.storage), true)
    assert.equal(encoded.ufid, await computeUfidFromBytes(original))
    const reader = await openArchive(encoded.storage, "private", memoryRead(encoded.ciphertext))
    assert.deepEqual(await bytesOf(reader.stream()), original)
    assert.deepEqual(reader.index.entries.map((entry) => entry.path), ["one.txt", "two.txt"])
    assert.equal(reader.index.ufid, encoded.ufid)
    assert.equal(new TextDecoder().decode(await bytesOf(reader.entryStream("1"))), "two")
    assert.equal(new TextDecoder().decode(encoded.ciphertext).includes("one.txt"), false)
})

test("opening an archive fetches only its index and selected blocks", async () => {
    const original = await tarOf([{ name: "large.bin", bytes: new Uint8Array(16000).fill(7) }, { name: "small.txt", bytes: encoder.encode("chosen") }])
    const encoded = await encode(original)
    const requests: [number, number][] = []
    const reader = await openArchive(encoded.storage, "", async (offset, length) => {
        requests.push([offset, length])
        return encoded.ciphertext.slice(offset, offset + length)
    })
    assert.deepEqual(requests, [[encoded.storage.indexOffset, encoded.storage.indexLength]])
    assert.equal(new TextDecoder().decode(await bytesOf(reader.entryStream("1"))), "chosen")
    assert.equal(requests.length, 2)
    assert.ok(requests[1][0] > 0)
    assert.ok(requests.length < reader.index.blocks.length)
})

test("overlapping preview ranges share pending and cached block reads", async () => {
    const original = await tarOf([{ name: "data", bytes: new Uint8Array(8192).fill(7) }])
    const encoded = await encode(original)
    const requests: number[] = []
    const reader = await openArchive(encoded.storage, "", async (offset, length) => {
        requests.push(offset)
        return encoded.ciphertext.slice(offset, offset + length)
    })
    await Promise.all([reader.readRange(0, 128), reader.readRange(128, 128), reader.readRange(256, 128)])
    await reader.readRange(384, 128)
    assert.deepEqual(requests, [encoded.storage.indexOffset, 0])
    await reader.readRange(1024, 1)
    await reader.readRange(0, 1)
    assert.equal(requests.filter((offset) => offset === 0).length, 1)
    await reader.readRange(2048, 1)
    await reader.readRange(1024, 1)
    assert.equal(requests.filter((offset) => offset === encoded.index.blocks[1].storedOffset).length, 2)
})

test("closing a reader refuses cached plaintext and further network reads", async () => {
    const original = await tarOf([{ name: "private.txt", bytes: encoder.encode("private") }])
    const encoded = await encode(original)
    const controller = new AbortController()
    let requests = 0
    const reader = await openArchive(encoded.storage, "", async (offset, length) => {
        requests += 1
        return encoded.ciphertext.slice(offset, offset + length)
    }, { signal: controller.signal })
    await reader.readRange(0, 1)
    const beforeClosing = requests
    controller.abort()
    await assert.rejects(reader.readRange(0, 1), /cancelled/)
    await assert.rejects(reader.readRange(1024, 1), /cancelled/)
    assert.equal(requests, beforeClosing)
})

test("empty and nonempty passwords use identical formats and reject wrong passwords", async () => {
    const original = await tarOf([{ name: "a", bytes: encoder.encode("a") }])
    for (const password of ["", "secret"]) {
        const encoded = await encode(original, password)
        assert.equal(encoded.storage.type, "tglfs:archive-content")
        const reader = await openArchive(encoded.storage, password, memoryRead(encoded.ciphertext))
        assert.deepEqual(await bytesOf(reader.stream()), original)
        await assert.rejects(openArchive(encoded.storage, `${password}!`, memoryRead(encoded.ciphertext)), /password or damaged/)
    }
})

test("encrypted index, descriptor, selected blocks, and swapped blocks are authenticated", async () => {
    const original = await tarOf([{ name: "data", bytes: new Uint8Array(5000).fill(23) }])
    const encoded = await encode(original)
    const damagedIndex = encoded.ciphertext.slice()
    damagedIndex[encoded.storage.indexOffset] ^= 1
    await assert.rejects(openArchive(encoded.storage, "", memoryRead(damagedIndex)), /password or damaged/)
    await assert.rejects(openArchive({ ...encoded.storage, archiveId: "f".repeat(32) }, "", memoryRead(encoded.ciphertext)), /password or damaged/)
    await assert.rejects(openArchive({ ...encoded.storage, blockSize: 2048 }, "", memoryRead(encoded.ciphertext)), /password or damaged/)
    const damagedBlock = encoded.ciphertext.slice()
    damagedBlock[0] ^= 1
    const damagedReader = await openArchive(encoded.storage, "", memoryRead(damagedBlock))
    await assert.rejects(damagedReader.readRange(0, 1), /password or damaged/)
    const swappedReader = await openArchive(encoded.storage, "", async (offset, length) => {
        const target = encoded.index.blocks.findIndex((block) => block.storedOffset === offset)
        if (target >= 0 && target < 2) {
            const other = encoded.index.blocks[1 - target]
            return encoded.ciphertext.slice(other.storedOffset, other.storedOffset + length)
        }
        return encoded.ciphertext.slice(offset, offset + length)
    })
    await assert.rejects(swappedReader.readRange(0, 1), /password or damaged/)
})

test("unknown versions and malformed descriptors fail before any remote read", async () => {
    const original = await tarOf([{ name: "a", bytes: encoder.encode("a") }])
    const encoded = await encode(original)
    for (const changed of [
        { version: 2 }, { blockSize: 513 }, { indexOffset: -1 }, { indexLength: 0 },
        { storedSize: Number.MAX_SAFE_INTEGER + 1 }, { salt: "bad" }, { noncePrefix: "bad" },
    ]) {
        const descriptor = { ...encoded.storage, ...changed } as ArchiveStorageDescriptor
        assert.equal(isArchiveStorageDescriptor(descriptor), false)
        await assert.rejects(openArchive(descriptor, "", async () => { throw new Error("Unexpected remote read") }), /unsupported/)
    }
    await assert.rejects(openArchive(encoded.storage, "", async () => new Uint8Array()), /incomplete/)
})

test("authenticated but unsupported or inconsistent indexes are refused", async () => {
    const original = await tarOf([{ name: "data", bytes: new Uint8Array(3000) }])
    const encoded = await encode(original)
    for (const change of [
        (index: any) => { index.version = 2 },
        (index: any) => { index.blocks[1].offset += 1 },
        (index: any) => { index.entries[0].dataOffset += 1 },
        (index: any) => { index.entries[0].path = "../outside" },
        (index: any) => { index.blocks[0].storedLength += 1 },
    ]) {
        const modified = await rewriteIndex(encoded, change)
        await assert.rejects(openArchive(modified.storage, "", memoryRead(modified.ciphertext)), /unsupported|malformed|unsafe|does not match/)
    }
    const modified = await rewriteIndex(encoded, (index) => { index.ufid = "0".repeat(64) })
    const reader = await openArchive(modified.storage, "", memoryRead(modified.ciphertext))
    await assert.rejects(bytesOf(reader.stream()), /UFID does not match/)
})

test("duplicate paths remain distinct archive members", async () => {
    const original = await tarOf([{ name: "same.txt", bytes: encoder.encode("first") }, { name: "same.txt", bytes: encoder.encode("second") }])
    const encoded = await encode(original)
    const reader = await openArchive(encoded.storage, "", memoryRead(encoded.ciphertext))
    assert.equal(reader.index.entries[0].path, reader.index.entries[1].path)
    assert.equal(new TextDecoder().decode(await bytesOf(reader.entryStream("0"))), "first")
    assert.equal(new TextDecoder().decode(await bytesOf(reader.entryStream("1"))), "second")
})

test("long UTF-8 member names retain all bytes and tar size accounting", async () => {
    const name = `folder/${"日本語".repeat(90)}.txt`
    const payload = encoder.encode("long filename content")
    const entries = [{ name, size: payload.length, lastModified: 1700000000000, stream: () => streamOf(payload) }]
    const original = await bytesOf(createTarStream(entries))
    assert.equal(original.length, computeTarSize(entries))
    const encoded = await encode(original)
    const reader = await openArchive(encoded.storage, "", memoryRead(encoded.ciphertext))
    assert.equal(reader.index.entries[0].path, name)
    assert.deepEqual(await bytesOf(reader.entryStream("0")), payload)
    assert.deepEqual(await bytesOf(reader.stream()), original)
})

test("PAX paths and directories are indexed without following links", async () => {
    const base = await tarOf([{ name: "short", bytes: new Uint8Array() }])
    const paxValue = "path=folder/renamed.txt\n"
    let paxLength = encoder.encode(paxValue).length + 2
    while (encoder.encode(`${paxLength} ${paxValue}`).length !== paxLength) paxLength = encoder.encode(`${paxLength} ${paxValue}`).length
    const paxBytes = encoder.encode(`${paxLength} ${paxValue}`)
    const paxHeader = base.slice(0, 512)
    paxHeader[156] = "x".charCodeAt(0)
    paxHeader.set(encoder.encode(paxBytes.length.toString(8).padStart(11, "0") + "\0"), 124)
    checksum(paxHeader)
    const directoryHeader = base.slice(0, 512)
    directoryHeader.fill(0, 0, 100)
    directoryHeader.set(encoder.encode("folder/"))
    directoryHeader[156] = "5".charCodeAt(0)
    checksum(directoryHeader)
    const linkHeader = base.slice(0, 512)
    linkHeader.fill(0, 0, 100)
    linkHeader.set(encoder.encode("folder/link"))
    linkHeader[156] = "2".charCodeAt(0)
    linkHeader.set(encoder.encode("../../outside"), 157)
    checksum(linkHeader)
    const original = new Uint8Array(512 * 7)
    original.set(directoryHeader, 0)
    original.set(paxHeader, 512)
    original.set(paxBytes, 1024)
    original.set(base.subarray(0, 512), 1536)
    original.set(linkHeader, 2048)
    const encoded = await encode(original)
    const reader = await openArchive(encoded.storage, "", memoryRead(encoded.ciphertext))
    assert.deepEqual(reader.index.entries.map((entry) => [entry.kind, entry.path]), [
        ["directory", "folder/"], ["file", "folder/renamed.txt"], ["symlink", "folder/link"],
    ])
    assert.throws(() => reader.entryStream("2"), /Only regular/)
    assert.deepEqual(await bytesOf(reader.stream()), original)
})

test("repeated PAX headers do not retain unrelated metadata keys", async () => {
    const base = await tarOf([{ name: "member.txt", bytes: new Uint8Array() }])
    const parts: Uint8Array[] = []
    for (let ordinal = 0; ordinal < 64; ordinal += 1) {
        const value = `vendor.unused-${ordinal}=${"x".repeat(8192)}\n`
        let length = encoder.encode(value).length + 2
        while (encoder.encode(`${length} ${value}`).length !== length) length = encoder.encode(`${length} ${value}`).length
        const data = encoder.encode(`${length} ${value}`)
        const header = base.slice(0, 512)
        header[156] = "g".charCodeAt(0)
        header.set(encoder.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124)
        checksum(header)
        const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
        padded.set(data)
        parts.push(header, padded)
    }
    parts.push(base)
    const original = new Uint8Array(parts.reduce((size, bytes) => size + bytes.length, 0))
    let offset = 0
    for (const bytes of parts) {
        original.set(bytes, offset)
        offset += bytes.length
    }
    const encoded = await encode(original, "", 64 * 1024)
    assert.equal(encoded.index.entries.length, 1)
    assert.equal(encoded.index.entries[0].path, "member.txt")
    assert.ok(JSON.stringify(encoded.index).length < 4096)
    const reader = await openArchive(encoded.storage, "", memoryRead(encoded.ciphertext))
    assert.deepEqual(await bytesOf(reader.stream()), original)
})

test("tar source size changes fail rather than writing a corrupt directory", async () => {
    for (const size of [1, 3]) {
        const stream = createTarStream([{ name: "data", size, lastModified: 0, stream: () => streamOf(new Uint8Array(2)) }])
        await assert.rejects(bytesOf(stream), /changed size/)
    }
})

test("tar parser rejects bad checksums, truncated members, unsafe paths, and unsupported sparse entries", async () => {
    const original = await tarOf([{ name: "safe.txt", bytes: encoder.encode("hello") }])
    const badChecksum = original.slice()
    badChecksum[0] ^= 1
    await assert.rejects(encode(badChecksum), /checksum/)
    await assert.rejects(encode(original.subarray(0, 600)), /truncated/)
    const unsafe = original.slice()
    unsafe.fill(0, 0, 100)
    unsafe.set(encoder.encode("../unsafe"), 0)
    checksum(unsafe.subarray(0, 512))
    await assert.rejects(encode(unsafe), /unsafe member path/)
    const sparse = original.slice()
    sparse[156] = "S".charCodeAt(0)
    checksum(sparse.subarray(0, 512))
    await assert.rejects(encode(sparse), /unsupported entry type/)
})

test("encoder does not read ahead while its output sink is blocked", async () => {
    const original = await tarOf([{ name: "data", bytes: new Uint8Array(8192) }])
    let pulls = 0
    let cursor = 0
    const source = new ReadableStream<Uint8Array>({
        pull(controller) {
            pulls += 1
            if (cursor >= original.length) return controller.close()
            controller.enqueue(original.subarray(cursor, cursor + 1024))
            cursor += 1024
        },
    }, { highWaterMark: 0 })
    let release!: () => void
    let outputStarted!: () => void
    const started = new Promise<void>((resolve) => { outputStarted = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let first = true
    const completion = encodeArchiveStream(source, { password: "", blockSize: 1024 }, async () => {
        if (first) {
            first = false
            outputStarted()
            await blocked
        }
    })
    await started
    const whileBlocked = pulls
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(pulls, whileBlocked)
    assert.equal(pulls, 1)
    release()
    await completion
})

test("tar source creation is lazy and cancellation releases the active file reader", async () => {
    let pulls = 0
    let cancelled = false
    const stream = createTarStream([{
        name: "data", size: 1024, lastModified: 0,
        stream: () => new ReadableStream<Uint8Array>({
            pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(512)) },
            cancel() { cancelled = true },
        }, { highWaterMark: 0 }),
    }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(pulls, 0)
    const reader = stream.getReader()
    await reader.read()
    assert.equal(pulls, 0)
    await reader.read()
    assert.equal(pulls, 1)
    await reader.cancel()
    assert.equal(cancelled, true)
})

test("cancelled encodes stop before publishing additional blocks", async () => {
    const original = await tarOf([{ name: "data", bytes: new Uint8Array(8192) }])
    const controller = new AbortController()
    let writes = 0
    await assert.rejects(encodeArchiveStream(streamOf(original, 1024), { password: "", blockSize: 1024, signal: controller.signal }, async () => {
        writes += 1
        controller.abort()
    }), /cancelled/)
    assert.equal(writes, 1)
})

test("real serialized archive content fixture remains readable", async () => {
    const fixture = JSON.parse(await readFile(new URL("fixtures/archive-content-v1.json", import.meta.url), "utf8"))
    const ciphertext = Uint8Array.from(Buffer.from(fixture.ciphertext, "base64"))
    const reader = await openArchive(fixture.storage, fixture.password, memoryRead(ciphertext))
    assert.equal(reader.index.entries[0].path, "fixture.txt")
    assert.equal(new TextDecoder().decode(await bytesOf(reader.entryStream("0"))), "archive fixture\n")
    assert.deepEqual(await bytesOf(reader.stream()), Uint8Array.from(Buffer.from(fixture.tar, "base64")))
})
