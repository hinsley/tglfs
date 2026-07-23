export type TimeRangesLike = {
    length: number
    start(index: number): number
    end(index: number): number
}

export const MP4_BUFFER_AHEAD_HIGH_WATER_SECONDS = 24
export const MP4_BUFFER_AHEAD_LOW_WATER_SECONDS = 12
export const MP4_BUFFER_AHEAD_MINIMUM_SECONDS = 4
export const MP4_BUFFER_TARGET_BYTES = 48 * 1024 * 1024
export const MP4_BUFFER_BEHIND_SECONDS = 30
export const MP4_QUOTA_BUFFER_BEHIND_SECONDS = 2
export const MP4_MIN_EVICTION_SECONDS = 5

export type Mp4BufferLimits = {
    highWaterSeconds: number
    lowWaterSeconds: number
}

export type Mp4EvictionRange = {
    start: number
    end: number
}

export function getFurthestBufferedEnd(ranges: TimeRangesLike): number {
    let furthestEnd = 0
    for (let index = 0; index < ranges.length; index++) {
        furthestEnd = Math.max(furthestEnd, ranges.end(index))
    }
    return furthestEnd
}

export function getBufferedAheadSeconds(ranges: TimeRangesLike, currentTime: number): number {
    return Math.max(0, getFurthestBufferedEnd(ranges) - currentTime)
}

export function getMp4BufferLimits(totalAppendedBytes: number, furthestBufferedEnd: number): Mp4BufferLimits {
    if (!(totalAppendedBytes > 0) || !(furthestBufferedEnd > 0)) {
        return {
            highWaterSeconds: MP4_BUFFER_AHEAD_HIGH_WATER_SECONDS,
            lowWaterSeconds: MP4_BUFFER_AHEAD_LOW_WATER_SECONDS,
        }
    }

    const averageBytesPerSecond = totalAppendedBytes / furthestBufferedEnd
    const byteLimitedHighWater = MP4_BUFFER_TARGET_BYTES / averageBytesPerSecond
    const highWaterSeconds = Math.max(
        MP4_BUFFER_AHEAD_MINIMUM_SECONDS,
        Math.min(MP4_BUFFER_AHEAD_HIGH_WATER_SECONDS, byteLimitedHighWater),
    )
    return {
        highWaterSeconds,
        lowWaterSeconds: Math.max(2, highWaterSeconds / 2),
    }
}

export function getMp4EvictionRange(
    ranges: TimeRangesLike,
    currentTime: number,
    keepBehindSeconds = MP4_BUFFER_BEHIND_SECONDS,
    minimumSeconds = MP4_MIN_EVICTION_SECONDS,
): Mp4EvictionRange | null {
    const cutoff = currentTime - keepBehindSeconds
    if (!(cutoff > 0)) return null

    let start = Number.POSITIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY
    for (let index = 0; index < ranges.length; index++) {
        const rangeStart = ranges.start(index)
        if (rangeStart >= cutoff) break
        const rangeEnd = Math.min(ranges.end(index), cutoff)
        if (rangeEnd <= rangeStart) continue
        start = Math.min(start, rangeStart)
        end = Math.max(end, rangeEnd)
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < minimumSeconds) return null
    return { start, end }
}
