/**
 * M3-PLAN.md F4 — incremental reparse. Reparses only the innermost node
 * whose span fully contains an edit, via `FormatModule.parseRange`
 * (already implemented, covered by B12's invariant 4 since M0 — this task
 * is its first real consumer), and grafts the result into the live store
 * rather than rebuilding it from scratch.
 *
 * **The graft is array surgery, not a tree walk.** `NodeRef`s are plain
 * indices into `NodeStore`'s parallel arrays, allocated in open order —
 * document order — so a node's entire subtree occupies one contiguous
 * range of refs (CONCEPT.md §3.2). That means splicing is exactly three
 * concatenated array segments: refs before the edited node (untouched,
 * with one exception below), the freshly-parsed replacement (renumbered
 * by a constant offset), and refs after it (renumbered by a constant
 * offset, spans shifted by a constant byte delta). No per-node walk, no
 * NodeSink replay — `NodeStore.exportBuffers`/`fromBuffers` (already
 * public, already used for the worker transfer) are the only surface this
 * needs.
 *
 * **The edited node keeps its own ref.** The replacement subtree is
 * spliced in starting at the *same* index the old subtree occupied, not
 * appended at the end. That is what makes the "before" segment need zero
 * pointer fixups: whatever pointed at the old subtree's root — the
 * parent's `firstChild`, a sibling's `nextSibling` — already points at the
 * right index; it just resolves to different content now. The only
 * pointers actually rewritten live in the "after" segment (shifted by the
 * node-count delta) and in the few ancestors whose own `spanEnd` extends
 * past the edit (shifted by the byte delta) — bounded by document depth,
 * not document size.
 *
 * **What this deliberately does not do**: keep the pending-delta list
 * (`core/deltaList.ts`) around for later reads. Each splice computes and
 * applies its own shift immediately, in full, to everything after the
 * edit — an O(document node count) rewrite per edit, not the O(delta list
 * size) F2 was built to make possible. That's the "start simple" version:
 * wiring `shiftedOffset` into every UI read path (Tree rows, grid cells,
 * Raw decorations) so *multiple* edits between reparses could share one
 * unfolded delta list is real, cross-cutting scope this task's own file
 * boundary (`subtreeSplice.ts`, one file) doesn't cover. F10's measurement
 * is what would motivate actually building that.
 */
import { Interner } from '../../core/interner'
import { NodeStore, type NodeStoreBuffers } from '../../core/nodeStore'
import {
  NodeKind,
  type AncestorView,
  type Diagnostic,
  type FormatModule,
  type NodeRef,
  type Offset,
  type ParseOptions
} from '../../core/types'
import { nodeContainingRange } from '../nodeSpanLookup'
import { runChunkedJob, type SearchJob } from './searchJob'

const NO_REF = -1
/** Mirrors `NodeStore`'s own private `NO_VALUE` sentinel — not exported
 * there (it's an implementation constant, not part of the public
 * surface), so this module defines its own copy rather than reach for a
 * private one. Distinct constant from `NO_REF` only by convention; both
 * happen to be `-1`, but they mark different fields for different
 * reasons and are kept named separately so a future change to one
 * doesn't silently affect the other. */
const NO_VALUE = -1

export type SpliceFailureReason =
  /** `capabilities.canIncrementalReparse` is false for this format. */
  | 'unsupported'
  /** No node's span fully contains `[dirtyStart, dirtyEnd)` — shouldn't
   * happen for a real edit inside an open document (the root always
   * covers the whole buffer), but the caller falls back rather than
   * assume it can't. */
  | 'no-containing-node'
  /** `parseRange` reported `complete: false` — the edited region doesn't
   * parse as one well-formed subtree on its own (crossed a boundary, or
   * broke well-formedness). */
  | 'malformed'

export interface SpliceSuccess {
  readonly ok: true
  readonly store: NodeStore
}

export interface SpliceFailure {
  readonly ok: false
  readonly reason: SpliceFailureReason
}

export type SpliceOutcome = SpliceSuccess | SpliceFailure

