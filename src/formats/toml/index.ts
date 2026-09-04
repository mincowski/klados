/**
 * TOML (M6-PLAN.md, R14). The architecture-validation format: `core/types.ts`'s own header
 * names TOML as the test of "adding a format is only writing a parser," so nothing here should
 * ever need a change outside this file plus the two small registration points M6-PLAN.md names
 * (`src/formats/registry.ts`, `src/main/documents.ts`'s open-dialog filter).
 *
 * TOML tables map to `NodeKind.Object`, arrays-of-tables to `NodeKind.Array` (of `Object`),
 * key-value pairs to `NodeKind.Property` holding its own scalar directly (D-030's fold rule,
 * already true for JSON) — no new `NodeKind` anywhere.
 *
 * The one genuinely new piece of structural work (M6-PLAN.md §1.1): **dotted keys create
 * implicit nested tables**, and both dotted keys and `[table]`/`[[array]]` headers must unify
 * into the *same* open table when they name the same path within a contiguous run. That is
 * what `StackFrame`/`navigateToTablePath`/`navigateToArrayPath` below exist to do.
 *
 * **A disclosed, deliberate limitation** (not a bug): a table's span in this model must be a
 * contiguous byte range containing all its children — the same invariant every other parser in
 * this codebase relies on (Raw view windowing, subtree splicing, no overlapping spans between
 * non-ancestor nodes). TOML's spec legally permits a table to be *extended* non-contiguously —
 * `[x.y.z]` followed later by unrelated content followed by `[x]` filling in `x`'s own direct
 * keys — which cannot be represented as one node once `x`'s span would need to reach past the
 * unrelated content in between. When that happens, this parser does **not** attempt to merge:
 * the later `[x]` simply opens a second, separate `Object` node also named `x`, rather than
 * corrupting spans or throwing (invariant 5). Real-world TOML (Cargo.toml/pyproject.toml-style
 * files) defines parents before children, contiguously, essentially always — this limitation is
 * believed to be unreachable in practice, and is called out here and in `M6-RESULTS.md`
 * rather than left to be rediscovered.
 */
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

// ---------------------------------------------------------------------------
// Byte constants
// ---------------------------------------------------------------------------

const HASH = 0x23 // #
const OPEN_BRACKET = 0x5b // [
const CLOSE_BRACKET = 0x5d // ]
const OPEN_BRACE = 0x7b // {
const CLOSE_BRACE = 0x7d // }
const EQUALS = 0x3d // =
const DOT = 0x2e // .
const COMMA = 0x2c // ,
const DQUOTE = 0x22 // "
const SQUOTE = 0x27 // '
const BACKSLASH = 0x5c
const NEWLINE = 0x0a // \n
const CR = 0x0d // \r
const SPACE = 0x20
const TAB = 0x09
const UNDERSCORE = 0x5f
const MINUS = 0x2d

function isInlineWhitespace(b: number): boolean {
  return b === SPACE || b === TAB
}

function isNewlineByte(b: number): boolean {
  return b === NEWLINE || b === CR
}

function isBareKeyByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) || // 0-9
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    b === UNDERSCORE ||
    b === MINUS
  )
}

/** Terminates a bare (unquoted) value token — number, boolean, or date/time. Permissive by
 * design (M6-PLAN.md §1's own convention, matching JSON's `isNumberByte`/`scanNumber`): this
 * greedily consumes a run of non-terminator bytes rather than validating TOML's exact number/
 * date grammar, since the model never type-discriminates a scalar beyond its byte span anyway
 * (`format()`'s own JSON precedent: every scalar round-trips via `pushBytes`, never decoded). */
function isBareValueTerminator(b: number): boolean {
  return (
    isInlineWhitespace(b) ||
    isNewlineByte(b) ||
    b === COMMA ||
    b === CLOSE_BRACKET ||
    b === CLOSE_BRACE ||
    b === HASH
  )
}

export const tomlCapabilities: FormatCapabilities = {
  id: 'toml',
  displayName: 'TOML',
  extensions: ['.toml'],
  hasAttributes: false,
  hasComments: true,
  hasNamespaces: false,
  canFormat: true,
  canIncrementalReparse: true, // R15
  rowBreakBytes: [NEWLINE]
}

// ---------------------------------------------------------------------------
// ParserState — same shape as json/index.ts's own, plus TOML's string/value scanners
// ---------------------------------------------------------------------------

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

  reportProgress(): void {
    if (this.pos - this.lastProgressAt >= PROGRESS_INTERVAL_BYTES) {
      this.lastProgressAt = this.pos
      this.sink.progress(this.pos)
    }
  }

  atEnd(): boolean {
    return this.pos >= this.source.length
  }

  peek(offset = 0): number {
    return this.source[this.pos + offset]!
  }

  skipInlineWhitespace(): void {
    while (!this.atEnd() && isInlineWhitespace(this.peek())) this.pos++
  }

  /** Spaces, tabs and newlines — the "nothing meaningful here" skip used *between* statements,
   * never inside one (a key path, a single-line string, or an inline table must not swallow a
   * newline this way — TOML statements are line-oriented). */
  skipInlineWhitespaceAndNewlines(): void {
    while (!this.atEnd() && (isInlineWhitespace(this.peek()) || isNewlineByte(this.peek()))) {
      this.pos++
    }
  }

  skipToEndOfLine(): void {
    while (!this.atEnd() && !isNewlineByte(this.peek())) this.pos++
    if (!this.atEnd()) this.pos++
  }

  /** A basic (`"…"`) or multi-line basic (`"""…"""`) string. Never decodes escapes — only
   * finds the span, the same "don't interpret, just skip two bytes" simplification JSON's own
   * `scanString` already uses (a `\u`/`\U` escape's extra hex digits are ordinary bytes to this
   * scan, since none of them can be a bare quote or backslash). */
  scanBasicString(): number {
    const start = this.pos
    const multiline = this.peek(1) === DQUOTE && this.peek(2) === DQUOTE
    this.pos += multiline ? 3 : 1
    for (;;) {
      if (this.atEnd()) {
        this.emit(
          Severity.Fatal,
          'toml.unterminated-string',
          start,
          this.pos - start,
          'Unterminated string'
        )
        return this.pos
      }
      const b = this.peek()
      if (b === BACKSLASH) {
        this.pos += 2
        continue
      }
      if (b === DQUOTE) {
        if (!multiline) {
          this.pos++
          return this.pos
        }
        if (this.peek(1) === DQUOTE && this.peek(2) === DQUOTE) {
          this.pos += 3
          return this.pos
        }
        this.pos++
        continue
      }
      if (!multiline && isNewlineByte(b)) {
        this.emit(
          Severity.Fatal,
          'toml.unterminated-string',
          start,
          this.pos - start,
          'Unterminated string'
        )
        return this.pos
      }
      this.pos++
    }
  }

  /** A literal (`'…'`) or multi-line literal (`'''…'''`) string — no escapes at all. */
  scanLiteralString(): number {
    const start = this.pos
    const multiline = this.peek(1) === SQUOTE && this.peek(2) === SQUOTE
    this.pos += multiline ? 3 : 1
    for (;;) {
      if (this.atEnd()) {
        this.emit(
          Severity.Fatal,
          'toml.unterminated-string',
          start,
          this.pos - start,
          'Unterminated string'
        )
        return this.pos
      }
      const b = this.peek()
      if (b === SQUOTE) {
        if (!multiline) {
          this.pos++
          return this.pos
        }
        if (this.peek(1) === SQUOTE && this.peek(2) === SQUOTE) {
          this.pos += 3
          return this.pos
        }
        this.pos++
        continue
      }
      if (!multiline && isNewlineByte(b)) {
        this.emit(
          Severity.Fatal,
          'toml.unterminated-string',
          start,
          this.pos - start,
          'Unterminated string'
        )
        return this.pos
      }
      this.pos++
    }
  }

  /** A bare value token — integer, float, boolean, or date/time (M6-PLAN.md's own "permissive
   * scan, no grammar validation" decision). */
  scanBareValue(): number {
    while (!this.atEnd() && !isBareValueTerminator(this.peek())) this.pos++
    return this.pos
  }
}

