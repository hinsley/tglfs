import * as Telegram from "../telegram"
import { initFileBrowser } from "./browser"

async function init(phoneNumber?: string) {
    const phoneElement = document.getElementById("phone") as HTMLInputElement | null

    if (!phoneElement) {
        throw new Error("Required input elements are missing.")
    }

    const apiIdFromEnv = (process as any).env.TELEGRAM_API_ID ?? (globalThis as any).TELEGRAM_API_ID
    const apiHashFromEnv = (process as any).env.TELEGRAM_API_HASH ?? (globalThis as any).TELEGRAM_API_HASH

    if (!apiIdFromEnv || !apiHashFromEnv) {
        console.error(
            "Missing TELEGRAM_API_ID or TELEGRAM_API_HASH. These must be provided at build time for the static client (e.g., set in Vercel Production env) or exposed on globalThis.",
            { TELEGRAM_API_ID: (globalThis as any)?.TELEGRAM_API_ID, TELEGRAM_API_HASH: (globalThis as any)?.TELEGRAM_API_HASH },
        )
        alert("Server misconfiguration: missing TELEGRAM_API_ID or TELEGRAM_API_HASH.")
        throw new Error("Missing TELEGRAM_API_ID or TELEGRAM_API_HASH environment variables.")
    }

    const phoneValue = phoneNumber ?? phoneElement.value

    if (phoneValue.trim() === "") {
        throw new Error("Input fields cannot be empty.")
    }

    const config = {
        apiId: Number(apiIdFromEnv),
        apiHash: String(apiHashFromEnv),
        chunkSize: 1024 ** 3 * 2, // 2 GiB.
        phone: phoneValue,
    }

    const client = await Telegram.init(config)

    // Set login credential cookies.
    document.cookie = `phone=${encodeURIComponent(phoneValue)}; path=/`

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
    const fileBrowserDiv = document.getElementById("fileBrowser")

    // Remove splash once we are logged in and UI is ready.
    const splashDivAtInit = document.getElementById("splash")
    if (splashDivAtInit) {
        splashDivAtInit.remove()
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
                const downloadFileLegacyButton = document.getElementById("downloadFileLegacyButton") as HTMLButtonElement
                downloadFileLegacyButton.addEventListener("click", async () => {
                    await Telegram.fileDownloadLegacy(client, config)
                })
            })
            .catch(function (error) {
                alert(
                    "Failed to register ServiceWorker.\nYou will not be able to download files.\nSee developer console for details.",
                )
                console.error("ServiceWorker registration failed: ", error)
            })
    }

    const fileBrowserButton = document.getElementById("fileBrowserButton") as HTMLButtonElement
    const browserBackButton = document.getElementById("browserBackButton") as HTMLButtonElement
    fileBrowserButton.addEventListener("click", async () => {
        // Show browser, hide controls.
        controlsDiv?.setAttribute("hidden", "")
        fileBrowserDiv?.removeAttribute("hidden")
        document.body.classList.add("file-browser-active")
        await initFileBrowser(client, config)
    })
    browserBackButton.addEventListener("click", () => {
        fileBrowserDiv?.setAttribute("hidden", "")
        controlsDiv?.removeAttribute("hidden")
        document.body.classList.remove("file-browser-active")
    })
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

    const phone = getCookie("phone");

    // Check if login credentials are already stored as cookies.
    if (phone) {
        (document.getElementById("phone") as HTMLInputElement).value = phone;
        await init();
    } else {
        const loginDiv = document.getElementById("login")
        if (loginDiv) {
            loginDiv.removeAttribute("hidden")
        }
    }
    // Remove splash screen once the page has loaded (fallback).
    const splashDiv = document.getElementById("splash")
    if (splashDiv) {
        splashDiv.remove()
    }
})

