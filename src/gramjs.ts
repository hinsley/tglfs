type StorageShim = {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem: (key: string) => void
    clear: () => void
    key: (index: number) => string | null
    readonly length: number
}

type GramJsModules = {
    TelegramClient: typeof import("telegram")["TelegramClient"]
    Api: typeof import("telegram")["Api"]
    StoreSession: typeof import("telegram/sessions")["StoreSession"]
    getFileInfo: typeof import("telegram/Utils")["getFileInfo"]
}

let gramJsModulesPromise: Promise<GramJsModules> | null = null

function installLocalStorageShim() {
    if (typeof window !== "undefined") {
        return
    }

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    if (!descriptor?.configurable || !descriptor.get) {
        return
    }

    const storage = new Map<string, string>()
    const shim: StorageShim = {
        getItem(key) {
            return storage.has(key) ? storage.get(key)! : null
        },
        setItem(key, value) {
            storage.set(String(key), String(value))
        },
        removeItem(key) {
            storage.delete(String(key))
        },
        clear() {
            storage.clear()
        },
        key(index) {
            return Array.from(storage.keys())[index] ?? null
        },
        get length() {
            return storage.size
        },
    }

    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: true,
        value: shim,
    })
}

async function loadGramJsModules(): Promise<GramJsModules> {
    installLocalStorageShim()

    const [telegram, sessionModule, utilsModule] = await Promise.all([
        import("telegram"),
        import("telegram/sessions"),
        import("telegram/Utils"),
    ])

    return {
        TelegramClient: telegram.TelegramClient,
        Api: telegram.Api,
        StoreSession: sessionModule.StoreSession,
        getFileInfo: utilsModule.getFileInfo,
    }
}

export async function getGramJs(): Promise<GramJsModules> {
    if (!gramJsModulesPromise) {
        gramJsModulesPromise = loadGramJsModules()
    }
    return gramJsModulesPromise
}
