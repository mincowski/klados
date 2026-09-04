/**
 * Content-derived grid column widths (M2-PLAN.md's `CELL_WIDTH = 160` for
 * every column, replaced — R43, `R43-grid-sizing-and-scroll.md`,
 * D-071). Pure logic, no React — the same `*Model.ts`/`*Logic.ts` split the
 * rest of `Detail/` uses.
 *
 * **Sample, don't measure everything.** Same precedent `gridSort.ts`'s
 * `isNumericColumn` set: a bounded scan, not every row. `sampleColumnStats`
 * below is that same scan widened to answer both questions in one pass —
 * two independent bounded scans over the same rows is the shape R34 spent a
 * round removing (`gridFilter.ts`'s `rowFields`).
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeRef } from '../../../core/types'
import { EMPTY_DELTA_LIST, type DeltaList } from '../../../core/deltaList'
import { CellKind, cellOf } from './gridCell'
import { NUMERIC_SAMPLE_SIZE, NUMERIC_SCAN_LIMIT } from './gridSort'
import type { GridColumn } from './gridColumns'

function numericValue(text: string): number | null {
  if (text.trim().length === 0) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

export interface ColumnStats {
  readonly numeric: boolean
  /** Longest decoded cell text seen in the sample, in characters — the raw
   * material `defaultColumnWidthCh` clamps into a column width. */
  readonly maxContentChars: number
}

/**
 * Measured, not assumed: an early draft of this function kept scanning for
 * a *width* sample past the point `isNumericColumn`'s own early exit would
 * have already returned — up to `NUMERIC_SAMPLE_SIZE` (200) decodes for
 * every non-numeric column instead of the 1 the old code paid, on a 2 MB
 * document with many text columns that reproduced M2's own "more than half
 * the grid's time to first paint" cost (R30's tab-switch benchmark: 63 ms →
 * 6.8 s wall time for the switch). A width estimate does not need 200 rows
 * to stop being obviously wrong — it needs enough to not be decided by row
 * 0 alone. Kept deliberately small and independent of `NUMERIC_SAMPLE_SIZE`.
 */
const WIDTH_SAMPLE_SIZE = 24

/**
 * One scan answers both `isNumericColumn`'s own question and this round's
 * new one — but the two samples are **not** the same size (see
 * `WIDTH_SAMPLE_SIZE`'s own doc comment for why not, and what widening it
 * cost once). Numeric-ness still exits the moment a single present value
 * fails to parse as a number, exactly as `isNumericColumn` always has; the
 * width sample keeps scanning past that point, independently, up to its own
 * much smaller bound. Reusing the *loop*, not the *early exit*, is what "one
 * pass" still means here: both questions are answered without a second
 * O(rows) scan over the same members, just not to the same depth.
 */
export function sampleColumnStats(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  column: GridColumn,
  deltas: DeltaList = EMPTY_DELTA_LIST,
  numericSampleSize: number = NUMERIC_SAMPLE_SIZE,
  widthSampleSize: number = WIDTH_SAMPLE_SIZE
): ColumnStats {
  let numericSoFar = true
  let numericPresentSeen = 0
  let widthSampleSeen = 0
  let maxChars = 0
  const scanned = Math.min(members.length, NUMERIC_SCAN_LIMIT)

  for (let i = 0; i < scanned; i++) {
    const cell = cellOf(store, source, members[i]!, column.nameId, deltas)
    if (cell.kind === CellKind.Absent || cell.text === null) continue

    if (widthSampleSeen < widthSampleSize) {
      maxChars = Math.max(maxChars, cell.text.length)
      widthSampleSeen++
    }
    if (numericSoFar) {
      numericPresentSeen++
      if (numericValue(cell.text) === null) numericSoFar = false
    }

    if (
      widthSampleSeen >= widthSampleSize &&
      (!numericSoFar || numericPresentSeen >= numericSampleSize)
    ) {
      break
    }
  }

  return { numeric: numericSoFar && numericPresentSeen > 0, maxContentChars: maxChars }
}

/** The grid's font is proportional (`--font-ui`), so a character count is
 * an estimate, not a measurement — good enough to stop `year` being 160 px
 * wide, visibly wrong for some column somewhere. That gap is the reason
 * column resize (below) exists as an escape hatch, not a reason to try to
 * measure exactly here. */
const CHAR_WIDTH_PX = 7
/** Room for a header's pin button, kind glyph and padding (`Grid.css`'s
 * `.grid-header-pin`/`.grid-header-glyph`) — the widest chrome case, so one
 * constant covers header and body cells alike. A guess, not a measurement,
 * same as `CHAR_WIDTH_PX`. */
const CELL_CHROME_PX = 40
/** Below this a header is unreadable. */
const MIN_COLUMN_WIDTH_PX = 64
/** Above this one column starts pushing everything else off screen. */
const MAX_COLUMN_WIDTH_PX = 320

/** `headerChars` is the column's own name length — a short column with a
 * long header (`id` vs. a verbose attribute name) is the case a naive
 * content-only fit gets wrong. */
export function defaultColumnWidthPx(headerChars: number, stats: ColumnStats): number {
  const chars = Math.max(headerChars, stats.maxContentChars)
  const px = chars * CHAR_WIDTH_PX + CELL_CHROME_PX
  return Math.min(MAX_COLUMN_WIDTH_PX, Math.max(MIN_COLUMN_WIDTH_PX, Math.round(px)))
}
