import {
  DIAGNOSTICS_CAPPED_CODE,
  DIAGNOSTIC_CAP_PER_CODE,
  DiagnosticIndex
} from './diagnosticIndex'
import { Severity, type Diagnostic, type NodeRef, type NodeSink, type Offset } from './types'
import { NodeKind } from './types'
import type { Interner } from './interner'

const INITIAL_CAPACITY = 1024

/**
 * "Absent" sentinels. `-1` rather than `0` or `spanStart`, so an array element
 * (no name) or a childless leaf (no value) is never confusable with "empty at
 * offset 0" — B12's span-containment invariant and `valueOf` both depend on
 * this being unambiguous.
 */
const NO_REF: NodeRef = -1
const NO_NAME = -1
const NO_VALUE = -1

export const enum NodeFlags {
  HasAttributes = 1 << 0,
  IsAlias = 1 << 1, // reserved for TOML/YAML anchors — unused by XML/JSON
  IsCData = 1 << 2,
  IsMixed = 1 << 3,
  DroppedWhitespace = 1 << 4,
  SubtreeComplete = 1 << 5
}

interface OpenFrame {
  node: NodeRef
  lastChild: NodeRef
  childOpened: boolean
  sawTextChild: boolean
  sawNonTextChild: boolean
  sawEmptyValue: boolean
}

export interface Span {
  readonly start: Offset
  readonly end: Offset
}

export interface AttributeRef {
  readonly nameId: number
  readonly valueStart: Offset
  readonly valueEnd: Offset
}

/** The node store's backing arrays, trimmed to their used length — see
 * `exportBuffers`/`fromBuffers`, the two halves of a worker transfer. */
export interface NodeStoreBuffers {
  kind: Uint8Array
  nameId: Int32Array
  valueStart: Int32Array
  valueEnd: Int32Array
  spanStart: Int32Array
  spanEnd: Int32Array
  parent: Int32Array
  firstChild: Int32Array
  nextSibling: Int32Array
  prevSibling: Int32Array
  flags: Uint8Array
  attrOwner: Int32Array
  attrNameId: Int32Array
  attrValueStart: Int32Array
  attrValueEnd: Int32Array
  nodeCount: number
  attrCount: number
}

/**
 * The parallel-array node store from CONCEPT.md §3.2. Implements NodeSink so
 * parsers can push directly into it; nothing here is an object-per-node.
 */
export class NodeStore implements NodeSink {
  private kindArr: Uint8Array
  private nameIdArr: Int32Array
  private valueStartArr: Int32Array
  private valueEndArr: Int32Array
  private spanStartArr: Int32Array
  private spanEndArr: Int32Array
  private parentArr: Int32Array
  private firstChildArr: Int32Array
  private nextSiblingArr: Int32Array
  private prevSiblingArr: Int32Array
  private flagsArr: Uint8Array
  private count = 0

  private attrOwnerArr: Int32Array
  private attrNameIdArr: Int32Array
  private attrValueStartArr: Int32Array
  private attrValueEndArr: Int32Array
  private attrCount = 0

  private readonly stack: OpenFrame[] = []

  /** The *retained* diagnostic records — bounded at `DIAGNOSTIC_CAP_PER_CODE`
   * per code (R200 §5). The positions of the ones that were not retained are
   * still recorded, in `diagnosticIndex_`. */
  private readonly diagnosticList: Diagnostic[] = []
  /** How many of each code have been retained so far. The cap is per code so
   * that a flood of one kind cannot push out the handful of another. */
  private readonly retainedByCode = new Map<string, number>()
  /** Every diagnostic's position and severity, uncapped. */
  private diagnosticIndex_ = new DiagnosticIndex()
  /** `diagnostics`' cached return value. Consumers memoize on its identity
   * (`Scrubber.tsx`), so it must not be a fresh array per read; invalidated
   * by `diagnostic()` and `adoptDiagnostics()`. */
  private diagnosticsView: readonly Diagnostic[] | null = null
  private lastProgress = 0

