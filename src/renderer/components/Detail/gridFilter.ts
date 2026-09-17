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
import { isAsciiOnly } from '../../../core/textFind'
import type { NodeRef } from '../../../core/types'
import { cellOf, rowFields } from './gridCell'
import type { GridColumn } from './gridColumns'
import { prefilterTokenFor, rowMayMatch } from './gridPrefilter'

export interface GridFilters {
  readonly quick: string
  readonly perColumn: ReadonlyMap<number, string>
}

export const EMPTY_GRID_FILTERS: GridFilters = { quick: '', perColumn: new Map() }

/**
 * R202 — fold a cell for comparison against a needle that has already been
 * folded the same way.
 *
 * `normalize` is applied **only when the needle is not pure ASCII**, and that
 * is a correctness rule before it is a performance one.
 *
 * NFC composes: a decomposed `cafe` + U+0301 becomes `café`. So normalizing
 * the *cell* for an ASCII needle can only ever **remove** matches — `cafe`
 * matches the decomposed spelling today, character for character, and would
 * stop once the cell is composed.
 *
 * *Corrected by R214:* this said nothing in NFC can produce an ASCII character
 * that was not already there. Checked over every code point, three canonical
 * singletons do — U+212A KELVIN SIGN to `K`, U+037E to `;`, U+1FEF to a
 * backtick — so for those three an ASCII needle misses a match normalization
 * would have found. The rule stands: those are rare, the `cafe` loss is not,
 * and `K` already matches through `toLowerCase`.
 *
 * The plan proposed normalizing unconditionally. Measured, that costs ~21% of
 * a 200,000-row filter pass on all-ASCII content — to make a permissive
 * result *less* permissive. Gating on the needle makes the common case free
 * and the uncommon one correct, and matches `chooseFindPath`'s own rule that
 * an ASCII needle never pays for Unicode machinery.
 */
function fold(text: string, needleIsAscii: boolean): string {
  return needleIsAscii ? text.toLowerCase() : text.normalize('NFC').toLowerCase()
}

