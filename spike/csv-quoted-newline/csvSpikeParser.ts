/**
 * R31 (`R31-csv-spike.md`) — a minimal, spike-quality CSV parser
 * exercising exactly the shape the real question is about: does
 * incremental reparse (`subtreeSplice.ts`) stay correct when a quoted
 * field can contain a raw newline, without `resumeContextFor` needing any
 * CSV-specific state?
 *
 * **Not a real `FormatModule`** — no dialect sniffing, no header-row
 * handling, no `format()`. It exists only to be a real, spec-shaped
 * implementation of `parse`/`parseRange`/`resumeContextFor` that the real
 * production `subtreeSplice.ts` can be pointed at, the same way
 * `test/subtreeSplice.test.ts` points it at the real XML/JSON/TOML
 * modules. If CSV proper gets built, this is a sketch to start from, not
 * code to promote as-is.
 *
 * Grammar (RFC 4180-ish, lenient): `Document -> Row* -> Field*`, comma-
 * separated fields, `\r\n`/`\n`/EOF row terminators, `""` as the escape for
 * a literal quote inside a quoted field. `Row` uses `NodeKind.Array`,
 * `Field` uses `NodeKind.Scalar` — there is no natural existing `NodeKind`
 * for "CSV record"/"CSV field" (invariant: never modify `core/types.ts`),
 * and the spike doesn't need one to answer its own question.
 */
import {
  NodeKind,
  Severity,
  type AncestorView,
  type FormatModule,
  type NodeSink,
  type Offset,
  type ParseOptions,
  type ParseResult,
  type ResumeContext
} from '../../src/core/types'

const COMMA = 0x2c
const QUOTE = 0x22
const CR = 0x0d
const LF = 0x0a

type CsvResumeKind = 'document' | 'row' | 'field'

interface CsvResumeContext extends ResumeContext {
  readonly resumeKind: CsvResumeKind
}

class ParserState {
  pos: Offset
  fatal = false
  diagnosticCount = 0

  constructor(
    readonly source: Uint8Array,
    readonly sink: NodeSink,
    start: Offset
  ) {
    this.pos = start
  }

  atEnd(): boolean {
    return this.pos >= this.source.length
  }

  emit(severity: Severity, code: string, offset: Offset, length: number, message: string): void {
    this.diagnosticCount++
    this.sink.diagnostic({ severity, code, offset, length, message })
  }
}

/**
 * Parses exactly one field (quoted or bare), starting at `state.pos`.
 * **Self-contained by construction**: every decision here depends only on
 * bytes at or after `state.pos` — never on anything before it, which is
 * the property the whole spike exists to establish (§2b: "is quote state
 * a property of any ancestor?" — this function is the proof it doesn't
 * need to be one).
 */
function parseField(state: ParserState): void {
  const { source, sink } = state
  const start = state.pos
  if (!state.atEnd() && source[state.pos] === QUOTE) {
    state.pos++
    for (;;) {
      if (state.pos >= source.length) {
        state.emit(
          Severity.Error,
          'csv.unterminated-quote',
          start,
          state.pos - start,
          'Quoted field is never closed'
        )
        break
      }
      const b = source[state.pos]!
      if (b === QUOTE) {
        if (state.pos + 1 < source.length && source[state.pos + 1] === QUOTE) {
          state.pos += 2 // "" — escaped literal quote
          continue
        }
        state.pos++ // the real closing quote
        break
      }
      state.pos++ // any other byte, including a raw newline — this is the
      // whole point: a newline inside quotes is just field content.
    }
  } else {
    while (
      !state.atEnd() &&
      source[state.pos] !== COMMA &&
      source[state.pos] !== CR &&
      source[state.pos] !== LF
    ) {
      state.pos++
    }
  }
  const field = sink.openNode(NodeKind.Scalar, start, -1, -1)
  sink.value(start, state.pos)
  sink.closeNode(field, state.pos)
}

