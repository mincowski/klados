/**
 * Path evaluation over the flat store (M4-PLAN.md G8, CONCEPT.md §6.6).
 * Every rule below is the design:
 *
 * - **Node sets are `Int32Array`**, never an array of objects — every step
 *   returns one, and the final result is one.
 * - **A name step walks each context node's children** comparing `nameId`
 *   directly (`NodeStore.childrenOf` + `nameIdOf`) — an integer compare,
 *   which is why §6.5 interns names at all.
 * - **A descendant step (`//`) uses G1's name index.** Every node with a
 *   given `nameId` is already ascending by ref (document order); node refs
 *   are allocated in document order and a subtree occupies one *contiguous*
 *   ref range (`subtreeSplice.ts`'s own fact, re-derived here as
 *   `subtreeEndRef` — O(depth), never O(subtree size), the same way
 *   `subtreeSplice.ts` sizes a graft without walking it). So "is this named
 *   node inside context node C's subtree" is a ref-range binary search, not
 *   a walk — **this is the step the name index exists for**; without it,
 *   `//price` is a full document scan.
 * - **A positional predicate groups by parent** — 1-based rank among a
 *   match's siblings sharing the same immediate parent, in document order,
 *   regardless of which axis produced the match.
 * - **A comparison predicate never decodes anything** (R129–R131 §9). The
 *   string needle is encoded into the document's own bytes once per query;
 *   values are compared byte for byte, and numbers are read straight out of
 *   the byte range by `xpathNumber.ts`. §2 measured the decoding shapes at
 *   22× (numeric) and 7.7× (string) the cost of these.
 * - **A comparison predicate is resumable** (R130). `startPathStep` returns
 *   a job whose `advance(batch)` filters at most `batch` candidates and
 *   reports whether it finished, so `runChunkedJob` can suspend *within* a
 *   step rather than only between steps. The batch exists because §6
 *   measured a `performance.now()` per candidate at +27.5 ms — more than
 *   the entire evaluation it was guarding.
 */
import type { NodeStore } from '../nodeStore'
import type { SourceBuffer } from '../buffer'
import { NodeKind, type NodeRef } from '../types'
import { nodesByNameId, type NameIndex } from '../nameIndex'
import { encodeText } from '../textEncode'
import type {
  BooleanPredicate,
  ComparisonOperator,
  ParsedPath,
  PathPredicate,
  PathStep,
  SubjectAxis
} from './parse'
import {
  bytesEqual,
  numberByteLayout,
  xpathNumberAscii,
  xpathNumberFromBytes,
  type NumberByteLayout
} from './xpathNumber'

const NO_REF = -1
/** `NodeStore`'s own "no value" sentinel, mirrored rather than imported —
 * `valueStartOf` returns it directly, and the store keeps the constant
 * private the way it keeps `NO_REF` private (which this file already
 * mirrors immediately above). */
const NO_VALUE = -1
const ROOT: NodeRef = 0

/**
 * How many candidates one `advance` filters before returning to the
 * scheduler, which reads the clock once per call. R130 §6 measured the
 * whole span: no check 17.5 ms, every 256 candidates 19.1 ms, every 1,024
 * candidates 20.5 ms, **every candidate 45.0 ms**. 256 and 1,024 are within
 * noise of each other, so this is the middle of that range and the plan's
 * own instruction is not to tune it further.
 */
export const PREDICATE_BATCH = 512

/** Same fact `subtreeSplice.ts`'s own `subtreeEndRef` rests on: contiguous
 * ref allocation means a subtree's ref boundary is found by walking
 * ancestors' `nextSibling`, never by walking the subtree's own contents. */
function subtreeEndRef(store: NodeStore, node: NodeRef): NodeRef {
  for (let n = node; ;) {
    const next = store.nextSiblingOf(n)
    if (next !== NO_REF) return next
    const parent = store.parentOf(n)
    if (parent === NO_REF) return store.nodeCount
    n = parent
  }
}

