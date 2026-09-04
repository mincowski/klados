/**
 * Whether a byte range contains a match — the primitive G5's Tree/grid
 * marking and G6's filter-to-matches both need. M4-PLAN.md G6: "A node's
 * subtree contains a match iff the sorted match array has an entry in
 * `[spanStart, spanEnd)` — two binary searches per visible row." Operates
 * on match **start** offsets only (what `SearchResult.starts` already is,
 * ascending) — a match's own length never matters for "does this subtree
 * contain one," only where it begins.
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

/** `true` iff some match starts in `[start, end)` — O(log n). */
export function hasMatchInRange(starts: Int32Array, start: number, end: number): boolean {
  if (starts.length === 0 || start >= end) return false
  const idx = lowerBound(starts, start)
  return idx < starts.length && starts[idx]! < end
}

/** Count of matches starting in `[start, end)` — O(log n), two searches. */
export function countMatchesInRange(starts: Int32Array, start: number, end: number): number {
  if (starts.length === 0 || start >= end) return 0
  const lo = lowerBound(starts, start)
  const hi = lowerBound(starts, end)
  return hi - lo
}
