/**
 * The Klados path parser (M4-PLAN.md G7, CONCEPT.md §6.3): the grammar,
 * and nothing beyond it —
 *
 * ```
 * cars/car               children by name
 * cars//price            any descendant
 * car[@id="c-001"]       attribute value, string
 * car[price>100]         child element's value, numeric
 * car[3]                 positional
 * *                      any name
 * ```
 *
 * Produces a small step list — `{ axis, nameId, predicate }` per step — not
 * an AST of objects per node (§6.6's integer-compare argument, applied one
 * level up from node data to query data). Names resolve to `nameId` at
 * parse time, through the document's own `Interner.lookup` (read-only — a
 * name that doesn't exist in the document must never be interned just
 * because a query mentioned it): a step whose name isn't in the document
 * carries `nameId: null` and is answerable as empty without the evaluator
 * (G8) touching the store at all.
 *
 * Malformed queries produce a `PathDiagnostic` with an offset into the
 * query string, never a throw — invariant 5's discipline, for the same
 * reason: the user is mid-typing.
 *
 * No recursion, via an explicit stack: the step list itself is flat (each
 * step has at most one bracketed predicate), but a predicate's own body is
 * a small boolean expression — comparisons and existence tests combined
 * with `and`/`or`/`not` and parentheses (R138) — which does nest. That
 * nesting is nonetheless handled with a straightforward left-to-right scan
 * over an explicit operand/operator stack (precedence climbing), not
 * recursive descent, so there is still no call-stack risk to guard against
 * the way a document parser's invariant 4 does. A depth cap
 * (`MAX_PREDICATE_DEPTH`) bounds a pathological paste with a diagnostic
 * rather than unbounded heap growth.
 */

import { xpathNumberFromText } from './xpathNumber'

export type Axis = 'child' | 'descendant'

/** The six XPath 1.0 relational/equality operators, and only those — R129
 * §5. No `and`/`or`, no functions (§11, deliberately). */
export type ComparisonOperator = '=' | '!=' | '<' | '<=' | '>' | '>='

/** Which side of the candidate the subject is read from: a child element's
 * value (`price`) or an attribute's value (`@id`). */
export type SubjectAxis = 'child' | 'attribute'

export interface PositionalPredicate {
  /** `car[3]` — 1-based position among same-step matches at that level.
   * §6.6: "a positional predicate groups by parent." Only valid as the
   * *entire* predicate body — R138 §5 rejects it as an operand inside a
   * boolean expression (`[3 and @id]`), since XPath's `boolean(3)` would
   * silently discard the positional meaning. */
  readonly kind: 'positional'
  readonly index: number
}

export interface ComparisonPredicate {
  /**
   * `car[price>100]`, `car[@year<2000]`, `car[@id="c-001"]` — R129 §5.
   * The last of those is what the `facet` kind used to be; it is folded
   * in here as the `op: '='`, `subjectAxis: 'attribute'`, string-literal
   * case rather than kept beside it, which is what makes R131 a retrofit
   * of one code path instead of a second implementation.
   */
  readonly kind: 'comparison'
  readonly subjectAxis: SubjectAxis
  /** As typed — kept for diagnostics and round-tripping only; nothing on
   * the evaluation path reads it. */
  readonly subjectName: string
  /** Resolved through the document's own interner at parse time, the
   * same read-only `NameResolver` a step's name goes through. `null`
   * when the document has no such element or attribute name, which
   * makes every operator false without touching the store (§5's
   * missing-subject rule). */
  readonly subjectNameId: number | null
  readonly op: ComparisonOperator
  /**
   * The literal's **syntactic form**, decided here and never re-derived
   * at evaluation time — §3: `=`/`!=` compare as strings when the
   * literal was quoted and as numbers when it was written bare. The
   * relational operators ignore this and always compare numerically.
   */
  readonly literalKind: 'string' | 'number'
  /** The literal's text, with the quotes stripped. Encoded to the
   * document's own bytes once per query at evaluation time — not here:
   * `parsePath` has no encoding and should not grow one (§5). */
  readonly literalText: string
  /** `literalText` through XPath's own `number()` — exact for a number
   * literal, and `NaN` for a string literal that isn't a number, which
   * is precisely what makes `price>"abc"` false. */
  readonly literalNumber: number
}

