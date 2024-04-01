import { TelegramClient } from "telegram"
import { StoreSession, StringSession } from "telegram/sessions"
import input from "input"
import fs from "fs/promises"

import * as cfg from "./config"

export async function init(config: cfg.Config): Promise<TelegramClient> {
    console.log("Starting up...")
    // Load previous session from a session string.
    const storeSession = new StoreSession("./tglfs.session")
    // Connect.
    const client = new TelegramClient(storeSession, config.apiId, config.apiHash, { connectionRetries: 5 })
    // Provide credentials to the server.
    await client.start({
        phoneNumber: config.phone,
        password: async () => await input.password("Enter your password: "),
        phoneCode: async () => await input.text("Enter the code you received: "),
        onError: (error) => console.error(error),
    })
    console.log("You are now logged in!")
    return client
}
