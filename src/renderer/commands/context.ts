/**
 * Context keys (CONCEPT.md §7): a small reactive key/value store that
 * `when` clauses evaluate against — what lets the same command mean
 * different things in the Tree, Detail and Raw views without conditional
 * logic scattered through the UI. Deliberately no `isLargeFile` key
 * (D-031 removed the size-tiered Raw View that key would have gated).
 *
 * `isReadOnly` defaults `true` (nothing to edit with no document open) and
 * is set from the opened file's actual write permission by D6's document
 * session — but no editing command exists to gate on it yet (§12 puts
 * editing at M3), so until then it's state with no observable effect,
 * kept accurate now rather than retrofitted later.
 */

export type Focus = 'tree' | 'detail' | 'raw'

export interface ContextKeys {
  readonly focus: Focus | null
  /** A format capability id (e.g. `'xml'`, `'json'`). Named in CONCEPT.md
   * §7 as a context key in its own right; still subject to hard rule 5 —
   * no command's `when` in this milestone branches on it, and a real need
   * to is a "stop and report" signal, not a reason to reach for it. */
  readonly format: string | null
  /** A node kind's friendly name (`'Element'`, `'Object'`, …), not the raw
   * `NodeKind` enum ordinal — `when` clauses are hand-authored strings and
   * shouldn't have to know the core enum's numbering. */
  readonly nodeKind: string | null
  readonly hasSelection: boolean
  readonly hasDiagnostics: boolean
  readonly isReadOnly: boolean
  readonly isWrapped: boolean
  /** D14's back/forward history — gates the two commands so they're
   * disabled (and absent from a keybinding's effect, per `canFire`) rather
   * than a no-op with no visible reason. */
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** M3-PLAN.md F6's undo stack — same "gate the command, don't leave it a
   * silent no-op" reasoning as `canGoBack`/`canGoForward`. Set by
   * `documentSession.ts`, consumed by F9's palette commands once they
   * exist. */
  readonly canUndo: boolean
  readonly canRedo: boolean
  /** M3-PLAN.md F7's dirty indicator. `false` outside a document being open
   * at all — no document, nothing unsaved. */
  readonly isDirty: boolean
  /** M3-PLAN.md F8's external-change banner — mirrors
   * `OpenDocument.externalChangeDetected`. */
  readonly hasExternalChange: boolean
  /** M5-PLAN.md H7 — mirrors the open document's format's own
   * `capabilities.canFormat` (invariant 8: gated on the capability, never
   * on `format` itself). Drives the Format/Minify palette commands. */
  readonly canFormat: boolean
  /** R21-notifications.md §3g — mirrors `OpenDocument.pendingTransform !==
   * null`. Gates `confirmTransformAnyway`/`cancelTransform`, the two
   * commands the pending-transform choice notification's actions resolve
   * to; both are meaningless with nothing pending. */
  readonly hasPendingTransform: boolean
  /** R26 (`R24-tabs.md` §4) — mirrors `session/tabs.ts`'s
   * `getPendingCloseTabId() === getActiveTabId()`: a close was requested for
   * the *active* tab while it had unsaved changes, and the Save/Discard/
   * Cancel choice notification it derives is still outstanding. Gates the
   * three commands that resolve it, the same "meaningless with nothing
   * pending" reasoning `hasPendingTransform` already uses. */
  readonly hasPendingCloseTab: boolean
  /** R26 §4 — `hasPendingCloseTab` *and* the close is part of a consolidated
   * quit flow (`session/tabs.ts`'s `isQuitInProgress()`), not a one-off ad
   * hoc close. Gates "Discard All" / "Cancel Quit", which only make sense
   * mid-flow — a plain single-tab close has nothing to discard "all" of. */
  readonly hasPendingQuit: boolean
  /** R95 (`R95-recent-files.md` §2) — mirrors `recentFiles.ts`'s own list
   * being non-empty. Gates `klados.document.clearRecentFiles`, hidden
   * rather than disabled when there's nothing to clear — the same
   * reasoning `canUndo`/`canRedo` already use. */
  readonly hasRecentFiles: boolean
}

