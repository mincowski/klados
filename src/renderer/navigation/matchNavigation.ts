/**
 * Next/previous match navigation (M4-PLAN.md G5): "Next/previous move the
 * selection and the Raw window. Both are absolute-offset operations, so
 * both are independent of where the window happens to be" (§4.4). Pure
 * binary search over ascending match-start offsets — no notion of "current
 * index" is trusted across a re-search, since a fresh search can renumber
 * or drop matches; navigation always resolves fresh from an offset instead.
 */

function lowerBound(starts: Int32Array, value: number): number {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The match index at or immediately after `fromOffset`, wrapping to the
 * first match if none qualifies — `null` only when there are no matches at
 * all. `fromOffset` is typically the current caret position (or a match's
 * own start, when moving on from the current match — see `nextMatchIndex`).
 */
export function matchIndexAtOrAfter(starts: Int32Array, fromOffset: number): number | null {
  if (starts.length === 0) return null
  const idx = lowerBound(starts, fromOffset)
  return idx < starts.length ? idx : 0
}

/** The match index immediately before `fromOffset`, wrapping to the last
 * match if none qualifies — `null` only when there are no matches. */
export function matchIndexBefore(starts: Int32Array, fromOffset: number): number | null {
  if (starts.length === 0) return null
  const idx = lowerBound(starts, fromOffset)
  return idx > 0 ? idx - 1 : starts.length - 1
}

/**
 * Advances from `currentIndex` (the currently-highlighted match, or `null`
 * if none is current yet) to the next match, wrapping past the end.
 * `null` current index behaves like "search just started" — the first
 * match at or after `caretOffset`.
 */
export function nextMatchIndex(
  starts: Int32Array,
  currentIndex: number | null,
  caretOffset: number
): number | null {
  if (starts.length === 0) return null
  if (currentIndex === null) return matchIndexAtOrAfter(starts, caretOffset)
  return (currentIndex + 1) % starts.length
}

/** The mirror of `nextMatchIndex` — wraps to the last match past the start. */
export function previousMatchIndex(
  starts: Int32Array,
  currentIndex: number | null,
  caretOffset: number
): number | null {
  if (starts.length === 0) return null
  if (currentIndex === null) return matchIndexBefore(starts, caretOffset)
  return (currentIndex - 1 + starts.length) % starts.length
}
