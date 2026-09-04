/**
 * Node-display utilities shared by every pane that shows a node by
 * `NodeRef`, not just the Tree it started in (M1-PLAN.md D8 built these;
 * D9's Detail view is the second consumer, which is why they live here
 * rather than under `components/Tree/`) — kind labels, glyph badges, the
 * name-or-kind-fallback label, and a bounded value preview. Kept free of
 * React so any of it can be exercised directly by a test.
 */
import { NodeFlags, type NodeStore } from '../core/nodeStore'
import type { SourceBuffer } from '../core/buffer'
import { NodeKind, type NodeRef } from '../core/types'
import { EMPTY_DELTA_LIST, type DeltaList } from '../core/deltaList'
import { translateSpan } from './session/spanTranslation'

/** `firstChildOf` reads back `-1` (`NodeStore`'s own `NO_REF`) for a node
 * with no children — true for any existing node ref. */
export function hasChildren(store: NodeStore, node: NodeRef): boolean {
  return store.firstChildOf(node) !== -1
}

/**
 * Whether `node` carries record-worthy content for grid detection specifically — either
 * children (CONCEPT.md §3.2's "composite," used everywhere else in this codebase
 * unchanged: wrapper descent, tree icons, the child-count badge) **or** scalar facets
 * (D-088). `detectGrid` used the plain "composite = has children" test exclusively until
 * CSV (R149, `docs/plans/R145-csv.md` §6): a CSV row is a `NodeKind.Object` with *only*
 * attributes, by R145 §2's own deliberate design (a field is a 16-byte facet, never a
 * 76-byte Property+Scalar child pair) — so under the old test every row failed
 * `hasChildren` and `detectGrid` found zero composite children for *any* CSV file, no
 * matter how many rows it had. Confirmed by running the real parser through `detectGrid`
 * before this existed: `compositeChildCount` was 0 and `grid` was `null` unconditionally.
 *
 * This does not redefine "composite" globally — `hasChildren` above, and every other
 * caller of it, is untouched — it only widens grid detection's own eligibility test,
 * which was already the one CONCEPT.md §4.3 names as "group composite children." An XML
 * element with attributes but no children (`<car color="red"/>`) was previously excluded
 * from grid detection too (untested, but implied by the same "has children" test); this
 * now includes it as well, which is the correct reading of "a repeating record; its
 * fields happen to be attributes" rather than an accidental side effect.
 */
export function isGridEligible(store: NodeStore, node: NodeRef): boolean {
  return hasChildren(store, node) || store.hasFlag(node, NodeFlags.HasAttributes)
}

/**
 * Number of `node`'s own children — for display (a child-count badge).
 * Cached per store: computing it means walking the child linked list once,
 * and a visible row would otherwise redo that walk on every re-render for
 * as long as it stays expanded or selected. Keyed by
 * `WeakMap<NodeStore, ...>` so the cache is scoped to one open document and
 * dropped when it closes, rather than a `Map` this module would have to
 * remember to clear.
 */
const childCountCaches = new WeakMap<NodeStore, Map<NodeRef, number>>()

export function childCountOf(store: NodeStore, node: NodeRef): number {
  let cache = childCountCaches.get(store)
  if (cache === undefined) {
    cache = new Map()
    childCountCaches.set(store, cache)
  }
  const cached = cache.get(node)
  if (cached !== undefined) return cached

  let count = 0
  for (let child = store.firstChildOf(node); child !== -1; child = store.nextSiblingOf(child)) {
    count++
  }
  cache.set(node, count)
  return count
}

const KIND_LABELS: Record<NodeKind, string> = {
  [NodeKind.Document]: 'Document',
  [NodeKind.Element]: 'Element',
  [NodeKind.Object]: 'Object',
  [NodeKind.Array]: 'Array',
  [NodeKind.Property]: 'Property',
  [NodeKind.Scalar]: 'Scalar',
  [NodeKind.Text]: 'Text',
  [NodeKind.CData]: 'CData',
  [NodeKind.Comment]: 'Comment',
  [NodeKind.ProcessingInstruction]: 'Processing Instruction',
  [NodeKind.DocType]: 'DocType'
}

/** The friendly name `commands/context.ts`'s `nodeKind` context key wants
 * — see that module's own note on why it's a string, not the raw enum. */
export function kindLabelOf(kind: NodeKind): string {
  return KIND_LABELS[kind]
}

/**
 * A short glyph badge per kind — CONCEPT.md's icon-per-node-kind (§4.2)
 * without depending on the Fluent icon set `assets/README.md` describes as
 * already vendored: only the app/window icons actually are (see that
 * file's own inventory). A real per-kind icon set is a separate asset
 * decision; these are plain characters styled from D2's token set like
 * anything else, not a stand-in for one.
 */
const KIND_GLYPHS: Record<NodeKind, string> = {
  [NodeKind.Document]: 'D',
  [NodeKind.Element]: '<>',
  [NodeKind.Object]: '{}',
  [NodeKind.Array]: '[]',
  [NodeKind.Property]: ':',
  [NodeKind.Scalar]: '"',
  [NodeKind.Text]: '¶',
  [NodeKind.CData]: '¶',
  [NodeKind.Comment]: '#',
  [NodeKind.ProcessingInstruction]: '?',
  [NodeKind.DocType]: '!'
}

export function glyphOf(kind: NodeKind): string {
  return KIND_GLYPHS[kind]
}

/** Falls back to the kind label for an unnamed node (an array element, a
 * text node, the document root) — never renders an empty row label. */
export function labelOf(store: NodeStore, node: NodeRef): string {
  return store.nameOf(node) ?? kindLabelOf(store.kindOf(node))
}

const PREVIEW_MAX_CHARS = 60
/** UTF-8 is at most 4 bytes per code point — decoding this many bytes can
 * never yield fewer than `PREVIEW_MAX_CHARS` characters, so truncating
 * after decoding still has enough text to truncate. */
const PREVIEW_MAX_BYTES = PREVIEW_MAX_CHARS * 4

/**
 * A leaf's value, decoded on demand and bounded to a short slice —
 * invariant 1 applies to a preview exactly as it does to the Raw View's
 * window: this decodes at most ~240 bytes regardless of the value's actual
 * length, never the whole node.
 */
export function previewOf(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList = EMPTY_DELTA_LIST
): string | null {
  const rawSpan = store.valueOf(node)
  if (rawSpan === null) return null
  const span = translateSpan(rawSpan, deltas)

  const boundedEnd = Math.min(span.end, span.start + PREVIEW_MAX_BYTES)
  const end = source.snapToCharBoundary(boundedEnd)
  const text = source.slice(span.start, end).replace(/\s+/g, ' ').trim()
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text
}
