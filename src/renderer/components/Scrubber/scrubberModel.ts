/**
 * Pure logic for the scrubber (M1-PLAN.md D13, CONCEPT.md §4.5). A
 * scrubber, not a scrollbar: position is a ratio resolved through the row
 * index (`y → row → byte offset`), so it never asks the editor how tall
 * the document is — which is what keeps a 500 MB file off Chromium's
 * ~33.5M px maximum element height.
 */
import type { DiagnosticIndexBuffers } from '../../../core/diagnosticIndex'
import { rowAt } from '../../../core/rowIndex'
import { type Offset } from '../../../core/types'
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

/** Default bucket count for both marker sources — a fixed resolution rather
 * than one derived from the strip's actual pixel height (which this pure
 * module has no access to, by design — see this file's own top comment on why
 * position never depends on rendered geometry). 256 is finer than any
 * screen's practical strip height and still cheap: `~256 × 2` binary
 * searches over an ascending array, not a scan of however many million
 * entries there are. Named for matches because that is what it was introduced
 * for; R200 gave diagnostics the same treatment and the name is kept rather
 * than churned through every caller and test. */
export const DEFAULT_MATCH_BUCKET_COUNT = 256

/**
 * How many of `starts` fall in each of `bucketCount` equal slices of the
 * document, resolved through the row index the same way a drag on the strip
 * is. `starts` must be ascending — `countMatchesInRange` binary-searches it
 * rather than scanning, which is what keeps this cheap at a million entries.
 *
 * Shared by both marker sources since R200 gave diagnostics the same
 * treatment search hits have had since M5b: the strip is a few hundred pixels
 * tall, so the number of markers it can usefully draw is a property of the
 * strip, not of the document.
 */
function bucketCounts(rowIndex: Int32Array, starts: Int32Array, bucketCount: number): number[] {
  const counts = new Array<number>(bucketCount).fill(0)
  if (starts.length === 0) return counts
  for (let i = 0; i < bucketCount; i++) {
    const start = ratioToOffset(rowIndex, i / bucketCount)
    // The last bucket's own upper edge is `ratioToOffset(rowIndex, 1)` —
    // the *start* of the document's last row, not its true byte end (the
    // row index has no entry past the final row start) — so an entry
    // beginning anywhere in that last row would fall just outside a
    // `[start, end)` range built from it. Unbounded above only for the
    // last bucket avoids underselling the document's own tail.
    const end =
      i === bucketCount - 1
        ? Number.MAX_SAFE_INTEGER
        : ratioToOffset(rowIndex, (i + 1) / bucketCount)
    counts[i] = countMatchesInRange(starts, start, end)
  }
  return counts
}

/**
 * One marker per non-empty bucket, drawn from the *uncapped* position index
 * rather than from the capped diagnostic records (R200 §5).
 *
 * This used to be one marker per diagnostic, on the reasoning — inherited
 * from CONCEPT.md §11.1's "parse to the point of failure" — that diagnostics
 * were rare. No parser implements that: every format emits a recoverable
 * error per item and keeps going, so a defect that repeats per row or per
 * element produced one `<div>` per occurrence in a strip a few hundred pixels
 * tall. Bucketing discards nothing the display could have shown.
 *
 * Drawing it from the *capped* list instead would have been worse than
 * either: parsers walk forward, so the retained records are very nearly the
 * document's first N by offset, and the strip would have reported a clean
 * document below the cap.
 *
 * A bucket holding more than one severity is drawn at its most severe — a
 * fatal must not be hidden behind a warning that happens to share its slice.
 */
export function diagnosticMarkers(
  rowIndex: Int32Array,
  positions: DiagnosticIndexBuffers,
  bucketCount: number = DEFAULT_MATCH_BUCKET_COUNT
): ScrubberMarker[] {
  if (bucketCount <= 0) return []
  const warning = bucketCounts(rowIndex, positions.warning, bucketCount)
  const error = bucketCounts(rowIndex, positions.error, bucketCount)
  const fatal = bucketCounts(rowIndex, positions.fatal, bucketCount)

  const markers: ScrubberMarker[] = []
  for (let i = 0; i < bucketCount; i++) {
    const kind: MarkerKind | null =
      fatal[i]! > 0 ? 'fatal' : error[i]! > 0 ? 'error' : warning[i]! > 0 ? 'warning' : null
    if (kind === null) continue
    // No `density`: whether a diagnostic marker should fade with bucket
    // occupancy the way a match marker does is a question about how the strip
    // reads, not one this module can settle — R200 §7 leaves it open and
    // deliberately records no preference. Solid is what shipped before.
    markers.push({ ratio: i / bucketCount, kind })
  }
  return markers
}

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

  const counts = bucketCounts(rowIndex, starts, bucketCount)
  let maxCount = 0
  for (const count of counts) if (count > maxCount) maxCount = count
  if (maxCount === 0) return []

  const markers: ScrubberMarker[] = []
  for (let i = 0; i < bucketCount; i++) {
    const count = counts[i]!
    if (count === 0) continue
    markers.push({ ratio: i / bucketCount, kind: 'match', density: count / maxCount })
  }
  return markers
}
