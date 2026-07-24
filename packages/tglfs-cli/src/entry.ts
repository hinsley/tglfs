#!/usr/bin/env node
import process from "node:process"
import { runEntrypoint } from "./cli.js"
import { MAKE_PREVIEWABLE_COMMAND_SUMMARY, runMakePreviewableCli } from "./make-previewable-cli.js"

const args = process.argv.slice(2)
const rootHelp = args.length === 1 && ["--help", "-h", "help"].includes(args[0])
const makePreviewableIndex = args.indexOf("make-previewable")
const makePreviewablePrefix = makePreviewableIndex >= 0 ? args.slice(0, makePreviewableIndex) : []
const supportedGlobalPrefix = makePreviewablePrefix.every((arg) => arg === "--no-interactive")
const helpIndex = args.indexOf("help")

if (makePreviewableIndex >= 0 && supportedGlobalPrefix) {
    await runMakePreviewableCli([
        ...makePreviewablePrefix,
        ...args.slice(makePreviewableIndex + 1),
    ])
} else if (
    helpIndex >= 0 &&
    args[helpIndex + 1] === "make-previewable" &&
    args.slice(0, helpIndex).every((arg) => arg === "--no-interactive")
) {
    await runMakePreviewableCli(["--help"])
} else {
    if (rootHelp) process.stdout.write(`Additional command:\n${MAKE_PREVIEWABLE_COMMAND_SUMMARY}\n\n`)
    await runEntrypoint(process.argv)
}
