// Pure helpers behind the file browser's undo support. No DOM access, so Node tests can import this module.

export type MutationQueue = {
    /** Runs `task` after every previously queued task has settled. Never nest calls (that would deadlock). */
    run: <T>(task: () => Promise<T>) => Promise<T>
    /** Number of tasks currently executing (0 or 1). */
    inFlight: () => number
}

export function createMutationQueue(): MutationQueue {
    let chain: Promise<unknown> = Promise.resolve()
    let running = 0
    return {
        run<T>(task: () => Promise<T>): Promise<T> {
            const result = chain.then(async () => {
                running++
                try {
                    return await task()
                } finally {
                    running--
                }
            })
            chain = result.catch(() => undefined)
            return result
        },
        inFlight: () => running,
    }
}

export type UndoCandidateState = {
    /** Parent folder id as currently stored (root normalized to the root parent id), or null when not found. */
    parentId: string | null
    name: string | null
}

export type UndoCandidateExpectation = {
    /** Where the operation put the item. */
    expectedParentId: string
    /** The name the operation left the item with. */
    expectedName: string
    /** Where the item was before the operation (the undo target). */
    originParentId: string
}

/**
 * Decides whether an item may be reverted by an undo:
 * - "revert": it is exactly as the operation left it;
 * - "unchanged": it is already back at the origin with the expected name (e.g. it never moved because of a
 *   name conflict), so nothing needs to happen;
 * - "changed": it was deleted, moved, or renamed since — leave it alone so a newer change is never overwritten.
 */
export function classifyUndoCandidate(current: UndoCandidateState, expectation: UndoCandidateExpectation) {
    if (current.parentId === null || current.name === null) return "changed" as const
    if (current.name !== expectation.expectedName) return "changed" as const
    if (current.parentId === expectation.expectedParentId) return "revert" as const
    if (current.parentId === expectation.originParentId) return "unchanged" as const
    return "changed" as const
}