export interface ExistencePredicate {
  /**
   * `car[@id]`, `car[price]`, `car[@*]`, `car[*]` (R132) — true when the
   * subject *exists at all*, independent of its value: `[price]` is true
   * for `<price></price>` and for `<price><a/></price>`, and `[@id]` is
   * true for `id=""`. This is why it cannot reuse the comparison
   * candidate loops as-is (`R132-existence-predicates.md` §2) — those
   * stop at "no value" and treat that as false, which is correct for a
   * comparison and wrong here; existence stops at the *name* match.
   */
  readonly kind: 'existence'
  readonly subjectAxis: SubjectAxis
  readonly subjectName: string
  /** `null` when the document has no such name — every operator is then
   * false (R129 §5's rule), unless `isWildcard`. Meaningless when
   * `isWildcard` is `true` (no single name to resolve). */
  readonly subjectNameId: number | null
  /** `car[@*]` / `car[*]` — at least one attribute / child element, of any
   * name. Comes along for free because `isWildcard` is already a concept
   * on `PathStep` (R132 §2). */
  readonly isWildcard: boolean
}

export interface NotPredicate {
  /** `not(...)` — R138 §6. A unary operator in the expression grammar,
   * not R133's special form: composes with parentheses for free and has
   * no depth limit of its own beyond the expression parser's general
   * `MAX_PREDICATE_DEPTH`. */
  readonly kind: 'not'
  readonly operand: BooleanPredicate
}

export interface AndPredicate {
  readonly kind: 'and'
  readonly left: BooleanPredicate
  readonly right: BooleanPredicate
}

export interface OrPredicate {
  readonly kind: 'or'
  readonly left: BooleanPredicate
  readonly right: BooleanPredicate
}

/** Everything a predicate body can be *except* a bare positional index —
 * the operand/operator vocabulary the R138 expression parser builds from.
 * Named separately from `PathPredicate` because `not`/`and`/`or` combine
 * these and only these (a positional cannot be an operand — R138 §5). */
export type BooleanPredicate =
  ComparisonPredicate | ExistencePredicate | NotPredicate | AndPredicate | OrPredicate

export type PathPredicate = PositionalPredicate | BooleanPredicate

export interface PathStep {
  readonly axis: Axis
  /** `true` for `*` — matches every name, `nameId` is meaningless then. */
  readonly isWildcard: boolean
  /** `null` when the name doesn't exist in the document's interner at
   * parse time — the query is answerable as empty, per this module's own
   * top comment. Always `null` when `isWildcard` is `true`. */
  readonly nameId: number | null
  readonly predicate: PathPredicate | null
}

export interface ParsedPath {
  readonly steps: readonly PathStep[]
}

export interface PathDiagnostic {
  readonly offset: number
  readonly message: string
}

export type PathParseResult =
  | { readonly ok: true; readonly path: ParsedPath }
  | { readonly ok: false; readonly diagnostic: PathDiagnostic }

/** Resolves a step's name to an existing `nameId`, `null` if the document
 * has no node/attribute interned under that exact text, or
 * `'unrepresentable'` (R53, `R53-interner-encoding.md`) if the name
 * contains a character the document's own encoding cannot represent at
 * all — a real, distinct answer from "absent," surfaced as a diagnostic
 * rather than folded into an empty result. `Interner.lookup`, read-only,
 * is the production implementation; tests can inject a plain `Map`-backed
 * stand-in (which never needs to produce `'unrepresentable'`). */
export type NameResolver = (name: string) => number | null | 'unrepresentable'

