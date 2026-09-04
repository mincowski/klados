/**
 * The Raw View's window mechanism (M1-PLAN.md D10, CONCEPT.md §4.4). Pure
 * logic — bounds computation, the incremental re-slice plan, and the
 * re-center trigger — kept free of CodeMirror and React so it can be
 * exercised directly by `test/rawWindow.test.ts`; `Raw.tsx` is the thin
 * layer that turns a `ReslicePlan` into actual `EditorView.dispatch` calls.
 *
 * The re-slice mechanism is ported from the measured spike, not reinvented:
 * `spike/codemirror-harness/renderer-a6b.js`'s `incrementalReslice`. A
 * window re-centers by dispatching exactly two edge changes — drop the
 * stale leading edge, append the new trailing edge, leave the shared
 * middle untouched — with no accompanying selection or scroll-into-view
 * effect. CodeMirror's own change-mapping is what keeps the caret and
 * scroll position steady across the edit; A6b measured 0 bytes of drift
 * over 20 crossings doing exactly this, against 29-46 ms crossing cost and
 * nonzero drift for A6's naive full-document replace.
 */
import { rowAt } from '../../../core/rowIndex'
import type { Offset } from '../../../core/types'

/** A6/A6b's winning configuration: large enough that boundary crossings are
 * infrequent, small enough that CodeMirror's own UTF-16 copy of the window
 * (invariant 1's bounded exception, D-031) stays negligible against a
 * 500 MB document — A6b measured a −3.1 MB renderer memory delta at this
 * size, i.e. noise. */
export const WINDOW_BYTES = 1024 * 1024

export interface WindowBounds {
  readonly start: Offset
  readonly end: Offset
}

/**
 * A `windowBytes`-ish window centred on `centerOffset`, snapped so both
 * ends land on row boundaries (M0c's row index) rather than a raw byte
 * offset that could split a row — and since every row start is already
 * character-boundary-snapped (`rowIndex.ts`'s own build step), this can
 * never split a multi-byte character either. The result is not exactly
 * `windowBytes` long, only close to it — rows are at most
 * `DEFAULT_MAX_ROW_BYTES`, so the overshoot at each end is bounded by that,
 * negligible against a ~1 MB window.
 */
export function computeWindowBounds(
  rowIndex: Int32Array,
  byteLength: number,
  centerOffset: Offset,
  windowBytes: number = WINDOW_BYTES
): WindowBounds {
  if (byteLength === 0) return { start: 0, end: 0 }

  const maxOrigin = Math.max(0, byteLength - windowBytes)
  const rawOrigin = Math.max(0, Math.min(Math.floor(centerOffset - windowBytes / 2), maxOrigin))

  const startRow = rowAt(rowIndex, rawOrigin)
  const start = rowIndex[startRow]!

  const rawEnd = Math.min(byteLength, start + windowBytes)
  const endRow = rowAt(rowIndex, Math.max(start, rawEnd - 1))
  const end = endRow + 1 < rowIndex.length ? rowIndex[endRow + 1]! : byteLength

  return { start, end }
}

export interface ByteRange {
  readonly start: Offset
  readonly end: Offset
}

export type ReslicePlan =
  | {
      readonly kind: 'incremental'
      readonly newStart: Offset
      readonly newEnd: Offset
      readonly sharedStart: Offset
      readonly sharedEnd: Offset
      /** Byte range to decode and insert at the front — empty (`start ===
       * end`) when the new window starts at or before the old one. */
      readonly leading: ByteRange
      /** Byte range to decode and append at the back — empty when the new
       * window ends at or before the old one. */
      readonly trailing: ByteRange
    }
  | { readonly kind: 'replace'; readonly newStart: Offset; readonly newEnd: Offset }

/**
 * Two edge changes when the old and new windows overlap at all; a full
 * replace only for the no-overlap case — a large "Locate in source" jump,
 * where old and new windows share nothing — never the steady-state
 * scrolling mechanism (M1-PLAN.md D10's own requirement).
 */
export function planReslice(
  oldStart: Offset,
  oldEnd: Offset,
  newStart: Offset,
  newEnd: Offset
): ReslicePlan {
  const sharedStart = Math.max(oldStart, newStart)
  const sharedEnd = Math.min(oldEnd, newEnd)

  if (sharedStart >= sharedEnd) return { kind: 'replace', newStart, newEnd }

  return {
    kind: 'incremental',
    newStart,
    newEnd,
    sharedStart,
    sharedEnd,
    leading: { start: newStart, end: sharedStart },
    trailing: { start: sharedEnd, end: newEnd }
  }
}

/**
 * Whether the visible top-of-viewport offset is close enough to an edge of
 * the current window that it should be re-centred — a fraction of the
 * window's own size (`margin`), not a fixed byte count, so the trigger
 * scales with `windowBytes`. Symmetric: fires scrolling either direction.
 *
 * `byteLength` is the document's total size: a window already clamped
 * against a document edge cannot recentre further in that direction, so
 * that side of the check is skipped regardless of `margin` (M5g-PLAN.md
 * §1.6/O0) — without it, every scroll event in the first/last `margin`
 * fraction of a boundary-pinned window re-slices onto the window already in
 * place, indefinitely.
 */
export function shouldRecenter(
  viewportTopOffset: Offset,
  windowStart: Offset,
  windowEnd: Offset,
  byteLength: number,
  margin = 0.2
): boolean {
  const span = windowEnd - windowStart
  if (span <= 0) return false
  const position = (viewportTopOffset - windowStart) / span
  if (position < margin && windowStart > 0) return true
  if (position > 1 - margin && windowEnd < byteLength) return true
  return false
}
