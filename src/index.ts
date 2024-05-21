import * as cfg from "./config";
import * as tg from "./telegram";

async function main() {
    const config = await cfg.loadConfig()
    console.log(config)
    await tg.init(config)
}

main()