const DEFAULT_CONTEXT: ContextKeys = {
  focus: null,
  format: null,
  nodeKind: null,
  hasSelection: false,
  hasDiagnostics: false,
  isReadOnly: true,
  isWrapped: false,
  canGoBack: false,
  canGoForward: false,
  canUndo: false,
  canRedo: false,
  isDirty: false,
  hasExternalChange: false,
  canFormat: false,
  hasPendingTransform: false,
  hasPendingCloseTab: false,
  hasPendingQuit: false,
  hasRecentFiles: false
}

type Listener = () => void

// A single mutable object, not replaced on every change — `useSyncExternalStore`
// needs `getContext()` to return a referentially stable snapshot when nothing
// changed, and copying on every read would defeat that (theme.ts's `apply`
// pattern, same reasoning).
const state: { current: ContextKeys } = { current: DEFAULT_CONTEXT }
const listeners = new Set<Listener>()

export function getContext(): ContextKeys {
  return state.current
}

export function setContext<K extends keyof ContextKeys>(key: K, value: ContextKeys[K]): void {
  if (state.current[key] === value) return
  state.current = { ...state.current, [key]: value }
  for (const listener of listeners) listener()
}

export function subscribeContext(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: restores the default context between test cases. */
export function resetContextForTests(): void {
  state.current = DEFAULT_CONTEXT
}

// ---------------------------------------------------------------------------
// Context expressions — `==`, `!=`, `&&`, `||`, `!`, bare truthiness, and
// parenthesised grouping. Precedence, loosest to tightest:
//   ||  <  &&  <  !  <  ==/!=  <  identifier / ( expr )
// e.g. `!a && b` is `(!a) && b`; `a && b || c` is `(a && b) || c`.

export type ContextExpression = string

type Token =
  | { readonly type: 'ident'; readonly value: string }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'op'; readonly value: '==' | '!=' | '&&' | '||' | '!' | '(' | ')' }

const IDENT_CHAR = /[A-Za-z0-9_.]/

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }
    if (ch === '!') {
      if (expr[i + 1] === '=') {
        tokens.push({ type: 'op', value: '!=' })
        i += 2
      } else {
        tokens.push({ type: 'op', value: '!' })
        i++
      }
      continue
    }
    if (ch === '=' && expr[i + 1] === '=') {
      tokens.push({ type: 'op', value: '==' })
      i += 2
      continue
    }
    if (ch === '&' && expr[i + 1] === '&') {
      tokens.push({ type: 'op', value: '&&' })
      i += 2
      continue
    }
    if (ch === '|' && expr[i + 1] === '|') {
      tokens.push({ type: 'op', value: '||' })
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let value = ''
      while (j < expr.length && expr[j] !== quote) {
        value += expr[j]
        j++
      }
      if (j >= expr.length) {
        throw new Error(`unterminated string literal in context expression: ${expr}`)
      }
      tokens.push({ type: 'string', value })
      i = j + 1
      continue
    }
    if (IDENT_CHAR.test(ch)) {
      let j = i
      let value = ''
      while (j < expr.length && IDENT_CHAR.test(expr[j]!)) {
        value += expr[j]
        j++
      }
      tokens.push({ type: 'ident', value })
      i = j
      continue
    }
    throw new Error(`unexpected character '${ch}' in context expression: ${expr}`)
  }
  return tokens
}

type Expr =
  | { readonly kind: 'and'; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'or'; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'not'; readonly expr: Expr }
  | {
      readonly kind: 'eq'
      readonly negate: boolean
      readonly key: string
      readonly literal: string
    }
  | { readonly kind: 'truthy'; readonly key: string }

class Parser {
  private pos = 0
  constructor(
    private readonly tokens: Token[],
    private readonly source: string
  ) {}

