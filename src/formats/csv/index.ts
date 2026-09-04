/**
 * CSV (R146, `docs/plans/R145-csv.md` §2). Two levels deep, no nesting — the mapping onto
 * existing `NodeKind` values is exact and needs no new kind:
 *
 *   the file               -> Document
 *   the records collectively -> one unnamed Array (root)
 *   one record (row)       -> one unnamed Object
 *   one field (cell)       -> a scalar facet (`attribute()`), never a child node
 *
 * Fields are facets rather than `Property` nodes for the reason §2 gives: a facet costs
 * 16 bytes against a node-plus-scalar's 76, and it is what makes `gridDetection`/
 * `collectColumns` work on a CSV with no new code — they already collect repeating
 * children's facets into grid columns, which is exactly this shape.
 *
 * The header row is metadata, not a record: it is scanned for its field spans and then
 * *not* emitted as a node at all. Every data row's `attribute()` call points its name at
 * the *header's* bytes, so the interner sees one id per column no matter how many rows
 * follow (acceptance 6) — the header row itself lives in the gap between the Document's
 * span and the Array's, the same way an XML prolog precedes the root element's span
 * without being covered by any node under it.
 */
import {
  type AncestorView,
  type Diagnostic,
  type FormatCapabilities,
  type FormatModule,
  NodeKind,
  type NodeSink,
  type Offset,
  type ParseOptions,
  type ParseResult,
  type ResumeContext,
  Severity
} from '../../core/types'
import { bomLengthAt } from '../../core/encoding'
import { sniffDialect, type CsvDialect } from './dialect'
import { detectHeader } from './header'

const LF = 0x0a
const CR = 0x0d

function isNewlineByte(b: number): boolean {
  return b === LF || b === CR
}

export const csvCapabilities: FormatCapabilities = {
  id: 'csv',
  displayName: 'CSV',
  extensions: ['.csv', '.tsv', '.tab'],
  hasAttributes: true,
  hasComments: false,
  hasNamespaces: false,
  // No pretty-printed form (invariant 6): normalising quoting or padding columns
  // would rewrite bytes the user did not ask to change.
  canFormat: false,
  canIncrementalReparse: true,
  // LF plus the three sniffable delimiters (§7): `rowBreakBytes` is static on
  // `FormatCapabilities` but the real delimiter is per-document, so this is a
  // preference the row builder's backward scan may occasionally miss, not a
  // correctness requirement — the row index is already a resolution trade (D-006).
  rowBreakBytes: [0x0a, 0x2c, 0x3b, 0x09]
}

/** CSV needs no ancestor-derived scope to resume mid-document (§ R146/R147 below):
 * `parseRange` re-derives the dialect and header directly from `source`, since the
 * header always sits at a fixed, unmoved position (offset 0, past any BOM) that a
 * single-row splice elsewhere in the file never touches. */
const CSV_RESUME_CONTEXT: ResumeContext = { formatId: 'csv' }

const PROGRESS_INTERVAL_BYTES = 1024 * 1024

export interface FieldSpan {
  readonly start: Offset
  readonly end: Offset
}

class ParserState {
  pos: number
  diagnosticCount = 0
  private lastProgressAt = 0

  constructor(
    readonly source: Uint8Array,
    readonly sink: NodeSink,
    readonly options: ParseOptions,
    readonly dialect: CsvDialect,
    start: number
  ) {
    this.pos = start
  }

  emit(severity: Severity, code: string, offset: Offset, length: number, message: string): void {
    const d: Diagnostic = { severity, code, offset, length, message }
    this.sink.diagnostic(d)
    this.diagnosticCount++
  }

  reportProgress(): void {
    if (this.pos - this.lastProgressAt >= PROGRESS_INTERVAL_BYTES) {
      this.lastProgressAt = this.pos
      this.sink.progress(this.pos)
    }
  }

  atEnd(): boolean {
    return this.pos >= this.source.length
  }
}

