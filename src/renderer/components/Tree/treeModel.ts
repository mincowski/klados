/**
 * Pure logic for the Tree View (M1-PLAN.md D8, CONCEPT.md §4.2). Kept free
 * of React so the flattening, keyboard-navigation and type-ahead rules can
 * be exercised directly by `test/tree.test.ts` without a renderer — the
 * same split `Palette/paletteLogic.ts` uses.
 *
 * Hard rule 1 (M1-PLAN.md): rows are `NodeRef`s, never `{ id, name,
 * children }` objects. `TreeRow` below is the one small exception — it
 * holds a node ref plus the three numbers the ARIA `tree` pattern and the
 * virtualizer need per row (depth, posinset, setsize) — and even that is
 * discarded once the visible list changes, never retained per node.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { hasMatchInRange } from '../../navigation/matchSpanLookup'
import { hasChildren, labelOf } from '../../nodeDisplay'

// Re-exported so `Tree.tsx` and `test/tree.test.ts` have one import to reach
// for — these moved to `nodeDisplay.ts` once `Detail` (D9) needed them too,
// but nothing about the Tree's own use of them changed.
export {
  childCountOf,
  glyphOf,
  hasChildren,
  kindLabelOf,
  labelOf,
  previewOf
} from '../../nodeDisplay'

export interface TreeRow {
  readonly node: NodeRef
  readonly depth: number
  /** 1-based position among siblings — ARIA `aria-posinset`. */
  readonly posinset: number
  /** True sibling count — ARIA `aria-setsize`. Document-level, not
   * rendered-row-count, per D8's own acceptance criterion. */
  readonly setsize: number
}

/**
 * Flattens the currently-expanded subtree rooted at `root` into the flat
 * list a virtualizer renders. Iterative (an explicit stack), not recursive
 * descent — CLAUDE.md invariant 4 applies here as much as to a parser: a
 * document's nesting is real input, and a 6.6M-node document can nest
 * deeply enough to overflow a call stack that walks it recursively.
 *
 * A node's children are materialized into an array only when it's expanded
 * — that bounds the cost to what's actually being shown, not the whole
 * document — and pushed onto the stack in reverse so the first child is
 * popped (and so rendered) first, preserving document order.
 */
export function buildVisibleRows(
  store: NodeStore,
  root: NodeRef,
  expanded: ReadonlySet<NodeRef>
): TreeRow[] {
  const rows: TreeRow[] = []
  const stack: TreeRow[] = [{ node: root, depth: 0, posinset: 1, setsize: 1 }]

  while (stack.length > 0) {
    const frame = stack.pop()!
    rows.push(frame)
    if (!expanded.has(frame.node)) continue

    const children = [...store.childrenOf(frame.node)]
    const setsize = children.length
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, depth: frame.depth + 1, posinset: i + 1, setsize })
    }
  }

  return rows
}

export function indexOfNode(rows: readonly TreeRow[], node: NodeRef): number {
  return rows.findIndex((row) => row.node === node)
}

/** Bounds the recursive single-child auto-expand (below) to the same order
 * of magnitude as `wrapperDescent.ts`'s `DEFAULT_WRAPPER_DESCENT_DEPTH`
 * — a degenerate `<a><a><a>...` chain thousands deep is real input (see
 * `buildVisibleRows`'s own stack-depth test), and a bound keeps a single
 * click from walking all of it. */
export const MAX_AUTO_EXPAND_DEPTH = 1000

/**
 * `UI-FEEDBACK.md`'s "Single-child chains should be separate rows, not
 * one compacted row" — the counter-proposal that replaced compaction
 * (M2-PLAN.md E2, now removed): expanding a node also expands every
 * descendant reached through a chain of single-child nodes, down to the
 * first node with zero or more-than-one children. Every level stays its
 * own row and individually selectable — unlike compaction, nothing here
 * changes what `buildVisibleRows` shows, only which nodes are already
 * marked expanded before it runs.
 *
 * Returns `node` itself plus the chain, in expansion order, for the caller
 * to add to its `expanded` set. Collapsing `node` later needs no special
 * handling: removing `node` alone from the set is enough to hide the whole
 * chain (`buildVisibleRows` stops recursing at the first unexpanded node),
 * and the chain members stay marked expanded so re-expanding `node`
 * restores the same view — collapse and expand act on the chain as one
 * unit "for free".
 */