  /**
   * `source` is the buffer being parsed. `openNode`/`attribute` receive only
   * byte offsets (types.ts: parsers "never decode text"), so the sink that
   * owns the intern table must also hold the bytes those offsets index into.
   */
  constructor(
    private readonly source: Uint8Array,
    private readonly interner_: Interner,
    initialCapacity = INITIAL_CAPACITY,
    /**
     * Called from `progress()` in addition to recording it locally — lets
     * the worker relay progress to the main thread without wrapping the
     * store in a forwarding NodeSink, which cost 21% of parse time by
     * turning the hottest call site into a closure hop (C4).
     */
    private readonly onProgress?: (bytesConsumed: Offset) => void
  ) {
    this.kindArr = new Uint8Array(initialCapacity)
    this.nameIdArr = new Int32Array(initialCapacity)
    this.valueStartArr = new Int32Array(initialCapacity)
    this.valueEndArr = new Int32Array(initialCapacity)
    this.spanStartArr = new Int32Array(initialCapacity)
    this.spanEndArr = new Int32Array(initialCapacity)
    this.parentArr = new Int32Array(initialCapacity)
    this.firstChildArr = new Int32Array(initialCapacity)
    this.nextSiblingArr = new Int32Array(initialCapacity)
    this.prevSiblingArr = new Int32Array(initialCapacity)
    this.flagsArr = new Uint8Array(initialCapacity)

    this.attrOwnerArr = new Int32Array(initialCapacity)
    this.attrNameIdArr = new Int32Array(initialCapacity)
    this.attrValueStartArr = new Int32Array(initialCapacity)
    this.attrValueEndArr = new Int32Array(initialCapacity)
  }

  // ---------------------------------------------------------------------
  // NodeSink
  // ---------------------------------------------------------------------

  openNode(kind: NodeKind, spanStart: Offset, nameStart: Offset, nameEnd: Offset): NodeRef {
    const node = this.count
    this.growNodesIfNeeded(node + 1)
    this.count++

    this.kindArr[node] = kind
    this.nameIdArr[node] =
      nameStart === nameEnd ? NO_NAME : this.interner_.intern(this.source, nameStart, nameEnd)
    this.valueStartArr[node] = NO_VALUE
    this.valueEndArr[node] = NO_VALUE
    this.spanStartArr[node] = spanStart
    this.spanEndArr[node] = NO_VALUE
    this.parentArr[node] = NO_REF
    this.firstChildArr[node] = NO_REF
    this.nextSiblingArr[node] = NO_REF
    this.prevSiblingArr[node] = NO_REF
    this.flagsArr[node] = kind === NodeKind.CData ? NodeFlags.IsCData : 0

    const parentFrame = this.stack[this.stack.length - 1]
    if (parentFrame !== undefined) {
      const parent = parentFrame.node
      this.parentArr[node] = parent
      parentFrame.childOpened = true
      if (kind === NodeKind.Text || kind === NodeKind.CData) {
        parentFrame.sawTextChild = true
      } else {
        parentFrame.sawNonTextChild = true
      }

      if (parentFrame.lastChild === NO_REF) {
        this.firstChildArr[parent] = node
      } else {
        this.nextSiblingArr[parentFrame.lastChild] = node
        this.prevSiblingArr[node] = parentFrame.lastChild
      }
      parentFrame.lastChild = node
    }

    this.stack.push({
      node,
      lastChild: NO_REF,
      childOpened: false,
      sawTextChild: false,
      sawNonTextChild: false,
      sawEmptyValue: false
    })
    return node
  }

  attribute(nameStart: Offset, nameEnd: Offset, valueStart: Offset, valueEnd: Offset): void {
    const frame = this.stack[this.stack.length - 1]
    if (frame === undefined) {
      throw new Error('attribute() called with no open node')
    }
    if (import.meta.env?.DEV && frame.childOpened) {
      throw new Error('attribute() called after a child node was opened')
    }

    const index = this.attrCount
    this.growAttrsIfNeeded(index + 1)
    this.attrCount++

    this.attrOwnerArr[index] = frame.node
    this.attrNameIdArr[index] = this.interner_.intern(this.source, nameStart, nameEnd)
    this.attrValueStartArr[index] = valueStart
    this.attrValueEndArr[index] = valueEnd

    this.flagsArr[frame.node]! |= NodeFlags.HasAttributes
  }

