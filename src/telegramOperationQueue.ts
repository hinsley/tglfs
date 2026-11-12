import { installTelegramOperationQueue, type PersistedState } from "../packages/tglfs-cli/src/shared/telegram-operation-queue"

/** Web tabs share one pacing budget. Actual operation closures deliberately do not survive reload. */
export function installBrowserOperationQueue(client: any, account: string) {
    const key = `tglfs:operation-pacing:v1:${encodeURIComponent(account || "stored-session")}`
    return installTelegramOperationQueue(client, {
        loadState: async () => {
            const raw = localStorage.getItem(key)
            return raw ? JSON.parse(raw) as PersistedState : null
        },
        saveState: async state => { localStorage.setItem(key, JSON.stringify(state)) },
        exclusive: async run => {
            if (!navigator.locks) throw new Error("This browser cannot coordinate queued operations. Use a browser with Web Locks support.")
            return navigator.locks.request(key, { mode: "exclusive" }, run)
        },
    })
}

/** Never connect two tabs using the same stored authorization key at once. */
export async function acquireBrowserSessionLease(): Promise<() => void> {
    if (!navigator.locks) throw new Error("This browser cannot coordinate the Telegram session. Use a browser with Web Locks support.")
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    return new Promise<() => void>((resolve, reject) => {
        navigator.locks.request("tglfs:stored-telegram-session", { ifAvailable: true }, async lock => {
            if (!lock) { reject(new Error("TGLFS is connected in another tab. Disconnect it before connecting here.")); return }
            resolve(release)
            await held
        }).catch(reject)
    })
}
