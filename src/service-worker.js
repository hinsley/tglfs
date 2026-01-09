const SHARE_TARGET_PATHS = new Set(["/share-target", "/src/share-target"])
const SHARE_TARGET_REDIRECT_URL = "/?share-target=1"
const OFFLINE_CACHE = "pwabuilder-page"
const OFFLINE_URL = "/offline.html"
const SHARE_DB_NAME = "tglfs-share-target"
const SHARE_DB_VERSION = 2
const SHARE_STORE = "shares"
const SHARE_KEY = "pending"

let fileName
let downloadStreamController = null

function toShareRecords(entries) {
    return entries
        .filter((entry) => entry instanceof Blob)
        .map((entry) => {
            const name =
                typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name : "shared-file"
            const type = entry.type || "application/octet-stream"
            const lastModified = typeof entry.lastModified === "number" ? entry.lastModified : Date.now()
            return {
                name,
                type,
                lastModified,
                blob: entry.slice(0, entry.size, type),
            }
        })
}

function openShareDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(SHARE_DB_NAME, SHARE_DB_VERSION)
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(SHARE_STORE)) {
                request.result.createObjectStore(SHARE_STORE)
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function storeShareRecords(records) {
    if (!records.length) return
    const db = await openShareDb()
    await new Promise((resolve, reject) => {
        const tx = db.transaction(SHARE_STORE, "readwrite")
        tx.oncomplete = () => {
            db.close()
            resolve()
        }
        tx.onerror = () => {
            db.close()
            reject(tx.error)
        }
        tx.objectStore(SHARE_STORE).put(records, SHARE_KEY)
    })
}

async function loadShareRecords({ clear } = { clear: false }) {
    const db = await openShareDb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SHARE_STORE, clear ? "readwrite" : "readonly")
        const store = tx.objectStore(SHARE_STORE)
        let result = []
        const request = store.get(SHARE_KEY)
        request.onsuccess = () => {
            result = request.result || []
            if (clear) {
                store.delete(SHARE_KEY)
            }
        }
        tx.oncomplete = () => {
            db.close()
            resolve(result)
        }
        tx.onerror = () => {
            db.close()
            reject(tx.error)
        }
    })
}

async function clearShareRecords() {
    const db = await openShareDb()
    await new Promise((resolve, reject) => {
        const tx = db.transaction(SHARE_STORE, "readwrite")
        tx.oncomplete = () => {
            db.close()
            resolve()
        }
        tx.onerror = () => {
            db.close()
            reject(tx.error)
        }
        tx.objectStore(SHARE_STORE).delete(SHARE_KEY)
    })
}

async function deliverShareTarget(records) {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    let targetClient = clientsList.find((client) => {
        const url = new URL(client.url)
        return url.pathname === "/" || url.pathname.endsWith("/index.html")
    })

    if (!targetClient && clientsList.length > 0) {
        targetClient = clientsList[0]
    }

    if (!targetClient) {
        targetClient = await self.clients.openWindow(SHARE_TARGET_REDIRECT_URL)
    } else if ("focus" in targetClient) {
        await targetClient.focus()
    }

    if (targetClient) {
        targetClient.postMessage({ type: "SHARE_TARGET_FILES", files: records })
    }
}

async function handleShareTarget(request) {
    const formData = await request.formData()
    const entries = Array.from(formData.values())
    const records = toShareRecords(entries)
    await storeShareRecords(records)
    await deliverShareTarget(records)
}

self.addEventListener("install", (event) => {
    self.skipWaiting()
    event.waitUntil(
        (async () => {
            try {
                const cache = await caches.open(OFFLINE_CACHE)
                await cache.add(OFFLINE_URL)
            } catch (error) {
                // Ignore offline cache failures so the SW can still install.
            }
        })(),
    )
})

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url)
    if (SHARE_TARGET_PATHS.has(url.pathname)) {
        if (event.request.method === "POST") {
            const requestClone = event.request.clone()
            event.respondWith(Response.redirect(SHARE_TARGET_REDIRECT_URL, 303))
            event.waitUntil(handleShareTarget(requestClone))
        } else {
            event.respondWith(Response.redirect(SHARE_TARGET_REDIRECT_URL, 303))
        }
        return
    }
    if (url.pathname === "/download-file") {
        const downloadStream = new ReadableStream({
            start(controller) {
                downloadStreamController = controller
            },
        })
        const response = new Response(downloadStream, {
            headers: {
                "Content-Disposition": `attachment; filename="${fileName}"`,
            },
        })
        event.respondWith(response)
        return
    }
    if (event.request.mode === "navigate") {
        event.respondWith(
            (async () => {
                try {
                    return await fetch(event.request)
                } catch (error) {
                    const cache = await caches.open(OFFLINE_CACHE)
                    const cachedResp = await cache.match(OFFLINE_URL)
                    return cachedResp || Response.error()
                }
            })(),
        )
    }
})

self.addEventListener("message", (event) => {
    const data = event.data
    if (!data || !data.type) {
        return
    }
    if (data.type === "SKIP_WAITING") {
        self.skipWaiting()
        return
    }
    if (data.type === "SHARE_TARGET_RECEIVED") {
        event.waitUntil(clearShareRecords())
        return
    }
    if (data.type === "REQUEST_SHARE_TARGET") {
        event.waitUntil(
            (async () => {
                const records = await loadShareRecords()
                if (!records.length) return
                const source = event.source
                if (source && "postMessage" in source) {
                    source.postMessage({ type: "SHARE_TARGET_FILES", files: records })
                } else {
                    await deliverShareTarget(records)
                }
            })(),
        )
        return
    }
    switch (data.type) {
        case "SET_FILE_NAME":
            fileName = data.fileName
            break
        case "PROCESSED_DATA":
            downloadStreamController.enqueue(data.data)
            break
        case "DOWNLOAD_COMPLETE":
            downloadStreamController.close()
            downloadStreamController = null
            break
        default:
            console.log("Unknown message type. Event:", event)
    }
})
