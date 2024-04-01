// config.ts
// CRUD for the TGLFS client configuration file.

import fs from "fs/promises"

export interface Config {
    apiId: number
    apiHash: string
    phone: string
    chunkSizeGB: number
}

export async function loadConfig(): Promise<Config> {
    const jsonString = await fs.readFile("config.json", "utf8")
    return JSON.parse(jsonString)
}