export interface SpliceRequest {
  readonly format: FormatModule
  /** The store as of the last successful parse (full or spliced). */
  readonly oldStore: NodeStore
  /** The *current* buffer — already edited (F1 already applied the
   * patch(es) to it before this ever runs). */
  readonly newBytes: Uint8Array
  /** The same `Interner` `oldStore` uses. Names are interned by content
   * (`Interner.intern` hashes bytes, not identity), so reusing it means
   * every copied and freshly-parsed name id is already correct — nothing
   * here re-interns anything for a node it's just copying. */
  readonly interner: Interner
  /** The union of every edit since `oldStore` was produced, in
   * `oldStore`'s own coordinates. */
  readonly dirtyStart: Offset
  readonly dirtyEnd: Offset
  /** Net byte length change across all of those edits (new length minus
   * old length) — positive for a net insertion, negative for a net
   * deletion. */
  readonly delta: number
  readonly options: ParseOptions
}

/** Root-first ancestor chain of `node`, cheap regardless of document size
 * — bounded by depth, per `FormatModule.resumeContextFor`'s own contract. */
function ancestorChain(store: NodeStore, node: NodeRef): NodeRef[] {
  const chain: NodeRef[] = []
  for (let p = store.parentOf(node); p !== NO_REF; p = store.parentOf(p)) chain.push(p)
  chain.reverse()
  return chain
}

/** Ancestors are entirely outside the edited region, so their bytes are
 * identical in `bytes` at their existing (unshifted) offsets — decoding
 * attribute values straight from the live buffer at those offsets is
 * correct, not an approximation. */
function buildAncestorView(
  store: NodeStore,
  chain: readonly NodeRef[],
  bytes: Uint8Array,
  encoding: string
): AncestorView {
  const decoder = new TextDecoder(encoding)
  return {
    length: chain.length,
    kindAt: (i) => store.kindOf(chain[i]!),
    spanStartAt: (i) => store.spanOf(chain[i]!).start,
    spanEndAt: (i) => store.spanOf(chain[i]!).end,
    *attributesAt(i) {
      for (const attr of store.attributesOf(chain[i]!)) {
        yield {
          name: store.textOf(attr.nameId),
          value: decoder.decode(bytes.subarray(attr.valueStart, attr.valueEnd))
        }
      }
    }
  }
}

/**
 * The ref boundary (exclusive) marking the end of `node`'s subtree — the
 * smallest ref that is not `node` or one of its descendants. Contiguous
 * ref allocation means this is `node`'s own `nextSibling` if it has one,
 * or its nearest ancestor's `nextSibling`, or `store.nodeCount` if none of
 * `node`'s ancestors has a later sibling either. O(depth), never O(subtree
 * size) — no walk of the subtree's own contents is needed to size it.
 */
function subtreeEndRef(store: NodeStore, node: NodeRef): NodeRef {
  for (let n = node; ;) {
    const next = store.nextSiblingOf(n)
    if (next !== NO_REF) return next
    const parent = store.parentOf(n)
    if (parent === NO_REF) return store.nodeCount
    n = parent
  }
}

