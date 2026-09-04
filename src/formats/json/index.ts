import {
  type AncestorView,
  type Diagnostic,
  type FormatCapabilities,
  type FormatModule,
  type FormatOptions,
  NodeKind,
  type NodeRef,
  type NodeSink,
  type Offset,
  type ParseOptions,
  type ParseResult,
  type ResumeContext,
  Severity
} from '../../core/types'
import { bomLengthAt } from '../../core/encoding'
import { GrowableBytes } from '../../core/growableBytes'

const OPEN_BRACE = 0x7b // {
const CLOSE_BRACE = 0x7d // }
const OPEN_BRACKET = 0x5b // [
const CLOSE_BRACKET = 0x5d // ]
const COLON = 0x3a
const COMMA = 0x2c
const QUOTE = 0x22
const BACKSLASH = 0x5c
const MINUS = 0x2d

function isWhitespace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39
}

function isNumberByte(b: number): boolean {
  return isDigit(b) || b === MINUS || b === 0x2b || b === 0x2e || b === 0x65 || b === 0x45 // + . e E
}

export const jsonCapabilities: FormatCapabilities = {
  id: 'json',
  displayName: 'JSON',
  extensions: ['.json'],
  hasAttributes: false,
  hasComments: false,
  hasNamespaces: false,
  canFormat: true,
  canIncrementalReparse: true,
  rowBreakBytes: [COMMA, CLOSE_BRACE, CLOSE_BRACKET]
}

/** JSON needs no scope state to resume mid-document — the resume context is a constant. */
const JSON_RESUME_CONTEXT: ResumeContext = { formatId: 'json' }

// ---------------------------------------------------------------------------
// Container-frame stack — the parser's only recursion substitute.
// ---------------------------------------------------------------------------

const enum ContainerKind {
  Object,
  Array
}

const enum ObjectState {
  ExpectKeyOrClose,
  ExpectColon,
  ExpectValue,
  ExpectCommaOrClose
}

const enum ArrayState {
  ExpectValueOrClose,
  ExpectCommaOrClose
}

interface ObjectFrame {
  kind: ContainerKind.Object
  node: NodeRef
  state: ObjectState
  /** The Property node currently open and awaiting its value, if any. */
  pendingProperty: NodeRef | null
  /** Property this container is itself the value of, closed when this frame pops. */
  closesProperty: NodeRef | null
}

interface ArrayFrame {
  kind: ContainerKind.Array
  node: NodeRef
  state: ArrayState
  closesProperty: NodeRef | null
}

type Frame = ObjectFrame | ArrayFrame

/** Threaded through one call to `runParser`; not reused across parses. */
const PROGRESS_INTERVAL_BYTES = 1024 * 1024

class ParserState {
  pos: number
  diagnosticCount = 0
  fatal = false
  private lastProgressAt = 0

  constructor(
    readonly source: Uint8Array,
    readonly sink: NodeSink,
    readonly options: ParseOptions,
    start: number
  ) {
    this.pos = start
  }

  emit(severity: Severity, code: string, offset: Offset, length: number, message: string): void {
    const d: Diagnostic = { severity, code, offset, length, message }
    this.sink.diagnostic(d)
    this.diagnosticCount++
    if (severity === Severity.Fatal) this.fatal = true
  }

  /** Coarse progress signal (~1 MB) for the worker to relay to the UI. */
  reportProgress(): void {
    if (this.pos - this.lastProgressAt >= PROGRESS_INTERVAL_BYTES) {
      this.lastProgressAt = this.pos
      this.sink.progress(this.pos)
    }
  }

  skipWhitespace(): void {
    while (this.pos < this.source.length && isWhitespace(this.source[this.pos]!)) this.pos++
  }

  atEnd(): boolean {
    return this.pos >= this.source.length
  }

  peek(): number {
    return this.source[this.pos]!
  }

  /** Scans a JSON string starting at an opening quote; returns the offset just past the closing quote. */
  scanString(): number {
    const start = this.pos
    this.pos++ // opening quote
    while (this.pos < this.source.length) {
      const b = this.source[this.pos]!
      if (b === BACKSLASH) {
        this.pos += 2 // skip the escaped byte too, whatever it is
        continue
      }
      if (b === QUOTE) {
        this.pos++
        return this.pos
      }
      this.pos++
    }
    this.emit(
      Severity.Fatal,
      'json.unterminated-string',
      start,
      this.pos - start,
      'Unterminated string'
    )
    return this.pos
  }

