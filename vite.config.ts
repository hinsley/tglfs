import { defineConfig } from "vite"
import { resolve } from "path"

const fsShim = resolve(__dirname, "src/shims/fs.ts")
const netShim = resolve(__dirname, "src/shims/net.ts")
const vmShim = resolve(__dirname, "src/shims/vm.ts")

export default defineConfig({
    root: "src",
    publicDir: "../public",
    build: {
        outDir: "../dist",
        emptyOutDir: true,
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            input: {
                main: resolve(__dirname, "src/index.html"),
                offline: resolve(__dirname, "src/offline.html"),
            },
        },
    },
    resolve: {
        alias: {
            assert: "assert",
            buffer: "buffer",
            constants: "constants-browserify",
            crypto: "crypto-browserify",
            events: "events",
            fs: fsShim,
            net: netShim,
            os: "os-browserify",
            path: "path-browserify",
            process: "process/browser",
            stream: "stream-browserify",
            string_decoder: "string_decoder",
            util: "util",
            vm: vmShim,
        },
    },
    define: {
        global: "globalThis",
    },
    optimizeDeps: {
        esbuildOptions: {
            define: {
                global: "globalThis",
            },
        },
    },
})
