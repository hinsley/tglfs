let fileName
let downloadStreamController = null

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url)
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
