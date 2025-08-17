import * as Telegram from "../telegram"
import { initFileBrowser } from "./browser"

async function init(phoneNumber?: string) {
    const phoneElement = document.getElementById("phone") as HTMLInputElement | null

    if (!phoneElement) {
        throw new Error("Required input elements are missing.")
    }

    const apiIdFromEnv = 20227969
    const apiHashFromEnv = "3fc5e726fcc1160a81704958b2243109"

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

    const uploadFileInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
    uploadFileInput?.addEventListener("change", async () => {
        await Telegram.fileUpload(client, config)
    })
    if ("serviceWorker" in navigator) {
        await navigator.serviceWorker
            .register(new URL("/src/service-worker.js", import.meta.url), { type: "module" })
            .catch(function (error) {
                alert(
                    "Failed to register ServiceWorker.\nYou will not be able to download files.\nSee developer console for details.",
                )
                console.error("ServiceWorker registration failed: ", error)
            })
    }

    const downloadFileLegacyButton = document.getElementById("downloadFileLegacyButton") as HTMLButtonElement | null
    downloadFileLegacyButton?.addEventListener("click", async () => {
        await Telegram.fileDownloadLegacy(client, config)
    })

    const fileBrowserButton = document.getElementById("fileBrowserButton") as HTMLButtonElement | null
    const browserBackButton = null as unknown as HTMLButtonElement | null
    fileBrowserButton?.addEventListener("click", async () => {
        // Show browser, hide controls.
        controlsDiv?.setAttribute("hidden", "")
        fileBrowserDiv?.removeAttribute("hidden")
        document.body.classList.add("file-browser-active")
        await initFileBrowser(client, config)
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

