import * as Telegram from "../telegram"

async function init(apiId?: string, apiHash?: string, phoneNumber?: string) {
    const apiIdElement = document.getElementById("apiId") as HTMLInputElement | null
    const apiHashElement = document.getElementById("apiHash") as HTMLInputElement | null
    const phoneElement = document.getElementById("phone") as HTMLInputElement | null

    if (!apiIdElement || !apiHashElement || !phoneElement) {
        throw new Error("Required input elements are missing.")
    }

    const apiIdValue = apiId ?? apiIdElement.value
    const apiHashValue = apiHash ?? apiHashElement.value
    const phoneValue = phoneNumber ?? phoneElement.value

    if (apiIdValue.trim() === "" || apiHashValue.trim() === "" || phoneValue.trim() === "") {
        throw new Error("Input fields cannot be empty.")
    }

    const config = {
        apiId: Number(apiIdValue),
        apiHash: apiHashValue,
        chunkSize: 1024 ** 3 * 2, // 2 GiB.
        phone: phoneValue,
    }

    const client = await Telegram.init(config)

    // Set login credential cookies.
    document.cookie = `apiId=${apiIdValue}; path=/`
    document.cookie = `apiHash=${apiHashValue}; path=/`
    document.cookie = `phone=${phoneValue}; path=/`

    // Expose the client and config objects to the browser console
    ;(window as any).client = client
    ;(window as any).config = config

    // Set up UI
    const loginDiv = document.getElementById("login")
    if (loginDiv) {
        loginDiv.setAttribute("hidden", "")
    }
    const controlsDiv = document.getElementById("controls")
    if (controlsDiv) {
        controlsDiv.removeAttribute("hidden")
    }
    const uploadFileInput = document.getElementById("uploadFileInput") as HTMLInputElement
    uploadFileInput.addEventListener("change", async () => {
        await Telegram.fileUpload(client, config)
    })
    const fileLookupButton = document.getElementById("fileLookupButton") as HTMLButtonElement
    fileLookupButton.addEventListener("click", async () => {
        await Telegram.fileLookup(client, config)
    })
    const sendFileButton = document.getElementById("sendFileButton") as HTMLButtonElement
    sendFileButton.addEventListener("click", async () => {
        await Telegram.fileSend(client, config)
    })
    const unsendFileButton = document.getElementById("unsendFileButton") as HTMLButtonElement
    unsendFileButton.addEventListener("click", async () => {
        await Telegram.fileUnsend(client, config)
    })
    const receiveFileButton = document.getElementById("receiveFileButton") as HTMLButtonElement
    receiveFileButton.addEventListener("click", async () => {
        await Telegram.fileReceive(client, config)
    })
    const renameFileButton = document.getElementById("renameFileButton") as HTMLButtonElement
    renameFileButton.addEventListener("click", async () => {
        await Telegram.fileRename(client, config)
    })
    const deleteFileButton = document.getElementById("deleteFileButton") as HTMLButtonElement
    deleteFileButton.addEventListener("click", async () => {
        await Telegram.fileDelete(client, config)
    })
    const downloadFileButton = document.getElementById("downloadFileButton") as HTMLButtonElement
    if ("serviceWorker" in navigator) {
        await navigator.serviceWorker
            .register(new URL("/src/service-worker.js", import.meta.url), { type: "module" })
            .then(function (registration) {
                downloadFileButton.addEventListener("click", async () => {
                    await Telegram.fileDownload(client, config)
                })
            })
            .catch(function (error) {
                alert(
                    "Failed to register ServiceWorker.\nYou will not be able to download files.\nSee developer console for details.",
                )
                console.error("ServiceWorker registration failed: ", error)
            })
    }
}

const loginButton = document.getElementById("loginButton") as HTMLButtonElement
loginButton.addEventListener("click", () => {
    init()
})

window.addEventListener("load", async () => {
    function getCookie(name: string): string | null {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) {
            const cookieValue = parts.pop()?.split(';').shift() || null;
            return cookieValue ? decodeURIComponent(cookieValue) : null;
        }
        return null;
    }

    const apiId = getCookie("apiId");
    const apiHash = getCookie("apiHash");
    const phone = getCookie("phone");

    // Check if login credentials are already stored as cookies.
    if (apiId && apiHash && phone) {
        (document.getElementById("apiId") as HTMLInputElement).value = apiId;
        (document.getElementById("apiHash") as HTMLInputElement).value = apiHash;
        (document.getElementById("phone") as HTMLInputElement).value = phone;
        await init();
    } else {
        const loginDiv = document.getElementById("login")
        if (loginDiv) {
            loginDiv.removeAttribute("hidden")
        }
    }
    // Remove splash screen once the page has loaded.
    const splashDiv = document.getElementById("splash")
    if (splashDiv) {
        splashDiv.remove()
    }
})

