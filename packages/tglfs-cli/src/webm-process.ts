import { spawn } from "node:child_process"
import { Readable } from "node:stream"

/** Connect a verified input stream to a process without creating local files. */
export function runMediaProcess(binary: string, args: string[], source: ReadableStream<Uint8Array>, signal?: AbortSignal, metadataOnly = false) {
    signal?.throwIfAborted()
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] })
    const reader = source.getReader()
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-1024 * 1024) })
    let inputClosed = false
    const exit = new Promise<void>((resolve, reject) => {
        child.once("error", error => { void reader.cancel(error).catch(() => {}); reject(error) })
        child.once("close", code => {
            if (code !== 0 || metadataOnly) {
                inputClosed = true
                void reader.cancel().catch(() => {})
            }
            code === 0 ? resolve() : reject(new Error(`${binary} failed (${code}). ${stderr.slice(-4000)}`))
        })
    })
    child.stdin.on("error", error => {
        inputClosed = true
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") child.kill("SIGKILL")
    })
    const abort = () => { child.kill("SIGKILL"); void reader.cancel(signal?.reason).catch(() => {}) }
    signal?.addEventListener("abort", abort, { once: true })
    const pump = (async () => {
        try {
            while (!metadataOnly || !inputClosed) {
                signal?.throwIfAborted()
                const { value, done } = await reader.read()
                if (done) break
                if (!inputClosed && !child.stdin.destroyed && value?.length) {
                    await new Promise<void>((resolve, reject) => child.stdin.write(value, error => {
                        if (error && (error as NodeJS.ErrnoException).code !== "EPIPE") reject(error)
                        else resolve()
                    }))
                }
            }
            if (!child.stdin.destroyed) child.stdin.end()
            if (metadataOnly && inputClosed) await reader.cancel().catch(() => {})
        } catch (error) {
            child.kill("SIGKILL")
            await reader.cancel(error).catch(() => {})
            throw error
        } finally { reader.releaseLock() }
    })()
    const completion = Promise.all([exit, pump]).then(() => { signal?.throwIfAborted(); return stderr })
        .finally(() => signal?.removeEventListener("abort", abort))
    void completion.catch(() => {})
    return {
        stream: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, completion,
        cancel: async () => {
            child.kill("SIGKILL")
            await reader.cancel().catch(() => {})
            await completion.catch(() => {})
        },
    }
}

export async function collectMetadata(stream: ReadableStream<Uint8Array>, limit = 1024 * 1024) {
    const reader = stream.getReader()
    let bytes = 0
    const chunks: Uint8Array[] = []
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > limit) throw new Error("Media metadata exceeded its memory limit.")
            chunks.push(value)
        }
        return Buffer.concat(chunks).toString("utf8")
    } catch (error) { await reader.cancel(error).catch(() => {}); throw error }
    finally { reader.releaseLock() }
}