  /**
   * A zero-length, non-sentinel span (`start === end`, both !== -1) is how a
   * parser signals "insignificant whitespace was seen here and dropped"
   * (B9's XML text rules) without a dedicated NodeSink method — there is no
   * way to pass that intent otherwise. Whether it turns out to mean that, or
   * a genuinely empty leaf value, isn't decidable here: dropped whitespace
   * can precede a node's first child as easily as follow its last, so the
   * node's final composite-or-leaf shape isn't known until `closeNode`. This
   * records the value tentatively and `closeNode` reconciles it.
   */
  value(valueStart: Offset, valueEnd: Offset): void {
    const frame = this.stack[this.stack.length - 1]
    if (frame === undefined) {
      throw new Error('value() called with no open node')
    }
    if (valueStart === valueEnd) frame.sawEmptyValue = true
    this.valueStartArr[frame.node] = valueStart
    this.valueEndArr[frame.node] = valueEnd
  }

  closeNode(node: NodeRef, spanEnd: Offset): void {
    const frame = this.stack[this.stack.length - 1]
    if (import.meta.env?.DEV && (frame === undefined || frame.node !== node)) {
      throw new Error(
        `closeNode(${node}) does not match innermost open node (${frame?.node ?? 'none'})`
      )
    }
    this.stack.pop()
    this.spanEndArr[node] = spanEnd
    if (frame!.childOpened) {
      // Composite after all: any tentative value() was whitespace-between-
      // children signalling, not a real value — a composite node has none.
      this.valueStartArr[node] = NO_VALUE
      this.valueEndArr[node] = NO_VALUE
      if (frame!.sawEmptyValue) this.flagsArr[node]! |= NodeFlags.DroppedWhitespace
    }
    if (frame!.sawTextChild && frame!.sawNonTextChild) {
      this.flagsArr[node]! |= NodeFlags.IsMixed
    }
    this.flagsArr[node]! |= NodeFlags.SubtreeComplete
  }

  /**
   * Records the position always, the record itself only while this code is
   * under its budget (R200 §5). Never rejects a diagnostic outright: a
   * suppressed one still reaches the scrubber and still counts towards the
   * status bar's totals, because both read `diagnosticIndex_` rather than
   * the list.
   *
   * The message string is already built by the time this is called —
   * `ParserState.emit` takes an interpolated template — and that is
   * deliberate rather than overlooked: those strings are immediately
   * unreachable garbage, whereas the *retained* objects are what exhaust
   * memory. R200 §6 is explicit that bounded retention is the requirement and
   * that contorting twenty call sites into message thunks is not.
   */
  diagnostic(d: Diagnostic): void {
    this.diagnosticIndex_.add(d.severity, d.offset)
    this.retainRecord(d)
    this.diagnosticsView = null
  }

  private retainRecord(d: Diagnostic): void {
    const retained = this.retainedByCode.get(d.code) ?? 0
    if (retained >= DIAGNOSTIC_CAP_PER_CODE) return
    this.retainedByCode.set(d.code, retained + 1)
    this.diagnosticList.push(d)
  }

  /**
   * Replaces this store's whole diagnostic state at once — both halves
   * together, which is the point of the signature. The two callers each
   * rebuild a store rather than parse into one: `parseClient.ts` rehydrating
   * a worker's response, and `subtreeSplice.ts` grafting a reparsed subtree.
   *
   * R209 is why this takes both rather than offering a setter per half: the
   * namespace state it removed was derived state every store-rebuilding path
   * had to hand-carry, and *both* such paths got it wrong. One required
   * parameter pair is the smallest thing that makes forgetting a half a type
   * error.
   */
  adoptDiagnostics(list: readonly Diagnostic[], index: DiagnosticIndex): void {
    this.diagnosticList.length = 0
    this.retainedByCode.clear()
    this.diagnosticIndex_ = index
    for (const d of list) {
      // Regenerated from `index` on read, so carrying the old one would
      // double-count it and pin a stale number.
      if (d.code === DIAGNOSTICS_CAPPED_CODE) continue
      this.retainRecord(d)
    }
    this.diagnosticsView = null
  }

  progress(bytesConsumed: Offset): void {
    this.lastProgress = bytesConsumed
    this.onProgress?.(bytesConsumed)
  }

  // ---------------------------------------------------------------------
  // Read accessors
  // ---------------------------------------------------------------------

  get nodeCount(): number {
    return this.count
  }

