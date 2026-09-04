import type { Diagnostic, NodeRef, NodeSink, Offset } from './types'
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
  /**
   * R134: `prefix → URI` in scope for this node, `''` keying the default
   * namespace. `undefined` when namespace tracking is off (`interner`
   * doesn't split names) or this document has declared nothing yet.
   * Shared by reference with the parent frame until this node's own
   * `xmlns`/`xmlns:*` attribute first extends it (copy-on-write) — cloning
   * on every `openNode` regardless would be per-node allocation for a
   * document that never rebinds anything, which is exactly the cost §6
   * says a namespace-free (or declaration-free) document must not pay.
   */
  nsScope: ReadonlyMap<string, string> | undefined
}

const XMLNS = 'xmlns'
/** Decodes an `xmlns`/`xmlns:*` declaration's prefix and URI text — small,
 * per-declaration decodes, not per node. UTF-8 unconditionally, matching
 * `Interner.text()`'s own existing convention (`NodeStore` has no
 * encoding of its own to decode by; `SourceBuffer`/`ParseOptions.encoding`
 * live above this layer). */
const utf8Decoder = new TextDecoder('utf-8')

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

/** R134–R136's derived namespace-resolution state, transferred alongside
 * (but separately from) `NodeStoreBuffers` — see `NodeStore.exportNamespaceState`'s
 * own doc comment for why this is a second structure rather than folded
 * into the first. */
export interface NamespaceResolutionBuffers {
  readonly anyDeclarationSeen: boolean
  readonly hasRebinding: boolean
  readonly resolvedIdArr: Int32Array
  readonly uriByResolvedId: readonly string[]
  readonly declarations: readonly { declaringNode: NodeRef; prefix: string; uri: string }[]
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
  private readonly diagnosticList: Diagnostic[] = []
  private lastProgress = 0

  // ---------------------------------------------------------------------
  // Namespace resolution (R134–R136) — active only when `interner_`
  // splits names (`FormatCapabilities.hasNamespaces`, never a format id —
  // invariant 8). See `resolvedNameIdOf`'s own doc comment for the public
  // surface; everything below is the bookkeeping that fills it in as the
  // sink descends, the "sink accumulates prefix → URI... during parse"
  // mechanism `R134-xml-namespaces.md` §3 describes.
  // ---------------------------------------------------------------------

  private readonly nsEnabled: boolean
  /** Set the moment any `xmlns`/`xmlns:*` attribute is seen anywhere —
   * gates *all* further namespace bookkeeping so a namespace-*capable*
   * format that a given document simply doesn't use (an XML file with no
   * declarations) pays only this one flag check per node, not a resolution
   * per node (§6's regression requirement). */
  private nsAnyDeclarationSeen = false
  /** `nameId → resolved id` — the common-case O(1) answer, filled in once
   * per distinct name at `closeNode` (never per node beyond the one flag
   * check above). `-1` = not yet resolved for this id. Grown lazily,
   * parallel to nothing else here since it is indexed by `nameId`, not by
   * node ref. */
  private nsResolvedIdArr: Int32Array = new Int32Array(0)
  private readonly nsResolvedKeyToId = new Map<string, number>()
  private nsNextResolvedId = 0
  /** `resolvedId → URI text`, indexed in step with `nsResolvedKeyToId` —
   * R136's column tooltip needs the URI string a resolved id stands for,
   * not just the id itself. Sized with the resolved-id space, which §
   * "headline" already sizes at kilobytes. */
  private readonly nsUriByResolvedId: string[] = []
  /** Doc-wide `prefix → URI`, kept only to notice a *second*, different
   * URI for a prefix already seen — R135's trigger for the scope table. */
  private readonly nsPrefixLastUri = new Map<string, string>()
  private nsHasRebinding = false
  /** One row per `xmlns`/`xmlns:*` declaration actually seen, `endRef`
   * filled in lazily (`declarationEndRef`) since a declaring node's own
   * subtree isn't known to be complete until later siblings exist —
   * R135's scope table, in source form. Never consulted unless
   * `nsHasRebinding` is true; a document that never rebinds pays for this
   * array (proportional to *declaration* count, not node count — "a few
   * hundred on a schema-driven document" per §"headline") but never pays
   * for a materialized lookup table, which is the thing R135's acceptance
   * 3 asserts is absent. */
  private readonly nsDeclarations: { declaringNode: NodeRef; prefix: string; uri: string }[] = []

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

