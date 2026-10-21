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
const archiveMembers = new Map()
const ARCHIVE_MEMBER_PREFIX = "/archive-member/"
const ARCHIVE_READ_SIZE = 256 * 1024
const ARCHIVE_MEMBER_IDLE_MS = 30 * 60 * 1000

function closeArchiveMember(token) {
    const member = archiveMembers.get(token)
    if (!member) return
    archiveMembers.delete(token)
    member.closed = true
    for (const pending of member.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error("Archive preview closed."))
    }
    member.pending.clear()
    member.port.close()
}

function parseArchiveRange(value, size) {
    if (value === null) return { start: 0, end: size - 1, partial: false }
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
    if (!match || (!match[1] && !match[2]) || size === 0) return null
    let start
    let end
    if (!match[1]) {
        const suffix = Number(match[2])
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
        start = Math.max(0, size - suffix)
        end = size - 1
    } else {
        start = Number(match[1])
        end = match[2] ? Number(match[2]) : size - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null
        end = Math.min(end, size - 1)
    }
    return { start, end, partial: true }
}

function requestArchiveBytes(member, offset, length) {
    if (member.closed) return Promise.reject(new Error("Archive preview closed."))
    member.lastUsed = Date.now()
    const id = ++member.nextRequest
    const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            member.pending.delete(id)
            reject(new Error("Archive preview request timed out."))
        }, 60000)
        member.pending.set(id, { resolve, reject, timer, length })
        member.port.postMessage({ type: "read", id, offset, length })
    })
    promise.cancel = () => {
        const pending = member.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        member.pending.delete(id)
        pending.reject(new Error("Archive request cancelled."))
    }
    return promise
}