  scanNumber(): number {
    while (this.pos < this.source.length && isNumberByte(this.source[this.pos]!)) this.pos++
    return this.pos
  }

  scanLiteral(literal: string): number {
    const start = this.pos
    const bytes = literal.length
    let matched = true
    for (let i = 0; i < bytes; i++) {
      if (this.source[this.pos + i] !== literal.charCodeAt(i)) {
        matched = false
        break
      }
    }
    if (matched) {
      this.pos += bytes
      return this.pos
    }
    this.emit(Severity.Error, 'json.bad-literal', start, 1, `Invalid literal near offset ${start}`)
    this.pos++
    return this.pos
  }
}

/** True if the byte at `pos` starts a JSON scalar token (string, number, or literal). */
function startsScalar(b: number): boolean {
  return b === QUOTE || isDigit(b) || b === MINUS || b === 0x74 || b === 0x66 || b === 0x6e // t f n
}

/**
 * Scans exactly one scalar token starting at `state.pos` and returns its
 * span. Does not touch the sink — callers decide whether it folds into an
 * already-open node or becomes a new unnamed Scalar.
 */
function scanScalarToken(state: ParserState): { start: Offset; end: Offset } {
  const start = state.pos
  const b = state.peek()
  let end: number
  if (b === QUOTE) end = state.scanString()
  else if (isDigit(b) || b === MINUS) end = state.scanNumber()
  else if (b === 0x74) end = state.scanLiteral('true')
  else if (b === 0x66) end = state.scanLiteral('false')
  else end = state.scanLiteral('null')
  return { start, end }
}

/**
 * Parses exactly one JSON value at `state.pos` (object, array, or scalar) and
 * emits it into `sink`. A scalar here always becomes an unnamed `Scalar` node
 * — this is only ever called for a slot with no Property to fold into (the
 * top-level value, or a `parseRange` target): B8's scalar-folding rule folds
 * a Property's scalar value into the Property itself, which happens inline
 * in `stepObject` below, never through here.
 *
 * Iterative: recursion is replaced by the explicit `stack` of open
 * containers, so arbitrarily deep nesting cannot overflow the call stack.
 */
function parseOneValue(state: ParserState): void {
  state.skipWhitespace()
  if (state.atEnd()) {
    state.emit(Severity.Fatal, 'json.unexpected-eof', state.pos, 0, 'Expected a value')
    return
  }

  const first = state.peek()
  if (first !== OPEN_BRACE && first !== OPEN_BRACKET) {
    const { start, end } = scanScalarToken(state)
    const scalar = state.sink.openNode(NodeKind.Scalar, start, -1, -1)
    state.sink.value(start, end)
    state.sink.closeNode(scalar, end)
    return
  }

  const stack: Frame[] = []
  const rootKind = first === OPEN_BRACE ? ContainerKind.Object : ContainerKind.Array
  const rootNode = openContainer(state, rootKind)
  pushFrame(stack, rootKind, rootNode, null)

  while (stack.length > 0) {
    state.reportProgress()
    const frame = stack[stack.length - 1]!
    if (stack.length > state.options.maxDepth) {
      state.emit(
        Severity.Fatal,
        'json.max-depth-exceeded',
        state.pos,
        0,
        `Nesting exceeds maxDepth (${state.options.maxDepth})`
      )
      // Close what's open so far so the store is left consistent.
      while (stack.length > 0) popFrame(state, stack)
      return
    }

    if (state.options.signal?.aborted) {
      while (stack.length > 0) popFrame(state, stack)
      return
    }

    state.skipWhitespace()
    if (state.atEnd()) {
      state.emit(Severity.Fatal, 'json.unexpected-eof', state.pos, 0, 'Unexpected end of input')
      while (stack.length > 0) popFrame(state, stack)
      return
    }

    if (frame.kind === ContainerKind.Object) {
      stepObject(state, stack, frame)
    } else {
      stepArray(state, stack, frame)
    }
  }
}

function openContainer(state: ParserState, kind: ContainerKind): NodeRef {
  const node = state.sink.openNode(
    kind === ContainerKind.Object ? NodeKind.Object : NodeKind.Array,
    state.pos,
    -1,
    -1
  )
  state.pos++ // consume '{' or '['
  return node
}

