import { TelegramClient } from "telegram";

import * as Config from "../config";
import * as FileProcessing from "./fileProcessing";
import * as Telegram from "../telegram";

async function main(client: TelegramClient, config: Config.Config) {
    while (true) {
        try {
            console.log("Enter a command:");
            console.log("1. Upload a file");
            console.log("2. Search for a file");
            console.log("3. Send a file");
            console.log("4. Unsend a file");
            console.log("5. Receive a file");
            console.log("6. Rename a file");
            console.log("7. Delete a file");
            console.log("8. Download a file");

            const command = prompt("Choose an action (1-9).");

            switch (command) {
                case "1":
                    console.log("TODO: Implement file uploads.");
                    await Telegram.fileUpload(client, config);
                    break;
                case "2":
                    console.log("TODO: Implement file lookup.");
                    break;
                case "3":
                    console.log("TODO: Implement file sending.");
                    break;
                case "4":
                    console.log("TODO: Implement file unsending.");
                    break;
                case "5":
                    console.log("TODO: Implement file receipt.");
                    break;
                case "6":
                    console.log("TODO: Implement file renaming.");
                    break;
                case "7":
                    console.log("TODO: Implement file deletion.");
                    break;
                case "8":
                    console.log("TODO: Implement file downloading.");
                    break;
                default:
                    console.log("Invalid option. Please try again.");
            }
        } catch (error) {
            console.error("An error occurred:", error);
        }
    }
}

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

    const loginDiv = document.getElementById("login");
    if (loginDiv) {
        loginDiv.remove();
    }

    const client = await Telegram.init(config);

    // Expose the client object to the browser console
    (window as any).client = client;

    await main(client, config);
}

const loginButton = document.getElementById("loginButton") as HTMLButtonElement;
loginButton.addEventListener("click", init);