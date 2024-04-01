import  { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import * as input from "input";

import * as cfg from "./config";

export async function init(config: cfg.Config) {
    console.log("Starting up...")
    const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, {
        connectionRetries: 5
    });
    await client.start({
        phoneNumber: config.phone,
        password: async () => await input.password("Enter your password: "),
        phoneCode: async () => await input.text("Enter the code you received: "),
        onError: (error) => console.error(error),
    });
    console.log("You are now logged in!");
    console.log(client.session.save());
    await client.sendMessage("me", {message: "Welcome to TypeScript."});
    console.log("Message sent.");
}