function pushFrame(
  stack: Frame[],
  kind: ContainerKind,
  node: NodeRef,
  closesProperty: NodeRef | null
): void {
  if (kind === ContainerKind.Object) {
    stack.push({
      kind,
      node,
      state: ObjectState.ExpectKeyOrClose,
      pendingProperty: null,
      closesProperty
    })
  } else {
    stack.push({ kind, node, state: ArrayState.ExpectValueOrClose, closesProperty })
  }
}

/**
 * Pops the innermost frame and closes its node. If that frame was itself the
 * value of an enclosing object property (`closesProperty`), also closes that
 * Property now — deferred from when the child was pushed, since the
 * Property must stay open for its whole value's duration.
 */
function popFrame(state: ParserState, stack: Frame[]): void {
  const frame = stack.pop()!
  if (frame.kind === ContainerKind.Object && frame.pendingProperty !== null) {
    // Reached here (EOF, an aborted parse, or max-depth) with a property's
    // key parsed but no value yet (`ObjectState.ExpectColon` or
    // `ExpectValue`) — that Property node is still open and, having been
    // opened after `frame.node`, is the innermost thing on the store's own
    // open-node stack. It must close before `frame.node` does, or
    // `closeNode` below desyncs that stack: it throws in dev builds
    // (`closeNode(...) does not match innermost open node`) and silently
    // corrupts spans/parentage in production, since the store's stack
    // still pops *something*, just not what `frame.node` expects.
    state.sink.closeNode(frame.pendingProperty, state.pos)
    frame.pendingProperty = null
  }
  state.sink.closeNode(frame.node, state.pos)
  if (frame.closesProperty !== null) {
    state.sink.closeNode(frame.closesProperty, state.pos)
    const parent = stack[stack.length - 1] as ObjectFrame | undefined
    if (parent !== undefined) {
      parent.pendingProperty = null
      parent.state = ObjectState.ExpectCommaOrClose
    }
  }
}

function stepObject(state: ParserState, stack: Frame[], frame: ObjectFrame): void {
  const b = state.peek()

  if (
    frame.state === ObjectState.ExpectKeyOrClose ||
    frame.state === ObjectState.ExpectCommaOrClose
  ) {
    if (b === CLOSE_BRACE) {
      state.pos++
      popFrame(state, stack)
      return
    }
  }

  if (frame.state === ObjectState.ExpectCommaOrClose) {
    if (b === COMMA) {
      state.pos++
      frame.state = ObjectState.ExpectKeyOrClose
      return
    }
    state.emit(Severity.Error, 'json.expected-comma-or-close', state.pos, 1, "Expected ',' or '}'")
    state.pos++
    return
  }

  if (frame.state === ObjectState.ExpectKeyOrClose) {
    if (b !== QUOTE) {
      state.emit(Severity.Error, 'json.expected-key', state.pos, 1, 'Expected a property name')
      state.pos++
      return
    }
    const keyStart = state.pos
    const keyEnd = state.scanString()
    // Intern the key's text, excluding the surrounding quotes.
    frame.pendingProperty = state.sink.openNode(
      NodeKind.Property,
      keyStart,
      keyStart + 1,
      keyEnd - 1
    )
    frame.state = ObjectState.ExpectColon
    return
  }

  if (frame.state === ObjectState.ExpectColon) {
    if (b !== COLON) {
      state.emit(Severity.Error, 'json.expected-colon', state.pos, 1, "Expected ':'")
      // Recover by proceeding as if the colon were present.
    } else {
      state.pos++
    }
    frame.state = ObjectState.ExpectValue
    return
  }

  // ObjectState.ExpectValue
  const property = frame.pendingProperty!
  if (b === OPEN_BRACE || b === OPEN_BRACKET) {
    const childKind = b === OPEN_BRACE ? ContainerKind.Object : ContainerKind.Array
    const childNode = openContainer(state, childKind)
    // Stays open until the child container closes (popFrame reconciles it);
    // frame.state advances then, not here — the value isn't done yet.
    pushFrame(stack, childKind, childNode, property)
    return
  }
  const { start, end } = scanScalarToken(state)
  state.sink.value(start, end)
  state.sink.closeNode(property, end)
  frame.pendingProperty = null
  frame.state = ObjectState.ExpectCommaOrClose
}

