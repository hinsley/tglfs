import { Buffer } from "buffer"
import process from "process"

type GlobalWithPolyfills = typeof globalThis & {
    Buffer?: typeof Buffer
    process?: typeof process
    global?: typeof globalThis
}

const globalRef = globalThis as GlobalWithPolyfills

if (!globalRef.Buffer) {
    globalRef.Buffer = Buffer
}

if (!globalRef.process) {
    globalRef.process = process
}

if (!globalRef.global) {
    globalRef.global = globalRef
}
