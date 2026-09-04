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
import { bomLengthAt, detectEncoding as resolveDeclaredEncoding } from '../../core/encoding'
import { GrowableBytes } from '../../core/growableBytes'
import { DEFAULT_MAX_DEPTH } from '../../core/parseDefaults'

const LT = 0x3c // <
const GT = 0x3e // >
const SLASH = 0x2f // /
const QMARK = 0x3f // ?
const BANG = 0x21 // !
const LBRACKET = 0x5b // [
const RBRACKET = 0x5d // ]
const EQUALS = 0x3d // =
const DQUOTE = 0x22 // "
const SQUOTE = 0x27 // '

function isWhitespace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d
}

function isNameByte(b: number): boolean {
  // Permissive on purpose: a byte-scanning tokenizer, not a strict XML NCName
  // validator. Excludes markup delimiters and whitespace, nothing else.
  return (
    !isWhitespace(b) &&
    b !== LT &&
    b !== GT &&
    b !== SLASH &&
    b !== EQUALS &&
    b !== DQUOTE &&
    b !== SQUOTE &&
    b !== QMARK
  )
}

export const xmlCapabilities: FormatCapabilities = {
  id: 'xml',
  displayName: 'XML',
  extensions: ['.xml'],
  hasAttributes: true,
  hasComments: true,
  hasNamespaces: true,
  canFormat: true, // R11 (M5e-PLAN.md, reopens D-045) — see `format` below
  canIncrementalReparse: true,
  rowBreakBytes: ['>'.charCodeAt(0), ' '.charCodeAt(0)]
}

/** XML's format-specific resume state: the xml:space scope at the resume point. */
export interface XmlResumeContext extends ResumeContext {
  readonly preserveWhitespace: boolean
  /** prefix -> URI, accumulated from ancestor xmlns/xmlns:* attributes. */
  readonly namespaces: ReadonlyMap<string, string>
}

const XML_SPACE_BYTES = utf8Bytes('xml:space')
const PRESERVE_BYTES = utf8Bytes('preserve')

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function bytesEqualRange(
  a: Uint8Array,
  aStart: number,
  aEnd: number,
  b: Uint8Array,
  bStart: number,
  bEnd: number
): boolean {
  if (aEnd - aStart !== bEnd - bStart) return false
  for (let i = 0; i < aEnd - aStart; i++) {
    if (a[aStart + i] !== b[bStart + i]) return false
  }
  return true
}

function matchesLiteral(source: Uint8Array, pos: number, literal: Uint8Array): boolean {
  if (pos + literal.length > source.length) return false
  for (let i = 0; i < literal.length; i++) {
    if (source[pos + i] !== literal[i]) return false
  }
  return true
}

interface PendingText {
  start: Offset
  end: Offset
}

interface Frame {
  node: NodeRef
  /** The opening tag's raw name span — end tags are matched by comparing
   * bytes directly, since NodeSink exposes no name-lookup to the parser. */
  nameStart: Offset
  nameEnd: Offset
  preserve: boolean
  pendingText: PendingText | null
  /** Whether any child has opened so far — decides, at close, whether a
   * still-pending trailing run folds into the element or becomes a Text node. */
  hasChildNodes: boolean
}

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

  /** Coarse progress signal (~1 MB) for the worker to relay to the UI. */
  reportProgress(): void {
    if (this.pos - this.lastProgressAt >= PROGRESS_INTERVAL_BYTES) {
      this.lastProgressAt = this.pos
      this.sink.progress(this.pos)
    }
  }

  emit(severity: Severity, code: string, offset: Offset, length: number, message: string): void {
    const d: Diagnostic = { severity, code, offset, length, message }
    this.sink.diagnostic(d)
    this.diagnosticCount++
    if (severity === Severity.Fatal) this.fatal = true
  }

  atEnd(): boolean {
    return this.pos >= this.source.length
  }

  peek(offset = 0): number {
    return this.source[this.pos + offset]!
  }
}

function isWhitespaceOnly(source: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (!isWhitespace(source[i]!)) return false
  }
  return true
}

/** Flushes `frame`'s pending text run as a real child (Text node or a
 * dropped-whitespace signal), because a new child is about to open under it
 * and the parent is therefore composite. */
function flushPendingAsChild(state: ParserState, frame: Frame): void {
  frame.hasChildNodes = true
  const pending = frame.pendingText
  if (pending === null) return
  frame.pendingText = null

  if (!frame.preserve && isWhitespaceOnly(state.source, pending.start, pending.end)) {
    state.sink.value(pending.start, pending.start)
    return
  }
  const text = state.sink.openNode(NodeKind.Text, pending.start, -1, -1)
  state.sink.value(pending.start, pending.end)
  state.sink.closeNode(text, pending.end)
}

/** Flushes `frame`'s pending text run at its own close: folds directly into
 * the element's value if no child ever opened (B9's "one text run, no
 * children" leaf rule); otherwise this is a *trailing* run after other
 * children and must become its own Text node, same as any other child. */
function flushPendingAtClose(state: ParserState, frame: Frame): void {
  if (frame.hasChildNodes) {
    flushPendingAsChild(state, frame)
    return
  }
  const pending = frame.pendingText
  frame.pendingText = null
  if (pending === null) return
  state.sink.value(pending.start, pending.end)
}

function closeFrame(state: ParserState, frame: Frame, spanEnd: Offset): void {
  flushPendingAtClose(state, frame)
  state.sink.closeNode(frame.node, spanEnd)
}

/** Scans a name token (element/attribute/PI-target name). */
function scanName(state: ParserState): { start: Offset; end: Offset } {
  const start = state.pos
  while (!state.atEnd() && isNameByte(state.peek())) state.pos++
  return { start, end: state.pos }
}