  /** The `Interner` this store interns names into. Exposed so a caller
   * doing subtree splicing (M3-PLAN.md F4) can parse a replacement
   * subtree against the *same* table — `Interner.intern` is content-based
   * (hashes bytes, not identity), so reusing it is what makes a name's id
   * portable between the old store and the freshly-parsed one without any
   * remapping. */
  get interner(): Interner {
    return this.interner_
  }

  /** The length of what `diagnostics` returns — the retained records plus the
   * summary entry, not the true number the document produced.
   * `diagnosticIndex.total` is that. */
  get diagnosticCount(): number {
    return this.diagnostics.length
  }

  /**
   * The navigable records: everything retained, plus one synthesized entry
   * naming how many were not, whenever anything was suppressed.
   *
   * The summary sits at offset 0 with length 0 on purpose. R200 §3's argument
   * is that a `Diagnostic` carries an offset because it is a statement about
   * a *position* — so an entry that is a statement about the *file* has none
   * to claim, and pointing it at the first suppressed site would invite a
   * reader to treat that site as special when it is only the first one past a
   * budget. It is a Warning regardless of what was suppressed, for the same
   * reason: it is not itself a problem in the document, and the true
   * per-severity totals sit on the status bar beside it, read from
   * `diagnosticIndex`.
   */
  get diagnostics(): readonly Diagnostic[] {
    if (this.diagnosticsView === null) {
      const suppressed = this.diagnosticIndex_.total - this.diagnosticList.length
      this.diagnosticsView =
        suppressed <= 0
          ? this.diagnosticList
          : [
              ...this.diagnosticList,
              {
                severity: Severity.Warning,
                code: DIAGNOSTICS_CAPPED_CODE,
                offset: 0,
                length: 0,
                message:
                  `${suppressed.toLocaleString()} further diagnostic(s) are not listed — at most ` +
                  `${DIAGNOSTIC_CAP_PER_CODE} are kept per problem kind. Every one of them is ` +
                  `still counted, and still marked on the scrubber.`
              }
            ]
    }
    return this.diagnosticsView
  }

  /** Every diagnostic's position and severity, uncapped — what the scrubber
   * buckets and what the status bar counts. */
  get diagnosticIndex(): DiagnosticIndex {
    return this.diagnosticIndex_
  }

  get bytesProcessed(): number {
    return this.lastProgress
  }

  get attributeCount(): number {
    return this.attrCount
  }

  /** Allocated capacity of the node store's arrays, in bytes. Can run up to
   * ~2x `packedMemoryBytes` right after a doubling growth step — this is
   * capacity, not the figure the M0 done-criteria budget is measured
   * against; use `packedMemoryBytes` for that. Excludes the source buffer
   * and the interner, which are owned elsewhere. */
  get estimatedMemoryBytes(): number {
    return (
      this.kindArr.byteLength +
      this.nameIdArr.byteLength +
      this.valueStartArr.byteLength +
      this.valueEndArr.byteLength +
      this.spanStartArr.byteLength +
      this.spanEndArr.byteLength +
      this.parentArr.byteLength +
      this.firstChildArr.byteLength +
      this.nextSiblingArr.byteLength +
      this.prevSiblingArr.byteLength +
      this.flagsArr.byteLength +
      this.attrOwnerArr.byteLength +
      this.attrNameIdArr.byteLength +
      this.attrValueStartArr.byteLength +
      this.attrValueEndArr.byteLength
    )
  }

  /** Tightly-packed size in bytes — `nodeCount`/`attributeCount` elements
   * per column, not the arrays' possibly-doubled allocated capacity. This is
   * the node store plus attribute table figure the M0 done-criteria budget
   * (§ "under 320 MB") is actually measured against. */
  get packedMemoryBytes(): number {
    const perNode = 2 + 9 * 4 // kind/flags: 2 x Uint8, 9 x Int32 — 38 bytes, per §3.2
    const perAttr = 4 * 4 // attrOwner/attrNameId/attrValueStart/attrValueEnd
    return this.count * perNode + this.attrCount * perAttr
  }