// ---------------------------------------------------------------------------
// Key paths
// ---------------------------------------------------------------------------

interface KeySpan {
  readonly start: Offset
  readonly end: Offset
}

/** Raw byte comparison, delimiters included — a quoted key (`"foo"`) and a bare key (`foo`)
 * naming the same table are therefore *not* recognized as the same identity. A deliberate,
 * documented simplification (M6-PLAN.md's own convention of disclosing rather than silently
 * approximating): real-world TOML essentially never mixes quoting style for the same key
 * across a document. */
function keysEqual(source: Uint8Array, a: KeySpan, b: KeySpan): boolean {
  const len = a.end - a.start
  if (len !== b.end - b.start) return false
  for (let i = 0; i < len; i++) {
    if (source[a.start + i] !== source[b.start + i]) return false
  }
  return true
}

/** The name span passed to `NodeSink.openNode` — quotes stripped for a quoted key, matching
 * JSON's own `keyStart + 1, keyEnd - 1` convention for its (always-quoted) property names. */
function nameSpanOf(source: Uint8Array, seg: KeySpan): KeySpan {
  const b = source[seg.start]!
  if (b === DQUOTE || b === SQUOTE) return { start: seg.start + 1, end: seg.end - 1 }
  return seg
}

function scanOneKeySegment(state: ParserState): KeySpan | null {
  const b = state.peek()
  if (b === DQUOTE) {
    const start = state.pos
    const end = state.scanBasicString()
    return { start, end }
  }
  if (b === SQUOTE) {
    const start = state.pos
    const end = state.scanLiteralString()
    return { start, end }
  }
  if (isBareKeyByte(b)) {
    const start = state.pos
    while (!state.atEnd() && isBareKeyByte(state.peek())) state.pos++
    return { start, end: state.pos }
  }
  return null
}

/** `a.b.c`, `"a b".c`, or a single bare/quoted key — whitespace around dots is permitted,
 * newlines are not (each segment is scanned via `scanOneKeySegment`, which never crosses a
 * newline for a bare key and treats one as a fatal unterminated-string inside a quoted key). */
function scanKeyPath(state: ParserState): KeySpan[] | null {
  const segments: KeySpan[] = []
  for (;;) {
    state.skipInlineWhitespace()
    const seg = scanOneKeySegment(state)
    if (seg === null) break
    segments.push(seg)
    state.skipInlineWhitespace()
    if (state.peek() === DOT) {
      state.pos++
      continue
    }
    break
  }
  return segments.length > 0 ? segments : null
}

// ---------------------------------------------------------------------------
// The open-table stack — M6-PLAN.md §1.1's "dotted keys create implicit structure"
// ---------------------------------------------------------------------------

type StackFrame =
  | { readonly kind: 'table'; readonly key: KeySpan; readonly node: NodeRef }
  | {
      readonly kind: 'array'
      readonly key: KeySpan
      readonly arrayNode: NodeRef
      elementNode: NodeRef
    }

function closeFramesTo(
  state: ParserState,
  stack: StackFrame[],
  targetDepth: number,
  closeOffset: Offset
): void {
  while (stack.length > targetDepth) {
    const frame = stack.pop()!
    if (frame.kind === 'array') {
      state.sink.closeNode(frame.elementNode, closeOffset)
      state.sink.closeNode(frame.arrayNode, closeOffset)
    } else {
      state.sink.closeNode(frame.node, closeOffset)
    }
  }
}

/** How far `path` already matches what's open on `stack`, from the root down — the shared
 * computation `navigateToTablePath`/`navigateToArrayPath` each do internally, factored out so
 * R15's incremental-reparse boundary check (`runRangeBody`) can ask the same question *before*
 * committing to a header, without closing anything itself. */
function commonPrefixLength(
  state: ParserState,
  stack: readonly StackFrame[],
  path: readonly KeySpan[]
): number {
  let k = 0
  while (k < stack.length && k < path.length && keysEqual(state.source, stack[k]!.key, path[k]!)) {
    k++
  }
  return k
}

/** Navigates `stack` to exactly `path` (always plain tables — used for a single-bracket
 * `[table]` header's whole path, and for a key statement's `sectionBase + dotted prefix`).
 * Closes back to the longest common prefix with what's currently open, then opens whatever
 * remains — reusing an already-open ancestor is what makes `physical.color = …` followed by
 * `physical.shape = …` land in the *same* implicit `physical` table rather than two.
 *
 * `originOverride` (R15, M6-PLAN.md): when this call is satisfying a `[table]` header (not a
 * dotted key, which has no enclosing bracket to anchor to), every frame newly opened here gets
 * the header's own `[` as its span start rather than its name's — the same "span covers the
 * whole syntactic construct" convention XML/JSON already use, and the reason a header-driven
 * table's own span starts somewhere `parseRange` can recognize and resume from directly. It is
 * *also* the correct close offset for whatever this same header closes: a real bug caught by
 * `test/subtreeSplice.test.ts` — using `path[k]?.start` (the next header's own *name* text,
 * past its `[`) as the close offset left the previous table's span reaching one or more bytes
 * into the next header's own `[`/`[[` syntax, overlapping two *siblings'* spans, not just
 * looking imprecise.
 *
 * `closeOffsetOverride` (R17, M6-PLAN.md): a dotted key's own close offset, separate from
 * `originOverride` because the two must *not* be conflated here the way they are for a header —
 * a multi-segment dotted key opening several new implicit tables in one statement
 * (`a.b.c = 1`, none of `a`/`b`/`c` yet open) needs each newly-opened table's span to start at
 * *its own* segment (`seg.start`), not all coincide at one offset. `parseKeyValueStatement`
 * passes its own statement's start here: a real bug caught by `test/tomlFixtures.test.ts`
 * running every node of a real fixture through `parseRange` — the previous fallback,
 * `path[k]?.start`, is undefined once `k === path.length` (a *plain*, non-dotted key closing
 * an implicit table back down to its own section), leaving `state.pos`, which by that point
 * `parseKeyValueStatement` had already advanced *past* the new key's own text (and past `=` and
 * its surrounding whitespace) via `scanKeyPath` — corrupting the closing table's span to reach
 * into the next key's own name, not just imprecisely near it. `path[k]?.start` remains the
 * fallback for a header's own dotted-prefix opening (`navigateToArrayPath`'s own table-opening
 * loop), which never calls this with a `closeOffsetOverride` at all. */
function navigateToTablePath(
  state: ParserState,
  stack: StackFrame[],
  path: readonly KeySpan[],
  originOverride?: Offset,
  closeOffsetOverride?: Offset
): void {
  const k = commonPrefixLength(state, stack, path)
  const closeOffset = closeOffsetOverride ?? originOverride ?? path[k]?.start ?? state.pos
  closeFramesTo(state, stack, k, closeOffset)
  for (let i = k; i < path.length; i++) {
    const seg = path[i]!
    const name = nameSpanOf(state.source, seg)
    const spanStart = originOverride ?? seg.start
    const node = state.sink.openNode(NodeKind.Object, spanStart, name.start, name.end)
    stack.push({ kind: 'table', key: seg, node })
  }
}

/** Navigates to a `[[table]]` header's array-of-tables target: the path's last segment is the
 * array's own name. If the array is already open with this exact absolute path (a run of
 * consecutive `[[name]]` headers, the overwhelmingly common real-world shape), its current
 * element is closed and a new one opened in its place — the *same* `Array` node, correctly
 * accumulating elements. Otherwise a fresh `Array` is opened (see this file's own top comment
 * on why a non-contiguous re-use is not attempted). `originOverride` — see
 * `navigateToTablePath`'s own doc comment; applies to every node freshly opened here, including
 * a newly-appended element (each element's own "start" is where its own `[[name]]` began). */
