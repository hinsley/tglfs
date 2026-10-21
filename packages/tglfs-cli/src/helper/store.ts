import { randomUUID } from "node:crypto"
import { chmod, mkdir, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { storePaths } from "../store.js"
import { parseHelperConfig, parseHelperJob, validJobId } from "./protocol.js"
import type { HelperConfig, HelperJob } from "./protocol.js"
export const helperDirectory = join(storePaths.dataDir, "helper")
export async function privateDirectory(path: string) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if ((await lstat(path)).isSymbolicLink()) throw new Error("The helper storage directory cannot be a symbolic link.")
    await chmod(path, 0o700)
}
export async function writePrivateJson(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
        const file = await open(temporary, "wx", 0o600)
        try {
            await file.writeFile(JSON.stringify(value))
            await file.sync()
        } finally {
            await file.close()
        }
        await rename(temporary, path)
    } finally {
        await rm(temporary, { force: true })
    }
}
export class HelperStore {
    constructor(readonly directory = helperDirectory) {}
    async initialize() {
        await privateDirectory(this.directory)
        await privateDirectory(join(this.directory, "jobs"))
    }
    async config(): Promise<HelperConfig | null> {
        try {
            return parseHelperConfig(JSON.parse(await readFile(join(this.directory, "config.json"), "utf8")))
        } catch (e: any) {
            if (e.code === "ENOENT") return null
            throw e
        }
    }
    async saveConfig(config: HelperConfig) {
        await this.initialize()
        await writePrivateJson(join(this.directory, "config.json"), parseHelperConfig(config))
    }
    async jobs(): Promise<HelperJob[]> {
        await this.initialize()
        const result: HelperJob[] = []
        for (const name of await readdir(join(this.directory, "jobs"))) {
            if (!name.endsWith(".json")) continue
            const job = parseHelperJob(JSON.parse(await readFile(join(this.directory, "jobs", name), "utf8")))
            if (name !== `${job.id}.json`) throw new Error("A helper job filename does not match its identity.")
            result.push(job)
        }
        return result
    }
    async saveJob(job: HelperJob) {
        if (!validJobId(job.id)) throw new Error("Invalid helper job identity.")
        parseHelperJob(job)
        await writePrivateJson(join(this.directory, "jobs", `${job.id}.json`), job)
    }
}