  /** Trimmed copies of every backing array, for a zero-copy worker transfer
   * (B11) — `ArrayBuffer.prototype.transfer` needs its own standalone
   * buffers, not views into the (possibly oversized, doubled-capacity) ones
   * this store grows in place.
   *
   * M5-PLAN.md H2c: each column is sliced and its field reassigned
   * immediately, one at a time, rather than building all fifteen slices
   * inside one object literal — computing them together meant all fifteen
   * oversized originals and all fifteen trimmed copies were alive at once
   * (+257 MB at 200 MB, +643 MB at 500 MB, the single largest spike in the
   * open path). Reassigning as it goes means only the column currently
   * being sliced holds both; every earlier column has already dropped its
   * only reference to the oversized original, which can then be collected
   * before the next slice runs.
   *
   * **The real invariant, stated precisely rather than "discarded
   * immediately": read-only access to this store after calling this is
   * fine (every accessor is bounds-checked against `count`/`attrCount`,
   * unaffected by the trim, and the values themselves are unchanged) — a
   * *mutating* call (`openNode`, `closeNode`, `diagnostic` mid-parse, or
   * anything that would hit `growNodesIfNeeded`/`growAttrsIfNeeded`) is
   * not, or at least is not what this method was designed against.**
   * `documentSession.ts`'s `applyReparseResult` is a real example of the
   * former: it re-reads `state.document.store` (the same store `graft`
   * just called this on, via `subtreeSplice.ts`) for `reresolveSelection`
   * one more time before replacing it — read-only traversal, so correct,
   * but not "already discarded" the way this comment used to claim.
   * `growNodesIfNeeded`/`growAttrsIfNeeded` always reallocate into a *new*
   * array rather than mutate in place even when capacity is already
   * exactly `count`, so a stray mutating call afterward would not corrupt
   * an already-returned `NodeStoreBuffers` either — but nothing here
   * exists to make that a supported pattern; every real caller (the worker
   * transfer path, `subtreeSplice.ts`'s `graft`) still exports and then
   * lets the store go.
   */
  exportBuffers(): NodeStoreBuffers {
    this.kindArr = this.kindArr.slice(0, this.count)
    this.nameIdArr = this.nameIdArr.slice(0, this.count)
    this.valueStartArr = this.valueStartArr.slice(0, this.count)
    this.valueEndArr = this.valueEndArr.slice(0, this.count)
    this.spanStartArr = this.spanStartArr.slice(0, this.count)
    this.spanEndArr = this.spanEndArr.slice(0, this.count)
    this.parentArr = this.parentArr.slice(0, this.count)
    this.firstChildArr = this.firstChildArr.slice(0, this.count)
    this.nextSiblingArr = this.nextSiblingArr.slice(0, this.count)
    this.prevSiblingArr = this.prevSiblingArr.slice(0, this.count)
    this.flagsArr = this.flagsArr.slice(0, this.count)
    this.attrOwnerArr = this.attrOwnerArr.slice(0, this.attrCount)
    this.attrNameIdArr = this.attrNameIdArr.slice(0, this.attrCount)
    this.attrValueStartArr = this.attrValueStartArr.slice(0, this.attrCount)
    this.attrValueEndArr = this.attrValueEndArr.slice(0, this.attrCount)

    return {
      kind: this.kindArr,
      nameId: this.nameIdArr,
      valueStart: this.valueStartArr,
      valueEnd: this.valueEndArr,
      spanStart: this.spanStartArr,
      spanEnd: this.spanEndArr,
      parent: this.parentArr,
      firstChild: this.firstChildArr,
      nextSibling: this.nextSiblingArr,
      prevSibling: this.prevSiblingArr,
      flags: this.flagsArr,
      attrOwner: this.attrOwnerArr,
      attrNameId: this.attrNameIdArr,
      attrValueStart: this.attrValueStartArr,
      attrValueEnd: this.attrValueEndArr,
      nodeCount: this.count,
      attrCount: this.attrCount
    }
  }