export function autoExpandChain(
  store: NodeStore,
  node: NodeRef,
  maxDepth: number = MAX_AUTO_EXPAND_DEPTH
): NodeRef[] {
  const chain: NodeRef[] = [node]
  let current = node
  for (let depth = 0; depth < maxDepth; depth++) {
    const onlyChild = store.firstChildOf(current)
    if (onlyChild === -1) break
    if (store.nextSiblingOf(onlyChild) !== -1) break // more than one child
    if (!hasChildren(store, onlyChild)) break // a leaf, nothing to descend into
    chain.push(onlyChild)
    current = onlyChild
  }
  return chain
}

/** Bounds "Expand All" to a few tens of thousands of nodes rather than
 * attempting a 6.6M-node document's full tree (M1-PLAN.md D8's own
 * requirement) — chosen so the resulting DOM/virtualizer row count stays
 * comfortably below where either would start to struggle, while still
 * being enough to open most real documents completely. */
export const EXPAND_ALL_LIMIT = 20_000

export interface ExpandAllResult {
  readonly expanded: ReadonlySet<NodeRef>
  readonly truncated: boolean
}

/**
 * Breadth-first so a truncated result expands the shallowest levels first
 * — the more useful cutoff for a huge document — rather than a depth-first
 * cutoff that would fully expand one arbitrary early branch and stop.
 *
 * `enqueued` bounds the *queue*, not just the result: a node with millions
 * of children (plausible — a flat `<cars>` document is exactly this
 * shape) would otherwise enqueue all of them in one step before the
 * per-node check below ever runs again.
 */
export function expandAll(
  store: NodeStore,
  root: NodeRef,
  limit: number = EXPAND_ALL_LIMIT
): ExpandAllResult {
  const expanded = new Set<NodeRef>()
  const queue: NodeRef[] = [root]
  let head = 0
  let enqueued = 1
  let truncated = false

  while (head < queue.length) {
    if (enqueued >= limit) {
      truncated = true
      break
    }
    const node = queue[head++]!
    if (!hasChildren(store, node)) continue
    expanded.add(node)
    for (const child of store.childrenOf(node)) {
      queue.push(child)
      enqueued++
      if (enqueued >= limit) {
        truncated = true
        break
      }
    }
  }

  return { expanded, truncated }
}

export interface CollapseSubtreeResult {
  readonly toCollapse: ReadonlySet<NodeRef>
  readonly truncated: boolean
}

/**
 * M5c-PLAN.md J6 / D-052 — Collapse All's own traversal, breadth-first with
 * the same "bounds the queue, not just the result" property `expandAll`
 * has, for the same reason (a node with millions of children shouldn't
 * enqueue all of them in one step). Unlike `expandAll`, this doesn't need
 * to know which nodes *are* expanded — removing every expanded descendant
 * of `root` from the caller's `expanded` set collapses the whole subtree
 * whether or not this walk happens to agree with which of them were
 * actually open, so it returns every node in the subtree with children
 * (a safe superset) rather than cross-referencing the live `expanded` set
 * itself, keeping this pure and independent of `Tree.tsx`'s own state
 * shape.
 */
export function collapseSubtree(
  store: NodeStore,
  root: NodeRef,
  limit: number = EXPAND_ALL_LIMIT
): CollapseSubtreeResult {
  const toCollapse = new Set<NodeRef>()
  const queue: NodeRef[] = [root]
  let head = 0
  let enqueued = 1
  let truncated = false

  while (head < queue.length) {
    if (enqueued >= limit) {
      truncated = true
      break
    }
    const node = queue[head++]!
    if (!hasChildren(store, node)) continue
    toCollapse.add(node)
    for (const child of store.childrenOf(node)) {
      queue.push(child)
      enqueued++
      if (enqueued >= limit) {
        truncated = true
        break
      }
    }
  }

  return { toCollapse, truncated }
}

