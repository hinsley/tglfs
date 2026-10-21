import type * as Config from "../config"
import { uploadGeneratedFileStream } from "./generatedUpload"

/** Seed small synthetic videos in the localhost mock session, without contacting Telegram. */
export async function seedMockWebmFixtures(client: any, config: Config.Config, password = "webm-test") {
    const mb = await import("mediabunny")
    const canvas = new OffscreenCanvas(256, 144)
    const context = canvas.getContext("2d")!
    const target = new mb.BufferTarget()
    const output = new mb.Output({ target, format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }) })
    const source = new mb.CanvasSource(canvas, { codec: "avc", bitrate: 1_000_000, keyFrameInterval: 1 })
    output.addVideoTrack(source, { frameRate: 12 })
    await output.start()
    for (let frame = 0; frame < 36; frame++) {
        context.fillStyle = frame < 12 ? "#182333" : frame < 24 ? "#030303" : "#efefef"
        context.fillRect(0, 0, 256, 144)
        context.fillStyle = "#55bcce"
        context.fillRect((frame * 9) % 210, 24, 40, 50)
        context.fillStyle = frame < 24 ? "white" : "black"
        context.font = "18px monospace"
        context.fillText(`WebM sample ${frame}`, 12, 118)
        await source.add(frame / 12, 1 / 12)
    }
    source.close()
    await output.finalize()
    const bytes = new Uint8Array(target.buffer!)
    if (bytes.length > 1024 * 1024) throw new Error("The synthetic browser fixture exceeded its size limit.")
    const stream = (data: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close() } })
    await uploadGeneratedFileStream(client, config, { name: "WebM streaming sample.mov", stream: stream(bytes), password })
    const trailing = Uint8Array.of(0, 0, 0, 8, 109, 100, 97, 116, 0, 0, 0, 8, 109, 111, 111, 118)
    await uploadGeneratedFileStream(client, config, { name: "WebM seeking refused.mov", stream: stream(trailing), password: "" })
}