/**
 * Scans exactly one field starting at `state.pos`. A quoted field's span excludes the
 * surrounding quotes (matching XML's attribute-value convention, not JSON's — see
 * `gridCell.ts`'s own `stripJsonStringQuotes` for why that distinction matters to the
 * grid) so a quoted and an unquoted field with the same content render identically.
 * A doubled `""` escape inside a quoted field is left in the span as written, undecoded
 * — the same "never decode a scalar, copy the bytes verbatim" rule that leaves XML
 * entity references (`&amp;`) undecoded elsewhere in this codebase.
 *
 * Never throws (invariant 5): an unterminated quote at EOF closes the field where the
 * input ends and emits an Error diagnostic (§9) rather than losing the rest of the row.
 */
function scanField(state: ParserState): FieldSpan {
  const { source, dialect } = state
  if (source[state.pos] === dialect.quote) {
    state.pos++ // opening quote
    const start = state.pos
    while (state.pos < source.length) {
      const b = source[state.pos]!
      if (b === dialect.quote) {
        if (source[state.pos + 1] === dialect.quote) {
          state.pos += 2
          continue
        }
        const end = state.pos
        state.pos++ // closing quote
        // Lenient with anything between the closing quote and the next
        // delimiter/newline (not valid RFC 4180, but invariant 5 says
        // continue rather than throw) — skip it without extending the field.
        while (
          state.pos < source.length &&
          source[state.pos] !== dialect.delimiter &&
          !isNewlineByte(source[state.pos]!)
        ) {
          state.pos++
        }
        return { start, end }
      }
      state.pos++
    }
    // Unterminated quote: close at EOF and keep the partial tree.
    state.emit(
      Severity.Error,
      'csv.unterminated-quote',
      start - 1,
      state.pos - start + 1,
      'Unterminated quoted field'
    )
    return { start, end: state.pos }
  }

  const start = state.pos
  while (
    state.pos < source.length &&
    source[state.pos] !== dialect.delimiter &&
    !isNewlineByte(source[state.pos]!)
  ) {
    state.pos++
  }
  return { start, end: state.pos }
}

/** Consumes one CRLF/LF/CR line ending at `state.pos`, if any is there. */
function consumeNewline(state: ParserState): void {
  const b = state.source[state.pos]
  if (b === undefined) return
  if (b === CR) {
    state.pos++
    if (state.source[state.pos] === LF) state.pos++
    return
  }
  if (b === LF) state.pos++
}

/**
 * Scans one logical row (a run of fields separated by `dialect.delimiter`, terminated by
 * a line ending or EOF) into `FieldSpan`s, without touching the sink — the header row and
 * every data row are both scanned this way, but only data rows become nodes.
 */
function scanRow(state: ParserState): FieldSpan[] {
  const fields: FieldSpan[] = [scanField(state)]
  while (state.source[state.pos] === state.dialect.delimiter) {
    state.pos++
    fields.push(scanField(state))
  }
  consumeNewline(state)
  return fields
}

/**
 * Parses one data row at `state.pos` into an unnamed `Object` node, naming each field's
 * facet from `header`'s spans. §9's diagnostics: a short row's missing trailing fields
 * are simply never emitted (D-068: absent, not empty — the grid already renders a
 * missing facet as `Absent`); a long row's extra fields beyond `header.length` all share
 * one empty name span, so they collapse into a single catch-all "extra fields" column
 * rather than being dropped — accepted for what is already a Warning-flagged, malformed
 * row (a *second* extra field on the *same* row still collides with the first and is
 * lost, disclosed in `docs/plans/R145-csv.md`'s Owed entry rather than fixed here).
 */
function parseRow(state: ParserState, header: readonly FieldSpan[]): void {
  const rowStart = state.pos
  const fields = scanRow(state)

  if (fields.length < header.length) {
    state.emit(
      Severity.Warning,
      'csv.short-row',
      rowStart,
      state.pos - rowStart,
      `Row has ${fields.length} field(s), fewer than the ${header.length}-column header`
    )
  } else if (fields.length > header.length) {
    state.emit(
      Severity.Warning,
      'csv.long-row',
      rowStart,
      state.pos - rowStart,
      `Row has ${fields.length} field(s), more than the ${header.length}-column header`
    )
  }

  const node = state.sink.openNode(NodeKind.Object, rowStart, -1, -1)
  const n = Math.min(fields.length, header.length)
  for (let k = 0; k < n; k++) {
    const name = header[k]!
    const field = fields[k]!
    state.sink.attribute(name.start, name.end, field.start, field.end)
  }
  for (let k = header.length; k < fields.length; k++) {
    const field = fields[k]!
    // Extra, unheadered field: no bytes to name it with (§3) — an empty span,
    // which every such field across the document shares one interned id for.
    state.sink.attribute(field.start, field.start, field.start, field.end)
  }
  state.sink.closeNode(node, state.pos)
}