function navigateToArrayPath(
  state: ParserState,
  stack: StackFrame[],
  path: readonly KeySpan[],
  originOverride?: Offset
): void {
  const arrayDepth = path.length
  const k = commonPrefixLength(state, stack, path)
  const last = path[arrayDepth - 1]!
  // See navigateToTablePath's own doc comment on why `originOverride`, not
  // `path[k]?.start`, is the correct close offset whenever a header is
  // involved — the same span-overlap bug applied here too.
  const closeOffset = originOverride ?? (k < arrayDepth ? path[k]!.start : last.start)
  closeFramesTo(state, stack, k, closeOffset)

  for (let i = k; i < arrayDepth - 1; i++) {
    const seg = path[i]!
    const name = nameSpanOf(state.source, seg)
    const spanStart = originOverride ?? seg.start
    const node = state.sink.openNode(NodeKind.Object, spanStart, name.start, name.end)
    stack.push({ kind: 'table', key: seg, node })
  }

  const elementSpanStart = originOverride ?? last.start
  if (k === arrayDepth) {
    const top = stack[stack.length - 1]!
    if (top.kind === 'array') {
      // Everything through the array's own name was already open — append.
      state.sink.closeNode(top.elementNode, elementSpanStart)
      top.elementNode = state.sink.openNode(NodeKind.Object, elementSpanStart, -1, -1)
      return
    }
    // Same name, already open, but as a plain *table* — a spec violation
    // (a table can't become an array-of-tables), not the common case this
    // fast path is for. Close it and fall through to open a fresh Array in
    // its place: best-effort recovery (invariant 5), not a crash from
    // treating a `'table'` frame as if it had `elementNode`.
    closeFramesTo(state, stack, arrayDepth - 1, last.start)
  }

  const name = nameSpanOf(state.source, last)
  const arrayNode = state.sink.openNode(
    NodeKind.Array,
    originOverride ?? last.start,
    name.start,
    name.end
  )
  const elementNode = state.sink.openNode(NodeKind.Object, elementSpanStart, -1, -1)
  stack.push({ kind: 'array', key: last, arrayNode, elementNode })
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function scanScalarSpan(state: ParserState): { start: Offset; end: Offset } {
  const start = state.pos
  const b = state.peek()
  let end: number
  if (b === DQUOTE) end = state.scanBasicString()
  else if (b === SQUOTE) end = state.scanLiteralString()
  else end = state.scanBareValue()
  return { start, end }
}

/** A key=value statement's value — folds into the already-open `Property` node (D-030's rule,
 * matching JSON's own property-value fold) rather than a separate `Scalar` child, for a scalar;
 * a container opens as the Property's child via ordinary call-order parentage. */
function parsePropertyValue(state: ParserState, sink: NodeSink): void {
  const b = state.peek()
  if (b === OPEN_BRACE || b === OPEN_BRACKET) {
    parseInlineValue(state, sink, null)
    return
  }
  const { start, end } = scanScalarSpan(state)
  sink.value(start, end)
}

// ---------------------------------------------------------------------------
// Inline tables and arrays — `{ … }` / `[ … ]` as a *value*, not a header.
//
// MUST be iterative (hard rule 4): `x = {a = {b = {c = […]}}}` is real,
// generated-data-shaped input, and a naive `parseValue` calling back into
// `parseInlineTable`/`parseInlineArray` recursively overflows the JS call
// stack well before `maxDepth` would ever stop it — found by this file's
// own test suite (a 5,000-deep inline array), not assumed correct. The
// fix mirrors `formats/json/index.ts`'s own `Frame`/`stepObject`/
// `stepArray` shape exactly: one explicit stack of `InlineFrame`s, walked
// by a single `while` loop, however deep the real nesting goes.
// ---------------------------------------------------------------------------

const enum InlineTableState {
  ExpectKeyOrClose,
  ExpectEquals,
  ExpectValue,
  ExpectCommaOrClose
}

const enum InlineArrayState {
  ExpectValueOrClose,
  ExpectCommaOrClose
}

interface InlineTableFrame {
  readonly kind: 'inlineTable'
  readonly node: NodeRef
  state: InlineTableState
  /** Dotted keys inside *this* inline table (`{ a.b = 1 }`) — inline tables never contain
   * `[[…]]` headers, so this only ever holds `'table'` frames; reuses `navigateToTablePath`
   * unchanged. Discarded (closed) when the inline table itself closes. */
  readonly localStack: StackFrame[]
  pendingProperty: NodeRef | null
  /** The outer `Property` this whole table is the value of, if any — closed when this frame
   * pops (mirrors JSON's own `Frame.closesProperty`). `null` for an array element or a
   * top-level property value (the top-level caller closes its own Property itself). */
  readonly closesProperty: NodeRef | null
}

interface InlineArrayFrame {
  readonly kind: 'inlineArray'
  readonly node: NodeRef
  state: InlineArrayState
  readonly closesProperty: NodeRef | null
}

type InlineFrame = InlineTableFrame | InlineArrayFrame

function openInlineContainer(
  state: ParserState,
  sink: NodeSink,
  stack: InlineFrame[],
  bracket: number,
  closesProperty: NodeRef | null
): void {
  const start = state.pos
  if (bracket === OPEN_BRACE) {
    const node = sink.openNode(NodeKind.Object, start, -1, -1)
    state.pos++
    stack.push({
      kind: 'inlineTable',
      node,
      state: InlineTableState.ExpectKeyOrClose,
      localStack: [],
      pendingProperty: null,
      closesProperty
    })
  } else {
    const node = sink.openNode(NodeKind.Array, start, -1, -1)
    state.pos++
    stack.push({
      kind: 'inlineArray',
      node,
      state: InlineArrayState.ExpectValueOrClose,
      closesProperty
    })
  }
}

/** Pops the innermost frame, closing its node (and any still-open dotted-key sub-tables for an
 * inline table) — then, if it was itself a Property's value, closes that Property too and
 * updates the new top-of-stack frame's own state, the same deferred-close JSON's `popFrame`
 * uses for exactly this reason. */
function popInlineFrame(state: ParserState, sink: NodeSink, stack: InlineFrame[]): void {
  const frame = stack.pop()!
  if (frame.kind === 'inlineTable') {
    if (frame.pendingProperty !== null) sink.closeNode(frame.pendingProperty, state.pos)
    closeFramesTo(state, frame.localStack, 0, state.pos)
  }
  sink.closeNode(frame.node, state.pos)
  if (frame.closesProperty !== null) {
    sink.closeNode(frame.closesProperty, state.pos)
    const parent = stack[stack.length - 1]
    if (parent !== undefined) {
      if (parent.kind === 'inlineTable') {
        parent.pendingProperty = null
        parent.state = InlineTableState.ExpectCommaOrClose
      } else {
        parent.state = InlineArrayState.ExpectCommaOrClose
      }
    }
  }
}

function stepInlineTable(
  state: ParserState,
  sink: NodeSink,
  stack: InlineFrame[],
  frame: InlineTableFrame
): void {
  state.skipInlineWhitespace()
  if (state.atEnd()) {
    state.emit(
      Severity.Fatal,
      'toml.unterminated-inline-table',
      state.pos,
      0,
      'Unterminated inline table'
    )
    while (stack.length > 0) popInlineFrame(state, sink, stack)
    return
  }
  const b = state.peek()

  if (
    frame.state === InlineTableState.ExpectKeyOrClose ||
    frame.state === InlineTableState.ExpectCommaOrClose
  ) {
    if (b === CLOSE_BRACE) {
      state.pos++
      popInlineFrame(state, sink, stack)
      return
    }
  }

  if (frame.state === InlineTableState.ExpectCommaOrClose) {
    if (b === COMMA) {
      state.pos++
      frame.state = InlineTableState.ExpectKeyOrClose
      return
    }
    state.emit(Severity.Error, 'toml.expected-comma-or-close', state.pos, 1, "Expected ',' or '}'")
    state.pos++
    return
  }

  if (frame.state === InlineTableState.ExpectKeyOrClose) {
    // Captured before `scanKeyPath` — see `navigateToTablePath`'s own doc
    // comment on `closeOffsetOverride` (the same bug, same fix, for a
    // dotted-then-plain-key sequence inside an inline table instead of at
    // the top level: `{ a.b = 1, c = 2 }` closing `a` for `c`).
    const keyStatementStart = state.pos
    const keyPath = scanKeyPath(state)
    if (keyPath === null) {
      state.emit(Severity.Error, 'toml.expected-key', state.pos, 1, 'Expected a key')
      state.pos++
      return
    }
    const prefix = keyPath.slice(0, -1)
    const leaf = keyPath[keyPath.length - 1]!
    navigateToTablePath(state, frame.localStack, prefix, undefined, keyStatementStart)
    const leafName = nameSpanOf(state.source, leaf)
    frame.pendingProperty = sink.openNode(
      NodeKind.Property,
      leaf.start,
      leafName.start,
      leafName.end
    )
    frame.state = InlineTableState.ExpectEquals
    return
  }

  if (frame.state === InlineTableState.ExpectEquals) {
    if (b === EQUALS) state.pos++
    else state.emit(Severity.Error, 'toml.expected-equals', state.pos, 1, "Expected '='")
    frame.state = InlineTableState.ExpectValue
    return
  }

  // InlineTableState.ExpectValue
  state.skipInlineWhitespace()
  const property = frame.pendingProperty!
  if (state.peek() === OPEN_BRACE || state.peek() === OPEN_BRACKET) {
    openInlineContainer(state, sink, stack, state.peek(), property)
    return
  }
  const { start, end } = scanScalarSpan(state)
  sink.value(start, end)
  sink.closeNode(property, end)
  frame.pendingProperty = null
  frame.state = InlineTableState.ExpectCommaOrClose
}

function stepInlineArray(
  state: ParserState,
  sink: NodeSink,
  stack: InlineFrame[],
  frame: InlineArrayFrame
): void {
  // Unlike inline tables, TOML explicitly permits newlines and comments between array elements.
  for (;;) {
    state.skipInlineWhitespaceAndNewlines()
    if (state.peek() === HASH) {
      parseComment(state, sink)
      continue
    }
    break
  }
  if (state.atEnd()) {
    state.emit(
      Severity.Fatal,
      'toml.unterminated-inline-array',
      state.pos,
      0,
      'Unterminated inline array'
    )
    while (stack.length > 0) popInlineFrame(state, sink, stack)
    return
  }
  const b = state.peek()

  if (
    frame.state === InlineArrayState.ExpectValueOrClose ||
    frame.state === InlineArrayState.ExpectCommaOrClose
  ) {
    if (b === CLOSE_BRACKET) {
      state.pos++
      popInlineFrame(state, sink, stack)
      return
    }
  }

  if (frame.state === InlineArrayState.ExpectCommaOrClose) {
    if (b === COMMA) {
      state.pos++
      frame.state = InlineArrayState.ExpectValueOrClose
      return
    }
    state.emit(Severity.Error, 'toml.expected-comma-or-close', state.pos, 1, "Expected ',' or ']'")
    state.pos++
    return
  }

  // InlineArrayState.ExpectValueOrClose
  if (b === OPEN_BRACE || b === OPEN_BRACKET) {
    // Unlike the property-value case, a container array element has no
    // `closesProperty` to drive `popInlineFrame`'s parent-notify (it's
    // `null` — array elements aren't named) — so this frame's own state
    // must advance here, or the next iteration re-reads the same position
    // (now a ',' or ']') as if it still expected a *value*, and
    // `scanScalarSpan` on a terminator byte scans zero bytes, minting a
    // spurious empty Scalar. Found by this file's own multi-element
    // inline-array test, not assumed correct.
    openInlineContainer(state, sink, stack, b, null)
    frame.state = InlineArrayState.ExpectCommaOrClose
    return
  }
  const { start, end } = scanScalarSpan(state)
  const scalar = sink.openNode(NodeKind.Scalar, start, -1, -1)
  sink.value(start, end)
  sink.closeNode(scalar, end)
  frame.state = InlineArrayState.ExpectCommaOrClose
}

/** Entry point for a value position that turns out to be `{` or `[` — everything beneath it,
 * however deeply nested, is driven by this one loop over `stack`, never by a recursive call
 * back into this function (see this section's own top comment). `closesProperty` is the outer
 * `Property` this whole container is the value of, or `null` for an array element or a
 * top-level property value (whose caller closes its own Property itself, outside this call). */
function parseInlineValue(
  state: ParserState,
  sink: NodeSink,
  closesProperty: NodeRef | null
): void {
  const stack: InlineFrame[] = []
  openInlineContainer(state, sink, stack, state.peek(), closesProperty)
  while (stack.length > 0) {
    state.reportProgress()
    if (stack.length > state.options.maxDepth) {
      state.emit(
        Severity.Fatal,
        'toml.max-depth-exceeded',
        state.pos,
        0,
        `Nesting exceeds maxDepth (${state.options.maxDepth})`
      )
      while (stack.length > 0) popInlineFrame(state, sink, stack)
      return
    }
    if (state.options.signal?.aborted) {
      state.fatal = true
      while (stack.length > 0) popInlineFrame(state, sink, stack)
      return
    }
    const frame = stack[stack.length - 1]!
    if (frame.kind === 'inlineTable') stepInlineTable(state, sink, stack, frame)
    else stepInlineArray(state, sink, stack, frame)
  }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** `# … ` to end of line — a real `NodeKind.Comment` node (the same kind XML already has), a
 * child of whatever is currently open. `detailModel.ts`'s existing `adjacentCommentOf`
 * heuristic already knows how to associate a Comment with a nearby node generically — TOML
 * needs no format-specific code for "the comment is the documentation" (CONCEPT.md §5.3),
 * only for parsing the comment token itself. */
function parseComment(state: ParserState, sink: NodeSink): void {
  const start = state.pos
  state.pos++ // '#'
  const textStart = state.pos
  while (!state.atEnd() && !isNewlineByte(state.peek())) state.pos++
  const textEnd = state.pos
  const node = sink.openNode(NodeKind.Comment, start, -1, -1)
  sink.value(textStart, textEnd)
  sink.closeNode(node, textEnd)
}

// ---------------------------------------------------------------------------
// Top-level statements
// ---------------------------------------------------------------------------

function requireStatementEnd(state: ParserState, sink: NodeSink): void {
  state.skipInlineWhitespace()
  if (state.peek() === HASH) parseComment(state, sink)
  state.skipInlineWhitespace()
  if (state.atEnd() || isNewlineByte(state.peek())) return
  const start = state.pos
  state.emit(
    Severity.Error,
    'toml.trailing-content',
    start,
    0,
    'Expected end of line after this statement'
  )
  state.skipToEndOfLine()
}

/** `[table]` or `[[array]]` — consumes through the closing bracket(s), returning the path and
 * whether it was double-bracketed. `null` on a malformed header (caller recovers by skipping
 * to end of line). */
function parseHeader(state: ParserState): { path: KeySpan[]; isArray: boolean } | null {
  const isArray = state.peek(1) === OPEN_BRACKET
  state.pos += isArray ? 2 : 1
  state.skipInlineWhitespace()
  const path = scanKeyPath(state)
  state.skipInlineWhitespace()
  if (path === null) {
    state.emit(Severity.Error, 'toml.expected-key', state.pos, 1, 'Expected a table name')
    return null
  }
  if (isArray) {
    if (state.peek() === CLOSE_BRACKET && state.peek(1) === CLOSE_BRACKET) {
      state.pos += 2
    } else {
      state.emit(Severity.Error, 'toml.unterminated-header', state.pos, 1, "Expected ']]'")
      return null
    }
  } else {
    if (state.peek() === CLOSE_BRACKET) {
      state.pos++
    } else {
      state.emit(Severity.Error, 'toml.unterminated-header', state.pos, 1, "Expected ']'")
      return null
    }
  }
  return { path, isArray }
}

function parseKeyValueStatement(
  state: ParserState,
  sink: NodeSink,
  stack: StackFrame[],
  sectionBase: readonly KeySpan[]
): boolean {
  const statementStart = state.pos
  const keyPath = scanKeyPath(state)
  if (keyPath === null) {
    state.emit(Severity.Error, 'toml.expected-key', state.pos, 1, 'Expected a key')
    return false
  }
  state.skipInlineWhitespace()
  if (state.peek() !== EQUALS) {
    state.emit(Severity.Error, 'toml.expected-equals', state.pos, 1, "Expected '='")
    return false
  }
  state.pos++
  state.skipInlineWhitespace()

  const prefix = keyPath.slice(0, -1)
  const leaf = keyPath[keyPath.length - 1]!
  navigateToTablePath(state, stack, [...sectionBase, ...prefix], undefined, statementStart)

  const leafName = nameSpanOf(state.source, leaf)
  const propNode = sink.openNode(NodeKind.Property, leaf.start, leafName.start, leafName.end)
  if (state.atEnd() || isNewlineByte(state.peek()) || state.peek() === HASH) {
    state.emit(Severity.Error, 'toml.expected-value', state.pos, 0, 'Expected a value')
    sink.closeNode(propNode, state.pos)
    return true
  }
  parsePropertyValue(state, sink)
  sink.closeNode(propNode, state.pos)
  return true
}

/**
 * The shared statement loop for both a full top-level parse (`rootDepth = 0`, `stack` starts
 * empty, representing "the document itself") and R15's resumed range reparse (`rootDepth > 0`,
 * `stack` pre-seeded with the range's own already-open root frame(s)). A header whose target
 * would need to close back past `rootDepth` is **not** consumed: for `rootDepth = 0` this can
 * never happen (there is nothing to close past), and for `rootDepth > 0` it means the header
 * belongs to the *next* sibling range — `parseRange`'s own caller (`subtreeSplice.ts`) reparses
 * that separately, so this call rewinds to just before it and stops, leaving it unconsumed.
 * Closes everything opened *above* `rootDepth` before returning either way; frames at or below
 * `rootDepth` are the caller's own to close (with whatever offset the caller's `stopOffset`
 * actually means for them — `runToplevel` and `parseRange` differ here).
 */
function runStatements(
  state: ParserState,
  sink: NodeSink,
  stack: StackFrame[],
  initialSectionBase: readonly KeySpan[],
  rootDepth: number,
  stopOffset: Offset
): void {
  let sectionBase: KeySpan[] = [...initialSectionBase]

  for (;;) {
    state.reportProgress()
    if (state.options.signal?.aborted) {
      state.fatal = true
      break
    }
    state.skipInlineWhitespaceAndNewlines()
    if (state.atEnd() || state.pos >= stopOffset) break

    const b = state.peek()
    if (b === HASH) {
      parseComment(state, sink)
      continue
    }

    if (b === OPEN_BRACKET) {
      const headerStart = state.pos
      const header = parseHeader(state)
      if (header === null) {
        state.skipToEndOfLine()
        continue
      }
      if (stack.length > state.options.maxDepth || header.path.length > state.options.maxDepth) {
        state.emit(
          Severity.Fatal,
          'toml.max-depth-exceeded',
          state.pos,
          0,
          `Nesting exceeds maxDepth (${state.options.maxDepth})`
        )
        break
      }
      if (commonPrefixLength(state, stack, header.path) < rootDepth) {
        // This header belongs to whatever comes after our own range — not
        // consumed, not even the '[' already read; rewound so the caller
        // (or the next `parseRange` call entirely) sees it fresh.
        state.pos = headerStart
        break
      }
      // `headerStart`, not the name's own start, for every frame this header
      // opens fresh — R15's `parseRange` needs every header-driven table's
      // span to start at its own `[`/`[[` so it's recognizable and
      // resumable later, and that must hold uniformly, not just for
      // whichever header happens to be a splice's own outermost target.
      if (header.isArray) navigateToArrayPath(state, stack, header.path, headerStart)
      else navigateToTablePath(state, stack, header.path, headerStart)
      sectionBase = header.path
      requireStatementEnd(state, sink)
      continue
    }

    if (!isBareKeyByte(b) && b !== DQUOTE && b !== SQUOTE) {
      state.emit(
        Severity.Error,
        'toml.unexpected-token',
        state.pos,
        1,
        'Expected a key or a table header'
      )
      state.skipToEndOfLine()
      continue
    }

    const ok = parseKeyValueStatement(state, sink, stack, sectionBase)
    if (!ok) {
      state.skipToEndOfLine()
      continue
    }
    requireStatementEnd(state, sink)
  }

  closeFramesTo(state, stack, rootDepth, stopOffset)
}

function runToplevel(state: ParserState, sink: NodeSink, stopOffset: Offset): void {
  runStatements(state, sink, [], [], 0, stopOffset)
}

// ---------------------------------------------------------------------------
// FormatModule
// ---------------------------------------------------------------------------

/** No single-byte signature the way `<`/`{`/`[` give XML/JSON (M6-PLAN.md §1.2) — a TOML
 * document can open with a comment, a bare key, or a table header, and `[` alone would
 * misdetect against a JSON array. Filename carries almost all real detection; content-sniffing
 * without one requires the first non-comment, non-blank line to actually look like a key/value
 * or a header, not just start with a plausible byte. */
function detect(head: Uint8Array, filename: string | null): number {
  if (filename !== null && filename.toLowerCase().endsWith('.toml')) return 0.9

  let i = 0
  for (;;) {
    while (i < head.length && (isInlineWhitespace(head[i]!) || isNewlineByte(head[i]!))) i++
    if (i >= head.length) return 0
    if (head[i] === HASH) {
      while (i < head.length && !isNewlineByte(head[i]!)) i++
      continue
    }
    break
  }
  if (i >= head.length) return 0

  const b = head[i]!
  if (b === OPEN_BRACKET) {
    // `[table]` or `[[array]]` — look for a matching `]` before any newline, a JSON array
    // opening a line has no reason to close on the same line unless it's short and scalar-only,
    // so this stays a reasonably safe signal.
    let j = i + 1
    while (j < head.length && !isNewlineByte(head[j]!)) {
      if (head[j] === CLOSE_BRACKET) return 0.6
      j++
    }
    return 0
  }
  if (isBareKeyByte(b) || b === DQUOTE || b === SQUOTE) {
    // Looks like the start of a key — confirm an '=' appears before the line ends.
    let j = i
    while (j < head.length && !isNewlineByte(head[j]!)) {
      if (head[j] === EQUALS) return 0.6
      j++
    }
    return 0
  }
  return 0
}

function detectEncoding(): string | null {
  return null
}

function parse(source: Uint8Array, sink: NodeSink, options: ParseOptions): ParseResult {
  const state = new ParserState(source, sink, options, bomLengthAt(source))
  const doc = sink.openNode(NodeKind.Document, 0, -1, -1)
  runToplevel(state, sink, source.length)
  sink.closeNode(doc, source.length)
  return {
    complete: !state.fatal,
    bytesConsumed: state.pos,
    diagnosticCount: state.diagnosticCount
  }
}

/** M6-PLAN.md R15. `subtreeSplice.ts`'s own `findSpliceNode` never chooses a bare `Property`
 * (its span is never independently reparseable — every format's Property holds its own scalar,
 * D-030) or a node whose span exactly equals the edit — so `parseRange` only ever has to handle
 * a handful of shapes, and which one is discoverable from the *ancestor chain alone*, without
 * touching `source` at all:
 *
 *  - `ancestors.length === 0` — the node has no parent, so it's the Document itself.
 *  - *any* ancestor is a `Property` — the node lives somewhere inside an *inline* table/array
 *    value (`{ … }` / `[ … ]`), at any nesting depth — a header-driven table/array is never a
 *    Property's child at any depth (it's always reached by the open-table-stack navigation in
 *    `navigateToTablePath`/`navigateToArrayPath`, never by folding into a Property), so this
 *    test is exact, not just true for the outermost case. The whole inline value is
 *    self-contained and bracket- (or, for a bare scalar element, token-) delimited.
 *  - otherwise, the immediate parent is an `Array` — the node is one *element* of a
 *    header-driven array-of-tables (only an array-of-tables' own elements, never an inline
 *    array's, have an `Array` as their *direct* parent without a `Property` anywhere above —
 *    the previous bullet already claimed those).
 *  - otherwise — a header-driven `[table]` itself (or a nested dotted-key implicit table; see
 *    `parseRange`'s own handling of that case below), whose span *usually* starts exactly at
 *    its own `[`/`[[` (per `navigateToTablePath`/`navigateToArrayPath`'s `originOverride`) —
 *    except a table created purely by a dotted key (`a.b = 1`, no header of its own), whose
 *    span starts at its own name instead, since there is no bracket to anchor to.
 */
type TomlResumeKind = 'document' | 'inlineValue' | 'arrayElement' | 'headerTable'

interface TomlResumeContext extends ResumeContext {
  readonly resumeKind: TomlResumeKind
  /** Only set for `'arrayElement'` — the owning `Array` ancestor's own span start, always
   * exactly at its `[[` (`navigateToArrayPath`'s `originOverride`). Re-parsed as a header (via
   * a throwaway, silent `ParserState` — never touching the real `sink`) to recover the array's
   * own name path, the same way a nested header inside this element's own resumed body would
   * need to recognize it as already-open rather than trying to redundantly re-navigate to it. */
  readonly ownerArrayStart?: Offset
}

function resumeContextFor(ancestors: AncestorView): ResumeContext {
  if (ancestors.length === 0) {
    const ctx: TomlResumeContext = { formatId: 'toml', resumeKind: 'document' }
    return ctx
  }
  for (let i = 0; i < ancestors.length; i++) {
    if (ancestors.kindAt(i) === NodeKind.Property) {
      const ctx: TomlResumeContext = { formatId: 'toml', resumeKind: 'inlineValue' }
      return ctx
    }
  }
  const lastIndex = ancestors.length - 1
  if (ancestors.kindAt(lastIndex) === NodeKind.Array) {
    const ctx: TomlResumeContext = {
      formatId: 'toml',
      resumeKind: 'arrayElement',
      ownerArrayStart: ancestors.spanStartAt(lastIndex)
    }
    return ctx
  }
  const ctx: TomlResumeContext = { formatId: 'toml', resumeKind: 'headerTable' }
  return ctx
}

/** A no-op sink for a throwaway scan that only needs to advance `state.pos` and read back what
 * it found (`parseHeader`, re-deriving an owning array's name in the `'arrayElement'` case) —
 * never touches the real sink a `parse`/`parseRange` call is building. */
const silentSink: NodeSink = {
  openNode: () => 0,
  attribute: () => {},
  value: () => {},
  closeNode: () => {},
  diagnostic: () => {},
  progress: () => {}
}

/**
 * The body of a table that is its own fresh root for this reparse (an array-of-tables element,
 * or a dotted-key-created implicit table) — bare/dotted keys, comments and inline values,
 * relative to itself (`sectionBase` starts empty). **Deliberately does not attempt a nested
 * `[table]`/`[[array]]` header found inside such a body** — correctly placing one would need
 * this table's own full path (relative-path navigation against an owner it doesn't otherwise
 * need to know), which is real additional machinery for a pattern real-world TOML rarely
 * produces (an array-of-tables element or a dotted-key sub-table that itself contains a further
 * header, rather than just flat key-value pairs — `[[bin]]`/`physical.color`-style content, not
 * this). Returns `false` to signal "found one, could not resume precisely here" — the caller
 * reports `complete: false` and `subtreeSplice.ts` falls back to a full reparse, safely, not
 * incorrectly.
 *
 * `selfFrame`, for a dotted-key-created implicit table only: the caller already opened this
 * table's own node (it has to, as fresh index 0) but must **not** also consume its name out of
 * the byte stream first — the table's identity and its first key statement are the same bytes
 * (`physical.color = …` *is* how `physical` gets opened at all), so `state.pos` must still be
 * sitting at the very start of that first statement when this loop begins. Seeding `localStack`
 * with a frame whose `node` is the already-open table (not a new one) is what makes
 * `parseKeyValueStatement`'s own `navigateToTablePath` call recognize `physical.color` and a
 * later `physical.shape` as extending the *same* table rather than opening — and, worse,
 * nesting — a second one (a real bug this exact case caught: consuming `physical` first, then
 * handing the loop the orphaned `.color = …` tail, which no grammar production starts with). */
function runSelfContainedBody(
  state: ParserState,
  sink: NodeSink,
  end: Offset,
  selfFrame: StackFrame | null
): boolean {
  const localStack: StackFrame[] = selfFrame === null ? [] : [selfFrame]
  const rootDepth = selfFrame === null ? 0 : 1
  for (;;) {
    state.reportProgress()
    if (state.options.signal?.aborted) {
      state.fatal = true
      break
    }
    state.skipInlineWhitespaceAndNewlines()
    if (state.atEnd() || state.pos >= end) break

    const b = state.peek()
    if (b === HASH) {
      parseComment(state, sink)
      continue
    }
    if (b === OPEN_BRACKET) {
      return false
    }
    if (!isBareKeyByte(b) && b !== DQUOTE && b !== SQUOTE) {
      state.emit(
        Severity.Error,
        'toml.unexpected-token',
        state.pos,
        1,
        'Expected a key or a table header'
      )
      state.skipToEndOfLine()
      continue
    }
    const ok = parseKeyValueStatement(state, sink, localStack, [])
    if (!ok) {
      state.skipToEndOfLine()
      continue
    }
    requireStatementEnd(state, sink)
  }
  closeFramesTo(state, localStack, rootDepth, Math.min(end, state.source.length))
  return true
}

/** Reparses exactly one node's own span, per `resumeContextFor`'s shapes. The caller guarantees
 * `[start, end)` covers a complete node (`core/types.ts`'s own contract) — this function's job
 * is to reproduce that node (as fresh index 0) and its children, nothing past `end`.
 * `runStatements`'s `rootDepth` boundary check is what makes the `'headerTable'`/`'document'`
 * shapes safe: a sibling header found while walking this range's own body is recognized and
 * left unconsumed rather than accidentally absorbed into this node. */
function parseRange(
  source: Uint8Array,
  start: Offset,
  end: Offset,
  sink: NodeSink,
  context: ResumeContext,
  options: ParseOptions
): ParseResult {
  const state = new ParserState(source, sink, options, start)
  const tomlContext = context as TomlResumeContext
  const resumeKind = tomlContext.resumeKind

  if (resumeKind === 'inlineValue') {
    if (state.atEnd()) {
      return { complete: false, bytesConsumed: state.pos, diagnosticCount: 0 }
    }
    if (state.peek() === OPEN_BRACE || state.peek() === OPEN_BRACKET) {
      parseInlineValue(state, sink, null)
    } else if (state.peek() === HASH) {
      // A Comment sitting between elements of a multi-line inline array —
      // same "the ancestor chain alone can't tell a Comment from any other
      // child at this position" gap as the 'headerTable' branch's own
      // top-level case, see that branch's comment.
      parseComment(state, sink)
    } else {
      // A bare scalar array element — the only inline shape with no bracket
      // of its own (JSON's own parseRange has the same "value, not just
      // container" shape for the same reason: Property already escalates
      // away the one case that would fold instead of standing alone).
      const { start: valueStart, end: valueEnd } = scanScalarSpan(state)
      const scalar = sink.openNode(NodeKind.Scalar, valueStart, -1, -1)
      sink.value(valueStart, valueEnd)
      sink.closeNode(scalar, valueEnd)
    }
    return {
      complete: !state.fatal && state.pos <= end,
      bytesConsumed: state.pos,
      diagnosticCount: state.diagnosticCount
    }
  }

  if (resumeKind === 'document') {
    const doc = sink.openNode(NodeKind.Document, 0, -1, -1)
    runStatements(state, sink, [], [], 0, end)
    sink.closeNode(doc, Math.min(end, source.length))
    return {
      complete: !state.fatal && state.pos <= end,
      bytesConsumed: state.pos,
      diagnosticCount: state.diagnosticCount
    }
  }

  if (resumeKind === 'arrayElement') {
    const ownerStart = tomlContext.ownerArrayStart
    const ownerHeader =
      ownerStart === undefined
        ? null
        : parseHeader(new ParserState(source, silentSink, options, ownerStart))
    if (ownerHeader === null || !ownerHeader.isArray) {
      state.emit(
        Severity.Fatal,
        'toml.splice-mismatch',
        start,
        0,
        'Could not re-derive the owning array for this element'
      )
      return { complete: false, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
    }
    // Every element's own span starts at the exact `[[name]]` occurrence
    // that created it (`navigateToArrayPath`'s `originOverride`, always
    // passed by both callers) — so `start` is always positioned at that
    // header, and it must be consumed here before the element's *body*
    // (what comes after that header line) is parsed, the same way a
    // `'headerTable'` reparse consumes its own `[table]` first.
    if (state.atEnd() || state.peek() !== OPEN_BRACKET) {
      state.emit(
        Severity.Fatal,
        'toml.splice-mismatch',
        start,
        0,
        'Expected this element’s own [[header]] at this offset'
      )
      return { complete: false, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
    }
    const ownHeader = parseHeader(state)
    if (ownHeader === null || !ownHeader.isArray) {
      return { complete: false, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
    }
    const element = sink.openNode(NodeKind.Object, start, -1, -1)
    requireStatementEnd(state, sink)
    const resumed = runSelfContainedBody(state, sink, end, null)
    sink.closeNode(element, Math.min(end, source.length))
    return {
      complete: resumed && !state.fatal && state.pos <= end,
      bytesConsumed: state.pos,
      diagnosticCount: state.diagnosticCount
    }
  }

  // 'headerTable' — a header-driven table (span starts at its own '[') or an
  // implicit dotted-key table (span starts at its own name — no header to expect here).
  if (state.atEnd()) {
    return { complete: false, bytesConsumed: state.pos, diagnosticCount: 0 }
  }
  if (state.peek() === HASH) {
    // A standalone top-level Comment node lands here too: its ancestor
    // chain (parent = whatever table/Document it sits in, nothing more
    // distinguishing) is indistinguishable from an implicit dotted-key
    // table's own from `resumeContextFor`'s ancestor-only vantage point —
    // an edit strictly inside a comment's own text (not replacing its
    // whole span) really does make `findSpliceNode` pick the Comment
    // itself. Caught by test/tomlFixtures.test.ts running every real node
    // in a real fixture through this path, not assumed safe.
    parseComment(state, sink)
    return {
      complete: !state.fatal && state.pos <= end,
      bytesConsumed: state.pos,
      diagnosticCount: state.diagnosticCount
    }
  }
  if (state.peek() !== OPEN_BRACKET) {
    // An implicit dotted-key table's span starts at its own name (no
    // bracket to anchor to) — but that name is the *start of its own first
    // key statement* (`physical.color = …` is how `physical` gets opened
    // at all), not a separate token to consume and move past. Peek it
    // (restoring `state.pos` afterward) purely to name the fresh node;
    // `runSelfContainedBody` then re-scans the same bytes for real, with
    // this node seeded into its local stack so `physical.color` and a
    // later `physical.shape` both extend it instead of orphaning the
    // `.color = …` tail into a re-parse that starts mid-key (a real bug
    // this exact case caught — see that function's own doc comment).
    const peekPos = state.pos
    const ownName = scanOneKeySegment(state)
    state.pos = peekPos
    if (ownName === null) {
      state.emit(
        Severity.Fatal,
        'toml.splice-mismatch',
        start,
        0,
        'Expected a table name at this offset'
      )
      return { complete: false, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
    }
    const name = nameSpanOf(source, ownName)
    const table = sink.openNode(NodeKind.Object, start, name.start, name.end)
    const resumed = runSelfContainedBody(state, sink, end, {
      kind: 'table',
      key: ownName,
      node: table
    })
    sink.closeNode(table, Math.min(end, source.length))
    return {
      complete: resumed && !state.fatal && state.pos <= end,
      bytesConsumed: state.pos,
      diagnosticCount: state.diagnosticCount
    }
  }
  const header = parseHeader(state)
  if (header === null) {
    return { complete: false, bytesConsumed: state.pos, diagnosticCount: state.diagnosticCount }
  }
  const stack: StackFrame[] = []
  if (header.isArray) navigateToArrayPath(state, stack, header.path, start)
  else navigateToTablePath(state, stack, header.path, start)
  requireStatementEnd(state, sink)
  const rootDepth = stack.length
  runStatements(state, sink, stack, header.path, rootDepth, end)
  closeFramesTo(state, stack, 0, Math.min(end, source.length))
  return {
    complete: !state.fatal && state.pos <= end,
    bytesConsumed: state.pos,
    diagnosticCount: state.diagnosticCount
  }
}

// ---------------------------------------------------------------------------
// format() — R16, M6-PLAN.md. Conservative (CONCEPT.md §5.7's own rule for
// TOML: "key order and table grouping preserved; only whitespace
// normalized"). A single-line inline table/array (`{ a = 1 }`, `[1, 2, 3]`)
// is re-emitted with consistent internal spacing, the same as everything
// else. A *multi-line* inline array is copied verbatim instead — TOML
// legally lets one span lines and hold `#` comments between elements, and
// collapsing that layout risks losing a comment or corrupting its
// placement, not just looking different; whether a value's own span
// contains a newline is checked once, via the real, already-iterative
// `parseInlineValue` run against a throwaway `ParserState` (never a second,
// parallel scanner that could disagree with the parser about where a
// string or nested container actually ends). No newline in the span also
// means no comment can be present (a comment always runs to end of line),
// so the single-line reformatter below never needs to account for one.
// ---------------------------------------------------------------------------

function formatKeyPath(source: Uint8Array, path: readonly KeySpan[], out: GrowableBytes): void {
  for (let i = 0; i < path.length; i++) {
    if (i > 0) out.push(DOT)
    const seg = path[i]!
    out.pushBytes(source, seg.start, seg.end)
  }
}

function endOfInlineValue(state: ParserState): number {
  const probe = new ParserState(state.source, silentSink, state.options, state.pos)
  parseInlineValue(probe, silentSink, null)
  return probe.pos
}

function spanHasNewline(source: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (isNewlineByte(source[i]!)) return true
  }
  return false
}

const enum FormatContainerKind {
  Table,
  Array
}
const enum FormatTableState {
  ExpectKeyOrClose,
  ExpectValue,
  ExpectCommaOrClose
}
const enum FormatArrayState {
  ExpectValueOrClose,
  ExpectCommaOrClose
}

interface FormatTableFrame {
  readonly kind: FormatContainerKind.Table
  state: FormatTableState
  first: boolean
}
interface FormatArrayFrame {
  readonly kind: FormatContainerKind.Array
  state: FormatArrayState
  first: boolean
}
type FormatFrame = FormatTableFrame | FormatArrayFrame

function openFormatContainer(state: ParserState, out: GrowableBytes, stack: FormatFrame[]): void {
  const b = state.peek()
  state.pos++
  if (b === OPEN_BRACE) {
    out.push(OPEN_BRACE)
    stack.push({
      kind: FormatContainerKind.Table,
      state: FormatTableState.ExpectKeyOrClose,
      first: true
    })
  } else {
    out.push(OPEN_BRACKET)
    stack.push({
      kind: FormatContainerKind.Array,
      state: FormatArrayState.ExpectValueOrClose,
      first: true
    })
  }
}

/** Only ever called on a span already verified newline-free (see this section's own top
 * comment) — every branch below still terminates its own frame on an unexpected byte or EOF
 * (best-effort recovery, invariant 5), it just never has a comment or a line break to account
 * for while doing it. */
function stepFormatTable(
  state: ParserState,
  out: GrowableBytes,
  stack: FormatFrame[],
  frame: FormatTableFrame
): void {
  state.skipInlineWhitespace()
  if (state.atEnd()) {
    out.pushAscii(frame.first ? '}' : ' }')
    stack.pop()
    return
  }
  const b = state.peek()

  if (
    (frame.state === FormatTableState.ExpectKeyOrClose ||
      frame.state === FormatTableState.ExpectCommaOrClose) &&
    b === CLOSE_BRACE
  ) {
    state.pos++
    out.pushAscii(frame.first ? '}' : ' }')
    stack.pop()
    return
  }
  if (frame.state === FormatTableState.ExpectCommaOrClose) {
    if (b === COMMA) {
      state.pos++
      frame.state = FormatTableState.ExpectKeyOrClose
      return
    }
    out.pushAscii(' }') // malformed — best effort, close and stop
    stack.pop()
    return
  }
  if (frame.state === FormatTableState.ExpectKeyOrClose) {
    const keyPath = scanKeyPath(state)
    if (keyPath === null) {
      out.pushAscii(' }')
      stack.pop()
      return
    }
    out.pushAscii(frame.first ? ' ' : ', ')
    frame.first = false
    formatKeyPath(state.source, keyPath, out)
    state.skipInlineWhitespace()
    if (state.peek() === EQUALS) state.pos++
    out.pushAscii(' = ')
    frame.state = FormatTableState.ExpectValue
    return
  }
  // ExpectValue
  state.skipInlineWhitespace()
  if (state.peek() === OPEN_BRACE || state.peek() === OPEN_BRACKET) {
    openFormatContainer(state, out, stack)
    frame.state = FormatTableState.ExpectCommaOrClose
    return
  }
  const { start, end } = scanScalarSpan(state)
  out.pushBytes(state.source, start, end)
  frame.state = FormatTableState.ExpectCommaOrClose
}

function stepFormatArray(
  state: ParserState,
  out: GrowableBytes,
  stack: FormatFrame[],
  frame: FormatArrayFrame
): void {
  state.skipInlineWhitespace()
  if (state.atEnd()) {
    out.push(CLOSE_BRACKET)
    stack.pop()
    return
  }
  const b = state.peek()

  if (
    (frame.state === FormatArrayState.ExpectValueOrClose ||
      frame.state === FormatArrayState.ExpectCommaOrClose) &&
    b === CLOSE_BRACKET
  ) {
    state.pos++
    out.push(CLOSE_BRACKET)
    stack.pop()
    return
  }
  if (frame.state === FormatArrayState.ExpectCommaOrClose) {
    if (b === COMMA) {
      state.pos++
      frame.state = FormatArrayState.ExpectValueOrClose
      return
    }
    out.push(CLOSE_BRACKET) // malformed — best effort, close and stop
    stack.pop()
    return
  }
  // ExpectValueOrClose
  if (!frame.first) out.pushAscii(', ')
  frame.first = false
  if (b === OPEN_BRACE || b === OPEN_BRACKET) {
    openFormatContainer(state, out, stack)
    frame.state = FormatArrayState.ExpectCommaOrClose
    return
  }
  const { start, end } = scanScalarSpan(state)
  out.pushBytes(state.source, start, end)
  frame.state = FormatArrayState.ExpectCommaOrClose
}

/** Entry point for a single-line inline value — mirrors `parseInlineValue`'s own iterative,
 * explicit-stack shape (hard rule 4) exactly, driven by `format()`'s caller having already
 * confirmed the span holds no newline. */
function formatInlineValue(state: ParserState, out: GrowableBytes): void {
  const stack: FormatFrame[] = []
  openFormatContainer(state, out, stack)
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    if (frame.kind === FormatContainerKind.Table) stepFormatTable(state, out, stack, frame)
    else stepFormatArray(state, out, stack, frame)
  }
}

function formatValue(state: ParserState, out: GrowableBytes): void {
  const b = state.peek()
  if (b === OPEN_BRACE || b === OPEN_BRACKET) {
    const end = endOfInlineValue(state)
    if (spanHasNewline(state.source, state.pos, end)) {
      out.pushBytes(state.source, state.pos, end)
      state.pos = end
      return
    }
    formatInlineValue(state, out)
    return
  }
  const { start, end } = scanScalarSpan(state)
  out.pushBytes(state.source, start, end)
}

function formatHeader(state: ParserState, out: GrowableBytes): void {
  const isArray = state.peek(1) === OPEN_BRACKET
  state.pos += isArray ? 2 : 1
  out.pushAscii(isArray ? '[[' : '[')
  state.skipInlineWhitespace()
  const path = scanKeyPath(state)
  state.skipInlineWhitespace()
  if (path !== null) formatKeyPath(state.source, path, out)
  if (isArray) {
    if (state.peek() === CLOSE_BRACKET && state.peek(1) === CLOSE_BRACKET) state.pos += 2
    out.pushAscii(']]')
  } else {
    if (state.peek() === CLOSE_BRACKET) state.pos++
    out.pushAscii(']')
  }
}

function formatComment(state: ParserState, out: GrowableBytes): void {
  const start = state.pos
  while (!state.atEnd() && !isNewlineByte(state.peek())) state.pos++
  out.pushBytes(state.source, start, state.pos)
}

function formatTrailingComment(state: ParserState, out: GrowableBytes): void {
  state.skipInlineWhitespace()
  if (state.peek() === HASH) {
    out.pushAscii(' ')
    formatComment(state, out)
  }
}

function formatKeyValueStatement(state: ParserState, out: GrowableBytes): void {
  const keyPath = scanKeyPath(state)
  if (keyPath === null) {
    // Malformed — best effort, copy the rest of the line verbatim rather
    // than lose or misrepresent content invariant 5 requires we tolerate.
    const start = state.pos
    state.skipToEndOfLine()
    out.pushBytes(state.source, start, state.pos)
    return
  }
  formatKeyPath(state.source, keyPath, out)
  state.skipInlineWhitespace()
  if (state.peek() === EQUALS) state.pos++
  out.pushAscii(' = ')
  state.skipInlineWhitespace()
  if (state.atEnd() || isNewlineByte(state.peek()) || state.peek() === HASH) return
  formatValue(state, out)
}

function format(source: Uint8Array, options: FormatOptions): Uint8Array {
  const bomLength = bomLengthAt(source)
  const out = new GrowableBytes(Math.max(1024, source.length))
  out.pushBytes(source, 0, bomLength)

  const noop: ParseOptions = { maxDepth: 100_000, encoding: 'utf-8' }
  const state = new ParserState(source, silentSink, noop, bomLength)

  // Tracks whether `out` currently ends in a newline, so the final
  // "ensure exactly one trailing newline" step below doesn't double up when
  // `copyBlankLines` already emitted one right up to EOF.
  let endsInNewline = out.length === 0

  /** Preserves the number of blank lines between statements while
   * normalizing newline style and stripping any leading inline indentation
   * (canonical TOML statements are never indented). */
  function copyBlankLines(): void {
    let newlineCount = 0
    while (!state.atEnd() && (isInlineWhitespace(state.peek()) || isNewlineByte(state.peek()))) {
      if (state.peek() === NEWLINE) newlineCount++
      else if (state.peek() === CR && state.peek(1) !== NEWLINE) newlineCount++
      state.pos++
    }
    for (let i = 0; i < newlineCount; i++) out.pushAscii(options.newline)
    if (newlineCount > 0) endsInNewline = true
  }

  for (;;) {
    copyBlankLines()
    if (state.atEnd()) break
    endsInNewline = false
    const b = state.peek()
    if (b === HASH) {
      formatComment(state, out)
      continue
    }
    if (b === OPEN_BRACKET) {
      formatHeader(state, out)
      formatTrailingComment(state, out)
      continue
    }
    formatKeyValueStatement(state, out)
    formatTrailingComment(state, out)
  }
  if (!endsInNewline) out.pushAscii(options.newline)
  return out.toArray()
}

export const tomlFormatModule: FormatModule = {
  capabilities: tomlCapabilities,
  detect,
  detectEncoding,
  parse,
  parseRange,
  resumeContextFor,
  format
}
