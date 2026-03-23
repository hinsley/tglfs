import process from "node:process"

export type ProgressStream = {
    isTTY?: boolean
    columns?: number
    write(chunk: string): boolean
}

function formatBytes(bytes: number) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    let value = Math.max(0, bytes)
    let unitIndex = 0

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024
        unitIndex += 1
    }

    const formatted = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)
    return `${formatted} ${units[unitIndex]}`
}

export function renderProgressLine(label: string, bytesWritten: number, totalBytes: number, width = 24) {
    const safeTotal = Math.max(totalBytes, 1)
    const ratio = Math.min(Math.max(bytesWritten / safeTotal, 0), 1)
    const filled = Math.round(ratio * width)
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`
    const percent = Math.round(ratio * 100)
    return `${label} [${bar}] ${percent}% ${formatBytes(bytesWritten)} / ${formatBytes(totalBytes)}`
}

export function createByteProgressReporter(options: {
    label: string
    totalBytes: number
    stream?: ProgressStream
    enabled?: boolean
}) {
    const stream = options.stream ?? process.stderr
    const enabled = options.enabled ?? Boolean(stream.isTTY)
    const minDelta = Math.max(64 * 1024, Math.floor(options.totalBytes / 100))
    let lastRenderedBytes = -1
    let hasRendered = false

    const render = (bytesWritten: number) => {
        if (!enabled) {
            return
        }

        const boundedBytes = Math.min(Math.max(bytesWritten, 0), options.totalBytes)
        if (
            lastRenderedBytes >= 0 &&
            boundedBytes !== options.totalBytes &&
            boundedBytes - lastRenderedBytes < minDelta
        ) {
            return
        }

        const columns = typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : 80
        const line = renderProgressLine(options.label, boundedBytes, options.totalBytes).slice(0, Math.max(columns - 1, 20))
        stream.write(`\r${line}`)
        lastRenderedBytes = boundedBytes
        hasRendered = true
    }

    return {
        update(bytesWritten: number) {
            render(bytesWritten)
        },
        complete() {
            if (lastRenderedBytes !== options.totalBytes) {
                render(options.totalBytes)
            }
            if (enabled && hasRendered) {
                stream.write("\n")
            }
        },
        abort() {
            if (enabled && hasRendered) {
                stream.write("\n")
            }
        },
    }
}