    this.nsEnabled = interner_.splitsNamespaces
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
      sawEmptyValue: false,
      // Inherited by reference (copy-on-write) — see the field's own doc
      // comment on `OpenFrame`.
      nsScope: parentFrame?.nsScope
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

    if (this.nsEnabled)
      this.recordNamespaceDeclaration(frame, nameStart, nameEnd, valueStart, valueEnd)
  }

  /**
   * `xmlns="…"` / `xmlns:prefix="…"` — recognized by comparing raw bytes
   * against `this.source`, the same technique `formats/xml/index.ts`'s own
   * `resumeContextFor` uses, just done forward during a real parse instead
   * of reconstructed afterward from ancestors (R134 §3, item 2). An
   * ordinary attribute costs one short byte comparison; only an actual
   * `xmlns...` name pays for decoding — the "kilobytes, per distinct
   * declaration" cost model, not "per attribute."
   */
  private recordNamespaceDeclaration(
    frame: OpenFrame,
    nameStart: Offset,
    nameEnd: Offset,
    valueStart: Offset,
    valueEnd: Offset
  ): void {
    const nameLength = nameEnd - nameStart
    if (nameLength < XMLNS.length) return
    for (let i = 0; i < XMLNS.length; i++) {
      if (this.source[nameStart + i] !== XMLNS.charCodeAt(i)) return
    }
    let prefix: string
    if (nameLength === XMLNS.length) {
      prefix = '' // xmlns="…" — the default namespace
    } else if (
      this.source[nameStart + XMLNS.length] === 0x3a /* ':' */ &&
      nameLength > XMLNS.length + 1
    ) {
      // `nameLength > XMLNS.length + 1` rules out the malformed `xmlns:`
      // (nothing after the colon) — without it, `prefix` would decode to
      // `''` and silently collide with the default-namespace key above,
      // corrupting `xmlns="…"` resolution with a malformed attribute.
      prefix = utf8Decoder.decode(this.source.subarray(nameStart + XMLNS.length + 1, nameEnd))
    } else {
      return // e.g. an attribute literally named "xmlnsfoo", or bare "xmlns:" — not a declaration
    }
    const uri = utf8Decoder.decode(this.source.subarray(valueStart, valueEnd))

    this.nsAnyDeclarationSeen = true
    const scope = new Map(frame.nsScope ?? [])
    scope.set(prefix, uri)
    frame.nsScope = scope

    this.nsDeclarations.push({ declaringNode: frame.node, prefix, uri })
    const previousUri = this.nsPrefixLastUri.get(prefix)
    if (previousUri !== undefined && previousUri !== uri) this.nsHasRebinding = true
    this.nsPrefixLastUri.set(prefix, uri)
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

    // R134: by `closeNode`, every one of this node's own attributes —
    // including any `xmlns`/`xmlns:*` it carries itself — has already been
    // seen (`attribute()` may only target the innermost open node, and
    // this frame is about to be popped), so its scope is final. Skipped
    // entirely when nothing in the whole document has declared a
    // namespace yet — the one-flag-check cost §6 requires of a
    // declaration-free document.
    if (this.nsEnabled && this.nsAnyDeclarationSeen) this.finalizeNamespace(node, frame!.nsScope)
  }

  /**
   * Resolves `node`'s own element name to a small "resolved id" — the
   * document-wide `(URI, localName)` identity R134 §3 describes — and
   * caches it in `nsResolvedIdArr[nameId]`. Composite keys are plain JS
   * strings (`uri + ' ' + local`) in a `Map`, not a second pass
   * through `interner_`: the resolved-id space is small (distinct
   * `(URI, local)` pairs, "kilobytes" per the plan's own sizing) and
   * reusing the *document's* interner for it would mix synthetic
   * resolution keys into the same id space real node/attribute names live
   * in, for no benefit.
   *
   * A name resolving differently than it did on an earlier occurrence
   * (same raw spelling, different active URI — only reachable once a
   * prefix has genuinely rebound) is the one case `nsResolvedIdArr`
   * *cannot* represent, since it is one slot per raw name, not per
   * occurrence: `resolvedNameIdOf` detects this via `nsHasRebinding` and
   * falls back to `resolveNamespaceLive`, which is position-aware.
   */
  private finalizeNamespace(node: NodeRef, scope: ReadonlyMap<string, string> | undefined): void {
    const nameId = this.nameIdArr[node]!
    if (nameId === NO_NAME) return
    const resolvedId = this.resolveNamespaceKey(nameId, scope)
    this.ensureResolvedIdCapacity(nameId + 1)
    this.nsResolvedIdArr[nameId] = resolvedId
  }

  /** The resolved id for `nameId` under `scope` — shared by the parse-time
   * fast path (`finalizeNamespace`) and the post-parse rebinding fallback
   * (`resolveNamespaceLive`), so both ultimately agree with whatever a
   * fresh resolution of the same `(nameId, scope)` pair would produce. */
  private resolveNamespaceKey(
    nameId: number,
    scope: ReadonlyMap<string, string> | undefined
  ): number {
    const prefix = this.interner_.prefixOf(nameId)
    // XML 1.0: an unprefixed *element* name inherits the default (`xmlns`)
    // binding; a prefixed name resolves its own prefix. There is no
    // "default namespace for attributes" — but this method only ever
    // resolves element names (R136's only consumer), so that attribute
    // rule has nothing to apply to here and is not encoded.
    const uri = scope?.get(prefix ?? '') ?? ''
    const local = prefix !== null ? this.interner_.localNameOf(nameId) : this.interner_.text(nameId)
    const key = `${uri} ${local}`
    let resolvedId = this.nsResolvedKeyToId.get(key)
    if (resolvedId === undefined) {
      resolvedId = this.nsNextResolvedId++
      this.nsResolvedKeyToId.set(key, resolvedId)
      this.nsUriByResolvedId[resolvedId] = uri
    }
    return resolvedId
  }

  private ensureResolvedIdCapacity(needed: number): void {
    if (needed <= this.nsResolvedIdArr.length) return
    let capacity = Math.max(this.nsResolvedIdArr.length, 1)
    while (capacity < needed) capacity *= 2
    const grown = new Int32Array(capacity).fill(-1)
    grown.set(this.nsResolvedIdArr)
    this.nsResolvedIdArr = grown
  }

  diagnostic(d: Diagnostic): void {
    this.diagnosticList.push(d)
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

  get diagnosticCount(): number {
    return this.diagnosticList.length
  }

  get diagnostics(): readonly Diagnostic[] {
    return this.diagnosticList
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

  /**
   * The namespace resolution state (R134–R136) computed live during a real
   * parse — everything `resolvedNameIdOf`/`namespaceUriOf`/
   * `hasNamespaceRebinding` need, none of which lives in `NodeStoreBuffers`
   * (those are the tree's own shape; this is derived, per-name/per-
   * declaration data). Small by construction: `resolvedIdArr` is sized by
   * distinct interned names, `uriByResolvedId` by distinct resolved
   * `(URI, local)` pairs, `declarations` by actual `xmlns` attributes —
   * every one of those is the "kilobytes, not megabytes" quantity R134's
   * own headline measured, not the node count.
   */
  exportNamespaceState(): NamespaceResolutionBuffers {
    return {
      anyDeclarationSeen: this.nsAnyDeclarationSeen,
      hasRebinding: this.nsHasRebinding,
      resolvedIdArr: this.nsResolvedIdArr.slice(0, this.interner_.size),
      uriByResolvedId: this.nsUriByResolvedId.slice(),
      declarations: this.nsDeclarations.slice()
    }
  }

  /** Rehydrates namespace state exported by `exportNamespaceState` — a
   * worker transfer's own far side, same as `fromBuffers` is for the tree
   * itself, but namespace state lives outside `NodeStoreBuffers` (see that
   * method's own doc comment) and so needs its own restore step, called
   * separately by `fromBuffers`'s own callers that pass it. `nsNextResolvedId`
   * resumes *after* the transferred ids, not from 0 — a later live
   * resolution (R135's rebinding fallback, position-aware and therefore
   * never cached across a transfer) must never mint an id that collides
   * with one already baked into `resolvedIdArr`. */
  private importNamespaceState(state: NamespaceResolutionBuffers): void {
    this.nsAnyDeclarationSeen = state.anyDeclarationSeen
    this.nsHasRebinding = state.hasRebinding
    this.nsResolvedIdArr = Int32Array.from(state.resolvedIdArr)
    this.nsUriByResolvedId.length = 0
    this.nsUriByResolvedId.push(...state.uriByResolvedId)
    this.nsNextResolvedId = state.uriByResolvedId.length
    this.nsDeclarations.length = 0
    this.nsDeclarations.push(...state.declarations)
  }

  /** Reconstructs a fully queryable NodeStore from buffers produced by
   * `exportBuffers` — the far side of a worker transfer. `source` and
   * `interner` must themselves already be transferred/rebuilt.
   * `namespaceState`, from `exportNamespaceState`, is optional: omitting it
   * (as `subtreeSplice.ts`'s incremental-reparse graft still does — a
   * disclosed gap, `R134-xml-namespaces.md`'s Owed entry) leaves the
   * reconstructed store's namespace resolution at its just-constructed
   * default (nothing declared yet), so `resolvedNameIdOf` falls back to the
   * raw `nameIdOf` until the document is next fully reopened. */
  static fromBuffers(
    source: Uint8Array,
    interner: Interner,
    buffers: NodeStoreBuffers,
    namespaceState?: NamespaceResolutionBuffers
  ): NodeStore {
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
    if (namespaceState !== undefined) store.importNamespaceState(namespaceState)
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

  /**
   * R134/R136: `node`'s own name, resolved to `(URI, localName)` — the id
   * two differently-prefixed spellings of one namespace share, and the
   * key `gridDetection.ts` groups children by instead of the raw `nameId`
   * (closing that file's own documented gap). Falls back to the raw
   * `nameIdOf(node)` — correct by construction, since an unresolved name
   * *is* its own resolution — whenever there is nothing to resolve:
   * namespaces disabled for this document's format, or a document that
   * declared no namespace at all (§6's "must stay unchanged" case, and the
   * common one).
   *
   * **O(1) except when this document rebinds a prefix** (R135) — the one
   * case a single `nameId → resolvedId` slot cannot represent (the same
   * raw spelling resolving to two different URIs in two different
   * subtrees), where this instead does a live, position-aware lookup
   * (`resolveNamespaceLive`) over the declarations actually seen.
   */
  resolvedNameIdOf(node: NodeRef): number {
    const nameId = this.nameIdArr[node]!
    if (!this.nsEnabled || !this.nsAnyDeclarationSeen) return nameId
    if (this.nsHasRebinding) return this.resolveNamespaceLive(node, nameId)
    const resolved = this.nsResolvedIdArr[nameId]
    return resolved !== undefined && resolved !== -1 ? resolved : nameId
  }

  /**
   * The URI backing `resolvedNameIdOf(node)` — R136's column header
   * tooltip ("the resolved URI appears in the header tooltip"), the only
   * way a user can tell *why* two differently-prefixed sections merged
   * into one group. `null` when there is nothing to show: namespaces
   * disabled, no declaration anywhere in the document, or a name that
   * genuinely has no namespace in scope (unprefixed with no default
   * binding, or a prefix this document never declares).
   */
  namespaceUriOf(node: NodeRef): string | null {
    if (!this.nsEnabled || !this.nsAnyDeclarationSeen) return null
    // Resolved directly (not through `resolvedNameIdOf`) so a name that was
    // never finalized — unreachable in practice, since `closeNode` finalizes
    // every node exactly once, but not a case worth trusting blindly here —
    // is reported as "no URI" rather than indexing `nsUriByResolvedId` with
    // a raw `nameId` from the wrong id space.
    const nameId = this.nameIdArr[node]!
    const resolvedId = this.nsHasRebinding
      ? this.resolveNamespaceLive(node, nameId)
      : this.nsResolvedIdArr[nameId]
    if (resolvedId === undefined || resolvedId === -1) return null
    const uri = this.nsUriByResolvedId[resolvedId]
    return uri !== undefined && uri !== '' ? uri : null
  }

  /**
   * The best-effort resolved URI for a name id **alone**, with no node
   * context — for a UI surface that has one `nameId` per column rather
   * than one particular occurrence (`Grid.tsx`'s column header tooltip,
   * R136). Uses whichever occurrence resolved first; under R135 rebinding
   * this is not necessarily every occurrence's true URI (`namespaceUriOf`
   * is the position-aware answer for that), which is an acceptable
   * approximation for an informational tooltip and is never consulted on
   * a grouping or query path.
   */
  namespaceUriOfName(nameId: number): string | null {
    if (!this.nsEnabled || !this.nsAnyDeclarationSeen) return null
    const resolvedId = this.nsResolvedIdArr[nameId]
    if (resolvedId === undefined || resolvedId === -1) return null
    const uri = this.nsUriByResolvedId[resolvedId]
    return uri !== undefined && uri !== '' ? uri : null
  }

  /** Whether this document binds any single prefix to more than one URI —
   * R135's trigger. `false` for every document that never allocates the
   * declaration list beyond the handful of rows real `xmlns` attributes
   * produce; asserted directly in tests rather than inferred from timing,
   * per that round's own acceptance criteria. */
  get hasNamespaceRebinding(): boolean {
    return this.nsHasRebinding
  }

  /**
   * R135's fallback: which URI was actually in scope for `node`'s prefix
   * *at `node`'s own position* — a binary search would need a table
   * sorted and range-checked the way `evaluate.ts`'s own `subtreeEndRef`
   * trick sizes a subtree without walking it; this instead does a direct
   * scan over `nsDeclarations`; because that list is sized per
   * *declaration*, not per node ("kilobytes… a few hundred on a schema-
   * driven document" per §"headline"), a linear scan here is the same
   * order of cost a sorted-table binary search would be for any
   * declaration count small enough to matter, and only the rebinding path
   * ever reaches this method at all — never the common case.
   */
  private resolveNamespaceLive(node: NodeRef, nameId: number): number {
    const prefix = this.interner_.prefixOf(nameId)
    const wantPrefix = prefix ?? ''
    let bestStart = -1
    let uri = ''
    for (const decl of this.nsDeclarations) {
      if (decl.prefix !== wantPrefix) continue
      if (decl.declaringNode > node) continue
      if (node >= this.subtreeEndRefOf(decl.declaringNode)) continue
      if (decl.declaringNode > bestStart) {
        bestStart = decl.declaringNode
        uri = decl.uri
      }
    }
    const local = prefix !== null ? this.interner_.localNameOf(nameId) : this.interner_.text(nameId)
    const key = `${uri} ${local}`
    let resolvedId = this.nsResolvedKeyToId.get(key)
    if (resolvedId === undefined) {
      resolvedId = this.nsNextResolvedId++
      this.nsResolvedKeyToId.set(key, resolvedId)
      this.nsUriByResolvedId[resolvedId] = uri
    }
    return resolvedId
  }

  /** The same fact `evaluate.ts`'s own `subtreeEndRef` rests on: contiguous
   * ref allocation means a subtree's ref boundary is found by walking
   * ancestors' `nextSibling`, never by walking the subtree's own contents.
   * Duplicated locally (rather than imported) because `core/path/` depends
   * on `nodeStore.ts`, not the other way around. */
  private subtreeEndRefOf(node: NodeRef): NodeRef {
    for (let n = node; ;) {
      const next = this.nextSiblingArr[n]
      if (next !== undefined && next !== NO_REF) return next
      const parent = this.parentArr[n]
      if (parent === undefined || parent === NO_REF) return this.count
      n = parent
    }
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