const NAME_CHAR = /[A-Za-z0-9_.:-]/

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && (NAME_CHAR.test(ch) || ch === '*')
}

class Cursor {
  pos = 0
  constructor(readonly source: string) {}

  peek(): string | undefined {
    return this.source[this.pos]
  }

  peekAt(offset: number): string | undefined {
    return this.source[this.pos + offset]
  }

  eof(): boolean {
    return this.pos >= this.source.length
  }
}

function fail(offset: number, message: string): PathParseResult {
  return { ok: false, diagnostic: { offset, message } }
}

/** Consumes `//` or `/` at the cursor, returning the axis it implies —
 * `null` (with the cursor untouched) when neither is present, which is
 * only valid at the very start of the query (the implicit first step).
 *
 * R73 (`R72-path-query.md` §3): a single `/` at position 0 means
 * **descendant**, not child. The palette's own mode-prefix strip
 * (`parsePaletteInput`) consumes exactly one leading `/` before this
 * module ever sees the query, so `//name` typed in the palette arrives
 * here as `/name` — this is the only way a lone leading `/` can occur at
 * all (`/garage/...` typed arrives as `garage/...`, no leading `/`
 * remaining), which is what makes repurposing it safe rather than
 * ambiguous: nothing valid today relies on a leading `/` meaning
 * "child of root" in a query this parser actually receives. Everywhere
 * else — mid-query, `/step` after a preceding name — a single `/` still
 * means child, unaffected. */
function consumeSeparator(cursor: Cursor): Axis | null {
  const atStart = cursor.pos === 0
  if (cursor.peek() === '/' && cursor.peekAt(1) === '/') {
    cursor.pos += 2
    return 'descendant'
  }
  if (cursor.peek() === '/') {
    cursor.pos += 1
    return atStart ? 'descendant' : 'child'
  }
  return null
}

function consumeName(cursor: Cursor): { name: string; isWildcard: boolean } | null {
  if (cursor.peek() === '*') {
    cursor.pos += 1
    return { name: '*', isWildcard: true }
  }
  const start = cursor.pos
  while (!cursor.eof() && NAME_CHAR.test(cursor.peek()!)) cursor.pos += 1
  if (cursor.pos === start) return null
  return { name: cursor.source.slice(start, cursor.pos), isWildcard: false }
}

/** The quoted-string grammar `[@id="c-001"]` needs — single or double
 * quotes, no escape sequences (a query string is a short, hand-typed
 * literal; nothing here needs to round-trip arbitrary attribute values
 * containing a quote character, and §6.3 names none). */
function consumeQuotedString(cursor: Cursor): string | null {
  const quote = cursor.peek()
  if (quote !== '"' && quote !== "'") return null
  cursor.pos += 1
  const start = cursor.pos
  while (!cursor.eof() && cursor.peek() !== quote) cursor.pos += 1
  if (cursor.eof()) return null // unterminated
  const value = cursor.source.slice(start, cursor.pos)
  cursor.pos += 1 // closing quote
  return value
}

function skipSpaces(cursor: Cursor): void {
  while (cursor.peek() === ' ' || cursor.peek() === '\t') cursor.pos += 1
}

/** The operator token, longest match first so `>=` is never read as `>`
 * followed by a literal starting `=`. `==` is deliberately *not* accepted:
 * XPath's equality operator is a single `=`, and taking `==` as a synonym
 * would be a dialect of one. It fails below, at the literal. */
function consumeOperator(cursor: Cursor): ComparisonOperator | null {
  // Each branch returns the *literal*, never the scanned substring: a
  // string built by concatenation is not internalized, so `predicate.op
  // === '>='` at evaluation time would be a character-by-character
  // comparison instead of a pointer one.
  const two = (cursor.peek() ?? '') + (cursor.peekAt(1) ?? '')
  if (two === '!=') {
    cursor.pos += 2
    return '!='
  }
  if (two === '>=') {
    cursor.pos += 2
    return '>='
  }
  if (two === '<=') {
    cursor.pos += 2
    return '<='
  }
  const one = cursor.peek()
  if (one === '=') {
    cursor.pos += 1
    return '='
  }
  if (one === '>') {
    cursor.pos += 1
    return '>'
  }
  if (one === '<') {
    cursor.pos += 1
    return '<'
  }
  return null
}