  /** Reconstructs a fully queryable NodeStore from buffers produced by
   * `exportBuffers` — the far side of a worker transfer. `source` and
   * `interner` must themselves already be transferred/rebuilt.
   *
   * R209 removed a fourth parameter carrying namespace-resolution state.
   * It was optional, and `subtreeSplice.ts` omitted it — so a spliced store
   * silently reverted to raw names after any edit. That the parameter
   * *could* be omitted is what made the defect invisible; the whole
   * category is gone with the feature. */
  static fromBuffers(source: Uint8Array, interner: Interner, buffers: NodeStoreBuffers): NodeStore {
    // 1, not buffers.nodeCount: every array below is about to be overwritten
    // wholesale by the transferred buffers, so sizing the constructor's own
    // allocation at the real node count just to discard it immediately would
    // throw away ~54 bytes/node for nothing (C3).
    const store = new NodeStore(source, interner, 1)
    store.kindArr = buffers.kind
    store.nameIdArr = buffers.nameId
    store.valueStartArr = buffers.valueStart
    store.valueEndArr = buffers.valueEnd
    store.spanStartArr = buffers.spanStart
    store.spanEndArr = buffers.spanEnd
    store.parentArr = buffers.parent
    store.firstChildArr = buffers.firstChild
    store.nextSiblingArr = buffers.nextSibling
    store.prevSiblingArr = buffers.prevSibling
    store.flagsArr = buffers.flags
    store.count = buffers.nodeCount
    store.attrOwnerArr = buffers.attrOwner
    store.attrNameIdArr = buffers.attrNameId
    store.attrValueStartArr = buffers.attrValueStart
    store.attrValueEndArr = buffers.attrValueEnd
    store.attrCount = buffers.attrCount
    return store
  }

  kindOf(node: NodeRef): NodeKind {
    return this.kindArr[node]! as NodeKind
  }

  nameOf(node: NodeRef): string | null {
    const id = this.nameIdArr[node]!
    return id === NO_NAME ? null : this.interner_.text(id)
  }

  nameIdOf(node: NodeRef): number {
    return this.nameIdArr[node]!
  }

  /** Decodes any id this store interned — an attribute's `nameId` from
   * `attributesOf`, in particular, which (unlike a node's own name) has no
   * `NO_NAME` case to guard: `attribute()` only ever interns a real span. */
  textOf(id: number): string {
    return this.interner_.text(id)
  }

  parentOf(node: NodeRef): NodeRef {
    return this.parentArr[node]!
  }

  firstChildOf(node: NodeRef): NodeRef {
    return this.firstChildArr[node]!
  }

  nextSiblingOf(node: NodeRef): NodeRef {
    return this.nextSiblingArr[node]!
  }

  prevSiblingOf(node: NodeRef): NodeRef {
    return this.prevSiblingArr[node]!
  }

  spanOf(node: NodeRef): Span {
    return { start: this.spanStartArr[node]!, end: this.spanEndArr[node]! }
  }

  flagsOf(node: NodeRef): number {
    return this.flagsArr[node]!
  }

  hasFlag(node: NodeRef, flag: NodeFlags): boolean {
    return (this.flagsArr[node]! & flag) !== 0
  }

  /** The node's own value span, or absent (`null`) — never a zero-object. */
  ownValueOf(node: NodeRef): Span | null {
    const start = this.valueStartArr[node]!
    if (start === NO_VALUE) return null
    return { start, end: this.valueEndArr[node]! }
  }

  /**
   * The node's value whether folded onto itself (the common case) or held by
   * a single Text/CData child (the fallback the folding rules mostly avoid
   * needing, but a well-formed accessor should not assume never happens).
   * Callers never branch on which representation a given element used.
   */
  valueOf(node: NodeRef): Span | null {
    if (!this.isNode(node)) return null
    const own = this.ownValueOf(node)
    if (own !== null) return own

    // Same bounding as `childrenOf`: this follows links too, so it must
    // reject a ref that only looks like one. It cannot loop, but without
    // the check it would read a neighbouring node's value as this one's.
    const child = this.firstChildArr[node]
    if (!this.isNode(child) || this.nextSiblingArr[child] !== NO_REF) return null
    const childKind = this.kindArr[child]!
    if (childKind !== NodeKind.Text && childKind !== NodeKind.CData) return null
    return this.ownValueOf(child)
  }

  /** Whether `ref` addresses a node that actually exists. Bounds a link
   * walk against *both* ways a bad ref reads back: past the arrays'
   * allocated length it is `undefined` (`noUncheckedIndexedAccess` types it
   * so, and the `!` these walks used to carry asserted that away), while
   * inside the allocated-but-unused tail it is `0` — a zero-filled slot
   * indistinguishable from a genuine reference to node 0. Only `count`
   * separates the two. */
  private isNode(ref: NodeRef | undefined): ref is NodeRef {
    return ref !== undefined && ref >= 0 && ref < this.count
  }

