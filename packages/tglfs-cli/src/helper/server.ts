import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"
import { requestSignature, responseSignature, openHelperPassword } from "../shared/helper-wire.js"
import { computeTarSize, defaultArchiveName } from "../shared/archive.js"
import { browseFiles, safeDownloadName, selectedSources } from "./files.js"
import { validJobId } from "./protocol.js"
import type { HelperConfig, HelperJob } from "./protocol.js"
import type { HelperQueue } from "./queue.js"
function publicJob({ sources, ...job }: HelperJob) {
    return { ...job, sourceCount: sources?.length }
}
function same(a: string, b: string) {
    return /^[0-9a-f]{64}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}
export function createHelperServer(
    config: HelperConfig,
    queue: HelperQueue,
    options: { stop?: () => void; port?: number } = {},
) {
    const nonces = new Map<string, number>()
    const server = createServer((req, res) => {
        void handle(req, res).catch(() => {
            if (!res.headersSent) {
                res.writeHead(500)
                res.end()
            } else res.destroy()
        })
    })
    server.requestTimeout = 15000
    server.headersTimeout = 10000
    server.keepAliveTimeout = 3000
    server.maxHeadersCount = 30
    async function handle(req: IncomingMessage, res: ServerResponse) {
        const origin = req.headers.origin
        const port = options.port ?? (server.address() as any)?.port ?? config.port
        if (
            !req.socket.remoteAddress?.match(/^(127\.0\.0\.1|::ffff:127\.0\.0\.1)$/) ||
            req.headers.host !== `127.0.0.1:${port}` ||
            (origin !== undefined && !config.origins.includes(origin))
        ) {
            res.writeHead(403)
            res.end()
            return
        }
        res.setHeader("Cache-Control", "no-store")
        res.setHeader("X-Content-Type-Options", "nosniff")
        if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin)
            res.setHeader("Vary", "Origin")
            res.setHeader("Access-Control-Expose-Headers", "X-TGLFS-Signature")
        }
        if (req.method === "OPTIONS") {
            if (!origin || !["GET", "POST"].includes(String(req.headers["access-control-request-method"]))) {
                res.writeHead(403)
                res.end()
                return
            }
            const allowed = ["content-type", "x-tglfs-time", "x-tglfs-nonce", "x-tglfs-signature"]
            if (
                String(req.headers["access-control-request-headers"] || "")
                    .toLowerCase()
                    .split(",")
                    .some((h) => h.trim() && !allowed.includes(h.trim()))
            ) {
                res.writeHead(403)
                res.end()
                return
            }
            res.setHeader("Access-Control-Allow-Methods", "GET, POST")
            res.setHeader("Access-Control-Allow-Headers", allowed.join(", "))
            res.setHeader("Access-Control-Allow-Private-Network", "true")
            res.writeHead(204)
            res.end()
            return
        }
        if (
            !["GET", "POST"].includes(req.method || "") ||
            !/^\/v1\/[a-z/]+$/.test(req.url || "") ||
            (req.method === "POST" && req.headers["content-type"] !== "application/json")
        ) {
            res.writeHead(400)
            res.end()
            return
        }
        let body = "",
            length = 0
        const chunks: Buffer[] = []
        try {
            for await (const chunk of req) {
                length += chunk.length
                if (length > 256 * 1024) {
                    res.writeHead(413)
                    res.end()
                    return
                }
                chunks.push(Buffer.from(chunk))
            }
        } catch {
            return
        }
        body = Buffer.concat(chunks).toString("utf8")
        const nonce = String(req.headers["x-tglfs-nonce"] || ""),
            time = String(req.headers["x-tglfs-time"] || ""),
            signature = String(req.headers["x-tglfs-signature"] || "")
        for (const [key, timestamp] of nonces) if (timestamp < Date.now() - 120000) nonces.delete(key)
        if (
            !/^[a-f0-9]{32}$/.test(nonce) ||
            !/^[0-9]{13}$/.test(time) ||
            Math.abs(Date.now() - Number(time)) > 60000 ||
            nonces.has(nonce) ||
            nonces.size >= 10000 ||
            !same(signature, await requestSignature(config.token, req.method!, req.url!, time, nonce, body))
        ) {
            res.writeHead(401)
            res.end()
            return
        }
        nonces.set(nonce, Date.now())
        const reply = async (status: number, data?: unknown, error?: string) => {
            const text = JSON.stringify({
                type: "tglfs:helper-response",
                version: 1,
                ok: status < 400,
                ...(data === undefined ? {} : { data }),
                ...(error ? { error } : {}),
            })
            res.setHeader("Content-Type", "application/json")
            res.setHeader("X-TGLFS-Signature", await responseSignature(config.token, nonce, status, text))
            res.writeHead(status)
            res.end(text)
        }
        try {
            if (req.method === "GET" && req.url === "/v1/status") {
                await reply(200, {
                    accountId: queue.accountId,
                    roots: config.uploadRoots.map((path, i) => ({ id: `root${i}`, name: path })),
                    downloadDir: config.downloadDir,
                    jobs: [
                        ...queue.list().filter((j) => !["done", "cancelled"].includes(j.status)),
                        ...queue
                            .list()
                            .filter((j) => ["done", "cancelled"].includes(j.status))
                            .slice(0, 100),
                    ].map(publicJob),
                })
                return
            }
            if (req.method !== "POST") {
                await reply(404, undefined, "Unknown helper endpoint.")
                return
            }
            const request = JSON.parse(body)
            if (
                !request ||
                request.type !== "tglfs:helper-request" ||
                request.version !== 1 ||
                request.accountId !== queue.accountId
            )
                throw new Error("Unsupported helper request or mismatched Telegram account.")
            if (req.url === "/v1/browse") {
                await reply(200, await browseFiles(config, request.rootId, request.path))
                return
            }
            if (req.url === "/v1/stop") {
                await reply(200, {})
                setImmediate(() => options.stop?.())
                return
            }
            if (!validJobId(request.id)) throw new Error("Invalid transfer identity.")
            if (req.url === "/v1/cancel") {
                await queue.cancel(request.id)
                await reply(200, {})
                return
            }
            if (req.url === "/v1/unlock") {
                await reply(
                    200,
                    publicJob(
                        await queue.unlock(
                            request.id,
                            await openHelperPassword(request.secret, config.token, request.id),
                        ),
                    ),
                )
                return
            }
            if (req.url !== "/v1/jobs") {
                await reply(404, undefined, "Unknown helper endpoint.")
                return
            }
            const now = Date.now(),
                password = await openHelperPassword(request.secret, config.token, request.id)
            let job: HelperJob
            const base = {
                type: "tglfs:helper-job" as const,
                version: 1 as const,
                id: request.id,
                accountId: queue.accountId,
                createdAt: now,
                updatedAt: now,
                status: "queued" as const,
                phase: "Queued",
                bytes: 0,
            }
            if (request.direction === "upload") {
                const sources = await selectedSources(config, request.rootId, request.files)
                const size =
                    sources.length === 1
                        ? sources[0].size
                        : computeTarSize(
                              sources.map((s) => ({
                                  name: s.name,
                                  size: s.size,
                                  lastModified: s.modified,
                                  stream() {
                                      throw new Error("No stream during selection")
                                  },
                              })),
                          )
                const name =
                    sources.length === 1
                        ? sources[0].name
                        : typeof request.name === "string" && request.name.endsWith(".tar")
                          ? request.name
                          : defaultArchiveName(new Date(now))
                if (
                    name.length > 512 ||
                    typeof request.parentFolderId !== "string" ||
                    !request.parentFolderId.trim() ||
                    request.parentFolderId.length > 256
                )
                    throw new Error("Invalid upload name or destination folder.")
                job = {
                    ...base,
                    direction: "upload",
                    name,
                    size,
                    total: size,
                    sources,
                    parentFolderId: request.parentFolderId,
                }
            } else if (request.direction === "download") {
                if (
                    typeof request.name !== "string" ||
                    !request.name.trim() ||
                    request.name.length > 512 ||
                    !Number.isSafeInteger(request.size) ||
                    request.size < 0
                )
                    throw new Error("Invalid download metadata.")
                job = {
                    ...base,
                    direction: "download",
                    name: request.name,
                    size: request.size,
                    total: request.size,
                    messageId: request.messageId,
                    ufid: request.ufid,
                    fileVersion: request.fileVersion,
                    outputPath: join(config.downloadDir, request.id, safeDownloadName(request.name)),
                }
            } else throw new Error("Unsupported helper transfer direction.")
            await reply(200, publicJob(await queue.add(job, password)))
        } catch (error) {
            await reply(400, undefined, error instanceof Error ? error.message : "The helper request failed.")
        }
    }
    return server
}
