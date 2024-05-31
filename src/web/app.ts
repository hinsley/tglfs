import { Api, TelegramClient } from "telegram";

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
        await Telegram.fileUpload(client, config);
    });
    const fileLookupButton = document.getElementById("fileLookupButton") as HTMLButtonElement;
    fileLookupButton.addEventListener("click", async () => {
        console.log("TODO: Implement file lookup.");
    });
    const sendFileButton = document.getElementById("sendFileButton") as HTMLButtonElement;
    sendFileButton.addEventListener("click", async () => {
        console.log("TODO: Implement file sending.");
        // TODO: Remove the following.
        // const message = await client.sendMessage("me", { message: "Hello, world!" });
        // (window as any).lastMessage = message;
        // console.log("Exposed message as lastMessage.");
        // console.log("ID is", message.id);
        const messages = await client.invoke(new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: 36100 })] }));
        if ('messages' in messages) {
            console.log("Messages:", messages.messages[0]);
        } else {
            console.log("No messages found or messages not modified.");
        }
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
    const clearCacheButton = document.getElementById("clearCacheButton") as HTMLButtonElement;
    clearCacheButton.addEventListener("click", async () => {
        async function deleteAllFiles(directoryHandle: FileSystemDirectoryHandle) {
            for await (const [name, handle] of directoryHandle.entries()) {
                if (handle.kind === 'file') {
                    await directoryHandle.removeEntry(name);
                    console.log(`Deleted file: ${name}`);
                }
            }
        }

        (async () => {
            const dirHandle = await navigator.storage.getDirectory();
            await deleteAllFiles(dirHandle);
        })();

        alert("Local cache cleared.");
    });
}

const loginButton = document.getElementById("loginButton") as HTMLButtonElement;
loginButton.addEventListener("click", init);