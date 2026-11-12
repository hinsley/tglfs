/** Reject stale staged edits rather than overwrite a preceding operation's result. */
export function assertQueuedRevision(expected: string, current: unknown): void {
    if (current == null || JSON.stringify(current) !== expected) {
        throw new Error("Item changed since it was queued. Refresh and try again.")
    }
}