/**
 * XPath 1.0's `Number` token — `-? digits ('.' digits?)? | -? '.' digits`,
 * and nothing more. `1e3` is *not* a number here (§4's documented gap), so
 * it is rejected at parse time with an offset rather than silently becoming
 * a query that matches nothing.
 */
function consumeNumberLiteral(cursor: Cursor): string | null {
  const start = cursor.pos
  if (cursor.peek() === '-') cursor.pos += 1
  let sawDigit = false
  while (cursor.peek() !== undefined && cursor.peek()! >= '0' && cursor.peek()! <= '9') {
    cursor.pos += 1
    sawDigit = true
  }
  if (cursor.peek() === '.') {
    cursor.pos += 1
    while (cursor.peek() !== undefined && cursor.peek()! >= '0' && cursor.peek()! <= '9') {
      cursor.pos += 1
      sawDigit = true
    }
  }
  if (!sawDigit) {
    cursor.pos = start
    return null
  }
  return cursor.source.slice(start, cursor.pos)
}

/** Depth of nested parentheses / `not(` a single predicate body may carry —
 * R138 §4: parentheses are handled with an explicit stack rather than
 * recursion, but a *pathological* paste (`[((((…))))]`) still needs a
 * bound, as a diagnostic rather than unbounded heap growth. Arbitrary but
 * generous for anything a person would type or a real query generator
 * would produce. */
const MAX_PREDICATE_DEPTH = 64

/**
 * Consumes `word` (`not`, `and`, `or`) at the cursor if it is there as a
 * whole token — not a prefix of a longer name (`andy` must not match
 * `and`) — leaving the cursor untouched and returning `false` otherwise.
 * This, plus the operand/operator alternation `parseBooleanExpr` drives, is
 * the entire implementation of R138 §2's XPath rule: a name reads as an
 * operator only in *operator position* (i.e. this function is only ever
 * called there), never in operand position — `[and]` never reaches this
 * function at all, because operand parsing goes straight to `parseOperand`.
 */
function matchesWord(cursor: Cursor, word: string): boolean {
  const start = cursor.pos
  for (let i = 0; i < word.length; i++) {
    if (cursor.source[start + i] !== word[i]) return false
  }
  const after = cursor.source[start + word.length]
  if (after !== undefined && NAME_CHAR.test(after)) return false
  cursor.pos = start + word.length
  return true
}

/**
 * One operand of a boolean expression: a comparison (`price>100`) or,
 * absent a comparison operator, an existence test (`price`, `@id`, `@*`,
 * `*` — R132). `contentStart` lets diagnostics index the original query,
 * same convention as the caller.
 *
 * A bare digit run reaching here (`[3 and @id]`) is **not** read as a name
 * — it is rejected with a diagnostic (R138 §5): XPath's `boolean(3)` would
 * silently discard the positional meaning, which is exactly the kind of
 * wrong-but-quiet result this module's own top comment says predicates
 * must never produce. `[3]` alone never reaches this function — the whole-
 * content positional check in `parsePredicateBody` intercepts it first.
 */
