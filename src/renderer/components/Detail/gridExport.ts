/**
 * Copy grid selection as CSV/TSV/Markdown (M2-PLAN.md E8, CONCEPT.md §4.3).
 * Pure logic, no React.
 *
 * **v1 rule: copy the cell text as displayed**, including derived
 * summaries. Knowingly imperfect — CSV/TSV/Markdown have no styling, so
 * the literal/derived distinction §4.3 makes visually is lost on export,
 * and `3 items` can be mistaken for a stored value. Accepted because
 * export is a convenience feature; §13 leaves open what users actually
 * expect instead (expansion, a marker, empty cells) pending real usage.
 *
 * R39 (`R39-grid-followups.md`, D-068): a presence-marker cell (an
 * empty element/property, §4.3's `<sunroof/>` — `CellKind !== Absent` with
 * `text === null`) used to collapse into the same blank field as a
 * genuinely `Absent` one, emptying an entire tick-mark column. Fixed per
 * cell (a marker exports as a token) and per column (a column where every
 * *present* cell is a marker is boolean-shaped, so `Absent` exports as
 * `false` rather than "no such field").
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeRef } from '../../../core/types'
import { cellOf, CellKind, rowFields } from './gridCell'
import type { GridColumn } from './gridColumns'

export type GridExportFormat = 'csv' | 'tsv' | 'markdown'

/**
 * Rows above which an export asks first (§11.2's soft-cap shape: a
 * confirmation showing the estimated cost, never a refusal).
 *
 * Export builds the whole result as one JS string, and a JS string is
 * UTF-16 — the same doubling invariant 1 exists to avoid. Measured on
 * `cars-10mb.xml`'s 31,655 rows: 401 ms and 5 MB, which extrapolates to
 * roughly **8 s and 97 MB on `cars-200mb.xml`** and ~20 s / ~240 MB at
 * 500 MB. That was reachable from a toolbar button and a palette command
 * with no warning at all.
 *
 * 50,000 rows is ~600 ms and ~8 MB on the fixture shape above — slow enough
 * to notice, small enough not to ask about.
 */
export const GRID_EXPORT_CONFIRM_ROWS = 50_000

/** Rough output size for the confirmation message, without building the
 * string first — which would defeat the point of asking. Sampled from the
 * first few rows rather than estimated from a constant, so a grid of long
 * values reports honestly. */
export function estimateExportBytes(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  rowIndices: readonly number[],
  columns: readonly GridColumn[]
): number {
  const sample = Math.min(20, rowIndices.length)
  if (sample === 0) return 0
  let chars = 0
  for (let i = 0; i < sample; i++) {
    const row = members[rowIndices[i]!]!
    for (const column of columns) {
      chars += (cellOf(store, source, row, column.nameId).text?.length ?? 0) + 1
    }
  }
  // ×2 for UTF-16, which is what the string actually costs in memory.
  return Math.round((chars / sample) * rowIndices.length) * 2
}

/** RFC 4180 quoting: a field containing the delimiter, a quote, or a
 * newline is wrapped in quotes, with embedded quotes doubled. */
