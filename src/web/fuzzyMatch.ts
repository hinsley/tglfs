// Dependency-free fuzzy matching and ranking for the command palette. Pure: safe to import from Node tests.

export type FuzzyMatch = {
    /** Higher is better. Only comparable between matches of the same query. */
    score: number
    /** Indices into the candidate text of the matched characters, ascending and unique. */
    indices: number[]
}

const WORD_SEPARATORS = new Set([" ", "-", "_", ".", "/", "\\", "(", ")", "[", "]", ",", ":", "+", "&"])

function isWordStart(text: string, index: number) {
    if (index === 0) return true
    const previous = text[index - 1]
    if (WORD_SEPARATORS.has(previous)) return true
    const current = text[index]
    // camelCase and letter→digit boundaries
    if (previous >= "a" && previous <= "z" && current >= "A" && current <= "Z") return true
    // letter→digit and digit→letter boundaries ("report2024", "v2beta")
    const previousIsDigit = previous >= "0" && previous <= "9"
    const currentIsDigit = current >= "0" && current <= "9"
    return previousIsDigit !== currentIsDigit && ALNUM.test(previous) && ALNUM.test(current)
}

const ALNUM = /^[\p{L}\p{N}]$/u

/**
 * Scores one query token against `text` as an in-order subsequence. Prefers, in order: an exact match, a
 * prefix, a contiguous substring at a word start, any contiguous substring, and finally a scattered
 * subsequence where matches at word starts and consecutive runs earn bonuses and gaps cost points.
 */
function matchToken(token: string, text: string, lowerText: string): FuzzyMatch | null {
    if (!token) return { score: 0, indices: [] }
    if (token.length > text.length) return null

    if (lowerText === token) {
        return { score: 1000 + token.length * 10, indices: range(0, token.length) }
    }

    const substring = lowerText.indexOf(token)
    if (substring !== -1) {
        // Prefer the earliest occurrence that starts a word.
        let best = substring
        let wordStart = isWordStart(text, substring)
        if (!wordStart) {
            let next = lowerText.indexOf(token, substring + 1)
            while (next !== -1) {
                if (isWordStart(text, next)) {
                    best = next
                    wordStart = true
                    break
                }
                next = lowerText.indexOf(token, next + 1)
            }
        }
        let score = 400 + token.length * 12
        if (best === 0) score += 300
        else if (wordStart) score += 150
        score -= Math.min(best, 40) * 2
        score -= Math.min(text.length - token.length, 80) * 0.5
        return { score, indices: range(best, best + token.length) }
    }

    // Greedy forward scan, then a backward pass to tighten the match window.
    const indices: number[] = []
    let cursor = 0
    for (const char of token) {
        const found = lowerText.indexOf(char, cursor)
        if (found === -1) return null
        indices.push(found)
        cursor = found + 1
    }
    let end = indices[indices.length - 1]
    for (let i = token.length - 1; i >= 0; i--) {
        const found = lowerText.lastIndexOf(token[i], end)
        indices[i] = found
        end = found - 1
    }
    // Snap characters forward to word starts when that keeps the order valid.
    for (let i = 0; i < indices.length; i++) {
        if (isWordStart(text, indices[i])) continue
        const limit = i + 1 < indices.length ? indices[i + 1] : text.length
        for (let candidate = indices[i] + 1; candidate < limit; candidate++) {
            if (lowerText[candidate] === token[i] && isWordStart(text, candidate)) {
                indices[i] = candidate
                break
            }
        }
    }

    // Every character at a word start is an acronym ("hm" → "Home movie"): rank it just above an inner
    // substring ("rhythm") but below a substring that starts a word.
    if (indices.every((index) => isWordStart(text, index))) {
        return {
            score: 480 + token.length * 12 - Math.min(indices[0], 40) * 2 - Math.min(text.length - token.length, 80) * 0.5,
            indices,
        }
    }

    let score = 0
    for (let i = 0; i < indices.length; i++) {
        const index = indices[i]
        score += 10
        if (isWordStart(text, index)) score += 24
        if (i > 0) {
            const gap = index - indices[i - 1] - 1
            if (gap === 0) score += 16
            else score -= Math.min(gap, 12) * 2
        }
    }
    if (indices[0] === 0) score += 30
    score -= Math.min(indices[0], 30)
    score -= Math.min(text.length - token.length, 80) * 0.3
    return { score, indices }
}

function range(start: number, end: number) {
    const out: number[] = []
    for (let i = start; i < end; i++) out.push(i)
    return out
}

export function tokenizeQuery(query: string) {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Matches every whitespace-separated token of `query` against `text` (any order). Returns null when any
 * token fails. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
    const tokens = tokenizeQuery(query)
    if (tokens.length === 0) return { score: 0, indices: [] }
    const lowerText = text.toLowerCase()
    let score = 0
    const indices = new Set<number>()
    for (const token of tokens) {
        const match = matchToken(token, text, lowerText)
        if (!match) return null
        score += match.score
        for (const index of match.indices) indices.add(index)
    }
    return { score, indices: [...indices].sort((a, b) => a - b) }
}

export type RankedItem<T> = { item: T; match: FuzzyMatch; text: string }

/**
 * Ranks `items` by their best match over the texts returned by `textsOf` (e.g. a label plus keywords). The
 * first text is the display label: indices are only reported when the label itself matched. Ties keep the
 * input order, so callers can pre-sort by recency or importance.
 */
export function rankFuzzy<T>(
    query: string,
    items: readonly T[],
    textsOf: (item: T) => string | readonly string[],
    options: { limit?: number; minScore?: number } = {},
): Array<RankedItem<T>> {
    const ranked: Array<RankedItem<T> & { order: number }> = []
    for (const [order, item] of items.entries()) {
        const texts = textsOf(item)
        const list: readonly string[] = typeof texts === "string" ? [texts] : texts
        let best: FuzzyMatch | null = null
        for (const [index, text] of list.entries()) {
            if (!text) continue
            const match = fuzzyMatch(query, text)
            if (!match) continue
            // Keywords are a fallback: they rank below an equally good label match.
            const score = index === 0 ? match.score : match.score - 60
            if (!best || score > best.score) {
                best = { score, indices: index === 0 ? match.indices : [] }
            }
        }
        if (!best) continue
        if (options.minScore !== undefined && best.score < options.minScore) continue
        ranked.push({ item, match: best, text: list[0] ?? "", order })
    }
    ranked.sort((a, b) => b.match.score - a.match.score || a.order - b.order)
    const limited = options.limit !== undefined ? ranked.slice(0, options.limit) : ranked
    return limited.map(({ item, match, text }) => ({ item, match, text }))
}

/** Splits `text` into plain/highlighted segments for rendering matched characters. */
export function highlightSegments(text: string, indices: readonly number[]): Array<{ text: string; match: boolean }> {
    if (indices.length === 0) return text ? [{ text, match: false }] : []
    const marked = new Set(indices)
    const segments: Array<{ text: string; match: boolean }> = []
    for (let i = 0; i < text.length; i++) {
        const match = marked.has(i)
        const last = segments[segments.length - 1]
        if (last && last.match === match) {
            last.text += text[i]
        } else {
            segments.push({ text: text[i], match })
        }
    }
    return segments
}
