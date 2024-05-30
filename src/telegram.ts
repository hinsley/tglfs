/**
 * Telegram client methods. 
 * @module Telegram
 */

import { TelegramClient } from "telegram";
import { StoreSession, StringSession } from "telegram/sessions";

import * as Config from "./config";
import * as FileProcessing from "./web/fileProcessing";


export async function fileUpload(client: TelegramClient, config: Config.Config) {
    try {
        const [fileHandle] = await (window as any).showOpenFilePicker(); // Types are broken for this.
        const file = await fileHandle.getFile();
        console.log(`Selected file: ${file.name}`);

        const password = prompt("(Optional) Encryption password:");
        const [salt, initialCounter] = await FileProcessing.prepFile(file, password ? password : "", config.chunkSize, config.chunkSize);
        console.log("Salt:", salt);
        console.log("Initial AES-CTR counter:", initialCounter);
    } catch (error) {
        console.error(
            "An error occurred during file upload:",
            (error as Error).name,
            (error as Error).message,
            error
        );
    }
}

export async function init(config: Config.Config): Promise<TelegramClient> {
    console.log("Starting up...");
    // Load previous session from a session string.
    const storeSession = new StoreSession("./tglfs.session");
    // Connect.
    const client = new TelegramClient(storeSession, config.apiId, config.apiHash, { connectionRetries: 5 });
    // Provide credentials to the server.
    await client.start({
        phoneNumber: config.phone,
        password: async () => {
            const pwd = prompt("Enter your password: ");
            if (!pwd) {
                throw new Error("No password provided.");
            }
            return pwd;
        },
        phoneCode: async () => {
            const code = prompt("Enter the code you received: ");
            if (!code) {
                throw new Error("No code provided.");
            }
            return code;
        },
        onError: (error) => console.error(error),
    });
    console.log("You are now logged in!");
    return client;
}