function cellTextLower(
  store: NodeStore,
  source: SourceBuffer,
  row: NodeRef,
  nameId: number,
  needleIsAscii: boolean
): string {
  return fold(cellOf(store, source, row, nameId).text ?? '', needleIsAscii)
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

/** A filter's needles, prepared once per pass. */
interface PreparedFilters {
  readonly quick: string
  readonly quickIsAscii: boolean
  readonly perColumn: readonly (readonly [number, string, boolean])[]
}

function prepare(filters: GridFilters): PreparedFilters {
  // The needle is folded once, here; each cell is folded the same way below.
  // `quickIsAscii` decides whether either side is normalized at all — see
  // `fold`. A per-column filter carries its own answer, so one non-ASCII
  // column filter does not make every other column pay.
  const quickRaw = filters.quick.trim()
  const quickIsAscii = isAsciiOnly(quickRaw)
  const perColumn = [...filters.perColumn.entries()]
    .map(([nameId, text]) => {
      const trimmed = text.trim()
      const ascii = isAsciiOnly(trimmed)
      return [nameId, fold(trimmed, ascii), ascii] as const
    })
    .filter(([, text]) => text.length > 0)
  return { quick: fold(quickRaw, quickIsAscii), quickIsAscii, perColumn }
}

export interface FilterOutcome extends FilterResult {
  /**
   * R214 § 3: member indices that passed every column filter and matched the
   * quick filter **anywhere** — visible or hidden columns — in document order.
   * What the next pass may narrow to when the quick filter is extended. `null`
   * when there is no quick filter to narrow from.
   */
  readonly anywhere: readonly number[] | null
}

/**
 * R214 § 3: what a completed pass leaves for the next one. Narrowing is sound
 * only when the new quick filter can match nothing the old one did not: the
 * same rows, the same column filters, and a needle that **contains** the old
 * one, folded the same way — a row whose text contains `golf` contains `gol`.
 */
export interface NarrowingBase {
  readonly store: NodeStore
  readonly source: SourceBuffer
  readonly members: readonly NodeRef[]
  readonly filters: GridFilters
  readonly outcome: FilterOutcome
}

function sameColumnFilters(a: GridFilters, b: GridFilters): boolean {
  if (a.perColumn.size !== b.perColumn.size) return false
  for (const [nameId, text] of a.perColumn) {
    if (b.perColumn.get(nameId)?.trim() !== text.trim()) return false
  }
  return true
}

/** The rows a pass for `filters` needs to visit, if `base` lets it narrow. */
export function narrowedRows(
  base: NarrowingBase | null,
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  filters: GridFilters
): readonly number[] | null {
  if (base === null || base.outcome.anywhere === null) return null
  if (base.store !== store || base.source !== source || base.members !== members) return null
  if (!sameColumnFilters(base.filters, filters)) return null
  const previous = prepare(base.filters)
  const next = prepare(filters)
  if (previous.quick.length === 0 || previous.quickIsAscii !== next.quickIsAscii) return null
  if (next.quick === previous.quick || !next.quick.includes(previous.quick)) return null
  return base.outcome.anywhere
}

export interface FilterPassOptions {
  /** Visit only these member indices (ascending) — a narrowing (§ 3). */
  readonly within?: readonly number[] | null
  /** Off only for the differential test and the bench, which compare against
   * the plain pass (§ 4). */
  readonly prefilter?: boolean
}

/**
 * A filter pass that can be run in slices (R214 § 2). `step` works until
 * `deadline` (a `performance.now()` value) and returns the outcome once every
 * row has been visited, `null` before that. Pure — no timers of its own — so the
 * caller decides how slices are scheduled, and a pass nobody steps any more is
 * simply garbage.
 */
export interface FilterPass {
  step(deadline: number): FilterOutcome | null
  /** Rows this pass visits: all members, or fewer when it narrowed. */
  readonly total: number
}

/** How many rows run between deadline checks: `performance.now()` is not free,
 * and a row costs microseconds. */
const ROWS_PER_CLOCK_CHECK = 256

/**
 * R34 §5: row-major. The old column-major scan
 * (`columns.some((c) => cellOf(…).includes(quick))`) called `cellOf` once
 * per *visible* column, and `cellOf` itself rescans the row's attributes
 * and children on every call — O(visibleColumns × rowFanOut) per row, and
 * silently blind to a match sitting in a column outside `columns` (a wide
 * document's overflow). `rowFields` replaces both: one O(rowFanOut) pass
 * over the row's own fields, checked against the visible set by one `Set`
 * lookup per field, with hidden matches tallied in the same pass instead of
 * never being looked for.
 */
export function createFilterPass(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  columns: readonly GridColumn[],
  filters: GridFilters,
  options: FilterPassOptions = {}
): FilterPass {
  const { quick, quickIsAscii, perColumn } = prepare(filters)
  const within = options.within ?? null
  const total = within === null ? members.length : within.length

  if (quick.length === 0 && perColumn.length === 0) {
    const outcome: FilterOutcome = {
      indices: members.map((_, i) => i),
      hiddenMatchCount: 0,
      hiddenMatchColumns: NO_HIDDEN_MATCHES,
      anywhere: null
    }
    return { step: () => outcome, total }
  }

  const token =
    options.prefilter === false || quick.length === 0 ? null : prefilterTokenFor(quick, source)
  const visible = new Set(columns.map((c) => c.nameId))
  const hiddenMatchColumns = new Set<number>()
  const indices: number[] = []
  const anywhere: number[] | null = quick.length === 0 ? null : []
  let hiddenMatchCount = 0
  let position = 0
  let outcome: FilterOutcome | null = null

  function visit(i: number): void {
    const row = members[i]!
    for (const [nameId, text, ascii] of perColumn) {
      if (!cellTextLower(store, source, row, nameId, ascii).includes(text)) return
    }
    if (quick.length === 0) {
      indices.push(i)
      return
    }
    if (token !== null && !rowMayMatch(store, source, row, token)) return

    let visibleMatch = false
    let hiddenMatches: number[] | null = null
    for (const [nameId, cell] of rowFields(store, source, row)) {
      if (!fold(cell.text ?? '', quickIsAscii).includes(quick)) continue
      if (visible.has(nameId)) {
        visibleMatch = true
        break
      }
      ;(hiddenMatches ??= []).push(nameId)
    }

    if (visibleMatch) {
      indices.push(i)
      anywhere!.push(i)
    } else if (hiddenMatches !== null) {
      hiddenMatchCount++
      anywhere!.push(i)
      for (const nameId of hiddenMatches) hiddenMatchColumns.add(nameId)
    }
  }

  const pass: FilterPass = {
    total,
    step(deadline: number): FilterOutcome | null {
      if (outcome !== null) return outcome
      while (position < total) {
        const stop = Math.min(total, position + ROWS_PER_CLOCK_CHECK)
        for (; position < stop; position++) visit(within === null ? position : within[position]!)
        if (position < total && performance.now() >= deadline) return null
      }
      outcome = {
        indices,
        hiddenMatchCount,
        hiddenMatchColumns: [...hiddenMatchColumns],
        anywhere
      }
      return outcome
    }
  }
  return pass
}

/** The whole pass at once — for callers that are not rendering: tests, benches,
 * and anything that must have an answer now. */
export function filterIndices(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  columns: readonly GridColumn[],
  filters: GridFilters,
  options: FilterPassOptions = {}
): FilterOutcome {
  return createFilterPass(store, source, members, columns, filters, options).step(Infinity)!
}
