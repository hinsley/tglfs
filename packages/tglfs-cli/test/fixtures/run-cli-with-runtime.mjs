import { pathToFileURL } from "node:url"

const runtimeModulePath = process.argv[2]
const cliArgs = process.argv.slice(3)

if (!runtimeModulePath) {
    throw new Error("A runtime fixture module path is required.")
}

await import(pathToFileURL(runtimeModulePath).href)

const { runEntrypoint } = await import("../../src/cli.ts")

await runEntrypoint(["node", "tglfs", ...cliArgs])
