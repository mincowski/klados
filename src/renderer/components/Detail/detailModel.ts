/**
 * Pure logic for the Detail View (M1-PLAN.md D9, CONCEPT.md §4.3). Kept
 * free of React so path-building, source-range formatting and facet
 * extraction can be exercised directly by `test/detail.test.ts` — the same
 * split every other view's `*Model.ts`/`*Logic.ts` uses.
 */
import type { NodeStore, Span } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import { NodeKind, type NodeRef } from '../../../core/types'
import { lineAtOffset, DEFAULT_MAX_ROW_BYTES, type LineIndex } from '../../../core/rowIndex'
import { EMPTY_DELTA_LIST, type DeltaList } from '../../../core/deltaList'
import { childCountOf, hasChildren, kindLabelOf, labelOf, previewOf } from '../../nodeDisplay'
import { translateSpan } from '../../session/spanTranslation'

// ---------------------------------------------------------------------------
// Breadcrumb path

export interface PathSegment {
  readonly node: NodeRef
  /** Display label — `labelOf`, i.e. the node's own name or its kind. */
  readonly label: string
  readonly name: string | null
  readonly kind: NodeKind
  /** 0-based position among ALL of the parent's children — what a JSON
   * Pointer array segment is. 0 for the root segment, which has no parent. */
  readonly siblingIndex: number
  /** 1-based position among siblings sharing `name` — what an XPath
   * predicate needs. 0 when `name` is `null` or the segment is the root. */
  readonly sameNamePosition: number
  /** How many siblings (including this one) share `name`. */
  readonly sameNameCount: number
}

/**
 * Root-first ancestor chain from the Document node (§4.2's Tree root, kept
 * as the breadcrumb's own first segment for the same reason) down to
 * `node`, inclusive. Every level scans its own sibling list once to work
 * out this node's position — cheap for the typical shallow-nesting case,
 * and bounded by fan-out at the one level (`node`'s immediate parent) where
 * it's a real cost: a two-million-child parent is exactly the shape this
 * scan handles, once, on a selection change rather than every render.
 */
export function pathSegmentsOf(store: NodeStore, node: NodeRef): PathSegment[] {
  const segments: PathSegment[] = []
  let current = node

  while (current !== -1) {
    const parent = store.parentOf(current)
    const name = store.nameOf(current)
    let siblingIndex = 0
    let sameNamePosition = 0
    let sameNameCount = 0

    if (parent !== -1) {
      let index = 0
      for (
        let sibling = store.firstChildOf(parent);
        sibling !== -1;
        sibling = store.nextSiblingOf(sibling)
      ) {
        if (name !== null && store.nameOf(sibling) === name) {
          sameNameCount++
          if (sibling === current) sameNamePosition = sameNameCount
        }
        if (sibling === current) siblingIndex = index
        index++
      }
    }

    segments.unshift({
      node: current,
      label: labelOf(store, current),
      name,
      kind: store.kindOf(current),
      siblingIndex,
      sameNamePosition,
      sameNameCount
    })
    current = parent
  }

  return segments
}

function escapeJsonPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

/**
 * Which segments actually correspond to a path *step*, as opposed to one
 * that exists in the tree but not in the address space a path describes.
 * A step exists only where the grammar itself creates an address: a named
 * node (an XML element, or a JSON property — `segment.name !== null`), or
 * a direct child of an Array, addressed by position regardless of its own
 * name (always `null` for an array element in this store).
 *
 * Everything else is a transparent link in the ancestor chain, not a step
 * of its own — covering two shapes at once:
 *
 * - **D-030's folding** means a Property's composite value is a separate,
 *   unnamed Object/Array node (`{"a":{"b":1}}` is `Property"a" -> Object ->
 *   Property"b"`, four nodes deep for a path that's only two steps,
 *   `/a/b`) — the Property already accounts for that position.
 * - **The document's own top-level value** (an unnamed Object, Array, or
 *   even a bare scalar — `42` alone is valid JSON) is addressed by the
 *   empty pointer, not a segment of its own; `parent.kind` being Document
 *   rather than Array falls out of the same rule rather than needing a
 *   special case.
 *
 * XML has no unnamed non-root node this ever filters (every element has a
 * tag name), so this only ever changes JSON's — and later TOML/YAML's —
 * output; an XML path keeps every element exactly as before.
 */