async function archiveMemberResponse(event, token) {
    const member = archiveMembers.get(token)
    const closed = () => new Response("Archive preview closed.", { status: 410, headers: { "Cache-Control": "no-store" } })
    if (!member) return closed()
    if (Date.now() - member.lastUsed > ARCHIVE_MEMBER_IDLE_MS || !(await self.clients.get(member.clientId))) {
        closeArchiveMember(token)
        return closed()
    }
    const downloadRequested = new URL(event.request.url).searchParams.get("download") === "1"
    const isOwner = !!event.clientId && member.allowedClients.has(event.clientId)
    const oneTimeDownload = member.downloadOnly && downloadRequested && event.request.method === "GET" &&
        !event.request.headers.has("Range") && !member.downloadStarted && Date.now() - member.createdAt < 10000 &&
        (isOwner || !event.clientId)
    if (member.downloadOnly ? !oneTimeDownload : !isOwner) {
        if (new URL(event.request.url).searchParams.get("download") === "1") member.port.postMessage({ type: "download-error", error: "This browser did not identify the archive preview tab." })
        return new Response("This archive preview belongs to another tab.", { status: 403, headers: { "Cache-Control": "no-store" } })
    }
    if (member.downloadOnly) member.downloadStarted = true
    if (event.clientId && event.resultingClientId) member.allowedClients.add(event.resultingClientId)
    if (event.request.method !== "GET" && event.request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } })
    }
    const range = parseArchiveRange(event.request.headers.get("Range"), member.size)
    if (!range) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${member.size}`, "Cache-Control": "no-store" } })
    }
    member.lastUsed = Date.now()
    const headers = {
        "Content-Type": member.mime,
        "Content-Length": String(Math.max(0, range.end - range.start + 1)),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; sandbox allow-downloads",
    }
    if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${member.size}`
    if (new URL(event.request.url).searchParams.get("download") === "1") {
        headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(member.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`
    }
    if (event.request.method === "HEAD") return new Response(null, { status: range.partial ? 206 : 200, headers })
    let offset = range.start
    let cancelled = false
    let pendingRead = null
    const isDownload = new URL(event.request.url).searchParams.get("download") === "1"
    const isFullDownload = isDownload && range.start === 0 && range.end === member.size - 1
    const stream = new ReadableStream({
        async pull(controller) {
            if (cancelled) return
            if (offset > range.end) {
                controller.close()
                if (isFullDownload) member.port.postMessage({ type: "download-complete" })
                return
            }
            try {
                pendingRead = requestArchiveBytes(member, offset, Math.min(ARCHIVE_READ_SIZE, range.end - offset + 1))
                const bytes = await pendingRead
                pendingRead = null
                if (cancelled) return
                offset += bytes.byteLength
                controller.enqueue(bytes)
                if (offset > range.end) {
                    controller.close()
                    if (isFullDownload) member.port.postMessage({ type: "download-complete" })
                }
            } catch (error) {
                if (!cancelled) {
                    controller.error(error)
                    if (isDownload) member.port.postMessage({ type: "download-error" })
                }
            }
        },
        cancel() {
            cancelled = true
            pendingRead?.cancel?.()
            if (isDownload) member.port.postMessage({ type: "download-error" })
        },
    }, { highWaterMark: 0 })
    return new Response(stream, { status: range.partial ? 206 : 200, headers })
}

function registerArchiveMember(event, data) {
    const port = event.ports?.[0]
    if (!port || !event.source?.id || !/^[a-f0-9]{32}$/.test(data.token) ||
        !Number.isSafeInteger(data.size) || data.size < 0 || typeof data.name !== "string") return
    const allowedMime = /^(image\/(jpeg|png|gif|webp|bmp)|video\/(mp4|webm|quicktime|x-msvideo|x-matroska)|audio\/(mpeg|wav|ogg|flac|mp4|aac)|application\/(pdf|octet-stream))$/
    const mime = typeof data.mime === "string" && allowedMime.test(data.mime) ? data.mime : "application/octet-stream"
    for (const [token, member] of archiveMembers) {
        if (Date.now() - member.lastUsed > ARCHIVE_MEMBER_IDLE_MS) closeArchiveMember(token)
    }
    if (archiveMembers.size >= 64) {
        port.postMessage({ type: "error", error: "Too many archive previews are open." })
        port.close()
        return
    }
    closeArchiveMember(data.token)
    const member = { clientId: event.source.id, allowedClients: new Set([event.source.id]), port, size: data.size, name: data.name, mime,
        nextRequest: 0, pending: new Map(), closed: false, lastUsed: Date.now(), createdAt: Date.now(),
        downloadOnly: data.downloadOnly === true, downloadStarted: false }
    archiveMembers.set(data.token, member)
    port.onmessage = (message) => {
        if (message.data?.type === "close") {
            closeArchiveMember(data.token)
            return
        }
        const pending = member.pending.get(message.data?.id)
        if (!pending) return
        clearTimeout(pending.timer)
        member.pending.delete(message.data.id)
        if (message.data.type === "error") pending.reject(new Error("Unable to read archive member."))
        else if (!(message.data.bytes instanceof Uint8Array) || message.data.bytes.byteLength !== pending.length) {
            pending.reject(new Error("Invalid archive preview response."))
        } else pending.resolve(message.data.bytes)
    }
    port.start()
    port.postMessage({ type: "ready" })
}

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
    if (url.origin === self.location.origin && url.pathname.startsWith(ARCHIVE_MEMBER_PREFIX)) {
        event.respondWith(archiveMemberResponse(event, url.pathname.slice(ARCHIVE_MEMBER_PREFIX.length)))
        return
    }
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

// Transfer notifications (shown by src/web/transferAttention.ts): focus the TGLFS tab and ask it to expand the tray.
const TRANSFER_NOTIFICATION_SOURCE = "tglfs-transfers"
const SHOW_TRANSFERS_MESSAGE = "TGLFS_SHOW_TRANSFERS"

async function focusTransfersClient(notificationData) {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    const scope = self.registration ? self.registration.scope : ""
    const sameApp = clientsList.filter((client) => !scope || client.url.startsWith(scope))
    // Prefer the tab that showed the notification; matchAll lists the most recently focused tab first.
    const target =
        sameApp.find((client) => notificationData && client.url === notificationData.url) || sameApp[0] || null
    if (!target) {
        // The transfer queue lives in the page, so a fresh window can't show it; just reopen the app.
        if (self.clients.openWindow) await self.clients.openWindow("/")
        return
    }
    if ("focus" in target) {
        try {
            await target.focus()
        } catch (error) {
            // Focus can be refused; still deliver the message so the tray opens when the user switches back.
        }
    }
    target.postMessage({ type: SHOW_TRANSFERS_MESSAGE })
}

self.addEventListener("notificationclick", (event) => {
    const data = event.notification && event.notification.data
    if (!data || data.source !== TRANSFER_NOTIFICATION_SOURCE) {
        return
    }
    event.notification.close()
    event.waitUntil(focusTransfersClient(data))
})

self.addEventListener("message", (event) => {
    const data = event.data
    if (!data || !data.type) {
        return
    }
    if (data.type === "REGISTER_ARCHIVE_MEMBER") {
        registerArchiveMember(event, data)
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