function delimitedField(text: string, delimiter: string): string {
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** Markdown table cells can't contain a literal `|` or a raw newline
 * without breaking the table structure. */
function markdownField(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** A cell's export-relevant state, one per (row, visible column) — resolved
 * to actual output text only after every row has been classified (see
 * `exportGrid`), since a column's `Absent` handling depends on what every
 * *other* row in that column turned out to be. */
const enum ExportCellState {
  Absent,
  Marker,
  Text
}

interface DecodedExportCell {
  readonly state: ExportCellState
  /** Only meaningful when `state === Text`. */
  readonly text: string
}

const ABSENT_EXPORT_CELL: DecodedExportCell = { state: ExportCellState.Absent, text: '' }

/**
 * One row, decoded once via `rowFields`'s single structural pass (R34's own
 * O(rowFanOut) primitive) rather than once per visible column — `cellOf`
 * itself re-scans the row's attributes and children on every call, and R34
 * measured that scan as the dominant cost of a wide operation over this
 * grid. `columns` may include names `rowFields` never saw on this
 * particular row; those resolve to `Absent`, exactly as `cellOf` would.
 */
function decodeExportRow(
  store: NodeStore,
  source: SourceBuffer,
  row: NodeRef,
  columns: readonly GridColumn[]
): DecodedExportCell[] {
  const fields = rowFields(store, source, row)
  return columns.map((column) => {
    const cell = fields.get(column.nameId)
    if (cell === undefined || cell.kind === CellKind.Absent) return ABSENT_EXPORT_CELL
    if (cell.text === null) return { state: ExportCellState.Marker, text: '' }
    return { state: ExportCellState.Text, text: cell.text }
  })
}

/**
 * `true` when every *present* cell `column` had, across the whole export,
 * was a presence marker — i.e. the column is boolean-shaped, and `Absent`
 * means "false" rather than "no such field." Vacuously false for a column
 * that never had a marker at all, since there is then nothing to justify
 * reading `Absent` as a boolean rather than as "field not present."
 */
function isBooleanShaped(decoded: readonly DecodedExportCell[][], columnIndex: number): boolean {
  let sawMarker = false
  for (const row of decoded) {
    const state = row[columnIndex]!.state
    if (state === ExportCellState.Text) return false
    if (state === ExportCellState.Marker) sawMarker = true
  }
  return sawMarker
}

/** Resolves one cell's already-classified state to output text — the
 * per-format token table from `R39-grid-followups.md`. */
function resolveDelimitedCell(cell: DecodedExportCell, booleanShaped: boolean): string {
  switch (cell.state) {
    case ExportCellState.Text:
      return cell.text
    case ExportCellState.Marker:
      return 'true'
    case ExportCellState.Absent:
      return booleanShaped ? 'false' : ''
  }
}

function resolveMarkdownCell(cell: DecodedExportCell): string {
  switch (cell.state) {
    case ExportCellState.Text:
      return cell.text
    case ExportCellState.Marker:
      return '✓'
    case ExportCellState.Absent:
      return ''
  }
}

/**
 * `rowIndices` is the currently-displayed order (after any sort/filter,
 * E6/E7) — export reflects what's on screen, not the group's raw document
 * order, since that's what "copy" means for a visible selection.
 *
 * R39: one pass to decode every row (`decodeExportRow`, `rowFields`
 * underneath), one pass to classify each column as boolean-shaped or not
 * (`isBooleanShaped`), one pass to resolve and serialize — no cell is
 * decoded from the store more than once, regardless of how many times its
 * column's classification is consulted.
 */
export function exportGrid(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  rowIndices: readonly number[],
  columns: readonly GridColumn[],
  format: GridExportFormat
): string {
  const headers = columns.map((c) => store.textOf(c.nameId))
  const decoded = rowIndices.map((i) => decodeExportRow(store, source, members[i]!, columns))
  const booleanShaped = columns.map((_, j) => isBooleanShaped(decoded, j))

  if (format === 'markdown') {
    const headerRow = `| ${headers.map(markdownField).join(' | ')} |`
    const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`
    const bodyRows = decoded.map(
      (row) => `| ${row.map((cell) => markdownField(resolveMarkdownCell(cell))).join(' | ')} |`
    )
    return [headerRow, separatorRow, ...bodyRows].join('\n')
  }

  const delimiter = format === 'csv' ? ',' : '\t'
  const lines = [headers.map((h) => delimitedField(h, delimiter)).join(delimiter)]
  for (const row of decoded) {
    lines.push(
      row
        .map((cell, j) => delimitedField(resolveDelimitedCell(cell, booleanShaped[j]!), delimiter))
        .join(delimiter)
    )
  }
  return lines.join('\r\n')
}
