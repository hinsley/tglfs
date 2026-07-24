import { basename } from "node:path"
import process from "node:process"

function isDirectCliInvocation() {
    const entryName = process.argv[1] ? basename(process.argv[1]).toLowerCase() : ""
    return entryName === "cli.js" || entryName === "cli.ts" || entryName === "tglfs"
}

async function runMakePreviewable(args: string[]) {
    const { runMakePreviewableCli } = await import("./make-previewable-cli.js")
    await runMakePreviewableCli(args)
    process.exit(process.exitCode ?? 0)
}

if (isDirectCliInvocation()) {
    const args = process.argv.slice(2)
    const commandIndex = args.indexOf("make-previewable")
    if (commandIndex >= 0) {
        const globalPrefix = args.slice(0, commandIndex)
        if (globalPrefix.every((arg) => arg === "--no-interactive")) {
            await runMakePreviewable([...globalPrefix, ...args.slice(commandIndex + 1)])
        }
    }

    const helpIndex = args.indexOf("help")
    if (
        helpIndex >= 0 &&
        args[helpIndex + 1] === "make-previewable" &&
        args.slice(0, helpIndex).every((arg) => arg === "--no-interactive")
    ) {
        await runMakePreviewable(["--help"])
    }
}