function skipWhitespace(state: ParserState): void {
  while (!state.atEnd() && isWhitespace(state.peek())) state.pos++
}

/** Scans an attribute value's quoted content; returns the span *excluding* the quotes. */
function scanAttributeValue(state: ParserState): { start: Offset; end: Offset } {
  const quote = state.peek()
  state.pos++ // opening quote
  const start = state.pos
  while (!state.atEnd() && state.peek() !== quote) state.pos++
  const end = state.pos
  if (state.atEnd()) {
    state.emit(
      Severity.Fatal,
      'xml.unterminated-attribute-value',
      start,
      end - start,
      'Unterminated attribute value'
    )
  } else {
    state.pos++ // closing quote
  }
  return { start, end }
}

/** Parses the attribute list of a start/empty-element tag, up to (not including) '/' or '>'. */
function scanAttributes(state: ParserState, frame: Frame): void {
  for (;;) {
    skipWhitespace(state)
    if (state.atEnd()) return
    const b = state.peek()
    if (b === SLASH || b === GT || b === QMARK) return

    const name = scanName(state)
    if (name.end === name.start) {
      // Not making progress — bail to avoid looping forever on garbage.
      state.emit(Severity.Error, 'xml.expected-attribute', state.pos, 1, 'Expected an attribute')
      state.pos++
      continue
    }
    skipWhitespace(state)
    if (state.peek() === EQUALS) {
      state.pos++
    } else {
      state.emit(Severity.Error, 'xml.expected-equals', state.pos, 1, "Expected '=' in attribute")
      continue
    }
    skipWhitespace(state)
    if (state.peek() !== DQUOTE && state.peek() !== SQUOTE) {
      state.emit(
        Severity.Error,
        'xml.expected-quote',
        state.pos,
        1,
        'Expected a quoted attribute value'
      )
      continue
    }
    const value = scanAttributeValue(state)
    state.sink.attribute(name.start, name.end, value.start, value.end)

    if (
      bytesEqualRange(
        state.source,
        name.start,
        name.end,
        XML_SPACE_BYTES,
        0,
        XML_SPACE_BYTES.length
      )
    ) {
      frame.preserve = bytesEqualRange(
        state.source,
        value.start,
        value.end,
        PRESERVE_BYTES,
        0,
        PRESERVE_BYTES.length
      )
    }
  }
}

/** Scans forward to the first occurrence of `terminator`, returning the offset just past it. */
/** Scans forward to `terminator` and consumes it, advancing `state.pos` past
 * it. Returns the resulting position (same as `state.pos`) for callers that
 * want it inline; the advance is not optional the way a return value is. */
function scanUntilLiteral(state: ParserState, terminator: Uint8Array, code: string): number {
  while (!state.atEnd() && !matchesLiteral(state.source, state.pos, terminator)) state.pos++
  if (state.atEnd()) {
    state.emit(Severity.Fatal, code, state.pos, 0, 'Unterminated markup section')
    return state.pos
  }
  state.pos += terminator.length
  return state.pos
}

const COMMENT_END = utf8Bytes('-->')
const CDATA_START = utf8Bytes('<![CDATA[')
const CDATA_END = utf8Bytes(']]>')
const PI_END = utf8Bytes('?>')
const XML_DECL_START = utf8Bytes('<?xml')
const DOCTYPE_START = utf8Bytes('<!DOCTYPE')
const END_TAG_START = utf8Bytes('</')
const COMMENT_START = utf8Bytes('<!--')

/** `<?xml` is only the declaration when it isn't the start of a longer PI
 * target, e.g. `<?xml-stylesheet`: the next byte must end the target name. */
function isXmlDeclarationAt(source: Uint8Array, pos: number): boolean {
  if (!matchesLiteral(source, pos, XML_DECL_START)) return false
  const next = source[pos + XML_DECL_START.length]
  return next === undefined || isWhitespace(next) || next === QMARK
}

function parseComment(state: ParserState, stack: Frame[]): void {
  const spanStart = state.pos
  flushPendingAsChild(state, stack[stack.length - 1]!)
  state.pos += COMMENT_START.length
  const innerStart = state.pos
  const end = scanUntilLiteral(state, COMMENT_END, 'xml.unterminated-comment')
  const innerEnd = Math.max(innerStart, end - COMMENT_END.length)
  const node = state.sink.openNode(NodeKind.Comment, spanStart, -1, -1)
  state.sink.value(innerStart, innerEnd)
  state.sink.closeNode(node, end)
}

function parseCData(state: ParserState, stack: Frame[]): void {
  const spanStart = state.pos
  flushPendingAsChild(state, stack[stack.length - 1]!)
  state.pos += CDATA_START.length
  const innerStart = state.pos
  const end = scanUntilLiteral(state, CDATA_END, 'xml.unterminated-cdata')
  const innerEnd = Math.max(innerStart, end - CDATA_END.length)
  const node = state.sink.openNode(NodeKind.CData, spanStart, -1, -1)
  state.sink.value(innerStart, innerEnd)
  state.sink.closeNode(node, end)
}

function parseProcessingInstruction(state: ParserState, stack: Frame[]): void {
  const spanStart = state.pos
  flushPendingAsChild(state, stack[stack.length - 1]!)
  state.pos += 2 // '<?'
  const target = scanName(state)
  skipWhitespace(state)
  const contentStart = state.pos
  const end = scanUntilLiteral(state, PI_END, 'xml.unterminated-pi')
  const contentEnd = Math.max(contentStart, end - PI_END.length)
  const node = state.sink.openNode(
    NodeKind.ProcessingInstruction,
    spanStart,
    target.start,
    target.end
  )
  state.sink.value(contentStart, contentEnd)
  state.sink.closeNode(node, end)
}

