/**
 * Grid filtering (M2-PLAN.md E7, CONCEPT.md §4.3). Pure logic, no React —
 * the same `*Model.ts`/`*Logic.ts` split the rest of `Detail/` uses.
 *
 * Substring, case-insensitive, over each column's *displayed* cell text —
 * not a document-wide search (M4, §6): this narrows the rendered group's
 * own rows and touches nothing outside it, no index, no intern table.
 *
 * A subset of row indices, document order preserved — filtering narrows
 * which rows are visible, it never reorders them, which is what lets the
 * row-header column (E5) keep showing each surviving row's real document
 * position instead of a renumbered 1..N.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeRef } from '../../../core/types'
import { cellOf, rowFields } from './gridCell'
import type { GridColumn } from './gridColumns'

export interface GridFilters {
  readonly quick: string
  readonly perColumn: ReadonlyMap<number, string>
}

export const EMPTY_GRID_FILTERS: GridFilters = { quick: '', perColumn: new Map() }

function cellTextLower(
  store: NodeStore,
  source: SourceBuffer,
  row: NodeRef,
  nameId: number
): string {
  return (cellOf(store, source, row, nameId).text ?? '').toLowerCase()
}

export interface FilterResult {
  /** Indices into `members`, document order, narrowed to rows matching
   * every active per-column filter and (if set) the quick filter against a
   * *visible* column. */
  readonly indices: readonly number[]
  /** Rows that matched the quick filter only in a column not currently
   * shown (R34 §5) — excluded from `indices` (the quick filter's scope
   * stays the visible column set), but counted rather than silently
   * dropped, so the UI can say what it left out instead of looking like it
   * searched everywhere when it didn't. */
  readonly hiddenMatchCount: number
  /** The distinct hidden name ids that produced at least one of those
   * matches — bounded by what actually matched, not by the whole overflow
   * column list, so "why did this match" stays a short, concrete answer. */
  readonly hiddenMatchColumns: readonly number[]
}

const NO_HIDDEN_MATCHES: FilterResult['hiddenMatchColumns'] = []

/**
 * R34 §5: rewritten row-major. The old column-major scan
 * (`columns.some((c) => cellOf(…).includes(quick))`) called `cellOf` once
 * per *visible* column, and `cellOf` itself rescans the row's attributes
 * and children on every call — O(visibleColumns × rowFanOut) per row, and
 * silently blind to a match sitting in a column outside `columns` (a wide
 * document's overflow). `rowFields` replaces both: one O(rowFanOut) pass
 * over the row's own fields, checked against the visible set by one `Set`
 * lookup per field, with hidden matches tallied in the same pass instead of
 * never being looked for.
 */
export function filterIndices(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  columns: readonly GridColumn[],
  filters: GridFilters
): FilterResult {
  const quick = filters.quick.trim().toLowerCase()
  const perColumn = [...filters.perColumn.entries()]
    .map(([nameId, text]) => [nameId, text.trim().toLowerCase()] as const)
    .filter(([, text]) => text.length > 0)

  if (quick.length === 0 && perColumn.length === 0) {
    return {
      indices: members.map((_, i) => i),
      hiddenMatchCount: 0,
      hiddenMatchColumns: NO_HIDDEN_MATCHES
    }
  }

  const visible = new Set(columns.map((c) => c.nameId))
  const hiddenMatchColumns = new Set<number>()
  let hiddenMatchCount = 0

  const indices: number[] = []
  outer: for (let i = 0; i < members.length; i++) {
    const row = members[i]!
    for (const [nameId, text] of perColumn) {
      if (!cellTextLower(store, source, row, nameId).includes(text)) continue outer
    }
    if (quick.length === 0) {
      indices.push(i)
      continue
    }

    let visibleMatch = false
    let hiddenMatches: number[] | null = null
    for (const [nameId, cell] of rowFields(store, source, row)) {
      if (!(cell.text ?? '').toLowerCase().includes(quick)) continue
      if (visible.has(nameId)) {
        visibleMatch = true
        break
      }
      ;(hiddenMatches ??= []).push(nameId)
    }

    if (visibleMatch) {
      indices.push(i)
    } else if (hiddenMatches !== null) {
      hiddenMatchCount++
      for (const nameId of hiddenMatches) hiddenMatchColumns.add(nameId)
    }
  }
  return { indices, hiddenMatchCount, hiddenMatchColumns: [...hiddenMatchColumns] }
}