  parse(): Expr {
    const expr = this.parseOr()
    if (this.pos !== this.tokens.length) {
      throw new Error(`unexpected trailing tokens in context expression: ${this.source}`)
    }
    return expr
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private next(): Token {
    const token = this.tokens[this.pos]
    if (token === undefined) {
      throw new Error(`unexpected end of context expression: ${this.source}`)
    }
    this.pos++
    return token
  }

  private isOp(token: Token | undefined, value: string): boolean {
    return token?.type === 'op' && token.value === value
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.isOp(this.peek(), '||')) {
      this.next()
      left = { kind: 'or', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseUnary()
    while (this.isOp(this.peek(), '&&')) {
      this.next()
      left = { kind: 'and', left, right: this.parseUnary() }
    }
    return left
  }

  private parseUnary(): Expr {
    if (this.isOp(this.peek(), '!')) {
      this.next()
      return { kind: 'not', expr: this.parseUnary() }
    }
    return this.parseComparison()
  }

  private parseComparison(): Expr {
    const left = this.parsePrimary()
    const token = this.peek()
    if (token?.type === 'op' && (token.value === '==' || token.value === '!=')) {
      if (left.kind !== 'truthy') {
        throw new Error(`left side of '${token.value}' must be a context key: ${this.source}`)
      }
      this.next()
      const rhs = this.next()
      if (rhs.type === 'op') {
        throw new Error(`expected a value after '${token.value}': ${this.source}`)
      }
      return { kind: 'eq', negate: token.value === '!=', key: left.key, literal: rhs.value }
    }
    return left
  }

  private parsePrimary(): Expr {
    const token = this.next()
    if (token.type === 'op' && token.value === '(') {
      const expr = this.parseOr()
      if (!this.isOp(this.peek(), ')')) {
        throw new Error(`expected ')' in context expression: ${this.source}`)
      }
      this.next()
      return expr
    }
    if (token.type === 'ident') return { kind: 'truthy', key: token.value }
    throw new Error(`a bare string literal is not a valid context expression: ${this.source}`)
  }
}

function evaluate(expr: Expr, context: ContextKeys): boolean {
  switch (expr.kind) {
    case 'and':
      return evaluate(expr.left, context) && evaluate(expr.right, context)
    case 'or':
      return evaluate(expr.left, context) || evaluate(expr.right, context)
    case 'not':
      return !evaluate(expr.expr, context)
    case 'truthy':
      return Boolean(context[expr.key as keyof ContextKeys])
    case 'eq': {
      const matches = String(context[expr.key as keyof ContextKeys]) === expr.literal
      return expr.negate ? !matches : matches
    }
  }
}

export type CompiledExpression = (context: ContextKeys) => boolean

/**
 * Parsed expressions, keyed by their source text. Bounded in practice:
 * `when` clauses are string literals in command definitions, not values
 * built at runtime.
 */
const compiledCache = new Map<ContextExpression, CompiledExpression>()

/**
 * Parses once, evaluates many times. Throws on malformed input — which is
 * the point of separating the two phases: `registerCommand` compiles a
 * command's `when` at registration, so a typo fails at the definition that
 * introduced it rather than inside whichever surface happens to query
 * first. Evaluation afterwards is an AST walk with no re-parse, which
 * matters because the palette (D5) filters the whole registry on every
 * keystroke.
 */
export function compileContextExpression(expr: ContextExpression): CompiledExpression {
  const cached = compiledCache.get(expr)
  if (cached !== undefined) return cached

  const ast = new Parser(tokenize(expr), expr).parse()
  const compiled = (context: ContextKeys): boolean => evaluate(ast, context)
  compiledCache.set(expr, compiled)
  return compiled
}

/** Convenience for one-shot evaluation. Throws on malformed input. */
export function evaluateContextExpression(expr: ContextExpression, context: ContextKeys): boolean {
  return compileContextExpression(expr)(context)
}
