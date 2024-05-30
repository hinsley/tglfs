import { TelegramClient } from "telegram";

import * as Config from "../config";
import * as FileProcessing from "./fileProcessing";
import * as Telegram from "../telegram";

async function init() {
    const apiIdElement = document.getElementById("apiId") as HTMLInputElement | null;
    const apiHashElement = document.getElementById("apiHash") as HTMLInputElement | null;
    const telegramPremiumElement = document.getElementById("telegramPremium") as HTMLInputElement | null;
    const phoneElement = document.getElementById("phone") as HTMLInputElement | null;

    if (!apiIdElement || !apiHashElement || !telegramPremiumElement || !phoneElement) {
        throw new Error("Required input elements are missing.");
    }

    if (apiIdElement.value.trim() === "" || apiHashElement.value.trim() === "" || phoneElement.value.trim() === "") {
        throw new Error("Input fields cannot be empty.");
    }

    const config = {
        apiId: Number(apiIdElement.value),
        apiHash: apiHashElement.value,
        chunkSize: 1024**3 * (telegramPremiumElement.checked ? 4 : 2),
        phone: phoneElement.value,
    };

    const client = await Telegram.init(config);

    // Expose the client and config objects to the browser console
    (window as any).client = client;
    (window as any).config = config;

    // Set up UI
    const loginDiv = document.getElementById("login");
    if (loginDiv) {
        loginDiv.remove();
    }
    const controlsDiv = document.getElementById("controls");
    if (controlsDiv) {
        controlsDiv.removeAttribute("hidden");
    }
    const uploadFileButton = document.getElementById("uploadFileButton") as HTMLButtonElement;
    uploadFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file uploads.");
        await Telegram.fileUpload(client, config);
    });
    const fileLookupButton = document.getElementById("fileLookupButton") as HTMLButtonElement;
    fileLookupButton.addEventListener("click", async () => {
        console.log("TODO: Implement file lookup.");
    });
    const sendFileButton = document.getElementById("sendFileButton") as HTMLButtonElement;
    sendFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file sending.");
    });
    const unsendFileButton = document.getElementById("unsendFileButton") as HTMLButtonElement;
    unsendFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file unsending.");
    });
    const receiveFileButton = document.getElementById("receiveFileButton") as HTMLButtonElement;
    receiveFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file receiving.");
    });
    const renameFileButton = document.getElementById("renameFileButton") as HTMLButtonElement;
    renameFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file renaming.");
    });
    const deleteFileButton = document.getElementById("deleteFileButton") as HTMLButtonElement;
    deleteFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file deletion.");
    });
    const downloadFileButton = document.getElementById("downloadFileButton") as HTMLButtonElement;
    downloadFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file downloading.");
    });
}

const loginButton = document.getElementById("loginButton") as HTMLButtonElement;
loginButton.addEventListener("click", init);