  /**
   * Terminates on any ref that is not a node, rather than only on the
   * `NO_REF` sentinel. Both failure modes were reachable and neither was
   * benign: `undefined !== -1` and `0 !== -1` are each `true`, so a walk
   * seeded from a nonexistent ref yielded forever. Materializing that —
   * `[...store.childrenOf(n)]`, which is what a tree view does — exhausted
   * the heap instead of returning nothing. An empty store reaches it, and
   * a document refused at offset 0 produces one.
   */
  *childrenOf(node: NodeRef): Iterable<NodeRef> {
    if (!this.isNode(node)) return
    let child = this.firstChildArr[node]
    while (this.isNode(child)) {
      yield child
      child = this.nextSiblingArr[child]
    }
  }

  *attributesOf(node: NodeRef): Iterable<AttributeRef> {
    const [start, end] = this.attrRangeOf(node)
    for (let i = start; i < end; i++) {
      yield {
        nameId: this.attrNameIdArr[i]!,
        valueStart: this.attrValueStartArr[i]!,
        valueEnd: this.attrValueEndArr[i]!
      }
    }
  }

  // -------------------------------------------------------------------
  // Allocation-free attribute access (R129–R131 §7)
  // -------------------------------------------------------------------
  //
  // `attributesOf` above is the convenience accessor and stays exactly as
  // it is — most callers visit one node and want the tuple. It is the
  // wrong shape for a *predicate*, which visits every candidate: per node
  // visit it allocates the `[number, number]` tuple `attrRangeOf` returns,
  // the generator object, and one `AttributeRef` per attribute yielded.
  // R129's §7 measured that at 400,000 + 400,000 + 2,000,000 objects for a
  // single `//car[@vin="…"]` on a 75 MB corpus — ~113 ms of the 239 ms that
  // query cost, and the reason its first-attribute and last-attribute cases
  // measured the same: the cost is per node visit, not per attribute
  // compared.
  //
  // These four are the same data addressed by index instead: a half-open
  // `[attrStartOf, attrEndOf)` range and three plain array reads. Nothing
  // is allocated, so a candidate loop over them allocates nothing — which
  // is also a move *toward* invariant 2, an object per attribute visit
  // being the shape that invariant forbids one level down.

  /**
   * First index of `node`'s attribute range; `attrEndOf` is its end. When
   * the node has no attributes this is still its *position* in the table
   * (and equals `attrEndOf`), so the range is empty either way and a
   * caller's `for (let i = start; i < end; i++)` needs no separate test.
   *
   * **`from` is a lower-bound hint, and it is what makes this cheap.**
   * `attrOwner` is non-decreasing, so the answer is non-decreasing in
   * `node` too: a caller visiting candidates in ascending ref order can
   * pass the previous range's end and get a *galloping* search over the
   * gap — a handful of sequential reads — instead of a binary search over
   * the whole table. R131 measured that difference on a 2,000,000-entry
   * table: `attrStartOf` + `attrEndOf` per candidate over 400,000
   * candidates cost **43.8 ms** as two plain binary searches, which was the
   * single largest remaining cost in `//car[@vin="…"]` and larger than the
   * allocation the plan's §7 identified. The binary search is not slow
   * because of its 21 iterations; it is slow because each one is a cache
   * miss into 8 MB.
   *
   * `from` must be at or before the true answer — `0` always is, and is
   * the default. Passing a *later* index silently returns the wrong range,
   * so a caller whose walk is not ascending must reset it to `0`.
   */
  attrStartOf(node: NodeRef, from = 0): number {
    return this.gallop(node, from, false)
  }

  /** One past `node`'s last attribute index. Pass `attrStartOf`'s answer as
   * `from`: the gallop then spans only this node's own attributes, which
   * are contiguous and already in cache. */
  attrEndOf(node: NodeRef, from = 0): number {
    return this.gallop(node, from, true)
  }