/** The `<?xml ...?>` declaration is metadata, not a tree node — skipped entirely. */
function skipXmlDeclaration(state: ParserState): void {
  state.pos += XML_DECL_START.length
  scanUntilLiteral(state, PI_END, 'xml.unterminated-xml-declaration')
}

function parseDoctype(state: ParserState, stack: Frame[]): void {
  const spanStart = state.pos
  flushPendingAsChild(state, stack[stack.length - 1]!)
  state.pos += DOCTYPE_START.length
  const innerStart = state.pos
  // Balanced-bracket scan for the internal subset; do not parse its contents.
  let depth = 0
  while (!state.atEnd()) {
    const b = state.peek()
    if (b === LBRACKET) depth++
    else if (b === RBRACKET) depth = Math.max(0, depth - 1)
    else if (b === GT && depth === 0) break
    state.pos++
  }
  const innerEnd = state.pos
  if (state.atEnd()) {
    state.emit(Severity.Fatal, 'xml.unterminated-doctype', spanStart, 0, 'Unterminated DOCTYPE')
  } else {
    state.pos++ // consume '>'
  }
  const node = state.sink.openNode(NodeKind.DocType, spanStart, -1, -1)
  state.sink.value(innerStart, innerEnd)
  state.sink.closeNode(node, state.pos)
}

function parseEndTag(state: ParserState, stack: Frame[]): void {
  const tagStart = state.pos
  state.pos += END_TAG_START.length
  const name = scanName(state)
  skipWhitespace(state)
  if (!state.atEnd() && state.peek() === GT) state.pos++
  const spanEnd = state.pos

  // Find the nearest matching open frame by comparing raw name bytes.
  let matchIndex = -1
  for (let i = stack.length - 1; i >= 1; i--) {
    const f = stack[i]!
    if (bytesEqualRange(state.source, f.nameStart, f.nameEnd, state.source, name.start, name.end)) {
      matchIndex = i
      break
    }
  }

  if (matchIndex === -1) {
    state.emit(
      Severity.Error,
      'xml.unmatched-end-tag',
      tagStart,
      spanEnd - tagStart,
      'End tag does not match any open element'
    )
    return
  }

  if (matchIndex !== stack.length - 1) {
    state.emit(
      Severity.Error,
      'xml.mismatched-end-tag',
      tagStart,
      spanEnd - tagStart,
      'End tag does not match the innermost open element; closing intervening elements'
    )
  }
  while (stack.length > matchIndex) {
    const frame = stack.pop()!
    closeFrame(state, frame, spanEnd)
  }
}

function parseStartTag(state: ParserState, stack: Frame[]): void {
  const tagStart = state.pos
  const parent = stack[stack.length - 1]!
  flushPendingAsChild(state, parent)

  state.pos++ // '<'
  const name = scanName(state)
  const node = state.sink.openNode(NodeKind.Element, tagStart, name.start, name.end)
  const newFrame: Frame = {
    node,
    nameStart: name.start,
    nameEnd: name.end,
    preserve: parent.preserve,
    pendingText: null,
    hasChildNodes: false
  }
  scanAttributes(state, newFrame)

  skipWhitespace(state)
  if (!state.atEnd() && state.peek() === SLASH) {
    state.pos++ // '/'
    if (!state.atEnd() && state.peek() === GT) state.pos++
    state.sink.closeNode(node, state.pos)
    return
  }
  if (!state.atEnd() && state.peek() === GT) state.pos++
  stack.push(newFrame)
}

/**
 * Drives the tokenizer/tree-builder loop. `stopAtStackLength`, when given, is
 * checked *after* each dispatch (never before the first) so the loop halts
 * the moment the target subtree's own frame — or a self-contained node like
 * a comment or self-closing tag, which never pushes one — has fully closed,
 * instead of continuing to scan sibling content beyond it. `parse` passes
 * `null` and runs to EOF; `parseRange` passes the stack depth it started at.
 */
function runParser(state: ParserState, stack: Frame[], stopAtStackLength: number | null): void {
  while (!state.atEnd()) {
    state.reportProgress()
    if (stack.length > state.options.maxDepth) {
      state.emit(
        Severity.Fatal,
        'xml.max-depth-exceeded',
        state.pos,
        0,
        `Nesting exceeds maxDepth (${state.options.maxDepth})`
      )
      break
    }
    if (state.options.signal?.aborted) break

    if (state.peek() !== LT) {
      const start = state.pos
      while (!state.atEnd() && state.peek() !== LT) state.pos++
      const frame = stack[stack.length - 1]!
      // A single contiguous run since the last markup boundary — nothing to merge.
      frame.pendingText = { start, end: state.pos }
    } else if (isXmlDeclarationAt(state.source, state.pos)) {
      skipXmlDeclaration(state)
    } else if (matchesLiteral(state.source, state.pos, END_TAG_START)) {
      parseEndTag(state, stack)
    } else if (matchesLiteral(state.source, state.pos, COMMENT_START)) {
      parseComment(state, stack)
    } else if (matchesLiteral(state.source, state.pos, CDATA_START)) {
      parseCData(state, stack)
    } else if (matchesLiteral(state.source, state.pos, DOCTYPE_START)) {
      parseDoctype(state, stack)
    } else if (state.peek(1) === QMARK) {
      parseProcessingInstruction(state, stack)
    } else if (state.peek(1) === BANG) {
      // Unrecognized `<!...>` markup (e.g. a malformed declaration) — skip to '>'.
      const start = state.pos
      while (!state.atEnd() && state.peek() !== GT) state.pos++
      if (!state.atEnd()) state.pos++
      state.emit(
        Severity.Error,
        'xml.unknown-markup',
        start,
        state.pos - start,
        'Unrecognized markup'
      )
    } else {
      parseStartTag(state, stack)
    }

    if (stopAtStackLength !== null && stack.length <= stopAtStackLength) return
  }

  // Truncated input: close whatever is still open, deepest first. Only
  // reached by a full `parse()` — `parseRange` returns above once its target
  // subtree closes, well before EOF.
  while (stack.length > 1) {
    const frame = stack.pop()!
    if (!state.fatal) {
      // Reaching EOF with an element still open means parsing genuinely
      // cannot continue, same as any other unexpected-EOF case — Fatal, not
      // a recoverable Error.
      state.emit(
        Severity.Fatal,
        'xml.unclosed-element',
        frame.nameStart,
        frame.nameEnd - frame.nameStart,
        'Element was never closed'
      )
    }
    closeFrame(state, frame, state.source.length)
  }
}

