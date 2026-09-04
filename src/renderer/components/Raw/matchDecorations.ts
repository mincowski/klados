/**
 * Match highlighting for the Raw View (M4-PLAN.md G5): "Highlighting in Raw
 * is viewport-bounded. `rawDecorations.ts` already builds decorations for
 * the visible window only, and D-031's whole argument is that the
 * decoration set must never be document-sized. Match highlights follow the
 * same rule — binary-search the match array for the window's range,
 * decorate that slice."
 *
 * Kept free of CodeMirror, same split as `decorations.ts`/`rawDecorations.ts`
 * — this is the pure offset math, exercised directly by tests;
 * `rawDecorations.ts` is the thin layer turning it into real decorations.
 */
import type { Offset } from '../../../core/types'

export interface MatchDecorationSpan {
  readonly start: Offset
  readonly end: Offset
  /** Distinct styling for the match navigation is currently parked on. */
  readonly current: boolean
}

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
 * Every match overlapping `[from, to)`, clipped to it — never a
 * document-sized scan. `starts`/`ends` are ascending and the same length;
 * a match's own extent can be longer than the window (impossible in
 * practice — G2's own limits bound a single match to at most one decoded
 * window), so this still clips defensively rather than assuming it.
 *
 * Finds the first match whose **end** could still be `> from` by walking
 * back from the first match starting at or after `from` — a match starting
 * before `from` can still overlap it if long enough. Bounded by how far a
 * single match can extend (small), not by document size.
 */
export function viewportMatchDecorations(
  starts: Int32Array,
  ends: Int32Array,
  currentIndex: number | null,
  from: Offset,
  to: Offset
): MatchDecorationSpan[] {
  if (starts.length === 0 || from >= to) return []

  // Start scanning from one match before the first that starts at/after
  // `from` — covers a match that started just before the window but still
  // overlaps into it. Matches are non-overlapping in the sense that starts
  // are strictly ascending, so walking back one is always sufficient: a
  // match ending inside `[from, to)` cannot have another, earlier match
  // also ending inside it without violating ascending starts + G2's own
  // bounded-match-length guarantee.
  const firstAtOrAfter = lowerBound(starts, from)
  let i = firstAtOrAfter > 0 ? firstAtOrAfter - 1 : 0

  const spans: MatchDecorationSpan[] = []
  for (; i < starts.length; i++) {
    const start = starts[i]!
    const end = ends[i]!
    if (start >= to) break
    if (end <= from) continue
    spans.push({
      start: Math.max(start, from),
      end: Math.min(end, to),
      current: i === currentIndex
    })
  }
  return spans
}
