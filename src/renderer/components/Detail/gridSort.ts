/**
 * Grid sorting (M2-PLAN.md E6, CONCEPT.md §4.3). Pure logic, no React —
 * the same `*Model.ts`/`*Logic.ts` split the rest of `Detail/` uses.
 *
 * View-only, and an index permutation rather than a reordering of the
 * members themselves (rule 1: no sorted array of row objects) — sorting a
 * 2 M-row group means permuting an index list, not decoding and comparing
 * 2 M values ahead of time. Sort keys are decoded on demand, per
 * comparison, through the same `cellOf` every rendered cell uses.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeRef } from '../../../core/types'
import { CellKind, cellOf } from './gridCell'
import { widestKind, type GridColumn } from './gridColumns'

export type SortDirection = 'asc' | 'desc'

/** Composite columns are not sortable (§4.3) — a sort that silently means
 * something other than what it appears to mean (sorting by what, exactly,
 * for a column that's a mix of "diesel · 110" and "3 items"?) is worse
 * than no sort at all. */
export function isColumnSortable(column: GridColumn): boolean {
  return widestKind(column) === 'scalar'
}

function numericValue(text: string): number | null {
  if (text.trim().length === 0) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/**
 * How many present values `isNumericColumn` inspects before deciding. A
 * column that is numeric for this many rows and textual afterwards
 * right-aligns when it shouldn't — a cosmetic misalignment, and the only
 * thing at stake, which is what makes sampling safe here where it is not
 * safe for column *collection* (there, a sample decides column order, and
 * revising it reorders columns under the user).
 */
export const NUMERIC_SAMPLE_SIZE = 200

/**
 * Rows examined before giving up on finding `NUMERIC_SAMPLE_SIZE` present
 * values. Without this the value sample alone is unbounded on a *sparse*
 * column: a field present on 1% of rows still scans every row looking for
 * its 200th value, which on `cars-200mb.xml` was measured at 328 ms for one
 * column even after the value sample was added. Sparse columns are exactly
 * the ones where a wrong alignment guess matters least.
 */
export const NUMERIC_SCAN_LIMIT = 5_000

/**
 * Whether `column` looks numeric — §4.3's "numeric columns right-align with
 * tabular figures," and also what `sortByColumn` uses to pick numeric vs.
 * string comparison. Absent cells don't count against it: a column that is
 * numeric everywhere it has a value is still numeric.
 *
 * **Sampled, not exhaustive.** This used to read every member, and `cellOf`
 * decodes text — so on `cars-200mb.xml` it cost **1522 ms** across the
 * column set, more than column collection itself and more than half of the
 * grid's whole time to first paint, for a question whose answer only decides
 * text alignment. It early-exited on the first non-numeric value, so only
 * genuinely-numeric columns paid the full scan, which is exactly the columns
 * a user is most likely to sort by.
 *
 * Non-numeric columns still exit on their first non-numeric value, usually
 * row 0, so the sample bound only ever shortens the numeric case.
 */
export function isNumericColumn(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  column: GridColumn,
  sampleSize: number = NUMERIC_SAMPLE_SIZE
): boolean {
  let seen = 0
  const scanned = Math.min(members.length, NUMERIC_SCAN_LIMIT)
  for (let i = 0; i < scanned; i++) {
    const cell = cellOf(store, source, members[i]!, column.nameId)
    if (cell.kind === CellKind.Absent || cell.text === null) continue
    if (numericValue(cell.text) === null) return false
    seen++
    if (seen >= sampleSize) return true
  }
  return seen > 0
}

/**
 * Sorts `indices` (indices into `members`) by `column`'s value. Absent
 * cells sort last regardless of direction — there is no "value" to place
 * relative to the others, and burying them at the bottom (rather than
 * flipping with direction) keeps their position predictable.
 *
 * `numeric` is the caller's own `isNumericColumn` result, not recomputed
 * here — a fresh O(members) scan on every sort click would mean re-reading
 * every row's cell text a second time on top of the sort itself, for a
 * question ("is this column numeric") whose answer doesn't change between
 * clicks. `Grid.tsx` computes it once per column and reuses it across
 * sorts; only the direct unit tests below still call `isNumericColumn`
 * themselves.
 */
export function sortByColumn(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  indices: readonly number[],
  column: GridColumn,
  direction: SortDirection,
  numeric: boolean
): number[] {
  const sign = direction === 'asc' ? 1 : -1

  // Decorate-sort-undecorate: each row's key is computed once here rather
  // than inside the comparator, which runs O(n log n) times — on a 633 K-row
  // group that is ~12.6 M calls, so parsing the number (or re-reading the
  // cell) per comparison rather than per row is a 20× difference in how
  // often the work happens. `numericKey` is resolved in the same pass for
  // the same reason.
  const keyed = indices.map((i) => {
    const cell = cellOf(store, source, members[i]!, column.nameId)
    const absent = cell.kind === CellKind.Absent || cell.text === null
    return {
      i,
      absent,
      text: absent ? '' : cell.text!,
      value: absent || !numeric ? 0 : (numericValue(cell.text!) ?? 0)
    }
  })

  // `Intl.Collator.compare` rather than `String.prototype.localeCompare`:
  // the latter reconstructs a collator on every call, which at 12.6 M calls
  // dominates the sort outright.
  const collator = new Intl.Collator(undefined, { numeric: false })

  keyed.sort((a, b) => {
    // Absent sorts last regardless of direction — there is no value to place
    // relative to the others, and a fixed position is predictable where one
    // that flips with direction is not.
    if (a.absent && b.absent) return 0
    if (a.absent) return 1
    if (b.absent) return -1
    if (numeric) return sign * (a.value - b.value)
    return sign * collator.compare(a.text, b.text)
  })
  return keyed.map((k) => k.i)
}