function attrLowerBound(attrOwner: Int32Array, owner: NodeRef): number {
  let lo = 0
  let hi = attrOwner.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (attrOwner[mid]! < owner) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Splices `freshBuffers` (the reparsed replacement for `[spliceNode,
 * boundary)`) into `oldStore`'s exported buffers, producing a new,
 * complete, self-consistent `NodeStoreBuffers` — three concatenated
 * segments, refs and spans adjusted as this module's own top comment
 * describes.
 */
function graft(
  oldStore: NodeStore,
  spliceNode: NodeRef,
  ancestors: readonly NodeRef[],
  freshBuffers: NodeStoreBuffers,
  delta: number
): NodeStoreBuffers {
  const oldBuffers = oldStore.exportBuffers()
  const boundary = subtreeEndRef(oldStore, spliceNode)
  const oldSubtreeCount = boundary - spliceNode
  const freshCount = freshBuffers.nodeCount
  const refDelta = freshCount - oldSubtreeCount

  const beforeCount = spliceNode
  const afterCount = oldBuffers.nodeCount - boundary
  const totalCount = beforeCount + freshCount + afterCount

  const kind = new Uint8Array(totalCount)
  const nameId = new Int32Array(totalCount)
  const valueStart = new Int32Array(totalCount)
  const valueEnd = new Int32Array(totalCount)
  const spanStart = new Int32Array(totalCount)
  const spanEnd = new Int32Array(totalCount)
  const parent = new Int32Array(totalCount)
  const firstChild = new Int32Array(totalCount)
  const nextSibling = new Int32Array(totalCount)
  const prevSibling = new Int32Array(totalCount)
  const flags = new Uint8Array(totalCount)

  // --- before segment: bulk-copied verbatim, then two fields patched for
  // ancestors of `spliceNode`. Every before-segment node's `parent`,
  // `firstChild` and `prevSibling` only ever reach other before-segment
  // nodes — but an ancestor's own `nextSibling` (if it has one) necessarily
  // points *past* the whole edited subtree, since the ancestor's span
  // contains it; that ref, like every after-segment ref, needs shifting by
  // `refDelta`. `spanEnd` needs the analogous byte-delta shift for the same
  // reason. Both are patched below, not in this bulk copy.
  kind.set(oldBuffers.kind.subarray(0, beforeCount), 0)
  nameId.set(oldBuffers.nameId.subarray(0, beforeCount), 0)
  valueStart.set(oldBuffers.valueStart.subarray(0, beforeCount), 0)
  valueEnd.set(oldBuffers.valueEnd.subarray(0, beforeCount), 0)
  spanStart.set(oldBuffers.spanStart.subarray(0, beforeCount), 0)
  spanEnd.set(oldBuffers.spanEnd.subarray(0, beforeCount), 0)
  parent.set(oldBuffers.parent.subarray(0, beforeCount), 0)
  firstChild.set(oldBuffers.firstChild.subarray(0, beforeCount), 0)
  nextSibling.set(oldBuffers.nextSibling.subarray(0, beforeCount), 0)
  prevSibling.set(oldBuffers.prevSibling.subarray(0, beforeCount), 0)
  flags.set(oldBuffers.flags.subarray(0, beforeCount), 0)

  for (const ancestor of ancestors) {
    spanEnd[ancestor] = oldBuffers.spanEnd[ancestor]! + delta
    const oldAncestorNextSibling = oldBuffers.nextSibling[ancestor]!
    nextSibling[ancestor] =
      oldAncestorNextSibling === NO_REF ? NO_REF : oldAncestorNextSibling + refDelta
  }

  // --- the freshly-parsed replacement, renumbered by +spliceNode ---
  function remapFresh(ref: number): number {
    return ref === NO_REF ? NO_REF : ref + spliceNode
  }
  for (let i = 0; i < freshCount; i++) {
    const dest = spliceNode + i
    kind[dest] = freshBuffers.kind[i]!
    nameId[dest] = freshBuffers.nameId[i]!
    valueStart[dest] = freshBuffers.valueStart[i]!
    valueEnd[dest] = freshBuffers.valueEnd[i]!
    spanStart[dest] = freshBuffers.spanStart[i]!
    spanEnd[dest] = freshBuffers.spanEnd[i]!
    parent[dest] = remapFresh(freshBuffers.parent[i]!)
    firstChild[dest] = remapFresh(freshBuffers.firstChild[i]!)
    nextSibling[dest] = remapFresh(freshBuffers.nextSibling[i]!)
    prevSibling[dest] = remapFresh(freshBuffers.prevSibling[i]!)
    flags[dest] = freshBuffers.flags[i]!
  }
  // The fresh subtree's own root (index 0) was parsed as if it had no
  // ancestors — `parseRange`'s contract only guarantees offsets, not tree
  // linkage above the range. Its parent/sibling links must instead be
  // exactly what the *old* spliceNode's were: the parent and prevSibling
  // are before-segment refs (unaffected by the edit), and the
  // nextSibling — if any — is an after-segment ref needing the same
  // shift every other after-segment pointer gets.
  parent[spliceNode] = oldBuffers.parent[spliceNode]!
  prevSibling[spliceNode] = oldBuffers.prevSibling[spliceNode]!
  const oldNextSibling = oldBuffers.nextSibling[spliceNode]!
  nextSibling[spliceNode] = oldNextSibling === NO_REF ? NO_REF : oldNextSibling + refDelta

  // --- after segment: every ref and span shifts by a constant ---
  function remapAfter(ref: number): number {
    if (ref === NO_REF) return NO_REF
    return ref < boundary ? ref : ref + refDelta
  }
  // `valueStart`/`valueEnd` carry their own sentinel (-1, "no value" — a
  // composite node, or a leaf whose value is a separate Text/CData child)
  // distinct from `NO_REF` but exactly as easy to corrupt the same way:
  // shifting -1 by `delta` produces a small, plausible-looking, entirely
  // wrong offset instead of staying "absent." `spanStart`/`spanEnd` need
  // no such guard — every node in a *completed* parse was closed with a
  // real span, never left at a sentinel.
  function shiftIfSet(value: number): number {
    return value === NO_VALUE ? NO_VALUE : value + delta
  }
  for (let i = 0; i < afterCount; i++) {
    const src = boundary + i
    const dest = spliceNode + freshCount + i
    kind[dest] = oldBuffers.kind[src]!
    nameId[dest] = oldBuffers.nameId[src]!
    valueStart[dest] = shiftIfSet(oldBuffers.valueStart[src]!)
    valueEnd[dest] = shiftIfSet(oldBuffers.valueEnd[src]!)
    spanStart[dest] = oldBuffers.spanStart[src]! + delta
    spanEnd[dest] = oldBuffers.spanEnd[src]! + delta
    parent[dest] = remapAfter(oldBuffers.parent[src]!)
    firstChild[dest] = remapAfter(oldBuffers.firstChild[src]!)
    nextSibling[dest] = remapAfter(oldBuffers.nextSibling[src]!)
    prevSibling[dest] = remapAfter(oldBuffers.prevSibling[src]!)
    flags[dest] = oldBuffers.flags[src]!
  }

  // --- attributes: same three-segment split, keyed by owner ref ---
  const oldAttrBeforeEnd = attrLowerBound(oldBuffers.attrOwner, spliceNode)
  const oldAttrAfterStart = attrLowerBound(oldBuffers.attrOwner, boundary)
  const afterAttrCount = oldBuffers.attrCount - oldAttrAfterStart
  const totalAttrCount = oldAttrBeforeEnd + freshBuffers.attrCount + afterAttrCount

  const attrOwner = new Int32Array(totalAttrCount)
  const attrNameId = new Int32Array(totalAttrCount)
  const attrValueStart = new Int32Array(totalAttrCount)
  const attrValueEnd = new Int32Array(totalAttrCount)

  attrOwner.set(oldBuffers.attrOwner.subarray(0, oldAttrBeforeEnd), 0)
  attrNameId.set(oldBuffers.attrNameId.subarray(0, oldAttrBeforeEnd), 0)
  attrValueStart.set(oldBuffers.attrValueStart.subarray(0, oldAttrBeforeEnd), 0)
  attrValueEnd.set(oldBuffers.attrValueEnd.subarray(0, oldAttrBeforeEnd), 0)

  for (let i = 0; i < freshBuffers.attrCount; i++) {
    const dest = oldAttrBeforeEnd + i
    attrOwner[dest] = freshBuffers.attrOwner[i]! + spliceNode
    attrNameId[dest] = freshBuffers.attrNameId[i]!
    attrValueStart[dest] = freshBuffers.attrValueStart[i]!
    attrValueEnd[dest] = freshBuffers.attrValueEnd[i]!
  }

  for (let i = 0; i < afterAttrCount; i++) {
    const src = oldAttrAfterStart + i
    const dest = oldAttrBeforeEnd + freshBuffers.attrCount + i
    attrOwner[dest] = oldBuffers.attrOwner[src]! + refDelta
    attrNameId[dest] = oldBuffers.attrNameId[src]!
    attrValueStart[dest] = oldBuffers.attrValueStart[src]! + delta
    attrValueEnd[dest] = oldBuffers.attrValueEnd[src]! + delta
  }

  return {
    kind,
    nameId,
    valueStart,
    valueEnd,
    spanStart,
    spanEnd,
    parent,
    firstChild,
    nextSibling,
    prevSibling,
    flags,
    attrOwner,
    attrNameId,
    attrValueStart,
    attrValueEnd,
    nodeCount: totalCount,
    attrCount: totalAttrCount
  }
}

/** Diagnostics inside the old subtree are dropped (replaced by whatever
 * the fresh parse found there instead); everything before is untouched;
 * everything after shifts by `delta`, same as every other post-edit span. */
function mergeDiagnostics(
  oldDiagnostics: readonly Diagnostic[],
  oldSpan: { readonly start: Offset; readonly end: Offset },
  delta: number,
  freshDiagnostics: readonly Diagnostic[]
): Diagnostic[] {
  const merged: Diagnostic[] = []
  for (const d of oldDiagnostics) {
    if (d.offset < oldSpan.start) merged.push(d)
    else if (d.offset >= oldSpan.end) merged.push({ ...d, offset: d.offset + delta })
  }
  merged.push(...freshDiagnostics)
  return merged
}

/**
 * `nodeContainingRange`'s answer, walked up past two shapes that can't be
 * reparsed via their own range:
 *
 * - A `Property` — its own span is never independently reparseable.
 *   JSON's `parseRange` only knows how to parse a bare *value*
 *   (`parseOneValue`: scalar, object or array); a `"key":value` pair has
 *   no grammar production of its own to reparse standalone. Every
 *   format's Property kind is exactly this shape (a name owning its own
 *   scalar rather than a separate child, D-030), so this holds regardless
 *   of which format produced it, not just JSON.
 * - A node whose span *exactly* equals `[start, end)` — the edit doesn't
 *   just change this node's content, it replaces the node itself
 *   entirely, which may leave zero nodes, a differently-shaped node, or
 *   several. `parseRange` parses one range into what's still recognizably
 *   that node's own replacement; it can't represent "this node is gone."
 *   Same ambiguity `nodeContainingRange`'s own zero-width bias resolves,
 *   one level up: here the edit isn't a point touching a boundary, it
 *   spans the whole node, so the fix is scoped to this splice-specific
 *   walk rather than the shared primitive (a caller resolving a caret or
 *   selection to "exactly this element" wants the exact match, not the
 *   parent).
 *
 * Walking up is always safe for both — the parent is strictly wider, so
 * it still contains the edit — and always terminates at the root, which
 * has neither problem.
 */
function findSpliceNode(store: NodeStore, start: Offset, end: Offset): NodeRef | null {
  let node = nodeContainingRange(store, start, end)
  while (node !== null) {
    const span = store.spanOf(node)
    const mustEscalate =
      store.kindOf(node) === NodeKind.Property || (span.start === start && span.end === end)
    if (!mustEscalate) break
    const parent = store.parentOf(node)
    node = parent === NO_REF ? null : parent
  }
  return node
}

/** What `spliceSubtree` and `beginSpliceSubtree` share: everything bounded
 * by *subtree* size (never document size), computed synchronously. Split
 * out so both the synchronous graft and M5-PLAN.md H2d's chunked one
 * start from the exact same decision — a splice that would succeed
 * synchronously must succeed identically when chunked, and vice versa. */
interface DecidedSplice {
  readonly spliceNode: NodeRef
  readonly ancestors: readonly NodeRef[]
  readonly oldSpan: { readonly start: Offset; readonly end: Offset }
  readonly freshBuffers: NodeStoreBuffers
  readonly freshDiagnostics: readonly Diagnostic[]
}

type DecideOutcome = { readonly ok: true; readonly decided: DecidedSplice } | SpliceFailure

function decideSplice(request: SpliceRequest): DecideOutcome {
  if (!request.format.capabilities.canIncrementalReparse) {
    return { ok: false, reason: 'unsupported' }
  }

  const spliceNode = findSpliceNode(request.oldStore, request.dirtyStart, request.dirtyEnd)
  if (spliceNode === null) return { ok: false, reason: 'no-containing-node' }

  const oldSpan = request.oldStore.spanOf(spliceNode)
  const newSpanEnd = oldSpan.end + request.delta
  const ancestors = ancestorChain(request.oldStore, spliceNode)
  const ancestorView = buildAncestorView(
    request.oldStore,
    ancestors,
    request.newBytes,
    request.options.encoding
  )
  const context = request.format.resumeContextFor(ancestorView)

  const freshStore = new NodeStore(request.newBytes, request.interner)
  const result = request.format.parseRange(
    request.newBytes,
    oldSpan.start,
    newSpanEnd,
    freshStore,
    context,
    request.options
  )
  if (!result.complete) return { ok: false, reason: 'malformed' }
  // `parseRange`'s own completeness check is `pos <= end`, not `pos === end`
  // (formats/xml, formats/json) — `complete: true` alone doesn't guarantee
  // the fresh parse consumed the *entire* target range. The graft below
  // places the "after" segment using `newSpanEnd` computed from the old
  // store's own bookkeeping, not from where the fresh parse actually
  // stopped; if those ever disagreed, the gap would silently vanish from
  // the tree rather than surface as a diagnostic or a thrown error. Treat
  // that disagreement as the same "fall back to a full reparse" case as any
  // other malformed edit, rather than trust it can't happen.
  if (result.bytesConsumed !== newSpanEnd) return { ok: false, reason: 'malformed' }

  const freshBuffers = freshStore.exportBuffers()
  // R143: the graft below assumes the fresh parse produced exactly one
  // root — fresh ref 0 takes `spliceNode`'s own parent/sibling links, and
  // every other fresh ref is remapped relative to it. Nothing upstream of
  // this guarantees that; a `parseRange` result with a *second* top-level
  // node (an outdent that closes the target node early and opens a sibling
  // in the same range — routine in YAML, unreachable through XML/JSON/TOML
  // today) silently orphans that second node: it keeps a real span and a
  // `parent === NO_REF`, invisible to every tree walk, grid build and
  // query, with no diagnostic. `bytesConsumed === newSpanEnd` does not
  // catch this — a multi-root parse consumes the range exactly. Refusing
  // here reuses the existing `malformed` → full-reparse fallback, already
  // correct behaviour for a structure-changing edit.
  if (!isSingleRootedFresh(freshBuffers)) return { ok: false, reason: 'malformed' }

  return {
    ok: true,
    decided: {
      spliceNode,
      ancestors,
      oldSpan,
      freshBuffers,
      freshDiagnostics: freshStore.diagnostics
    }
  }
}

/** Whether every fresh ref but 0 has a parent — equivalently, ref 0's own
 * subtree covers all `freshCount` nodes `parseRange` produced. O(fresh
 * nodes), bounded by the spliced subtree's own size, never document size. */
function isSingleRootedFresh(freshBuffers: NodeStoreBuffers): boolean {
  const { parent, nodeCount } = freshBuffers
  for (let i = 1; i < nodeCount; i++) {
    if (parent[i] === NO_REF) return false
  }
  return true
}

export function spliceSubtree(request: SpliceRequest): SpliceOutcome {
  const decision = decideSplice(request)
  if (!decision.ok) return decision
  const { spliceNode, ancestors, oldSpan, freshBuffers, freshDiagnostics } = decision.decided

  const finalBuffers = graft(request.oldStore, spliceNode, ancestors, freshBuffers, request.delta)
  const finalStore = NodeStore.fromBuffers(request.newBytes, request.interner, finalBuffers)
  for (const d of mergeDiagnostics(
    request.oldStore.diagnostics,
    oldSpan,
    request.delta,
    freshDiagnostics
  )) {
    finalStore.diagnostic(d)
  }

  return { ok: true, store: finalStore }
}

export type BeginSpliceOutcome =
  SpliceFailure | { readonly ok: true; readonly job: SearchJob<NodeStore> }

/**
 * M5-PLAN.md H2d — the chunked counterpart to `spliceSubtree`. The decide
 * phase (`decideSplice`, above) is identical and still runs synchronously
 * — bounded by the edited subtree's own size, never document size, so
 * `runReparse` still learns "splice or full reparse" immediately, exactly
 * as the synchronous path does. Only the graft — the O(document) "after"
 * segment copy — yields, via `graftChunked` below.
 */
export function beginSpliceSubtree(request: SpliceRequest): BeginSpliceOutcome {
  const decision = decideSplice(request)
  if (!decision.ok) return decision
  return { ok: true, job: graftChunked(request, decision.decided) }
}

/** Batch size for the chunked "after" segment loops — large enough that
 * `runChunkedJob`'s own per-slice `performance.now()` check isn't called
 * once per node (a few thousand simple typed-array assignments cost
 * nowhere near a slice budget), small enough that a slice's actual elapsed
 * time is still checked well within `DEFAULT_SLICE_MS`, not overshot by a
 * whole batch's worth of work past it. Not derived from a measurement —
 * a starting guess in the same spirit as `DEFAULT_UNDO_MAX_DEPTH`. */
const GRAFT_BATCH_SIZE = 4096

type GraftPhase =
  { readonly phase: 'nodes'; readonly i: number } | { readonly phase: 'attrs'; readonly i: number }

/**
 * Builds the same `NodeStoreBuffers` shape `graft` does — same three
 * segments, same remapping rules — but only the cheap parts (bounded by
 * ancestor depth or by the edited subtree's own size) run synchronously
 * here. The "after" segment — every ref and span past the edit, shifted by
 * a constant — is the O(document) part (`graft`'s own doc comment), and is
 * the only part run through `runChunkedJob`.
 *
 * **The swap stays atomic by construction**: every array allocated here is
 * fresh, never a view into the live store, so the store being edited keeps
 * rendering unchanged for the whole duration of this job — nothing is
 * partially visible. `NodeStore.fromBuffers` only runs once the job
 * resolves, and only the caller's own `applyReparseResult`-equivalent
 * commit point ever makes the result visible.
 */
function graftChunked(request: SpliceRequest, decided: DecidedSplice): SearchJob<NodeStore> {
  const { oldStore, delta } = request
  const { spliceNode, ancestors, freshBuffers } = decided

  const oldBuffers = oldStore.exportBuffers()
  const boundary = subtreeEndRef(oldStore, spliceNode)
  const oldSubtreeCount = boundary - spliceNode
  const freshCount = freshBuffers.nodeCount
  const refDelta = freshCount - oldSubtreeCount

  const beforeCount = spliceNode
  const afterCount = oldBuffers.nodeCount - boundary
  const totalCount = beforeCount + freshCount + afterCount

  const kind = new Uint8Array(totalCount)
  const nameId = new Int32Array(totalCount)
  const valueStart = new Int32Array(totalCount)
  const valueEnd = new Int32Array(totalCount)
  const spanStart = new Int32Array(totalCount)
  const spanEnd = new Int32Array(totalCount)
  const parent = new Int32Array(totalCount)
  const firstChild = new Int32Array(totalCount)
  const nextSibling = new Int32Array(totalCount)
  const prevSibling = new Int32Array(totalCount)
  const flags = new Uint8Array(totalCount)

  // --- before segment: bulk-copied verbatim (native memcpy, not the O(document)
  // per-element cost this task chunks), then the same ancestor patch `graft`
  // makes. See `graft`'s own comments for why this is correct. ---
  kind.set(oldBuffers.kind.subarray(0, beforeCount), 0)
  nameId.set(oldBuffers.nameId.subarray(0, beforeCount), 0)
  valueStart.set(oldBuffers.valueStart.subarray(0, beforeCount), 0)
  valueEnd.set(oldBuffers.valueEnd.subarray(0, beforeCount), 0)
  spanStart.set(oldBuffers.spanStart.subarray(0, beforeCount), 0)
  spanEnd.set(oldBuffers.spanEnd.subarray(0, beforeCount), 0)
  parent.set(oldBuffers.parent.subarray(0, beforeCount), 0)
  firstChild.set(oldBuffers.firstChild.subarray(0, beforeCount), 0)
  nextSibling.set(oldBuffers.nextSibling.subarray(0, beforeCount), 0)
  prevSibling.set(oldBuffers.prevSibling.subarray(0, beforeCount), 0)
  flags.set(oldBuffers.flags.subarray(0, beforeCount), 0)

  for (const ancestor of ancestors) {
    spanEnd[ancestor] = oldBuffers.spanEnd[ancestor]! + delta
    const oldAncestorNextSibling = oldBuffers.nextSibling[ancestor]!
    nextSibling[ancestor] =
      oldAncestorNextSibling === NO_REF ? NO_REF : oldAncestorNextSibling + refDelta
  }

  // --- the freshly-parsed replacement, renumbered by +spliceNode — bounded
  // by the edited subtree's own size, not document size. ---
  function remapFresh(ref: number): number {
    return ref === NO_REF ? NO_REF : ref + spliceNode
  }
  for (let i = 0; i < freshCount; i++) {
    const dest = spliceNode + i
    kind[dest] = freshBuffers.kind[i]!
    nameId[dest] = freshBuffers.nameId[i]!
    valueStart[dest] = freshBuffers.valueStart[i]!
    valueEnd[dest] = freshBuffers.valueEnd[i]!
    spanStart[dest] = freshBuffers.spanStart[i]!
    spanEnd[dest] = freshBuffers.spanEnd[i]!
    parent[dest] = remapFresh(freshBuffers.parent[i]!)
    firstChild[dest] = remapFresh(freshBuffers.firstChild[i]!)
    nextSibling[dest] = remapFresh(freshBuffers.nextSibling[i]!)
    prevSibling[dest] = remapFresh(freshBuffers.prevSibling[i]!)
    flags[dest] = freshBuffers.flags[i]!
  }
  parent[spliceNode] = oldBuffers.parent[spliceNode]!
  prevSibling[spliceNode] = oldBuffers.prevSibling[spliceNode]!
  const oldNextSibling = oldBuffers.nextSibling[spliceNode]!
  nextSibling[spliceNode] = oldNextSibling === NO_REF ? NO_REF : oldNextSibling + refDelta

  // --- attributes: before + fresh segments, same reasoning as the node
  // arrays above — bulk copy plus a subtree-bounded loop, both cheap. ---
  const oldAttrBeforeEnd = attrLowerBound(oldBuffers.attrOwner, spliceNode)
  const oldAttrAfterStart = attrLowerBound(oldBuffers.attrOwner, boundary)
  const afterAttrCount = oldBuffers.attrCount - oldAttrAfterStart
  const totalAttrCount = oldAttrBeforeEnd + freshBuffers.attrCount + afterAttrCount

  const attrOwner = new Int32Array(totalAttrCount)
  const attrNameId = new Int32Array(totalAttrCount)
  const attrValueStart = new Int32Array(totalAttrCount)
  const attrValueEnd = new Int32Array(totalAttrCount)

  attrOwner.set(oldBuffers.attrOwner.subarray(0, oldAttrBeforeEnd), 0)
  attrNameId.set(oldBuffers.attrNameId.subarray(0, oldAttrBeforeEnd), 0)
  attrValueStart.set(oldBuffers.attrValueStart.subarray(0, oldAttrBeforeEnd), 0)
  attrValueEnd.set(oldBuffers.attrValueEnd.subarray(0, oldAttrBeforeEnd), 0)

  for (let i = 0; i < freshBuffers.attrCount; i++) {
    const dest = oldAttrBeforeEnd + i
    attrOwner[dest] = freshBuffers.attrOwner[i]! + spliceNode
    attrNameId[dest] = freshBuffers.attrNameId[i]!
    attrValueStart[dest] = freshBuffers.attrValueStart[i]!
    attrValueEnd[dest] = freshBuffers.attrValueEnd[i]!
  }

  // --- the O(document) part: every ref/span past the edit, shifted by a
  // constant. Chunked — this is what H2d exists for. ---
  function remapAfter(ref: number): number {
    if (ref === NO_REF) return NO_REF
    return ref < boundary ? ref : ref + refDelta
  }
  function shiftIfSet(value: number): number {
    return value === NO_VALUE ? NO_VALUE : value + delta
  }

  const innerJob = runChunkedJob<GraftPhase, void>({ phase: 'nodes', i: 0 }, (state) => {
    if (state.phase === 'nodes') {
      if (state.i >= afterCount) return { done: false, state: { phase: 'attrs', i: 0 } }
      const end = Math.min(state.i + GRAFT_BATCH_SIZE, afterCount)
      for (let idx = state.i; idx < end; idx++) {
        const src = boundary + idx
        const dest = spliceNode + freshCount + idx
        kind[dest] = oldBuffers.kind[src]!
        nameId[dest] = oldBuffers.nameId[src]!
        valueStart[dest] = shiftIfSet(oldBuffers.valueStart[src]!)
        valueEnd[dest] = shiftIfSet(oldBuffers.valueEnd[src]!)
        spanStart[dest] = oldBuffers.spanStart[src]! + delta
        spanEnd[dest] = oldBuffers.spanEnd[src]! + delta
        parent[dest] = remapAfter(oldBuffers.parent[src]!)
        firstChild[dest] = remapAfter(oldBuffers.firstChild[src]!)
        nextSibling[dest] = remapAfter(oldBuffers.nextSibling[src]!)
        prevSibling[dest] = remapAfter(oldBuffers.prevSibling[src]!)
        flags[dest] = oldBuffers.flags[src]!
      }
      return { done: false, state: { phase: 'nodes', i: end } }
    }

    if (state.i >= afterAttrCount) return { done: true, value: undefined }
    const end = Math.min(state.i + GRAFT_BATCH_SIZE, afterAttrCount)
    for (let idx = state.i; idx < end; idx++) {
      const src = oldAttrAfterStart + idx
      const dest = oldAttrBeforeEnd + freshBuffers.attrCount + idx
      attrOwner[dest] = oldBuffers.attrOwner[src]! + refDelta
      attrNameId[dest] = oldBuffers.attrNameId[src]!
      attrValueStart[dest] = oldBuffers.attrValueStart[src]! + delta
      attrValueEnd[dest] = oldBuffers.attrValueEnd[src]! + delta
    }
    return { done: false, state: { phase: 'attrs', i: end } }
  })

  const result = innerJob.result.then((): NodeStore => {
    const finalBuffers: NodeStoreBuffers = {
      kind,
      nameId,
      valueStart,
      valueEnd,
      spanStart,
      spanEnd,
      parent,
      firstChild,
      nextSibling,
      prevSibling,
      flags,
      attrOwner,
      attrNameId,
      attrValueStart,
      attrValueEnd,
      nodeCount: totalCount,
      attrCount: totalAttrCount
    }
    const finalStore = NodeStore.fromBuffers(request.newBytes, request.interner, finalBuffers)
    for (const d of mergeDiagnostics(
      request.oldStore.diagnostics,
      decided.oldSpan,
      delta,
      decided.freshDiagnostics
    )) {
      finalStore.diagnostic(d)
    }
    return finalStore
  })

  return { result, cancel: () => innerJob.cancel() }
}