function parseOperand(
  cursor: Cursor,
  contentStart: number,
  resolveName: NameResolver
): { ok: true; predicate: BooleanPredicate } | { ok: false; diagnostic: PathDiagnostic } {
  const at = (pos: number): number => contentStart + pos

  skipSpaces(cursor)
  let subjectAxis: SubjectAxis = 'child'
  if (cursor.peek() === '@') {
    subjectAxis = 'attribute'
    cursor.pos += 1
  }

  let isWildcard = false
  let subjectName: string
  const nameStart = cursor.pos
  if (cursor.peek() === '*') {
    isWildcard = true
    cursor.pos += 1
    subjectName = '*'
  } else {
    while (!cursor.eof() && NAME_CHAR.test(cursor.peek()!)) cursor.pos += 1
    if (cursor.pos === nameStart) {
      return {
        ok: false,
        diagnostic: {
          offset: at(cursor.pos),
          message:
            subjectAxis === 'attribute'
              ? "expected an attribute name after '@'"
              : "expected a name, '*', 'not(', or '('"
        }
      }
    }
    subjectName = cursor.source.slice(nameStart, cursor.pos)
  }

  if (!isWildcard && /^[0-9]+$/.test(subjectName)) {
    return {
      ok: false,
      diagnostic: {
        offset: at(nameStart),
        message: 'a positional predicate cannot appear inside a boolean expression'
      }
    }
  }

  skipSpaces(cursor)
  const op = isWildcard ? null : consumeOperator(cursor)

  // The subject's name goes through the same read-only resolver a step's
  // own name does — including its 'unrepresentable' answer (R53), which is
  // a diagnostic rather than a silently-empty query. Skipped for a wildcard
  // subject, which has no single name to resolve.
  const resolved = isWildcard ? null : resolveName(subjectName)
  if (resolved === 'unrepresentable') {
    return {
      ok: false,
      diagnostic: {
        offset: at(nameStart),
        message: `'${subjectName}' cannot be represented in this document's encoding`
      }
    }
  }

  if (op === null) {
    // No comparison operator follows — R132: existence, not a value test.
    return {
      ok: true,
      predicate: {
        kind: 'existence',
        subjectAxis,
        subjectName,
        subjectNameId: resolved,
        isWildcard
      }
    }
  }

  skipSpaces(cursor)
  const literalStart = cursor.pos
  let literalKind: 'string' | 'number'
  let literalText: string
  const quoted = consumeQuotedString(cursor)
  if (quoted !== null) {
    literalKind = 'string'
    literalText = quoted
  } else {
    const number = consumeNumberLiteral(cursor)
    if (number === null) {
      return {
        ok: false,
        diagnostic: {
          offset: at(literalStart),
          message: `expected a quoted string or a number after '${op}'`
        }
      }
    }
    literalKind = 'number'
    literalText = number
  }

  return {
    ok: true,
    predicate: {
      kind: 'comparison',
      subjectAxis,
      subjectName,
      subjectNameId: resolved,
      op,
      literalKind,
      literalText,
      literalNumber: xpathNumberFromText(literalText)
    }
  }
}

type BinaryOp = 'and' | 'or'

/** `or` binds looser than `and` (XPath 1.0, R138 §1) — both left-
 * associative, so precedence climbing pops the operator stack while its
 * top has precedence `>=` the incoming operator. */
function precedenceOf(op: BinaryOp): number {
  return op === 'and' ? 2 : 1
}

/**
 * The predicate body's expression grammar — comparisons and existence
 * tests (R129/R132) combined with `not`/`and`/`or` and parentheses
 * (R138) — parsed with an explicit operand stack and operator stack
 * (precedence climbing) rather than recursive descent, per this module's
 * own no-recursion claim (top comment). `not(` pushes a parenthesis frame
 * tagged `negate: true`; closing it wraps whatever operand the
 * parenthesized expression produced in a `not` node, so `not` needs no
 * special-casing beyond that one tag.
 */
