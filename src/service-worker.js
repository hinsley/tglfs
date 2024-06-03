let fileName;
let downloadStreamController = null;

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.pathname === "/download-file") {
        const downloadStream = new ReadableStream({
            start(controller) {
                downloadStreamController = controller;
            },
        });
        const response = new Response(downloadStream, {
            headers: {
                "Content-Disposition": `attachment; filename="${fileName}"`,
            },
        });
        event.respondWith(response);
    }
});

// self.addEventListener("fetch", function(event) {
//     const url = new URL(event.request.url);
//     if (url.pathname === '/download-file') {
//         const ufid = url.searchParams.get('ufid');
//         if (ufid) {
//             event.respondWith(handleDownload(ufid));
//         } else {
//             event.respondWith(new Response('UFID not provided', { status: 400 }));
//         }
//     }
// });

// async function handleDownload(ufid) {
//     try {
//         console.log("Downloading file with UFID:", ufid);
//         const directoryHandle = await navigator.storage.getDirectory();
//         const fileHandle = await directoryHandle.getFileHandle("test.txt", { create: true });
//         const writable = await fileHandle.createWritable();
//         const content = new Uint8Array([0, 0, 0, 0, 0]);
//         await writable.write(content);
//         await writable.close();
//         const file = await fileHandle.getFile();
//         const stream = file.stream();

//         // Create a response with the file stream and appropriate headers
//         return new Response(stream, {
//             headers: {
//                 'Content-Type': 'application/octet-stream',
//                 'Content-Disposition': 'attachment; filename="test.txt"'
//             }
//         });
//     } catch (error) {
//         return new Response('File not found', { status: 404 });
//     }
// }

self.addEventListener("message", async (event) => {
    // Promise used to ensure fetch event triggers first,
    // initializing `downloadStreamController`.
    // await new Promise((resolve) => {
    //     function checkFetchHandled() {
    //         if (downloadStreamController !== null) {
    //             resolve();
    //         } else {
    //             setTimeout(checkFetchHandled, 50);
    //         }
    //     }
    //     checkFetchHandled();
    // });

    console.log(event.data.type);
    switch (event.data.type) {
        case "SET_FILE_NAME":
            fileName = event.data.fileName;
            break;
        case "PROCESSED_DATA":
            console.log("enqueueing:", event.data.data);
            downloadStreamController.enqueue(event.data.data);
            break;
        case "DOWNLOAD_COMPLETE":
            downloadStreamController.close();
            downloadStreamController = null;
            break;
        default:
            console.log("Unknown message type. Event:", event);
    }
});