function stepArray(state: ParserState, stack: Frame[], frame: ArrayFrame): void {
  const b = state.peek()

  if (
    frame.state === ArrayState.ExpectValueOrClose ||
    frame.state === ArrayState.ExpectCommaOrClose
  ) {
    if (b === CLOSE_BRACKET) {
      state.pos++
      popFrame(state, stack)
      return
    }
  }

  if (frame.state === ArrayState.ExpectCommaOrClose) {
    if (b === COMMA) {
      state.pos++
      frame.state = ArrayState.ExpectValueOrClose
      return
    }
    state.emit(Severity.Error, 'json.expected-comma-or-close', state.pos, 1, "Expected ',' or ']'")
    state.pos++
    return
  }

  // ArrayState.ExpectValueOrClose
  if (b === OPEN_BRACE || b === OPEN_BRACKET) {
    const childKind = b === OPEN_BRACE ? ContainerKind.Object : ContainerKind.Array
    const childNode = openContainer(state, childKind)
    pushFrame(stack, childKind, childNode, null)
    frame.state = ArrayState.ExpectCommaOrClose
    return
  } else if (startsScalar(b)) {
    const { start, end } = scanScalarToken(state)
    const scalar = state.sink.openNode(NodeKind.Scalar, start, -1, -1)
    state.sink.value(start, end)
    state.sink.closeNode(scalar, end)
  } else {
    state.emit(Severity.Error, 'json.expected-value', state.pos, 1, 'Expected a value')
    state.pos++
    return
  }
  frame.state = ArrayState.ExpectCommaOrClose
}

// ---------------------------------------------------------------------------
// FormatModule
// ---------------------------------------------------------------------------

function detect(head: Uint8Array, filename: string | null): number {
  if (filename !== null && filename.toLowerCase().endsWith('.json')) return 0.9
  for (let i = 0; i < head.length; i++) {
    const b = head[i]!
    if (isWhitespace(b)) continue
    if (b === OPEN_BRACE || b === OPEN_BRACKET) return 0.7
    return 0
  }
  return 0
}

function detectEncoding(): string | null {
  return null
}

function parse(source: Uint8Array, sink: NodeSink, options: ParseOptions): ParseResult {
  // A BOM at offset 0 is skipped in place, never stripped — spans stay
  // absolute in the original buffer (C1). JSON has no leading-whitespace
  // rule that would otherwise swallow it.
  const state = new ParserState(source, sink, options, bomLengthAt(source))
  const doc = sink.openNode(NodeKind.Document, 0, -1, -1)
  parseOneValue(state)
  state.skipWhitespace()
  if (!state.atEnd() && !state.fatal) {
    state.emit(
      Severity.Error,
      'json.trailing-content',
      state.pos,
      source.length - state.pos,
      'Unexpected trailing content after the top-level value'
    )
  }
  sink.closeNode(doc, source.length)
  return {
    complete: !state.fatal,
    bytesConsumed: state.pos,
    diagnosticCount: state.diagnosticCount
  }
}

function parseRange(
  source: Uint8Array,
  start: Offset,
  end: Offset,
  sink: NodeSink,
  _context: ResumeContext,
  options: ParseOptions
): ParseResult {
  const state = new ParserState(source, sink, options, start)
  parseOneValue(state)
  return {
    complete: !state.fatal && state.pos <= end,
    bytesConsumed: state.pos,
    diagnosticCount: state.diagnosticCount
  }
}

function resumeContextFor(_ancestors: AncestorView): ResumeContext {
  return JSON_RESUME_CONTEXT
}