function parseBooleanExpr(
  cursor: Cursor,
  contentStart: number,
  resolveName: NameResolver
): { ok: true; predicate: BooleanPredicate } | { ok: false; diagnostic: PathDiagnostic } {
  const at = (pos: number): number => contentStart + pos
  const parens: { negate: boolean; offset: number }[] = []
  const operators: BinaryOp[] = []
  const operands: BooleanPredicate[] = []
  let depth = 0
  let expectOperand = true

  function applyTopOperator(): PathDiagnostic | null {
    const op = operators.pop()!
    const right = operands.pop()
    const left = operands.pop()
    if (left === undefined || right === undefined) {
      return { offset: at(cursor.pos), message: `expected an operand for '${op}'` }
    }
    operands.push({ kind: op, left, right })
    return null
  }

  for (;;) {
    skipSpaces(cursor)

    if (expectOperand) {
      if (cursor.eof()) {
        return { ok: false, diagnostic: { offset: at(cursor.pos), message: 'expected an operand' } }
      }

      if (cursor.peek() === '(') {
        cursor.pos += 1
        depth += 1
        if (depth > MAX_PREDICATE_DEPTH) {
          return {
            ok: false,
            diagnostic: { offset: at(cursor.pos), message: 'predicate nesting is too deep' }
          }
        }
        parens.push({ negate: false, offset: at(cursor.pos - 1) })
        continue
      }

      const beforeNot = cursor.pos
      if (matchesWord(cursor, 'not')) {
        skipSpaces(cursor)
        if (cursor.peek() === '(') {
          cursor.pos += 1
          depth += 1
          if (depth > MAX_PREDICATE_DEPTH) {
            return {
              ok: false,
              diagnostic: { offset: at(cursor.pos), message: 'predicate nesting is too deep' }
            }
          }
          // Points at the '(' itself, same convention as the plain-paren
          // case just above — not at "not", so an unterminated
          // `not(...)` reports the same way an unterminated `(...)` does.
          parens.push({ negate: true, offset: at(cursor.pos - 1) })
          continue
        }
        // Not followed by '(' — R138 §6: `not` with no call is the *name*
        // `not` (MathML has `<not/>`), so rewind and let `parseOperand`
        // read it as an ordinary subject.
        cursor.pos = beforeNot
      }

      const operand = parseOperand(cursor, contentStart, resolveName)
      if (!operand.ok) return operand
      operands.push(operand.predicate)
      expectOperand = false
      continue
    }

    // Operator position: ')', 'and'/'or', or the end of the predicate body.
    if (cursor.eof()) break

    if (cursor.peek() === ')') {
      const closeOffset = cursor.pos
      cursor.pos += 1
      while (operators.length > 0) {
        const err = applyTopOperator()
        if (err !== null) return { ok: false, diagnostic: err }
      }
      const frame = parens.pop()
      if (frame === undefined) {
        return { ok: false, diagnostic: { offset: closeOffset, message: "unmatched ')'" } }
      }
      depth -= 1
      if (frame.negate) {
        const operand = operands.pop()
        if (operand === undefined) {
          return {
            ok: false,
            diagnostic: { offset: closeOffset, message: "expected an operand inside 'not(...)'" }
          }
        }
        operands.push({ kind: 'not', operand })
      }
      continue // (...) is now a complete operand — stay in operator position
    }

    const beforeOp = cursor.pos
    let binaryOp: BinaryOp | null = null
    if (matchesWord(cursor, 'and')) binaryOp = 'and'
    else if (matchesWord(cursor, 'or')) binaryOp = 'or'

    if (binaryOp === null) {
      cursor.pos = beforeOp
      return {
        ok: false,
        diagnostic: { offset: at(cursor.pos), message: 'unexpected text after the predicate value' }
      }
    }

    while (
      operators.length > 0 &&
      precedenceOf(operators[operators.length - 1]!) >= precedenceOf(binaryOp)
    ) {
      const err = applyTopOperator()
      if (err !== null) return { ok: false, diagnostic: err }
    }
    operators.push(binaryOp)
    expectOperand = true
  }

  if (expectOperand) {
    return { ok: false, diagnostic: { offset: at(cursor.pos), message: 'expected an operand' } }
  }
  while (operators.length > 0) {
    const err = applyTopOperator()
    if (err !== null) return { ok: false, diagnostic: err }
  }
  if (parens.length > 0) {
    const frame = parens[parens.length - 1]!
    return { ok: false, diagnostic: { offset: frame.offset, message: "unterminated '('" } }
  }
  const result = operands.pop()
  if (result === undefined || operands.length > 0) {
    return { ok: false, diagnostic: { offset: at(0), message: 'malformed predicate expression' } }
  }
  return { ok: true, predicate: result }
}