// ---------------------------------------------------------------------------
// FormatModule
// ---------------------------------------------------------------------------

function detect(head: Uint8Array, filename: string | null): number {
  if (filename !== null && filename.toLowerCase().endsWith('.xml')) return 0.9
  for (let i = 0; i < head.length; i++) {
    const b = head[i]!
    if (isWhitespace(b)) continue
    return b === LT ? 0.7 : 0
  }
  return 0
}

const ENCODING_ATTR = utf8Bytes('encoding')

function detectEncoding(head: Uint8Array): string | null {
  if (!isXmlDeclarationAt(head, 0)) return null
  const declEnd = (() => {
    for (let i = 0; i + 1 < head.length; i++) {
      if (head[i] === QMARK && head[i + 1] === GT) return i + 2
    }
    return head.length
  })()

  const idx = indexOfBytes(head, ENCODING_ATTR, 0, declEnd)
  if (idx === -1) return null
  let i = idx + ENCODING_ATTR.length
  while (i < declEnd && isWhitespace(head[i]!)) i++
  if (head[i] !== EQUALS) return null
  i++
  while (i < declEnd && isWhitespace(head[i]!)) i++
  const quote = head[i]
  if (quote !== DQUOTE && quote !== SQUOTE) return null
  i++
  const start = i
  while (i < declEnd && head[i] !== quote) i++
  if (i >= declEnd) return null
  return new TextDecoder('ascii').decode(head.subarray(start, i))
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number, to: number): number {
  outer: for (let i = from; i + needle.length <= to; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function rootFrame(sink: NodeSink): Frame {
  const doc = sink.openNode(NodeKind.Document, 0, -1, -1)
  return {
    node: doc,
    nameStart: -1,
    nameEnd: -1,
    preserve: false,
    pendingText: null,
    hasChildNodes: false
  }
}

function parse(source: Uint8Array, sink: NodeSink, options: ParseOptions): ParseResult {
  // A BOM at offset 0 is skipped in place, never stripped — spans stay
  // absolute in the original buffer (C1).
  const state = new ParserState(source, sink, options, bomLengthAt(source))
  const stack: Frame[] = [rootFrame(sink)]
  runParser(state, stack, null)
  const doc = stack[0]!
  sink.closeNode(doc.node, source.length)
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
  context: ResumeContext,
  options: ParseOptions
): ParseResult {
  const state = new ParserState(source, sink, options, start)

  // A node whose span doesn't open with '<' can only be a Text run (every
  // other kind's span starts at its own markup delimiter) — no grammar to
  // dispatch on, so emit it directly rather than entering the tokenizer.
  if (state.atEnd() || state.peek() !== LT) {
    const node = sink.openNode(NodeKind.Text, start, -1, -1)
    sink.value(start, end)
    sink.closeNode(node, end)
    return { complete: true, bytesConsumed: end, diagnosticCount: 0 }
  }

  const xmlContext = context as XmlResumeContext
  // A synthetic, unclosed root frame standing in for "wherever this range is
  // rooted" — its own node is never opened/closed; it only carries the
  // inherited xml:space scope so text rules stay correct at the resume point.
  const stack: Frame[] = [
    {
      node: -1,
      nameStart: -1,
      nameEnd: -1,
      preserve: xmlContext.preserveWhitespace,
      pendingText: null,
      hasChildNodes: true
    }
  ]
  runParser(state, stack, 1)
  return {
    complete: !state.fatal && state.pos <= end,
    bytesConsumed: state.pos,
    diagnosticCount: state.diagnosticCount
  }
}

function resumeContextFor(ancestors: AncestorView): ResumeContext {
  let preserve = false
  const namespaces = new Map<string, string>()

  for (let i = 0; i < ancestors.length; i++) {
    for (const attr of ancestors.attributesAt(i)) {
      if (attr.name === 'xml:space') {
        preserve = attr.value === 'preserve'
      } else if (attr.name === 'xmlns') {
        namespaces.set('', attr.value)
      } else if (attr.name.startsWith('xmlns:')) {
        namespaces.set(attr.name.slice('xmlns:'.length), attr.value)
      }
    }
  }

  const ctx: XmlResumeContext = { formatId: 'xml', preserveWhitespace: preserve, namespaces }
  return ctx
}

// ---------------------------------------------------------------------------
// format (M5e-PLAN.md R11, reopens D-045)
// ---------------------------------------------------------------------------
//
// Two passes over the bytes, per the plan's own resolution of the one
// genuinely awkward part: `format()` receives bytes, not a `NodeStore`, so
// it cannot read `NodeFlags.IsMixed` directly, and mixed-content detection
// needs lookahead (an element isn't known to be mixed until all its
// children have been seen). Buffering per-element output instead would be
// unbounded on a large root element — the wrong trade.
//
// Pass 1 (`collectFormatInfo`) runs the real `parse()` above with a
// lightweight recording `NodeSink` — not a second parser — so its
// mixed/preserve verdicts are provably the same ones a real parse would
// produce (a real parse of the formatted output is exactly what the round-
// trip invariant tests check this against). Pass 2 (`emitChild` /
// `formatElement`) re-walks the same grammar, reusing this file's own
// tokenizer primitives (`scanName`, `scanAttributes`, `skipWhitespace`,
// `matchesLiteral`, `scanUntilLiteral`, the markup-literal constants) —
// the parser and the formatter agree on the grammar because they are
// *reading it with the same code*, not two independent descriptions of it.

/** A no-op sink, used for pass 2's own `ParserState` (it never builds a
 * tree) and for `captureVerbatimSpan`'s `runParser` calls — the same
 * pattern `formats/json/index.ts`'s `format` uses its own `silentSink` for. */
const silentSink: NodeSink = {
  openNode: () => 0,
  attribute: () => {},
  value: () => {},
  closeNode: () => {},
  diagnostic: () => {},
  progress: () => {}
}

/** M5g-PLAN.md O2: `isMixed`/`preserve`/`hasStructuralChildren` packed into
 * one bit each — invariant 2's no-object-per-node rule, applied to the
 * formatter's own working set (this file's pass 1 was the one place it was
 * still being broken: 329,573 `Map` entries plus 329,573 heap objects on
 * `cars-10mb.xml`, ~25 MB of overhead for a 10 MB file). */
const enum FormatFlag {
  IsMixed = 1,
  Preserve = 2,
  HasStructuralChildren = 4
}

/** Parallel arrays over every **Element** node pass 1 saw, `starts` sorted
 * ascending — pass 1 (`openNode`) and pass 2 (`formatElement`/`emitChild`)
 * both visit elements in document order, so pass 2 can walk this with a
 * plain cursor (`formatCursor`) instead of a `Map` lookup per element: no
 * hashing, no boxing, no per-element object. Only Element entries are kept
 * — `formatElement` is the only reader, and it only ever queries an
 * element's own span-start (never Text/CData/Comment/PI/DocType, which
 * `emitChild`'s other branch copies verbatim without consulting this at
 * all) — so those never got a real Map entry lookup either; the Map
 * version just paid to store them anyway. */
interface FormatInfoTable {
  readonly starts: Int32Array
  readonly ends: Int32Array
  readonly flags: Uint8Array
  readonly count: number
  /** `M5h-PLAN.md R18, §2c`: `parse`'s own `!state.fatal` — most concretely,
   * nesting past `options.maxDepth` (§2b: now the same limit the document
   * was actually opened under, not the old, ten-times-too-permissive
   * `100_000`). `format()` checks this *before* running pass 2 at all: a
   * document the real parse only got a bounded, diagnostic-carrying partial
   * tree from is not one pass 2 can safely re-render — degrade to "return
   * the input unchanged" (invariant 5's own rule, applied here rather than
   * having pass 2 discover an incomplete table mid-walk and improvise). */
  readonly complete: boolean
}

/** Mutable read position into a `FormatInfoTable`, threaded through the
 * pass-2 element stack by reference (a plain number can't be, in JS) — one
 * per `format()` call. */
interface FormatCursor {
  pos: number
}

/** Pass 1: a real parse (`parse`, above) through a sink that records, per
 * element, exactly what `formatElement` needs to decide how to render it —
 * nothing is decided here that pass 2 could get wrong independently,
 * because pass 2 never re-derives it; it only reads it off, in order. */
function collectFormatInfo(source: Uint8Array, options: ParseOptions): FormatInfoTable {
  let capacity = 1024
  let starts = new Int32Array(capacity)
  let ends = new Int32Array(capacity)
  let flags = new Uint8Array(capacity)
  let count = 0

  function grow(): void {
    capacity *= 2
    const nextStarts = new Int32Array(capacity)
    nextStarts.set(starts)
    starts = nextStarts
    const nextEnds = new Int32Array(capacity)
    nextEnds.set(ends)
    ends = nextEnds
    const nextFlags = new Uint8Array(capacity)
    nextFlags.set(flags)
    flags = nextFlags
  }

  interface CollectFrame {
    kind: NodeKind
    spanStart: Offset
    sawText: boolean
    sawNonText: boolean
    preserve: boolean
    /** Index reserved in `starts`/`ends`/`flags` at `openNode` time — `-1`
     * for every non-Element kind, which gets no entry (see this function's
     * own doc comment). Reserved at open, not close, so the slot's index
     * already reflects pre-order (document) position — the order pass 2
     * reads them back in. */
    slot: number
  }
  const stack: CollectFrame[] = []
  let nextRef = 0

  const sink: NodeSink = {
    openNode: (kind, spanStart) => {
      const parent = stack[stack.length - 1]
      if (parent !== undefined) {
        if (kind === NodeKind.Text || kind === NodeKind.CData) parent.sawText = true
        else parent.sawNonText = true
      }
      let slot = -1
      if (kind === NodeKind.Element) {
        if (count >= capacity) grow()
        slot = count++
        starts[slot] = spanStart
      }
      stack.push({
        kind,
        spanStart,
        sawText: false,
        sawNonText: false,
        preserve: parent?.preserve ?? false,
        slot
      })
      return nextRef++
    },
    attribute: (nameStart, nameEnd, valueStart, valueEnd) => {
      const frame = stack[stack.length - 1]
      if (frame === undefined) return
      if (bytesEqualRange(source, nameStart, nameEnd, XML_SPACE_BYTES, 0, XML_SPACE_BYTES.length)) {
        frame.preserve = bytesEqualRange(
          source,
          valueStart,
          valueEnd,
          PRESERVE_BYTES,
          0,
          PRESERVE_BYTES.length
        )
      }
    },
    value: () => {},
    closeNode: (_node, spanEnd) => {
      const frame = stack.pop()
      if (frame === undefined || frame.slot === -1) return
      ends[frame.slot] = spanEnd
      flags[frame.slot] =
        (frame.sawText && frame.sawNonText ? FormatFlag.IsMixed : 0) |
        (frame.preserve ? FormatFlag.Preserve : 0) |
        (frame.sawNonText ? FormatFlag.HasStructuralChildren : 0)
    },
    diagnostic: () => {},
    progress: () => {}
  }

  const result = parse(source, sink, options)
  return {
    starts: starts.subarray(0, count),
    ends: ends.subarray(0, count),
    flags: flags.subarray(0, count),
    count,
    complete: result.complete
  }
}

/** M5g-PLAN.md O3: precomputes each depth's `newline + indent.repeat(depth)`
 * run exactly once, as bytes, and reuses it for every element at that
 * depth — `formatElement`'s hot loop previously allocated a fresh string
 * via `options.indent.repeat(depth + 1)` (a whole new string) plus string
 * concatenation *per child, twice per element* (before and after), ~660k
 * allocations on `cars-10mb.xml`. Cached lazily, indexed by depth, so a
 * document that never nests very deep never builds entries past what it
 * actually used — bounded by nesting depth, which `DEFAULT_MAX_DEPTH`
 * already caps. `indent`/`newline` are always ASCII (app-supplied — see
 * `documentSession.ts`'s `DEFAULT_FORMAT_INDENT`/`DEFAULT_FORMAT_NEWLINE`),
 * so `pushAscii`'s own char-code-per-byte assumption already relied on by
 * every other call site here holds for these too. */
class IndentCache {
  private readonly newline: string
  private readonly indent: string
  private readonly lines: Uint8Array[] = []

  constructor(newline: string, indent: string) {
    this.newline = newline
    this.indent = indent
  }

  bytesFor(depth: number): Uint8Array {
    const cached = this.lines[depth]
    if (cached !== undefined) return cached
    const text = this.newline + this.indent.repeat(depth)
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    this.lines[depth] = bytes
    return bytes
  }
}

/** Advances `cursor` past every recorded entry whose start falls strictly
 * before `end` — used both when a matching element entry is consumed (skip
 * its own descendants, already covered by a verbatim subtree copy) and
 * when no entry matches at all (skip whatever pass 1 recorded inside a
 * verbatim-copied malformed span) — in both cases pass 2 is not going to
 * visit those slots itself, so the cursor must jump over them to stay
 * aligned with pass 2's own position. */
function skipCursorPast(table: FormatInfoTable, cursor: FormatCursor, end: Offset): void {
  while (cursor.pos < table.count && table.starts[cursor.pos]! < end) cursor.pos++
}

/** Captures the exact byte span of exactly one top-level "thing" at
 * `state.pos` (an element's whole subtree, a comment, CDATA, a PI, the
 * DOCTYPE, the XML declaration, a stray end tag, or a bare text run) by
 * running the real tokenizer (`runParser`, above — the same one `parse`
 * and `parseRange` drive) with a silent sink and `stopAtStackLength`
 * pinned to the current depth, exactly `parseRange`'s own resume shape.
 * Used both for genuinely atomic tokens (comments, CDATA, PI, DOCTYPE) and
 * for a mixed/preserve-scoped element, which must come out byte-identical
 * to its input — not reformatted, and not even recursed into, since a
 * nested non-mixed descendant's own whitespace is still part of the mixed
 * ancestor's content. */
function captureVerbatimSpan(state: ParserState): { start: Offset; end: Offset } {
  const start = state.pos
  const stack: Frame[] = [
    { node: -1, nameStart: -1, nameEnd: -1, preserve: true, pendingText: null, hasChildNodes: true }
  ]
  runParser(state, stack, 1)
  return { start, end: state.pos }
}

/** Scans a leaf element's inner content (no structural children — see
 * `FormatInfo.hasStructuralChildren`) to where its end tag starts,
 * stepping *over* any CDATA sections rather than stopping at their own
 * `<` — the only markup a text/CDATA-only body can contain. Never
 * reformats what it finds; text-and-CDATA content is copied verbatim
 * either way, so there is nothing here to decide about whitespace. */
function scanLeafInnerEnd(state: ParserState): Offset {
  for (;;) {
    while (!state.atEnd() && state.peek() !== LT) state.pos++
    if (state.atEnd()) return state.pos
    if (matchesLiteral(state.source, state.pos, CDATA_START)) {
      state.pos += CDATA_START.length
      scanUntilLiteral(state, CDATA_END, 'xml.unterminated-cdata')
      continue
    }
    return state.pos
  }
}

/** One open element on pass 2's own explicit stack (M5h-PLAN.md R18, §2a) —
 * `formatElement`/`emitChild` used to be mutually recursive over user input
 * with no depth bound of their own, overflowing the JS call stack at 5 000
 * levels of nesting (invariant 4's own predicted failure: "deeply nested
 * input is real input and will overflow the stack"). This frame carries
 * exactly the state that used to live in a suspended call frame between
 * "open tag emitted, about to walk children" and "children exhausted, emit
 * the closing indent and end tag" — the two phases `stepChildren` below
 * dispatches between, mirroring `runParser`'s own work-stack shape
 * (`stack.length > state.options.maxDepth`, elsewhere in this file) rather
 * than inventing a new pattern. */
interface ElementFrame {
  /** This element's own nesting depth — `indentCache.bytesFor(depth)` is
   * the *closing* indent, emitted once children are exhausted. */
  readonly depth: number
  /** `indentCache.bytesFor(depth + 1)` — emitted before every child. */
  readonly childIndent: Uint8Array
  /** Did at least one child get written? Decides whether a closing indent
   * is emitted at all (an element with no structural children present at
   * all never reaches this frame — see `stepChildren`'s own dispatch — but
   * one whose children are only ever whitespace between the open tag and
   * the end tag can, and must not get a manufactured closing line). */
  any: boolean
}

/** Consumes exactly the end tag at `state.pos`, if there is one — shared by
 * the leaf-element path and the frame-exit path below. Malformed input (no
 * matching end tag before EOF) is left alone, same as before this rewrite:
 * best effort, never throws. */
function emitEndTag(state: ParserState, out: GrowableBytes): void {
  if (matchesLiteral(state.source, state.pos, END_TAG_START)) {
    const tagStart = state.pos
    state.pos += END_TAG_START.length
    scanName(state)
    skipWhitespace(state)
    if (!state.atEnd() && state.peek() === GT) state.pos++
    out.pushBytes(state.source, tagStart, state.pos)
  }
}

/**
 * Handles exactly one "thing" at `state.pos` in the current context (a
 * top-level item, or a child of whatever `stack`'s own top frame is) —
 * `emitChild`'s old job. An element with structural children **pushes a
 * frame instead of recursing**, the one behavioural change from before this
 * rewrite; every other shape (comment/CDATA/PI/DOCTYPE/a bare text run/a
 * stray end tag, a self-closing element, a mixed-or-preserve-scoped
 * subtree, a leaf element) is still handled completely inline, in one
 * step, exactly as it always was — none of those ever grew the old
 * recursion either, so none of them need the stack now.
 */
function stepOneChild(
  state: ParserState,
  out: GrowableBytes,
  stack: ElementFrame[],
  depth: number,
  table: FormatInfoTable,
  cursor: FormatCursor,
  indentCache: IndentCache
): void {
  const next = state.peek(1)
  if (!(state.peek() === LT && next !== BANG && next !== QMARK && next !== SLASH)) {
    const span = captureVerbatimSpan(state)
    out.pushBytes(state.source, span.start, span.end)
    skipCursorPast(table, cursor, span.end)
    return
  }

  const elementStart = state.pos
  // Entries are consumed in ascending-start order, matching pass 1's own
  // reservation order (`collectFormatInfo`'s doc comment) — a stale entry
  // (start < elementStart) would mean pass 2 skipped something pass 1 saw,
  // which can't happen since both walk the same bytes; the loop is a no-op
  // in the ordinary case and only ever advances past entries already
  // consumed via `skipCursorPast` below.
  while (cursor.pos < table.count && table.starts[cursor.pos]! < elementStart) cursor.pos++
  const hasEntry = cursor.pos < table.count && table.starts[cursor.pos] === elementStart
  // Mixed or preserve-scoped: **subtree-scoped, not element-scoped** — the
  // whole span, open tag through close tag, descendants included, and no
  // recursion into it at all. Getting this element-scoped instead is the
  // easiest way to get this wrong: `<p>Text <b><a>x</a></b> more</p>` has
  // `<p>` mixed but `<b>`/`<a>` not, so an element-scoped skip would freeze
  // `<p>` and then happily descend into `<b>`/`<a>` and reindent them —
  // inserting whitespace into mixed content, exactly the corruption the
  // flag exists to prevent. The recorded `end` (pass 1's own `spanEnd`)
  // lets this jump straight to the end of the subtree via a byte copy,
  // rather than re-tokenizing bytes pass 1 already walked once —
  // `captureVerbatimSpan` stays as the fallback for the one case pass 1
  // has no entry for (a malformed/unrecognized token at this position).
  if (!hasEntry) {
    const span = captureVerbatimSpan(state)
    out.pushBytes(state.source, span.start, span.end)
    skipCursorPast(table, cursor, span.end)
    return
  }
  const slot = cursor.pos
  cursor.pos++
  // Both reads are in-bounds: `hasEntry` just confirmed `slot < table.count`,
  // and `ends`/`flags` are always populated for exactly the same slots
  // `starts` is (`collectFormatInfo` fills all three together, per index).
  const end = table.ends[slot]!
  const entryFlags = table.flags[slot]!
  const isMixed = (entryFlags & FormatFlag.IsMixed) !== 0
  const preserve = (entryFlags & FormatFlag.Preserve) !== 0
  const hasStructuralChildren = (entryFlags & FormatFlag.HasStructuralChildren) !== 0
  if (isMixed || preserve) {
    out.pushBytes(state.source, elementStart, end)
    state.pos = end
    skipCursorPast(table, cursor, end)
    return
  }

  state.pos++ // '<'
  const name = scanName(state)
  out.push(LT)
  out.pushBytes(state.source, name.start, name.end)

  const attrsStart = state.pos
  const dummyFrame: Frame = {
    node: -1,
    nameStart: name.start,
    nameEnd: name.end,
    preserve: false,
    pendingText: null,
    hasChildNodes: false
  }
  scanAttributes(state, dummyFrame)
  out.pushBytes(state.source, attrsStart, state.pos)

  if (state.atEnd()) {
    out.push(GT) // malformed (truncated tag) — best effort, never throws
    return
  }

  if (state.peek() === SLASH) {
    state.pos++
    if (!state.atEnd() && state.peek() === GT) state.pos++
    out.push(SLASH)
    out.push(GT)
    return
  }

  if (state.peek() === GT) state.pos++
  out.push(GT)

  if (hasStructuralChildren) {
    // The fix: push a frame for `stepChildren` to drive instead of looping
    // here and recursing back into `stepOneChild` per child.
    stack.push({ depth, childIndent: indentCache.bytesFor(depth + 1), any: false })
    return
  }

  const innerStart = state.pos
  const innerEnd = scanLeafInnerEnd(state)
  out.pushBytes(state.source, innerStart, innerEnd)
  emitEndTag(state, out)
}

/**
 * Drives `stack`'s own top frame by exactly one step: either emits one more
 * child (indented, via `stepOneChild`, which may itself push a *deeper*
 * frame) or — once whitespace-skipping finds the end tag or EOF — emits the
 * closing indent (if any child was written) and the end tag, then pops.
 * The whole of `format()`'s pass 2 is this function called in a loop until
 * `stack` is empty, the same top-level shape `runParser` uses for pass 1's
 * own tree-building walk.
 */
function stepChildren(
  state: ParserState,
  out: GrowableBytes,
  stack: ElementFrame[],
  table: FormatInfoTable,
  cursor: FormatCursor,
  indentCache: IndentCache
): void {
  const frame = stack[stack.length - 1]!
  skipWhitespace(state)
  if (state.atEnd() || matchesLiteral(state.source, state.pos, END_TAG_START)) {
    if (frame.any) {
      const closeIndent = indentCache.bytesFor(frame.depth)
      out.pushBytes(closeIndent, 0, closeIndent.length)
    }
    emitEndTag(state, out)
    stack.pop()
    return
  }
  frame.any = true
  out.pushBytes(frame.childIndent, 0, frame.childIndent.length)
  stepOneChild(state, out, stack, frame.depth + 1, table, cursor, indentCache)
}

/**
 * Conservative pretty-printer (§5.7). **Minify is not wired here** — unlike
 * JSON's `format`, XML's own minify path stays out of scope for R11 (the
 * plan's own §5: "Minify is the same category but stays palette-only,"
 * unbuilt until that command exists); `options.indent === ''` is not
 * special-cased.
 *
 * **Encoding**: never decodes text (every byte range is copied verbatim —
 * invariant 7), but *inserting* new whitespace bytes (indentation,
 * newlines) is only safe for an ASCII-compatible single-byte-per-codepoint
 * encoding. Resolved the same way the document's own encoding was resolved
 * on open — BOM first, then the prolog's declared `encoding=`, then UTF-8
 * — and refused outright (thrown, caught by `documentSession.ts`'s
 * `applyTransform` and surfaced as `pendingParseError`) rather than
 * silently corrupting a UTF-16 document with single-byte ASCII spaces.
 * `documentEdits.ts`'s `encodeForRoundTrip` draws the same UTF-8/UTF-16
 * line for editing; Format draws it narrower still (UTF-8 only) because,
 * unlike editing, nothing here needs to support UTF-16 today — Format is
 * gated on `!isReadOnly`, and every UTF-16 document already opens
 * read-only, so this refusal is currently unreachable from the UI and
 * exists for `format()` as a directly-callable function.
 */
function format(source: Uint8Array, options: FormatOptions): Uint8Array {
  const bomLength = bomLengthAt(source)
  const head = source.subarray(0, Math.min(source.length, 1024))
  const declared = detectEncoding(head)
  const resolved = resolveDeclaredEncoding(head, declared)
  if (resolved.toLowerCase() !== 'utf-8') {
    throw new Error(
      `XML formatting refused: ${resolved} has no safe encoder for inserted whitespace (only UTF-8 is supported).`
    )
  }

  // M5h-PLAN.md R18, §2b: the same limit the real parse enforces, not the
  // old `100_000` (ten times `DEFAULT_MAX_DEPTH`) — pass 1 has no reason to
  // accept nesting the document's own parse would already reject, and
  // §2c's degrade-instead-of-throwing check below only works if pass 1's
  // own `complete` reflects the real limit. `format()` receives bytes and
  // `FormatOptions`, not the `ParseOptions` this document was actually
  // opened with, so this is `DEFAULT_MAX_DEPTH` specifically, not "whatever
  // limit the caller used" — `core/types.ts`'s contract has no room to pass
  // that through, and widening it is out of scope here (§2b's own note).
  const noop: ParseOptions = { maxDepth: DEFAULT_MAX_DEPTH, encoding: 'utf-8' }
  const table = collectFormatInfo(source, noop)

  // §2c: a document past the depth limit only ever gets a bounded, partial
  // tree from the real parse (invariant 5) — pass 2 cannot safely re-render
  // from a `FormatInfoTable` that stops mid-document, and formatting is
  // optional where the document itself is not. Returning the input
  // unchanged here is indistinguishable from a no-op `format()` call to
  // everything downstream (M5g-PLAN.md O1 already handles that end to end,
  // worker through renderer), so there is nothing further to special-case.
  if (!table.complete) return source

  const cursor: FormatCursor = { pos: 0 }
  const indentCache = new IndentCache(options.newline, options.indent)

  const state = new ParserState(source, silentSink, noop, bomLength)
  const out = new GrowableBytes(Math.max(1024, source.length))
  out.pushBytes(source, 0, bomLength)

  // §2a: one explicit stack, driven to completion, replacing the old
  // `emitChild`/`formatElement` mutual recursion — see `ElementFrame`'s own
  // doc comment.
  const stack: ElementFrame[] = []
  let wroteAny = false
  for (;;) {
    if (stack.length > 0) {
      stepChildren(state, out, stack, table, cursor, indentCache)
      continue
    }
    skipWhitespace(state)
    if (state.atEnd()) break
    if (wroteAny) out.pushAscii(options.newline)
    wroteAny = true
    stepOneChild(state, out, stack, 0, table, cursor, indentCache)
  }
  if (wroteAny) out.pushAscii(options.newline)
  return out.toArray()
}

export const xmlFormatModule: FormatModule = {
  capabilities: xmlCapabilities,
  detect,
  detectEncoding,
  parse,
  parseRange,
  resumeContextFor,
  format
}
