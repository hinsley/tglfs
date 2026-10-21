export const FakeApi = {
    upload: {
        GetFile: class GetFile {
            constructor(readonly args: any) {}
        },
        SaveBigFilePart: class SaveBigFilePart {
            constructor(readonly args: any) {}
        },
    },
    InputFileBig: class InputFileBig {
        constructor(readonly args: any) {}
    },
    messages: {
        DeleteMessages: class DeleteMessages {
            constructor(readonly args: any) {}
        },
        ForwardMessages: class ForwardMessages {
            constructor(readonly args: any) {}
        },
    },
}
export function blockFixture() {
    const documents = new Map<number, Uint8Array>()
    const messages: any[] = []
    const uploads = new Map<string, Uint8Array[]>()
    const reads: number[] = []
    const deletes: number[] = []
    let next = 100
    let blockSends = 0
    const controls = { failBlock: -1, lostBlockAck: -1, lostPublication: false, failRead: -1 }
    const client = {
        async getMessages(_peer: string, options: any) {
            if (options.ids) return options.ids.map((id: number) => messages.find((m) => m.id === id)).filter(Boolean)
            return messages
                .filter(
                    (m) =>
                        (!options.maxId || m.id < options.maxId) &&
                        String(options.search || "")
                            .split(" ")
                            .every((s: string) => (m.message || "").includes(s)),
                )
                .sort((a, b) => b.id - a.id)
                .slice(0, options.limit || 100)
        },
        async invoke(request: any) {
            if (request instanceof FakeApi.upload.SaveBigFilePart) {
                const a = request.args
                const parts = uploads.get(String(a.fileId)) || []
                parts[a.filePart] = Uint8Array.from(a.bytes)
                uploads.set(String(a.fileId), parts)
                return true
            }
            if (request instanceof FakeApi.upload.GetFile) {
                const a = request.args
                reads.push(a.location.id)
                if (a.location.id === controls.failRead) throw new Error("Network interrupted")
                return { bytes: documents.get(a.location.id)!.slice(a.offset, a.offset + a.limit) }
            }
            if (request instanceof FakeApi.messages.DeleteMessages) {
                deletes.push(...request.args.id)
                for (const id of request.args.id) {
                    documents.delete(id)
                    const index = messages.findIndex((m) => m.id === id)
                    if (index >= 0) messages.splice(index, 1)
                }
                return true
            }
            if (request instanceof FakeApi.messages.ForwardMessages) {
                const id = next++
                const original = messages.find((m) => m.id === request.args.id[0])
                const bytes = documents.get(original.id)!
                documents.set(id, bytes)
                messages.push({ ...original, id, media: { document: { id, size: bytes.length } } })
                return { updates: [{ id }] }
            }
            throw new Error("Unexpected request")
        },
        async sendFile(_peer: string, options: any) {
            const cp = options.caption ? JSON.parse(options.caption) : null
            if (cp?.type === "tglfs:upload-block" && cp.index === controls.failBlock)
                throw new Error("Network interrupted")
            let bytes: Uint8Array
            if (options.file instanceof Uint8Array) bytes = options.file.slice()
            else {
                const parts = uploads.get(String(options.file.args.id))!
                bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
                let cursor = 0
                for (const part of parts) {
                    bytes.set(part, cursor)
                    cursor += part.length
                }
            }
            const id = next++
            documents.set(id, bytes)
            const message = {
                id,
                date: 1700000000,
                message: options.caption || "",
                media: { document: { id, size: bytes.length } },
            }
            messages.push(message)
            if (cp?.type === "tglfs:upload-block") {
                blockSends++
                if (cp.index === controls.lostBlockAck) throw new Error("Lost upload acknowledgement")
            }
            return message
        },
        async sendMessage(_peer: string, options: any) {
            const message = { id: next++, date: 1700000000, message: options.message }
            messages.push(message)
            if (controls.lostPublication) throw new Error("Lost publication acknowledgement")
            return message
        },
        async downloadMedia(message: any) {
            return documents.get(message.id)!.slice()
        },
    }
    return {
        client,
        documents,
        messages,
        reads,
        deletes,
        controls,
        get blockSends() {
            return blockSends
        },
        options: { Api: FakeApi, getFileInfo: (media: any) => ({ location: { id: media.document.id } }) },
    }
}

export async function gramBlockFixture() {
    const { getGramJs } = await import("../../src/gramjs.js")
    const { Api } = getGramJs()
    const fixture = blockFixture()
    const client = {
        ...fixture.client,
        async getMessages(peer: string, options: any) {
            return (await fixture.client.getMessages(peer, options)).map((m) =>
                m?.media
                    ? {
                          ...m,
                          media: new Api.MessageMediaDocument({
                              document: new Api.Document({
                                  id: BigInt(m.id),
                                  accessHash: 1n,
                                  fileReference: Buffer.alloc(0),
                                  date: 0,
                                  mimeType: "application/octet-stream",
                                  size: fixture.documents.get(m.id)!.length,
                                  dcId: 1,
                                  attributes: [],
                              } as any),
                          }),
                      }
                    : m,
            )
        },
        async invoke(request: any) {
            if (request.className === "upload.SaveBigFilePart")
                return fixture.client.invoke(new FakeApi.upload.SaveBigFilePart(request))
            if (request.className === "upload.GetFile")
                return fixture.client.invoke(
                    new FakeApi.upload.GetFile({
                        ...request,
                        location: { id: Number(request.location.id) },
                        offset: Number(request.offset),
                    }),
                )
            if (request.className === "messages.DeleteMessages")
                return fixture.client.invoke(new FakeApi.messages.DeleteMessages(request))
            return fixture.client.invoke(request)
        },
        async sendFile(peer: string, options: any) {
            return fixture.client.sendFile(peer, {
                ...options,
                file: options.file instanceof Uint8Array ? options.file : new FakeApi.InputFileBig(options.file),
            })
        },
    }
    return { fixture, client }
}