/**
 * Parses the bracketed content of `[...]`, the cursor already past the
 * opening `[`. `contentStart` is its offset, for diagnostics that need to
 * point at the predicate itself rather than the step's name. `content` is
 * passed untrimmed so every reported offset indexes the original query.
 *
 * A whole-content bare digit run is a positional predicate (`car[3]`),
 * checked first and separately from `parseBooleanExpr` — a positional is
 * never an *operand*, only ever the entire predicate body (R138 §5).
 * Everything else goes through the expression grammar, which resolves to
 * exactly one `BooleanPredicate` by construction (`parseBooleanExpr`'s own
 * end-of-content and unmatched-paren checks leave nothing further to
 * validate here).
 */
function parsePredicateBody(
  content: string,
  contentStart: number,
  resolveName: NameResolver
): { ok: true; predicate: PathPredicate } | { ok: false; diagnostic: PathDiagnostic } {
  const trimmed = content.trim()

  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10)
    if (index < 1) {
      return {
        ok: false,
        diagnostic: { offset: contentStart, message: 'a positional predicate is 1-based' }
      }
    }
    return { ok: true, predicate: { kind: 'positional', index } }
  }

  return parseBooleanExpr(new Cursor(content), contentStart, resolveName)
}

function consumePredicate(
  cursor: Cursor,
  resolveName: NameResolver
): { ok: true; predicate: PathPredicate | null } | { ok: false; diagnostic: PathDiagnostic } {
  if (cursor.peek() !== '[') return { ok: true, predicate: null }
  const bracketOffset = cursor.pos
  cursor.pos += 1
  const start = cursor.pos
  while (!cursor.eof() && cursor.peek() !== ']') cursor.pos += 1
  if (cursor.eof()) {
    return { ok: false, diagnostic: { offset: bracketOffset, message: "unterminated '['" } }
  }
  const content = cursor.source.slice(start, cursor.pos)
  cursor.pos += 1 // closing ']'

  const result = parsePredicateBody(content, start, resolveName)
  if (!result.ok) return result
  return { ok: true, predicate: result.predicate }
}

export function parsePath(query: string, resolveName: NameResolver): PathParseResult {
  if (query.trim().length === 0) {
    return fail(0, 'a query cannot be empty')
  }

  const cursor = new Cursor(query)
  const steps: PathStep[] = []
  let first = true

  while (!cursor.eof()) {
    const separatorStart = cursor.pos
    const axis = consumeSeparator(cursor)
    if (axis === null) {
      if (!first) {
        return fail(separatorStart, "expected '/' or '//' between steps")
      }
    }

    if (!isNameStart(cursor.peek())) {
      return fail(cursor.pos, "expected a name or '*'")
    }
    const nameStart = cursor.pos // just past the separator, if any
    const nameResult = consumeName(cursor)
    if (nameResult === null) {
      return fail(cursor.pos, "expected a name or '*'")
    }

    let nameId: number | null = null
    if (!nameResult.isWildcard) {
      const resolved = resolveName(nameResult.name)
      if (resolved === 'unrepresentable') {
        return fail(
          nameStart,
          `'${nameResult.name}' cannot be represented in this document's encoding`
        )
      }
      nameId = resolved
    }

    const predicateResult = consumePredicate(cursor, resolveName)
    if (!predicateResult.ok) {
      return { ok: false, diagnostic: predicateResult.diagnostic }
    }

    steps.push({
      axis: axis ?? 'child',
      isWildcard: nameResult.isWildcard,
      nameId,
      predicate: predicateResult.predicate
    })
    first = false
  }

  return { ok: true, path: { steps } }
}
