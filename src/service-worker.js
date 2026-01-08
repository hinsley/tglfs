const SHARE_TARGET_PATH = "/share-target"
const SHARE_TARGET_REDIRECT_URL = "/?share-target=1"

let fileName
let downloadStreamController = null

async function deliverShareTarget(files) {
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
        targetClient.postMessage({ type: "SHARE_TARGET_FILES", files })
    }
}

async function handleShareTarget(request) {
    const formData = await request.formData()
    const files = formData
        .getAll("files")
        .filter((entry) => entry instanceof File)
    await deliverShareTarget(files)
}

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url)
    if (url.pathname === SHARE_TARGET_PATH) {
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
    }
})

self.addEventListener("message", async (event) => {
    switch (event.data.type) {
        case "SET_FILE_NAME":
            fileName = event.data.fileName
            break
        case "PROCESSED_DATA":
            downloadStreamController.enqueue(event.data.data)
            break
        case "DOWNLOAD_COMPLETE":
            downloadStreamController.close()
            downloadStreamController = null
            break
        default:
            console.log("Unknown message type. Event:", event)
    }
})
