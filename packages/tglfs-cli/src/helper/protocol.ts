export type HelperConfig = {
    type: "tglfs:helper-config"
    version: 1
    port: number
    token: string
    origins: string[]
    uploadRoots: string[]
    downloadDir: string
}
export type HelperSource = { path: string; name: string; size: number; modified: number }
export type HelperJob = {
    type: "tglfs:helper-job"
    version: 1
    id: string
    accountId: string
    direction: "upload" | "download"
    name: string
    size: number
    createdAt: number
    updatedAt: number
    status: "queued" | "running" | "needs-password" | "done" | "failed" | "cancelled"
    phase: string
    bytes: number
    total: number
    sources?: HelperSource[]
    parentFolderId?: string
    messageId?: number
    ufid?: string
    fileVersion?: number
    outputPath?: string
    uploadSessionId?: string
    error?: string
    result?: { msgId?: number; ufid: string; outputPath?: string }
}
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim() && !v.includes("\0")
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
export const validJobId = (v: unknown): v is string =>
    typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
function keys(value: object, allowed: string[]) {
    if (Object.keys(value).some((k) => !allowed.includes(k)))
        throw new Error("Unknown helper record fields cannot be edited safely.")
}
export function parseHelperConfig(value: unknown): HelperConfig {
    const c = value as HelperConfig
    if (
        !c ||
        c.type !== "tglfs:helper-config" ||
        c.version !== 1 ||
        !integer(c.port) ||
        c.port < 1024 ||
        c.port > 65535 ||
        !/^[A-Za-z0-9_-]{43}$/.test(c.token) ||
        !Array.isArray(c.origins) ||
        !c.origins.length ||
        !c.origins.every((origin) => {
            try {
                const u = new URL(origin)
                return (
                    u.origin === origin &&
                    (u.protocol === "https:" ||
                        (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
                )
            } catch {
                return false
            }
        }) ||
        !Array.isArray(c.uploadRoots) ||
        !c.uploadRoots.every(nonempty) ||
        !nonempty(c.downloadDir)
    )
        throw new Error("Unsupported or malformed helper configuration.")
    keys(c, ["type", "version", "port", "token", "origins", "uploadRoots", "downloadDir"])
    return c
}
export function parseHelperJob(value: unknown): HelperJob {
    const j = value as HelperJob
    if (
        !j ||
        j.type !== "tglfs:helper-job" ||
        j.version !== 1 ||
        !validJobId(j.id) ||
        !/^[0-9]+$/.test(j.accountId) ||
        !["upload", "download"].includes(j.direction) ||
        !nonempty(j.name) ||
        !integer(j.size) ||
        !integer(j.createdAt) ||
        !integer(j.updatedAt) ||
        !["queued", "running", "needs-password", "done", "failed", "cancelled"].includes(j.status) ||
        typeof j.phase !== "string" ||
        !integer(j.bytes) ||
        !integer(j.total)
    )
        throw new Error("Unsupported or malformed helper job.")
    keys(j, [
        "type",
        "version",
        "id",
        "accountId",
        "direction",
        "name",
        "size",
        "createdAt",
        "updatedAt",
        "status",
        "phase",
        "bytes",
        "total",
        "sources",
        "parentFolderId",
        "messageId",
        "ufid",
        "fileVersion",
        "outputPath",
        "uploadSessionId",
        "error",
        "result",
    ])
    if (j.direction === "upload") {
        if (
            !Array.isArray(j.sources) ||
            !j.sources.length ||
            j.sources.length > 1000 ||
            j.sources.some(
                (s) => !s || !nonempty(s.path) || !nonempty(s.name) || !integer(s.size) || !integer(s.modified),
            )
        )
            throw new Error("Malformed helper upload sources.")
        for (const s of j.sources) keys(s, ["path", "name", "size", "modified"])
        if (!nonempty(j.parentFolderId)) throw new Error("Missing helper upload folder.")
    } else if (
        !integer(j.messageId) ||
        j.messageId <= 0 ||
        !nonempty(j.ufid) ||
        ![1, 2, 3, 4, 5].includes(j.fileVersion!) ||
        !nonempty(j.outputPath)
    )
        throw new Error("Malformed helper download target.")
    if (j.uploadSessionId !== undefined && !/^[a-f0-9]{32}$/.test(j.uploadSessionId))
        throw new Error("Malformed helper upload session.")
    if (j.error !== undefined && typeof j.error !== "string") throw new Error("Malformed helper job error.")
    if (j.result !== undefined) {
        if (
            !j.result ||
            typeof j.result !== "object" ||
            !nonempty(j.result.ufid) ||
            (j.result.msgId !== undefined && (!integer(j.result.msgId) || j.result.msgId <= 0)) ||
            (j.result.outputPath !== undefined && !nonempty(j.result.outputPath))
        )
            throw new Error("Malformed helper result.")
        keys(j.result, ["msgId", "ufid", "outputPath"])
    }
    return j
}

export function parseHelperProcess(value: unknown): { type: "tglfs:helper-process"; version: 1; pid: number } {
    const p = value as any
    if (!p || p.type !== "tglfs:helper-process" || p.version !== 1 || !integer(p.pid) || p.pid <= 0)
        throw new Error("Unsupported or malformed helper process record. It was preserved.")
    keys(p, ["type", "version", "pid"])
    return p
}