export interface FilteredRowsResult {
  readonly rows: readonly TreeRow[]
  readonly truncated: boolean
}

/**
 * Filter-to-matches (M4-PLAN.md G6, CONCEPT.md §6.2): "A node's subtree
 * contains a match iff the sorted match array has an entry in `[spanStart,
 * spanEnd)`" — spans are contiguous over a subtree by construction
 * (`subtreeSplice.ts`), so that test is exact, not approximate. Every
 * matching subtree is auto-expanded all the way down to its matches;
 * non-matching subtrees never become rows at all (hidden entirely, not
 * merely collapsed) — an overlay this is not; `Tree.tsx`'s ordinary
 * `expanded` set (manual expand/collapse) is untouched by this function
 * either way, which is what makes turning filter mode back off restore the
 * previous expansion state for free rather than needing to be saved and
 * restored explicitly.
 *
 * Bounded the same way `expandAll` bounds its queue, not just its result:
 * `visited` counts every node whose span is *tested*, not only the ones
 * that become rows, since a single enormous-fanout parent (a flat `<cars>`
 * document is exactly this shape) could otherwise scan millions of
 * children's spans before the row-count limit is ever reached. A parent
 * with more direct children than fit under the remaining budget stops
 * scanning the rest of them and reports truncated — a match past that
 * point under the same parent is not found, an accepted approximation
 * "match count in the millions does not hang the Tree" needs.
 */
export function buildFilteredRows(
  store: NodeStore,
  root: NodeRef,
  matchStarts: Int32Array,
  limit: number = EXPAND_ALL_LIMIT
): FilteredRowsResult {
  if (matchStarts.length === 0) return { rows: [], truncated: false }

  const rootSpan = store.spanOf(root)
  if (!hasMatchInRange(matchStarts, rootSpan.start, rootSpan.end)) {
    return { rows: [], truncated: false }
  }

  const rows: TreeRow[] = []
  let visited = 0
  let truncated = false
  const stack: TreeRow[] = [{ node: root, depth: 0, posinset: 1, setsize: 1 }]

  while (stack.length > 0) {
    const frame = stack.pop()!
    rows.push(frame)
    visited++

    const matchingChildren: NodeRef[] = []
    for (const child of store.childrenOf(frame.node)) {
      if (visited >= limit) {
        truncated = true
        break
      }
      visited++
      const span = store.spanOf(child)
      if (hasMatchInRange(matchStarts, span.start, span.end)) matchingChildren.push(child)
    }
    if (truncated) break

    const setsize = matchingChildren.length
    for (let i = matchingChildren.length - 1; i >= 0; i--) {
      stack.push({ node: matchingChildren[i]!, depth: frame.depth + 1, posinset: i + 1, setsize })
    }
  }

  return { rows, truncated }
}

/**
 * Case-insensitive prefix match over row labels, starting just after
 * `fromIndex` (the anchor a type-ahead session started at, not wherever the
 * previous keystroke's match landed — the caller is expected to hold that
 * anchor fixed for the session) and wrapping. Starting at an offset of 1
 * rather than 0 is what makes repeating the same letter cycle through every
 * match instead of always landing back on the first one.
 */
export function typeAheadMatch(
  rows: readonly TreeRow[],
  store: NodeStore,
  fromIndex: number,
  query: string
): number | null {
  if (query.length === 0 || rows.length === 0) return null
  const q = query.toLowerCase()

  for (let offset = 1; offset <= rows.length; offset++) {
    const i = (fromIndex + offset) % rows.length
    if (labelOf(store, rows[i]!.node).toLowerCase().startsWith(q)) return i
  }
  return null
}