/**
 * Conservative pretty-printer and minifier — the same traversal with a
 * different whitespace policy (M5-PLAN.md H5), not two implementations.
 * Re-tokenizes the source with the same scanner used for parsing (never
 * decoding scalars — every number and string is copied verbatim via
 * `GrowableBytes.pushBytes`, so `1e400`, `1.0`, `-0` and integers past
 * 2^53 all survive a round trip, and no string is decoded then
 * re-encoded) and re-emits with the chosen whitespace — safe
 * unconditionally for JSON, unlike XML's mixed-content hazard (§5.7).
 *
 * **Minify is selected by `options.indent === ''`.** `FormatOptions`
 * (`core/types.ts`, not to be modified per the M5 hard rules) has no
 * separate minify flag — an empty indent already has no other meaning
 * ("indent by nothing" degenerates to "no indentation," which is what
 * minifying starts from), so it doubles as the mode switch rather than
 * extending the contract. When minified, the `newline` option is not
 * read at all: minifying means *no* whitespace between tokens, not "the
 * same whitespace with a different newline style," and `': '`'s space
 * after a colon also drops to `':'`.
 *
 * **The BOM, if any, is preserved and skipped before scanning** — like
 * `parse()` itself (`bomLengthAt(source)`, below), not like this
 * function's own pre-M5 version, which started at offset 0 regardless.
 * Unfixed, a BOM byte reached `formatValue` as if it were the start of a
 * value, matched none of the scalar-starting bytes, and silently
 * corrupted the output via `scanLiteral`'s own malformed-input fallback
 * — invariant 7 requires the BOM survive a Transform, not just parsing.
 */
// ---------------------------------------------------------------------------
// format() pass-2 frame stack (M5h-PLAN.md R18, §4). `formatValue`/
// `formatContainer`/`formatObjectBody`/`formatArrayBody` used to be mutually
// recursive over document structure, with no depth bound of their own —
// the exact invariant-4 shape `xml/index.ts`'s own formatter was found to
// have (`M5h-PLAN.md`'s §1), and confirmed to affect this file too by
// the same depth-100/1000/5000/9000 check: this recurses into the JS call
// stack once per level of `{`/`[` nesting and overflows at depth 5 000,
// well inside `DEFAULT_MAX_DEPTH`. Rewritten as one explicit `FormatFrame`
// stack, the same shape `stepObject`/`stepArray` already use for *parsing*
// above (`Frame`, this file's own local model to follow) and the shape
// `xml/index.ts`'s own pass 2 was rewritten into for the same reason.
// Unlike XML's two-pass design, this formatter is single-pass (no separate
// depth-limited "pass 1" to align, per §2b) — and once iterative, nothing
// here can overflow the call stack regardless of how deep the document
// nests, so there is no throw left for a §2c-style degrade path to guard
// against either.
// ---------------------------------------------------------------------------

const enum FormatContainerKind {
  Object,
  Array
}

interface FormatObjectFrame {
  readonly kind: FormatContainerKind.Object
  // Reuses the parser's own `ObjectState`/`ArrayState` (not redeclared) —
  // the state machine really is the same shape (expect a key or the close
  // brace; expect a value; expect a comma or the close brace), just walked
  // for re-emission instead of tree-building. `ObjectState.ExpectColon`
  // is unused here: this formatter's own key-scanning step consumes the
  // colon inline before moving to `ExpectValue`, one step earlier than the
  // parser's own frame needs to.
  state: ObjectState
  /** Whether the container was non-empty *at open* — decides whether a
   * closing indent is emitted, mirroring the old `hadMembers` (which was
   * always `true` once the body function ran at all, since it only ever
   * ran when non-empty at entry). */
  readonly nonEmpty: boolean
}

interface FormatArrayFrame {
  readonly kind: FormatContainerKind.Array
  state: ArrayState
  readonly nonEmpty: boolean
}

type FormatFrame = FormatObjectFrame | FormatArrayFrame