function isAddressableStep(segment: PathSegment, parent: PathSegment): boolean {
  return segment.name !== null || parent.kind === NodeKind.Array
}

function addressableSteps(segments: readonly PathSegment[]): PathSegment[] {
  const steps: PathSegment[] = []
  for (let i = 1; i < segments.length; i++) {
    if (isAddressableStep(segments[i]!, segments[i - 1]!)) steps.push(segments[i]!)
  }
  return steps
}

/** Each step resolves to either its name (an object property) or its
 * position among all siblings (an array element, which has none). */
export function toJsonPointer(segments: readonly PathSegment[]): string {
  const parts = addressableSteps(segments).map((s) =>
    s.name !== null ? escapeJsonPointerToken(s.name) : String(s.siblingIndex)
  )
  return parts.length === 0 ? '' : `/${parts.join('/')}`
}

/** The `[n]` predicate only appears when it's needed to disambiguate —
 * `sameNameCount > 1` — matching how XPath is conventionally written by
 * hand rather than always numbering every step. */
export function toXPath(segments: readonly PathSegment[]): string {
  const parts = addressableSteps(segments).map((s) => {
    const base = s.name ?? '*'
    return s.sameNameCount > 1 ? `${base}[${s.sameNamePosition}]` : base
  })
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

/**
 * R75 (`R72-path-query.md` §4) — `core/path/parse.ts`'s own grammar,
 * for every format, so the string `copyPathFor` emits is always something
 * the palette's `/` mode can parse back. Unlike `toXPath` (built for XML,
 * where every node has a name), this also has to address an unnamed JSON
 * array element — `pathSegmentsOf` only computes `sameNamePosition` when
 * `name !== null` (it compares siblings' *names*, and an array element has
 * none), so `toXPath` silently drops position for one entirely: every
 * element in a JSON array prints as the bare wildcard `*`, indistinguishable
 * from every other element at that level. The grammar's own positional
 * predicate doesn't require a name, though — `*[3]` ("any name, 3rd
 * position") is exactly what an array element needs, using `siblingIndex`
 * (0-based, "position among ALL of the parent's children") rather than
 * `sameNamePosition`, converted to the grammar's 1-based `[n]`.
 */
export function toKladosPath(segments: readonly PathSegment[]): string {
  const parts = addressableSteps(segments).map((s) => {
    if (s.name === null) return `*[${s.siblingIndex + 1}]`
    return s.sameNameCount > 1 ? `${s.name}[${s.sameNamePosition}]` : s.name
  })
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

/**
 * R75: always the grammar every format's documents can be queried with —
 * `toKladosPath`, not a per-format choice between XPath and JSON Pointer.
 * `copyPathFor`'s own name (not `toKladosPath` at the call site) is kept
 * as the stable public entry point, since "the thing the Copy Path command
 * calls" is the contract callers actually depend on, not which serializer
 * backs it today.
 *
 * Previously picked XPath or JSON Pointer from `capabilities.hasAttributes`
 * — plausible-looking (it happens to be true exactly when a document's
 * shape is element-and-attribute-based for every format M1 ships), but
 * `hasAttributes` was never actually about path *syntax*, and JSON Pointer
 * addresses an array element with a bare numeric segment the query grammar
 * reads as a *name* — silently unparseable, unlike XPath's `[n]`, which the
 * grammar already speaks natively (D-081).
 */
export function copyPathFor(segments: readonly PathSegment[]): string {
  return toKladosPath(segments)
}

// ---------------------------------------------------------------------------
// Source range

/**
 * A document has "meaningful lines" when its lines are, on average, well
 * short of the byte cap that forces a row cut in the absence of a real
 * newline (`rowIndex.ts`'s cutting rule: newline or `maxRowBytes`, whichever
 * comes first). A minified document is one enormous line, so "line 1" says
 * nothing about where you are and byte offsets are the honest unit.
 *
 * This measures the real line count from `LineIndex`. It used to estimate it
 * from the *row* count, which is only the same number while no line exceeds
 * the byte cap — a document with one long line silently drifted from that
 * point on, cumulatively, and every "line 42" after it was wrong.
 *
 * Display only, and separate from D12's per-window wrap decision, which is
 * tested directly on the window rather than estimated.
 */
const MEANINGFUL_LINE_MEAN_BYTES = DEFAULT_MAX_ROW_BYTES * 0.9

/** Exported for the palette's `:` mode (D14) — the same "does this
 * document have real lines" question decides whether typed input there
 * means a line number or a raw byte offset. */
export function hasMeaningfulLines(line: LineIndex, byteLength: number): boolean {
  return line.lineCount > 1 && byteLength / line.lineCount < MEANINGFUL_LINE_MEAN_BYTES
}

/** "line 42" / "lines 42–48" when the document has meaningful lines (see
 * above), "bytes 1024–2048" otherwise — §4.3's node header. */
export function sourceRangeLabel(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  line: LineIndex,
  byteLength: number,
  span: Span
): string {
  if (!hasMeaningfulLines(line, byteLength)) {
    return span.end > span.start ? `bytes ${span.start}–${span.end}` : `byte ${span.start}`
  }
  const startLine = lineAtOffset(bytes, rowIndex, line, span.start)
  const endOffset = Math.max(span.start, span.end - 1)
  const endLine = lineAtOffset(bytes, rowIndex, line, endOffset)
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`
}

// ---------------------------------------------------------------------------
// Comment block (§5.3 attachment is not implemented — this is the whole rule)

/** The adjacent Comment node, preceding sibling first, or `null`. Nothing
 * about "attachment" beyond adjacency — §5.3's real association rule is a
 * later milestone. */
export function adjacentCommentOf(store: NodeStore, node: NodeRef): NodeRef | null {
  const prev = store.prevSiblingOf(node)
  if (prev !== -1 && isComment(store, prev)) return prev
  const next = store.nextSiblingOf(node)
  if (next !== -1 && isComment(store, next)) return next
  return null
}

function isComment(store: NodeStore, node: NodeRef): boolean {
  return store.kindOf(node) === NodeKind.Comment
}

// ---------------------------------------------------------------------------
// Value / comment block text — bounded decodes, invariant 1 applies to a
// block the same as it does to a preview: "typically short" is not a bound.

const VALUE_BLOCK_MAX_CHARS = 500
const VALUE_BLOCK_MAX_BYTES = VALUE_BLOCK_MAX_CHARS * 4

/** `node`'s own value text (§4.3's value block, and the comment block reuses
 * it for a Comment node's text) — `null` when the node has no value at all
 * (§4.3's "if any"), never an empty string standing in for absence. */
export function valueTextOf(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList = EMPTY_DELTA_LIST
): string | null {
  const rawSpan = store.valueOf(node)
  if (rawSpan === null) return null
  const span = translateSpan(rawSpan, deltas)
  const end = source.snapToCharBoundary(Math.min(span.end, span.start + VALUE_BLOCK_MAX_BYTES))
  return source.slice(span.start, end)
}

// ---------------------------------------------------------------------------
// Scalar facets (XML attributes — absent for JSON, per `hasAttributes`)

export interface ScalarFacet {
  readonly name: string
  readonly value: string
}

const FACET_VALUE_MAX_CHARS = 200

/** One row per attribute, in document order — the table §4.3 calls the
 * scalar facets table. Caller gates this on `capabilities.hasAttributes`
 * (empty for a format that never calls `NodeSink.attribute`, but the table
 * itself should not render at all for one, per D9's own acceptance
 * criterion — an empty table is still a visible, if pointless, table). */
export function scalarFacetsOf(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList = EMPTY_DELTA_LIST
): ScalarFacet[] {
  const facets: ScalarFacet[] = []
  for (const attr of store.attributesOf(node)) {
    const name = store.textOf(attr.nameId)
    const valueSpan = translateSpan({ start: attr.valueStart, end: attr.valueEnd }, deltas)
    const end = source.snapToCharBoundary(
      Math.min(valueSpan.end, valueSpan.start + FACET_VALUE_MAX_CHARS * 4)
    )
    const value = source.slice(valueSpan.start, end)
    facets.push({ name, value })
  }
  return facets
}

// ---------------------------------------------------------------------------
// Children list column layout (M5c-PLAN.md J5) — the first content-derived
// column width in the codebase; the Grid's own (R43/D-071,
// `gridColumnWidth.ts`) followed the same "sample, don't measure
// everything" precedent later. Kept here, pure and testable, rather than
// measured in the component — every other view's `*Model.ts` puts its real
// logic here for the same reason (this file's own top comment).

export interface ChildrenColumnLayout {
  /** Only when the sampled children have more than one distinct
   * `NodeKind` — for XML that's every element (`kind` is near-constant
   * clutter), for JSON or mixed content it varies and earns the column. */
  readonly showKind: boolean
  readonly nameCh: number
  readonly kindCh: number
  readonly valueCh: number
  readonly childrenCh: number
}

/** Children beyond this many aren't measured — a two-million-child parent
 * is D9's own stated normal case, and a bounded sample is the whole point:
 * a row past it can be wrong (it ellipsizes), which is what today's fixed
 * percentage columns do to *every* row. */
const CHILDREN_SAMPLE_SIZE = 200

const CHILDREN_MIN_CH = 3
const CHILDREN_NAME_MAX_CH = 40
const CHILDREN_KIND_MAX_CH = 12
const CHILDREN_VALUE_MAX_CH = 60
const CHILDREN_CHILDREN_MAX_CH = 10

function clampCh(chars: number, max: number): number {
  return Math.max(CHILDREN_MIN_CH, Math.min(max, chars))
}

/**
 * Column widths in `ch` (the `Detail.css` container converts these to
 * `width: max-content` bounded by `max-width: 100%` — a sample can be
 * wrong for a later row, which just ellipsizes, same as today's fixed
 * percentages do to every row). `children`, not `node` — the caller
 * (`ChildrenList`) already has the filtered/excluded list this measures,
 * and re-deriving it here would mean walking `childrenOf` twice.
 */
export function childrenColumnLayout(
  store: NodeStore,
  sourceBuffer: SourceBuffer,
  children: readonly NodeRef[],
  deltas: DeltaList = EMPTY_DELTA_LIST
): ChildrenColumnLayout {
  const sample = children.slice(0, CHILDREN_SAMPLE_SIZE)
  const kinds = new Set<NodeKind>()
  let nameChars = 'Name'.length
  let kindChars = 'Kind'.length
  let valueChars = 'Value'.length
  let childrenChars = 'Children'.length

  for (const child of sample) {
    const kind = store.kindOf(child)
    kinds.add(kind)
    nameChars = Math.max(nameChars, labelOf(store, child).length)
    kindChars = Math.max(kindChars, kindLabelOf(kind).length)
    if (hasChildren(store, child)) {
      childrenChars = Math.max(childrenChars, childCountOf(store, child).toLocaleString().length)
    } else {
      const preview = previewOf(store, sourceBuffer, child, deltas) ?? ''
      valueChars = Math.max(valueChars, preview.length)
    }
  }

  return {
    showKind: kinds.size > 1,
    nameCh: clampCh(nameChars, CHILDREN_NAME_MAX_CH),
    kindCh: clampCh(kindChars, CHILDREN_KIND_MAX_CH),
    valueCh: clampCh(valueChars, CHILDREN_VALUE_MAX_CH),
    childrenCh: clampCh(childrenChars, CHILDREN_CHILDREN_MAX_CH)
  }
}