function consumeTerminator(state: ParserState): void {
  const { source } = state
  if (state.atEnd()) return
  if (source[state.pos] === CR) {
    state.pos++
    if (!state.atEnd() && source[state.pos] === LF) state.pos++
    return
  }
  if (source[state.pos] === LF) state.pos++
}

/** Parses exactly one row (its fields plus its own terminator), starting
 * at `state.pos`. A row always starts right after a genuine, unquoted
 * newline (or at byte 0) by construction — there is no quote state to
 * inherit here either. */
function parseRow(state: ParserState): void {
  const { sink, source } = state
  const rowStart = state.pos
  const row = sink.openNode(NodeKind.Array, rowStart, -1, -1)
  parseField(state)
  while (!state.atEnd() && source[state.pos] === COMMA) {
    state.pos++
    parseField(state)
  }
  consumeTerminator(state)
  sink.closeNode(row, state.pos)
}

function parseRows(state: ParserState): void {
  while (state.pos < state.source.length) {
    parseRow(state)
    state.sink.progress(state.pos)
  }
}

function csvParse(source: Uint8Array, sink: NodeSink, _options: ParseOptions): ParseResult {
  const state = new ParserState(source, sink, 0)
  const doc = sink.openNode(NodeKind.Document, 0, -1, -1)
  parseRows(state)
  sink.closeNode(doc, state.pos)
  return { complete: !state.fatal, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
}

function csvParseRange(
  source: Uint8Array,
  start: Offset,
  end: Offset,
  sink: NodeSink,
  context: ResumeContext,
  _options: ParseOptions
): ParseResult {
  const state = new ParserState(source, sink, start)
  const kind = (context as CsvResumeContext).resumeKind
  if (kind === 'document') {
    const doc = sink.openNode(NodeKind.Document, start, -1, -1)
    parseRows(state)
    sink.closeNode(doc, state.pos)
  } else if (kind === 'row') {
    parseRow(state)
  } else {
    parseField(state)
  }
  return {
    complete: !state.fatal && state.pos <= end,
    bytesConsumed: state.pos,
    diagnosticCount: state.diagnosticCount
  }
}

/**
 * Derived purely from ancestor *shape* (how many ancestors, and by
 * implication which kind the node-being-resumed must be) — no CSV-specific
 * state at all, matching JSON's own `resumeContextFor` (a constant) more
 * than TOML's (which genuinely needs the ancestor chain's *content*, not
 * just its length, to recover table paths). §2b's premise was that quote
 * state is "a property of every byte before the resume point" and
 * therefore NOT ancestor-derivable — this function is the concrete claim
 * that, for this grammar, nothing CSV-specific needs deriving in the first
 * place: a Field's own span already starts exactly at its own delimiter
 * (quote or field-start), a Row's span always starts right after a real
 * newline, and the Document is the Document.
 */
function csvResumeContextFor(ancestors: AncestorView): ResumeContext {
  if (ancestors.length === 0) {
    const ctx: CsvResumeContext = { formatId: 'csv', resumeKind: 'document' }
    return ctx
  }
  if (ancestors.length === 1) {
    const ctx: CsvResumeContext = { formatId: 'csv', resumeKind: 'row' }
    return ctx
  }
  const ctx: CsvResumeContext = { formatId: 'csv', resumeKind: 'field' }
  return ctx
}

export const csvSpikeFormatModule: FormatModule = {
  capabilities: {
    id: 'csv-spike',
    displayName: 'CSV (spike, not a real format)',
    extensions: ['.csv'],
    hasAttributes: false,
    hasComments: false,
    hasNamespaces: false,
    canFormat: false,
    canIncrementalReparse: true,
    rowBreakBytes: [COMMA, LF]
  },
  detect: () => 0,
  detectEncoding: () => null,
  parse: csvParse,
  parseRange: csvParseRange,
  resumeContextFor: csvResumeContextFor
}