function format(source: Uint8Array, options: FormatOptions): Uint8Array {
  const minified = options.indent === ''
  const bomLength = bomLengthAt(source)
  const out = new GrowableBytes(Math.max(1024, source.length))
  out.pushBytes(source, 0, bomLength)

  const noop: ParseOptions = { maxDepth: 100_000, encoding: 'utf-8' }
  const state = new ParserState(source, silentSink, noop, bomLength)
  const indentAt = (d: number): string =>
    minified ? '' : options.newline + options.indent.repeat(d)

  const stack: FormatFrame[] = []

  /** Emits a scalar at `state.pos`, or pushes a new frame for `{`/`[`
   * instead of recursing into a value-formatting call — the fix. Returns
   * `false` at end-of-input with nothing to emit (mirrors the old
   * `formatValue`'s own silent `return` on `atEnd()`, reachable only for a
   * truncated/malformed document). */
  function stepValue(): boolean {
    state.skipWhitespace()
    if (state.atEnd()) return false
    const b = state.peek()
    if (b === OPEN_BRACE) {
      out.push(OPEN_BRACE)
      state.pos++
      state.skipWhitespace()
      const nonEmpty = !state.atEnd() && state.peek() !== CLOSE_BRACE
      stack.push({
        kind: FormatContainerKind.Object,
        state: ObjectState.ExpectKeyOrClose,
        nonEmpty
      })
    } else if (b === OPEN_BRACKET) {
      out.push(OPEN_BRACKET)
      state.pos++
      state.skipWhitespace()
      const nonEmpty = !state.atEnd() && state.peek() !== CLOSE_BRACKET
      stack.push({
        kind: FormatContainerKind.Array,
        state: ArrayState.ExpectValueOrClose,
        nonEmpty
      })
    } else {
      const { start, end } = scanScalarToken(state)
      out.pushBytes(source, start, end)
    }
    return true
  }

  function closeObjectFrame(frame: FormatObjectFrame): void {
    if (!state.atEnd() && state.peek() === CLOSE_BRACE) state.pos++
    if (frame.nonEmpty) out.pushAscii(indentAt(stack.length - 1))
    out.push(CLOSE_BRACE)
    stack.pop()
  }

  function closeArrayFrame(frame: FormatArrayFrame): void {
    if (!state.atEnd() && state.peek() === CLOSE_BRACKET) state.pos++
    if (frame.nonEmpty) out.pushAscii(indentAt(stack.length - 1))
    out.push(CLOSE_BRACKET)
    stack.pop()
  }

  function stepObjectFrame(frame: FormatObjectFrame): void {
    if (frame.state === ObjectState.ExpectKeyOrClose) {
      state.skipWhitespace()
      if (state.atEnd() || state.peek() === CLOSE_BRACE) {
        closeObjectFrame(frame)
        return
      }
      out.pushAscii(indentAt(stack.length))
      const keyStart = state.pos
      const keyEnd = state.scanString()
      out.pushBytes(source, keyStart, keyEnd)
      state.skipWhitespace()
      if (state.peek() === COLON) state.pos++
      out.pushAscii(minified ? ':' : ': ')
      state.skipWhitespace()
      frame.state = ObjectState.ExpectValue
      return
    }
    if (frame.state === ObjectState.ExpectValue) {
      stepValue()
      frame.state = ObjectState.ExpectCommaOrClose
      return
    }
    // ExpectCommaOrClose
    state.skipWhitespace()
    if (state.atEnd() || state.peek() === CLOSE_BRACE) {
      closeObjectFrame(frame)
      return
    }
    if (state.peek() === COMMA) {
      out.push(COMMA)
      state.pos++
    }
    frame.state = ObjectState.ExpectKeyOrClose
  }

  function stepArrayFrame(frame: FormatArrayFrame): void {
    if (frame.state === ArrayState.ExpectValueOrClose) {
      state.skipWhitespace()
      if (state.atEnd() || state.peek() === CLOSE_BRACKET) {
        closeArrayFrame(frame)
        return
      }
      out.pushAscii(indentAt(stack.length))
      stepValue()
      frame.state = ArrayState.ExpectCommaOrClose
      return
    }
    // ExpectCommaOrClose
    state.skipWhitespace()
    if (state.atEnd() || state.peek() === CLOSE_BRACKET) {
      closeArrayFrame(frame)
      return
    }
    if (state.peek() === COMMA) {
      out.push(COMMA)
      state.pos++
    }
    frame.state = ArrayState.ExpectValueOrClose
  }

  stepValue()
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    if (frame.kind === FormatContainerKind.Object) stepObjectFrame(frame)
    else stepArrayFrame(frame)
  }

  if (!minified) out.pushAscii(options.newline)
  return out.toArray()
}

/** A no-op sink used only by `format`, which re-scans tokens without building a tree. */
const silentSink: NodeSink = {
  openNode: () => 0,
  attribute: () => {},
  value: () => {},
  closeNode: () => {},
  diagnostic: () => {},
  progress: () => {}
}

export const jsonFormatModule: FormatModule = {
  capabilities: jsonCapabilities,
  detect,
  detectEncoding,
  parse,
  parseRange,
  resumeContextFor,
  format
}