function lowerBound(refs: Int32Array, value: number): number {
  let lo = 0
  let hi = refs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (refs[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Every child of `context` matching `step` — direct children only, no
 * index needed (§6.6's "a name step walks each context node's children"). */
function childMatches(store: NodeStore, context: NodeRef, step: PathStep): number[] {
  const matches: number[] = []
  for (const child of store.childrenOf(context)) {
    if (step.isWildcard || store.nameIdOf(child) === step.nameId) matches.push(child)
  }
  return matches
}

/** Every descendant of `context` matching `step`, via G1's name index for a
 * resolved name, or a bounded subtree walk for a wildcard descendant step
 * (`//*`, which the index — grouped by name — cannot serve; no index over
 * "every node" exists or should, per G1's own memory-budget reasoning). */
function descendantMatches(
  store: NodeStore,
  nameIndex: NameIndex,
  context: NodeRef,
  step: PathStep
): ArrayLike<number> & Iterable<number> {
  const end = subtreeEndRef(store, context)

  if (step.isWildcard) {
    const matches: number[] = []
    for (let ref = context + 1; ref < end; ref++) matches.push(ref)
    return matches
  }

  if (step.nameId === null) return [] // G7: a name absent from the document is empty, not an error

  const refs = nodesByNameId(nameIndex, step.nameId)
  const lo = lowerBound(refs, context + 1) // excludes `context` itself
  const hi = lowerBound(refs, end)
  // A zero-copy view, not `Array.from(...)` — G10 measured the copy as a
  // real, avoidable second O(matchCount) pass on top of the aggregation
  // loop below that already visits every element once. This matters most
  // exactly when the index helps least: an unscoped `//name` from the
  // document root, where `[lo, hi)` is nearly the whole match set and a
  // copy costs about as much as the scan the index exists to avoid.
  return refs.subarray(lo, hi)
}

// ---------------------------------------------------------------------
// Comparison predicates (R129)
// ---------------------------------------------------------------------

/**
 * The second half of `NodeStore.valueOf`: a node whose value is *not*
 * folded onto itself may still hold one in a lone Text/CData child (CDATA
 * is the case that reaches this in practice). Returns that child, or
 * `NO_REF`.
 *
 * Split out rather than folded into the loop below because it is the rare
 * branch — the loop reads the folded value directly and only lands here
 * when there isn't one. Nothing here allocates, and there is no scratch
 * object or module-level slot standing in for a `Span`: the caller keeps
 * both offsets in locals.
 */
function valueBearingChild(store: NodeStore, node: NodeRef): NodeRef {
  const child = store.firstChildOf(node)
  if (child === NO_REF || store.nextSiblingOf(child) !== NO_REF) return NO_REF
  const kind = store.kindOf(child)
  if (kind !== NodeKind.Text && kind !== NodeKind.CData) return NO_REF
  return child
}

/**
 * Everything a comparison predicate needs that is the same for every
 * candidate, flattened into one monomorphic object built once per step
 * evaluation — which is once per query.
 *
 * **The operator is an integer here, not the `'>='` the AST carries.** The
 * candidate loop runs the comparison 400,000 times on the measured corpus,
 * and a string compare per candidate is exactly the kind of per-item cost
 * §9 exists to keep out of it; the parse tree keeps the readable form for
 * everything that isn't this loop.
 */
const OP_EQ = 0
const OP_NE = 1
const OP_LT = 2
const OP_LE = 3
const OP_GT = 4
const OP_GE = 5

function opCodeOf(op: ComparisonOperator): number {
  switch (op) {
    case '=':
      return OP_EQ
    case '!=':
      return OP_NE
    case '<':
      return OP_LT
    case '<=':
      return OP_LE
    case '>':
      return OP_GT
    default:
      return OP_GE
  }
}

interface ComparisonPlan {
  readonly bytes: Uint8Array
  readonly layout: NumberByteLayout
  /** `layout.stride === 1`, hoisted so the number reader is reached by a
   * direct call rather than through `xpathNumberFromBytes`'s dispatch —
   * the dispatch is per value, and the answer is per query. */
  readonly ascii: boolean
  /** The string literal in the document's own encoding, or `null` when the
   * encoding cannot represent it — which makes every `=` false and every
   * `!=` true *for values that exist*, exactly as an unequal needle would.
   * Numeric comparisons never read this. */
  readonly needle: Uint8Array | null
  readonly opCode: number
  /** True when `=`/`!=` compare bytes rather than numbers — the literal's
   * syntactic form, decided at parse time (§3). */
  readonly stringEquality: boolean
  readonly literalNumber: number
  readonly nameId: number
  readonly isAttribute: boolean
}

function planComparison(
  source: SourceBuffer,
  predicate: Extract<PathPredicate, { kind: 'comparison' }>
): ComparisonPlan {
  const stringEquality = predicate.literalKind === 'string'
  const layout = numberByteLayout(source.encoding)
  return {
    bytes: source.bytes,
    layout,
    ascii: layout.stride === 1,
    // Once per query, outside every candidate loop (§9).
    needle: stringEquality ? encodeText(predicate.literalText, source.encoding) : null,
    opCode: opCodeOf(predicate.op),
    stringEquality,
    literalNumber: predicate.literalNumber,
    nameId: predicate.subjectNameId!,
    isAttribute: predicate.subjectAxis === 'attribute'
  }
}

/**
 * One value against the predicate's literal — XPath 1.0's rules (§4):
 * `<`/`<=`/`>`/`>=` convert **both** sides to numbers always (a
 * non-numeric value is NaN, and every comparison against NaN is false),
 * while `=`/`!=` compare as strings or as numbers according to the
 * literal's syntactic form, decided at parse time.
 */
function numberAt(plan: ComparisonPlan, start: number, end: number): number {
  return plan.ascii
    ? xpathNumberAscii(plan.bytes, start, end)
    : xpathNumberFromBytes(plan.bytes, start, end, plan.layout)
}

function valueMatches(plan: ComparisonPlan, start: number, end: number): boolean {
  const op = plan.opCode
  if (op === OP_EQ || op === OP_NE) {
    let equal: boolean
    if (plan.stringEquality) {
      const needle = plan.needle
      equal = needle !== null && bytesEqual(plan.bytes, start, end, needle)
    } else {
      equal = numberAt(plan, start, end) === plan.literalNumber
    }
    return op === OP_EQ ? equal : !equal
  }

  const value = numberAt(plan, start, end)
  const literal = plan.literalNumber
  if (op === OP_LT) return value < literal
  if (op === OP_LE) return value <= literal
  if (op === OP_GT) return value > literal
  return value >= literal
}

/**
 * Whether `node` satisfies the comparison — existential over the subject,
 * as XPath is: true when *any* matching child element or attribute
 * compares true. A subject with no values at all is false for **every**
 * operator including `!=`, which is XPath's behaviour and the one place
 * the rule surprises people (§5).
 *
 * Allocates nothing: attributes are walked by index through R131's
 * `attrStartOf`/`attrNameIdAt` accessors rather than `attributesOf`'s
 * generator, and children through `firstChildOf`/`nextSiblingOf` rather
 * than `childrenOf`'s.
 */
function attributeSubjectMatches(
  store: NodeStore,
  plan: ComparisonPlan,
  start: number,
  end: number
): boolean {
  const nameId = plan.nameId
  for (let i = start; i < end; i++) {
    if (store.attrNameIdAt(i) !== nameId) continue
    if (valueMatches(plan, store.attrValueStartAt(i), store.attrValueEndAt(i))) return true
  }
  return false
}

function childSubjectMatches(store: NodeStore, plan: ComparisonPlan, node: NodeRef): boolean {
  const nameId = plan.nameId
  for (let child = store.firstChildOf(node); child !== NO_REF; child = store.nextSiblingOf(child)) {
    if (store.nameIdOf(child) !== nameId) continue
    let start = store.valueStartOf(child)
    let valueOwner = child
    if (start === NO_VALUE) {
      valueOwner = valueBearingChild(store, child)
      if (valueOwner === NO_REF) continue
      start = store.valueStartOf(valueOwner)
      if (start === NO_VALUE) continue
    }
    if (valueMatches(plan, start, store.valueEndOf(valueOwner))) return true
  }
  return false
}

// ---------------------------------------------------------------------
// Boolean predicate plan tree (R138–R139)
// ---------------------------------------------------------------------

/**
 * The predicate becomes a small expression tree — an AST, but per *query*,
 * a handful of objects built once (this section), not per node (§6.6's
 * per-node argument, `parse.ts`'s own top comment, stays about node data
 * and is untouched by this). Leaves are R129's monomorphic `ComparisonPlan`
 * or an existence test; internal nodes are `and`/`or`/`not`.
 *
 * `const` folds an unresolved subject (`subjectNameId === null`, R129 §5's
 * "answerable as false without touching the store") straight through
 * `and`/`or`/`not` at build time: `not(price>100)` over a `price` name
 * absent from the *whole document* becomes `{ kind: 'const', value: true }`
 * — every candidate passes with no per-node work at all, the same shortcut
 * G7 already gives an absent step name, one level up.
 */
type PredicatePlan =
  | { readonly kind: 'const'; readonly value: boolean }
  | { readonly kind: 'comparison'; readonly plan: ComparisonPlan }
  | {
      readonly kind: 'existence'
      readonly subjectAxis: SubjectAxis
      readonly nameId: number | null
      readonly isWildcard: boolean
    }
  | { readonly kind: 'not'; readonly operand: PredicatePlan }
  | { readonly kind: 'and'; readonly left: PredicatePlan; readonly right: PredicatePlan }
  | { readonly kind: 'or'; readonly left: PredicatePlan; readonly right: PredicatePlan }

/**
 * Built once per query. The recursion here walks the *parsed predicate*,
 * not document nodes — depth is bounded by `parse.ts`'s own
 * `MAX_PREDICATE_DEPTH`, so this cannot hit invariant 4's concern (which is
 * about walking arbitrarily-nested *document* input); a query-sized object
 * graph capped at 64 levels is nowhere near a stack risk.
 */
function planPredicate(source: SourceBuffer, predicate: BooleanPredicate): PredicatePlan {
  switch (predicate.kind) {
    case 'comparison':
      if (predicate.subjectNameId === null) return { kind: 'const', value: false }
      return { kind: 'comparison', plan: planComparison(source, predicate) }
    case 'existence':
      if (!predicate.isWildcard && predicate.subjectNameId === null) {
        return { kind: 'const', value: false }
      }
      return {
        kind: 'existence',
        subjectAxis: predicate.subjectAxis,
        nameId: predicate.subjectNameId,
        isWildcard: predicate.isWildcard
      }
    case 'not': {
      const operand = planPredicate(source, predicate.operand)
      return operand.kind === 'const'
        ? { kind: 'const', value: !operand.value }
        : { kind: 'not', operand }
    }
    case 'and': {
      const left = planPredicate(source, predicate.left)
      if (left.kind === 'const' && !left.value) return { kind: 'const', value: false }
      const right = planPredicate(source, predicate.right)
      if (right.kind === 'const' && !right.value) return { kind: 'const', value: false }
      if (left.kind === 'const') return right // left is `true` here
      if (right.kind === 'const') return left // right is `true` here
      return { kind: 'and', left, right }
    }
    case 'or': {
      const left = planPredicate(source, predicate.left)
      if (left.kind === 'const' && left.value) return { kind: 'const', value: true }
      const right = planPredicate(source, predicate.right)
      if (right.kind === 'const' && right.value) return { kind: 'const', value: true }
      if (left.kind === 'const') return right // left is `false` here
      if (right.kind === 'const') return left // right is `false` here
      return { kind: 'or', left, right }
    }
  }
}

/** Whether `plan` reads the attribute table at all — decided once per
 * query so `advance` below only gallops to a candidate's attribute range
 * when some leaf actually needs it, rather than paying that cost (cheap,
 * but not free) for a purely child-element predicate. */
function planUsesAttributes(plan: PredicatePlan): boolean {
  switch (plan.kind) {
    case 'const':
      return false
    case 'comparison':
      return plan.plan.isAttribute
    case 'existence':
      return plan.subjectAxis === 'attribute'
    case 'not':
      return planUsesAttributes(plan.operand)
    case 'and':
    case 'or':
      return planUsesAttributes(plan.left) || planUsesAttributes(plan.right)
  }
}

/** R132's existence rule: stop at the name match, never look at a value —
 * the detail `attributeSubjectMatches`/`childSubjectMatches` above get
 * wrong if reused as-is (they `continue`/skip past a subject with no
 * value, correct for a comparison, wrong for existence). Allocation-free
 * for the same reason those are: indexed attribute access, `firstChildOf`/
 * `nextSiblingOf` rather than the generator accessors. */
function existenceMatches(
  store: NodeStore,
  leaf: Extract<PredicatePlan, { kind: 'existence' }>,
  node: NodeRef,
  attrStart: number,
  attrEnd: number
): boolean {
  if (leaf.subjectAxis === 'attribute') {
    if (leaf.isWildcard) return attrEnd > attrStart
    const nameId = leaf.nameId!
    for (let i = attrStart; i < attrEnd; i++) {
      if (store.attrNameIdAt(i) === nameId) return true
    }
    return false
  }
  if (leaf.isWildcard) {
    // XPath's `*` node test matches element nodes only, not Text/CData/
    // Comment/PI/DocType children.
    for (
      let child = store.firstChildOf(node);
      child !== NO_REF;
      child = store.nextSiblingOf(child)
    ) {
      if (store.kindOf(child) === NodeKind.Element) return true
    }
    return false
  }
  const nameId = leaf.nameId!
  for (let child = store.firstChildOf(node); child !== NO_REF; child = store.nextSiblingOf(child)) {
    if (store.nameIdOf(child) === nameId) return true
  }
  return false
}

/**
 * One candidate against the whole plan tree — short-circuits left to
 * right, exactly as written (§9: never reorder operands by estimated cost;
 * a query's performance must not depend on an invisible reordering the
 * user cannot see or control). `attrStart`/`attrEnd` are computed once per
 * candidate by the caller, not per leaf, so a tree with several attribute-
 * subject leaves galleps to the attribute range only once.
 */
function evaluatePredicatePlan(
  store: NodeStore,
  plan: PredicatePlan,
  node: NodeRef,
  attrStart: number,
  attrEnd: number
): boolean {
  switch (plan.kind) {
    case 'const':
      return plan.value
    case 'comparison':
      return plan.plan.isAttribute
        ? attributeSubjectMatches(store, plan.plan, attrStart, attrEnd)
        : childSubjectMatches(store, plan.plan, node)
    case 'existence':
      return existenceMatches(store, plan, node, attrStart, attrEnd)
    case 'not':
      return !evaluatePredicatePlan(store, plan.operand, node, attrStart, attrEnd)
    case 'and':
      return (
        evaluatePredicatePlan(store, plan.left, node, attrStart, attrEnd) &&
        evaluatePredicatePlan(store, plan.right, node, attrStart, attrEnd)
      )
    case 'or':
      return (
        evaluatePredicatePlan(store, plan.left, node, attrStart, attrEnd) ||
        evaluatePredicatePlan(store, plan.right, node, attrStart, attrEnd)
      )
  }
}

/** Positional: rank within each parent group, in the order `matches`
 * already has them (ascending ref / document order, by construction of
 * both `childMatches` and `descendantMatches`). Cheap per candidate and
 * bounded by the match count, so it is not chunked. */
function applyPositional(store: NodeStore, matches: ArrayLike<NodeRef>, index: number): number[] {
  const rankByParent = new Map<NodeRef, number>()
  const result: number[] = []
  for (let i = 0; i < matches.length; i++) {
    const node = matches[i]!
    const parent = store.parentOf(node)
    const rank = (rankByParent.get(parent) ?? 0) + 1
    rankByParent.set(parent, rank)
    if (rank === index) result.push(node)
  }
  return result
}

/** The general candidate collection: every context's matches, in context
 * order. */
function collectMatches(
  store: NodeStore,
  nameIndex: NameIndex,
  context: Int32Array,
  step: PathStep
): number[] {
  const matches: number[] = []
  if (step.axis === 'child') {
    for (let i = 0; i < context.length; i++) {
      for (const m of childMatches(store, context[i]!, step)) matches.push(m)
    }
    return matches
  }

  // Context nodes are ascending and either disjoint or nested (G8's own
  // documented shape). Nested contexts are a real, reachable input —
  // e.g. `//a` matching an `<a>` nested inside another `<a>` — and
  // without this guard, a later, nested context's entire descendant
  // range is a *subset* of an earlier context's own range, already
  // emitted once: `coveredUpTo` skips any context whose ref falls inside
  // a range already covered, so each node is emitted at most once and
  // ascending order is preserved (contexts are only ever skipped
  // wholesale, never reordered).
  let coveredUpTo = -1
  for (let i = 0; i < context.length; i++) {
    const ctx = context[i]!
    if (ctx < coveredUpTo) continue
    for (const m of descendantMatches(store, nameIndex, ctx, step)) matches.push(m)
    coveredUpTo = subtreeEndRef(store, ctx)
  }
  return matches
}

/**
 * One step's evaluation, suspendable between batches of candidates (R130).
 * `advance` returns the finished node set, or `null` when there is more to
 * do — the caller decides when to come back, and reads the clock once per
 * call rather than once per candidate (§6: the latter costs +27.5 ms,
 * more than the whole evaluation).
 */
export interface PathStepJob {
  /** Filters at most `batch` more candidates. `null` means "not finished";
   * once it has returned the node set, every later call returns that same
   * array. */
  advance(batch: number): Int32Array | null
}

/** Already-finished work, wrapped so callers have one shape to drive.
 * Always copies, even when handed an `Int32Array`: the candidate set may
 * be a *view* into the name index (`descendantMatches`'s zero-copy
 * `subarray`), and a step's result outlives this call. */
function completed(result: ArrayLike<number>): PathStepJob {
  const value = Int32Array.from(result)
  return {
    advance(): Int32Array {
      return value
    }
  }
}

/**
 * One step, in isolation — exported so a caller that needs to chunk a
 * whole-path evaluation (M4-PLAN.md G8's own "runs through G3's
 * scheduler") can slice via G3's `runChunkedJob` without this module taking
 * on a dependency on the renderer-side scheduler itself (`core/` stays free
 * of `renderer/session` imports). `evaluatePathStep` and `evaluatePath`
 * below are the synchronous conveniences built from this — correct for a
 * query short enough not to need chunking (most are), and what every
 * existing test in this file exercises directly.
 *
 * **What is and isn't preemptible.** Collecting the candidate set is one
 * unit, as it was before R130 — it is a name-index range or a child walk,
 * with no per-candidate work beyond an integer compare. Filtering that set
 * through a comparison predicate is the part that is linear in candidate
 * count *and* does real work per candidate, and it is the part R130 makes
 * resumable.
 */
export function startPathStep(
  store: NodeStore,
  nameIndex: NameIndex,
  source: SourceBuffer,
  context: Int32Array,
  step: PathStep
): PathStepJob {
  if (!step.isWildcard && step.nameId === null && step.axis === 'child') {
    return completed([]) // G7: absent name, answerable as empty without touching the store
  }

  // The one shape where the candidate set already exists as an
  // `Int32Array`: a single context, a descendant axis, and a resolved
  // name make `descendantMatches` a zero-copy `subarray` of the name
  // index. Copying it into a JS array first — which is what the general
  // path below does — measured **7–8 ms** for 400,000 candidates on the
  // R131 corpus, on top of an evaluation budgeted at 40. It is only ever
  // read here, and `completed`/`Int32Array.from` copy before anything
  // escapes, so the view never leaks.
  const matches: ArrayLike<number> =
    step.axis === 'descendant' && context.length === 1 && !step.isWildcard
      ? descendantMatches(store, nameIndex, context[0]!, step)
      : collectMatches(store, nameIndex, context, step)

  const predicate = step.predicate
  if (predicate === null) return completed(matches)
  if (predicate.kind === 'positional') {
    return completed(applyPositional(store, matches, predicate.index))
  }

  // The plan tree (R139) — built here, once, rather than inside `advance`:
  // §9's "encode the string needle [and everything else query-shaped] once
  // per query, outside the candidate loop." A fully constant-folded plan
  // (every leaf's subject absent from the document) answers without
  // touching the store at all — the same shape G7 gives a step name that
  // isn't in the document, generalized to a whole boolean expression.
  const plan = planPredicate(source, predicate)
  if (plan.kind === 'const') {
    return completed(plan.value ? matches : [])
  }
  const usesAttributes = planUsesAttributes(plan)

  const kept: number[] = []
  let cursor = 0
  // The attribute-range lower-bound hint (see `NodeStore.attrStartOf`).
  // Candidates ascend in every ordinary shape — but not guaranteed to: a
  // *nested* context set (`//a` matching an `<a>` inside another `<a>`,
  // then a child step) can put a later context's children before an
  // earlier context's. So the hint is used only while the walk actually
  // ascends, and reset otherwise — too high a hint would silently return
  // the wrong attribute range, which is a correctness bug rather than a
  // slow path.
  let previousNode = -1
  let attrHint = 0
  // Built once, on the call that finishes the walk. `advance` past
  // completion then returns the same array rather than rebuilding it —
  // matching `completed`, which also answers only once, and keeping
  // "advance returned a value" from meaning two different things.
  let finished: Int32Array | null = null
  return {
    advance(batch: number): Int32Array | null {
      if (finished !== null) return finished
      const stop = Math.min(matches.length, cursor + batch)
      for (; cursor < stop; cursor++) {
        const node = matches[cursor]!
        // The attribute range is computed once per candidate regardless of
        // how many attribute-subject leaves the tree has (§9: never
        // implement `and`/`or` as two independent full evaluations) —
        // skipped entirely when no leaf in the tree reads it at all.
        let attrStart = 0
        let attrEnd = 0
        if (usesAttributes) {
          if (node < previousNode) attrHint = 0
          previousNode = node
          attrStart = store.attrStartOf(node, attrHint)
          attrEnd = store.attrEndOf(node, attrStart)
          attrHint = attrEnd
        }
        if (evaluatePredicatePlan(store, plan, node, attrStart, attrEnd)) kept.push(node)
      }
      if (cursor < matches.length) return null
      finished = Int32Array.from(kept)
      return finished
    }
  }
}

/**
 * The synchronous form of `startPathStep` — drives the job to completion
 * in one call. Every caller that isn't the chunked scheduler wants this.
 */
export function evaluatePathStep(
  store: NodeStore,
  nameIndex: NameIndex,
  source: SourceBuffer,
  context: Int32Array,
  step: PathStep
): Int32Array {
  const job = startPathStep(store, nameIndex, source, context, step)
  for (;;) {
    // `Number.MAX_SAFE_INTEGER` rather than a loop of batches: a caller
    // asking for the synchronous form has already accepted the whole cost,
    // and batching it would only add clock-free bookkeeping.
    const result = job.advance(Number.MAX_SAFE_INTEGER)
    if (result !== null) return result
  }
}

/**
 * The whole-path result — an `Int32Array` of node refs, ascending only
 * insofar as each step's own output already is (child/descendant matches
 * are collected in context order, which is document order for a
 * well-formed context set). Starts from the document root as the implicit
 * single-node context every path's first step evaluates against.
 */
export function evaluatePath(
  store: NodeStore,
  nameIndex: NameIndex,
  source: SourceBuffer,
  path: ParsedPath
): Int32Array {
  let context: Int32Array = Int32Array.from([ROOT])
  for (const step of path.steps) {
    context = evaluatePathStep(store, nameIndex, source, context, step)
    if (context.length === 0) break
  }
  return context
}