  /**
   * The first index whose owner is `> owner` (`inclusive`) or `>= owner`
   * (otherwise), searched forward from a known-valid lower bound: double
   * the step until the answer is bracketed, then binary-search the bracket.
   * O(log gap) rather than O(log attrCount), and sequential over the gap.
   */
  private gallop(owner: NodeRef, from: number, inclusive: boolean): number {
    const owners = this.attrOwnerArr
    const count = this.attrCount
    // Owners are integers, so "strictly before `owner`" is "at most
    // `owner - 1`" — one comparison covers both variants, and no closure
    // is allocated to carry the choice into the loop (§9: nothing may
    // allocate per candidate).
    const limit = inclusive ? owner : owner - 1

    let lo = from > 0 ? from : 0
    if (lo >= count) return count
    if (owners[lo]! > limit) return lo

    let step = 1
    let hi = lo + 1
    while (hi < count && owners[hi]! <= limit) {
      lo = hi
      step *= 2
      hi = lo + step
    }
    if (hi > count) hi = count

    let a = lo + 1
    let b = hi
    while (a < b) {
      const mid = (a + b) >>> 1
      if (owners[mid]! <= limit) a = mid + 1
      else b = mid
    }
    return a
  }

  /** `i` is an index from `[attrStartOf, attrEndOf)`, never a `NodeRef`. */
  attrNameIdAt(i: number): number {
    return this.attrNameIdArr[i]!
  }

  attrValueStartAt(i: number): number {
    return this.attrValueStartArr[i]!
  }

  attrValueEndAt(i: number): number {
    return this.attrValueEndArr[i]!
  }

  /** The same allocation argument as the attribute accessors above, for a
   * node's own value: `ownValueOf`/`valueOf` return a `Span` object, which
   * is one allocation per candidate in a predicate loop. `NO_VALUE` (`-1`)
   * is returned rather than `null` so the caller branches on a number. */
  valueStartOf(node: NodeRef): Offset {
    return this.valueStartArr[node]!
  }

  valueEndOf(node: NodeRef): Offset {
    return this.valueEndArr[node]!
  }

  /**
   * `attrOwnerArr` is non-decreasing: `attribute()` may only target the
   * currently-open (innermost) node, and once a child opens it can no longer
   * be called for that node's ancestors — so owners never appear out of
   * order. That makes each node's attributes a contiguous, binary-searchable
   * range without a dedicated per-node index.
   */
  private attrRangeOf(node: NodeRef): [number, number] {
    if (!this.hasFlag(node, NodeFlags.HasAttributes)) return [0, 0]
    const start = this.lowerBound(node)
    const end = this.upperBound(node)
    return [start, end]
  }

  private lowerBound(owner: NodeRef): number {
    let lo = 0
    let hi = this.attrCount
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.attrOwnerArr[mid]! < owner) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private upperBound(owner: NodeRef): number {
    let lo = 0
    let hi = this.attrCount
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.attrOwnerArr[mid]! <= owner) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // ---------------------------------------------------------------------
  // Growth
  // ---------------------------------------------------------------------

  private growNodesIfNeeded(needed: number): void {
    if (needed <= this.kindArr.length) return
    let capacity = this.kindArr.length
    while (capacity < needed) capacity *= 2

    this.kindArr = growUint8(this.kindArr, capacity)
    this.nameIdArr = growInt32(this.nameIdArr, capacity)
    this.valueStartArr = growInt32(this.valueStartArr, capacity)
    this.valueEndArr = growInt32(this.valueEndArr, capacity)
    this.spanStartArr = growInt32(this.spanStartArr, capacity)
    this.spanEndArr = growInt32(this.spanEndArr, capacity)
    this.parentArr = growInt32(this.parentArr, capacity)
    this.firstChildArr = growInt32(this.firstChildArr, capacity)
    this.nextSiblingArr = growInt32(this.nextSiblingArr, capacity)
    this.prevSiblingArr = growInt32(this.prevSiblingArr, capacity)
    this.flagsArr = growUint8(this.flagsArr, capacity)
  }

  private growAttrsIfNeeded(needed: number): void {
    if (needed <= this.attrOwnerArr.length) return
    let capacity = this.attrOwnerArr.length
    while (capacity < needed) capacity *= 2

    this.attrOwnerArr = growInt32(this.attrOwnerArr, capacity)
    this.attrNameIdArr = growInt32(this.attrNameIdArr, capacity)
    this.attrValueStartArr = growInt32(this.attrValueStartArr, capacity)
    this.attrValueEndArr = growInt32(this.attrValueEndArr, capacity)
  }
}

function growInt32(arr: Int32Array, capacity: number): Int32Array {
  const grown = new Int32Array(capacity)
  grown.set(arr)
  return grown
}

function growUint8(arr: Uint8Array, capacity: number): Uint8Array {
  const grown = new Uint8Array(capacity)
  grown.set(arr)
  return grown
}
