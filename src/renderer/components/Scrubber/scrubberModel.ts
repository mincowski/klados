/**
 * Pure logic for the scrubber (M1-PLAN.md D13, CONCEPT.md §4.5). A
 * scrubber, not a scrollbar: position is a ratio resolved through the row
 * index (`y → row → byte offset`), so it never asks the editor how tall
 * the document is — which is what keeps a 500 MB file off Chromium's
 * ~33.5M px maximum element height.
 */
import { rowAt } from '../../../core/rowIndex'
import { Severity, type Diagnostic, type Offset } from '../../../core/types'
import { countMatchesInRange } from '../../navigation/matchSpanLookup'

/** 0 for an empty/single-row document — there's nowhere else for it to
 * go, and `rowIndex.length - 1` would otherwise divide by zero. */
export function offsetToRatio(rowIndex: Int32Array, offset: Offset): number {
  if (rowIndex.length <= 1) return 0
  const row = rowAt(rowIndex, offset)
  return row / (rowIndex.length - 1)
}

/** Inverse of `offsetToRatio` — clamps `ratio` into `[0, 1]` first, so a
 * drag gesture that overshoots the strip (pointer capture makes this easy)
 * still resolves to a valid in-document offset rather than reading past
 * `rowIndex`. */
export function ratioToOffset(rowIndex: Int32Array, ratio: number): Offset {
  if (rowIndex.length === 0) return 0
  const clamped = Math.max(0, Math.min(1, ratio))
  const row = Math.round(clamped * (rowIndex.length - 1))
  return rowIndex[Math.max(0, Math.min(rowIndex.length - 1, row))]!
}

export type MarkerKind = 'selected' | 'warning' | 'error' | 'fatal' | 'match'

export interface ScrubberMarker {
  readonly ratio: number
  readonly kind: MarkerKind
  /** 0–1, how "full" this marker's bucket is relative to the densest one —
   * `matchMarkers`' own way of saying "a lot of matches landed on top of
   * each other here." `undefined` for every other marker kind, which are
   * never bucketed and always render at full opacity. */
  readonly density?: number
}

function severityKind(severity: Severity): MarkerKind {
  switch (severity) {
    case Severity.Fatal:
      return 'fatal'
    case Severity.Error:
      return 'error'
    default:
      return 'warning'
  }
}

/**
 * One marker per diagnostic. Not deduplicated by position — a document
 * with many diagnostics clustered at one offset is meaningful information
 * (and rare enough, per §11.1's partial-tree model, not to warrant the
 * complexity of merging).
 *
 * Kept as its own function, taking only `rowIndex` and a diagnostics list,
 * so a later marker source (M4 search hits, per §4.5's own note that the
 * marker layer should "take another source without redesign") is just
 * another array fed through the same shape, not a change to this one.
 */
export function diagnosticMarkers(
  rowIndex: Int32Array,
  diagnostics: readonly Diagnostic[]
): ScrubberMarker[] {
  return diagnostics.map((d) => ({
    ratio: offsetToRatio(rowIndex, d.offset),
    kind: severityKind(d.severity)
  }))
}

/** Default bucket count for `matchMarkers` — a fixed resolution rather than
 * one derived from the strip's actual pixel height (which this pure module
 * has no access to, by design — see this file's own top comment on why
 * position never depends on rendered geometry). 256 is finer than any
 * screen's practical strip height and still cheap: `~256 × 2` binary
 * searches over `starts`, not a scan of however many million matches
 * there are. */
export const DEFAULT_MATCH_BUCKET_COUNT = 256

/**
 * One marker per non-empty bucket of the document, ratio-bucketed rather
 * than one marker per match (UI-FEEDBACK.md M5b: "1.2 M matches on a
 * 200 MB document is 1.2 M DOM nodes, and the strip can only resolve a few
 * hundred positions anyway"). `density` is the bucket's own match count
 * relative to the densest bucket found, `matchNavigation.ts`'s
 * `countMatchesInRange` run twice per bucket (via `rowIndex`'s own
 * `rowAt`/row-to-offset mapping through `ratioToOffset`) rather than a scan
 * — cheap even at a search result in the millions, since `starts` is
 * already ascending.
 */
export function matchMarkers(
  rowIndex: Int32Array,
  starts: Int32Array,
  bucketCount: number = DEFAULT_MATCH_BUCKET_COUNT
): ScrubberMarker[] {
  if (starts.length === 0 || bucketCount <= 0) return []

  const counts = new Array<number>(bucketCount)
  let maxCount = 0
  for (let i = 0; i < bucketCount; i++) {
    const start = ratioToOffset(rowIndex, i / bucketCount)
    // The last bucket's own upper edge is `ratioToOffset(rowIndex, 1)` —
    // the *start* of the document's last row, not its true byte end (the
    // row index has no entry past the final row start) — so a match
    // beginning anywhere in that last row would fall just outside a
    // `[start, end)` range built from it. Unbounded above only for the
    // last bucket avoids underselling the document's own tail.
    const end =
      i === bucketCount - 1
        ? Number.MAX_SAFE_INTEGER
        : ratioToOffset(rowIndex, (i + 1) / bucketCount)
    const count = countMatchesInRange(starts, start, end)
    counts[i] = count
    if (count > maxCount) maxCount = count
  }
  if (maxCount === 0) return []

  const markers: ScrubberMarker[] = []
  for (let i = 0; i < bucketCount; i++) {
    const count = counts[i]!
    if (count === 0) continue
    markers.push({ ratio: i / bucketCount, kind: 'match', density: count / maxCount })
  }
  return markers
}