function parse(source: Uint8Array, sink: NodeSink, options: ParseOptions): ParseResult {
  const bomLength = bomLengthAt(source)
  const dialect = sniffDialect(source, bomLength)
  const doc = sink.openNode(NodeKind.Document, 0, -1, -1)

  const state = new ParserState(source, sink, options, dialect, bomLength)

  if (state.atEnd()) {
    const arr = sink.openNode(NodeKind.Array, state.pos, -1, -1)
    sink.closeNode(arr, state.pos)
    sink.closeNode(doc, source.length)
    return { complete: true, bytesConsumed: state.pos, diagnosticCount: 0 }
  }

  // §3: row 1 is always treated as the header — the probe (`header.ts`'s own doc
  // comment) found the alternative (an empty facet name per headerless column)
  // collides every such column into one interned id and silently drops data, which
  // rules it out without a `core/types.ts` change. When the has-header heuristic finds
  // no support for that assumption, it is disclosed rather than left unremarked.
  const header = scanRow(state)
  if (!detectHeader(source, dialect, header, state.pos)) {
    state.emit(
      Severity.Warning,
      'csv.no-header-detected',
      bomLength,
      state.pos - bomLength,
      'No header row was detected; the first row was used as column names anyway, ' +
        'so its data does not appear as a record. Headerless CSV column naming is not yet supported.'
    )
  }

  const arr = sink.openNode(NodeKind.Array, state.pos, -1, -1)
  while (!state.atEnd()) {
    state.reportProgress()
    if (options.signal?.aborted) {
      sink.closeNode(arr, state.pos)
      sink.closeNode(doc, source.length)
      return { complete: false, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
    }
    parseRow(state, header)
  }
  sink.closeNode(arr, state.pos)
  sink.closeNode(doc, source.length)

  return { complete: true, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
}

/**
 * Reparses a single row (`[start, end)`, the caller's guarantee). The header is
 * re-derived fresh from `source` rather than threaded through `context` — it always sits
 * at a fixed, unmoved offset (0, past any BOM) that a single-row splice elsewhere in the
 * file never touches, so re-scanning ~one row's worth of bytes is both correct and cheap
 * (R31: this is exactly the case the splice mechanism's own `bytesConsumed !==
 * newSpanEnd` safety net was validated against, for when it is *not* cheap — an edit
 * inside the header itself falls outside `[start, end)`'s guarantee and is caught there).
 */
function parseRange(
  source: Uint8Array,
  start: Offset,
  end: Offset,
  sink: NodeSink,
  _context: ResumeContext,
  options: ParseOptions
): ParseResult {
  const bomLength = bomLengthAt(source)
  const dialect = sniffDialect(source, bomLength)
  const headerState = new ParserState(source, sink, options, dialect, bomLength)
  const header = headerState.atEnd() ? [] : scanRow(headerState)

  const state = new ParserState(source, sink, options, dialect, start)
  parseRow(state, header)

  return {
    complete: state.pos <= end,
    bytesConsumed: state.pos,
    diagnosticCount: state.diagnosticCount
  }
}

function resumeContextFor(_ancestors: AncestorView): ResumeContext {
  return CSV_RESUME_CONTEXT
}

function detect(_head: Uint8Array, filename: string | null): number {
  // Extension-only (§5): CSV never inspects content to decide it is CSV. Every text
  // file has commas and newlines, so there is no cheap unambiguous content check the
  // way `<` identifies XML or `{`/`[` identifies JSON — a tabular-looking heuristic
  // would risk hijacking another format's file, silently and without recourse.
  if (filename !== null) {
    const lower = filename.toLowerCase()
    if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.tab')) return 0.9
  }
  return 0
}

function detectEncoding(): string | null {
  return null
}

export const csvFormatModule: FormatModule = {
  capabilities: csvCapabilities,
  detect,
  detectEncoding,
  parse,
  parseRange,
  resumeContextFor
}
