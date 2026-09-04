/**
 * M3-PLAN.md F5 — selection re-resolution. CONCEPT.md §5.1's three-step
 * cascade: a reparse allocates an entirely new `NodeStore`, so every old
 * `NodeRef` — including the selected one — is meaningless against it. This
 * module is pure computation (no session/UI imports, same shape as
 * `nodeSpanLookup.ts`) so it can be composed from `documentSession.ts`
 * without a circular import back to it.
 *
 * 1. **Structural path** (`pathSegmentsOf`'s own shape — name, kind,
 *    same-name position at each level, the same identity `toXPath` prints
 *    as `/root/books/book[3]/title`) walked down through the *new* store.
 *    Exact match: silent, nothing about the selection visibly changed.
 * 2. **Caret offset** — but only trusted *within* whatever the structural
 *    walk still resolved. Editing happens only via the Raw View caret
 *    (CLAUDE.md invariant 6), so the caret's current position is exactly
 *    where the edit that broke step 1 landed — a reliable signal for *that*
 *    subtree, and no signal at all about the rest of the document. Without
 *    this scoping, an edit somewhere else in a 200 MB file could silently
 *    steal the selection to wherever the caret happens to sit.
 * 3. **Nearest surviving ancestor** — the structural walk's own result
 *    either way, so no separate computation: it is literally how far step 1
 *    got before a segment stopped matching. Falls back to the document root
 *    (node 0, always present and always resolves trivially) when nothing
 *    deeper survived.
 */
import { pathSegmentsOf, type PathSegment } from '../components/Detail/detailModel'
import type { NodeStore } from '../../core/nodeStore'
import type { NodeRef, Offset } from '../../core/types'
import { nodeContainingOffset } from '../nodeSpanLookup'

/** Mirrors `documentSession.ts`'s exported `NO_SELECTION` (same value, same
 * meaning — "nothing to select," never node 0). Not imported from there:
 * `documentSession.ts` is this module's own caller, and importing back
 * would be circular. Kept as its own local constant rather than a shared
 * one for the same reason `subtreeSplice.ts` keeps its own `NO_VALUE`. */
const NO_SELECTION = -1
const NO_REF = -1

export type ReresolveStep = 1 | 2 | 3

export interface ReresolveResult {
  readonly node: NodeRef
  readonly step: ReresolveStep
  /** `true` only for an exact step-1 match. The caller's cue for "the Tree
   * must scroll and the change must be made visible" per §5.1's own words:
   * steps 2 and 3 are never silent. */
  readonly silent: boolean
}

/**
 * `segment`'s counterpart among `parent`'s children in `store` — matched by
 * kind + name + `sameNamePosition` when the segment is named (the same
 * identity an XPath `[n]` predicate encodes), or by kind + `siblingIndex`
 * when it isn't (an anonymous JSON array element, an unnamed wrapper).
 * `null` if nothing matches.
 */
function resolveChild(store: NodeStore, parent: NodeRef, segment: PathSegment): NodeRef | null {
  if (segment.name !== null) {
    let sameNameSeen = 0
    for (
      let child = store.firstChildOf(parent);
      child !== NO_REF;
      child = store.nextSiblingOf(child)
    ) {
      if (store.kindOf(child) === segment.kind && store.nameOf(child) === segment.name) {
        sameNameSeen++
        if (sameNameSeen === segment.sameNamePosition) return child
      }
    }
    return null
  }
  let index = 0
  for (
    let child = store.firstChildOf(parent);
    child !== NO_REF;
    child = store.nextSiblingOf(child)
  ) {
    if (index === segment.siblingIndex && store.kindOf(child) === segment.kind) return child
    index++
  }
  return null
}

/**
 * Walks `oldPath` (root-first, from `pathSegmentsOf` on the *old* store)
 * down through `newStore`, one `resolveChild` per level. `oldPath[0]` is
 * always the Document node — node 0 in both stores, since every parse
 * allocates it first — so the walk starts resolved there rather than
 * treating it as a segment to match. Returns the deepest index in
 * `oldPath` that still resolved and the `NodeRef` it resolved to; equal to
 * `oldPath.length - 1` exactly when the whole path survived.
 */
function deepestSurvivingAncestor(
  newStore: NodeStore,
  oldPath: readonly PathSegment[]
): { readonly node: NodeRef; readonly depth: number } {
  let resolved: NodeRef = 0
  let depth = 0
  for (let i = 1; i < oldPath.length; i++) {
    const next = resolveChild(newStore, resolved, oldPath[i]!)
    if (next === null) break
    resolved = next
    depth = i
  }
  return { node: resolved, depth }
}

/** Whether `node` is `ancestor` itself or a descendant of it — an O(depth)
 * walk up `parentOf`, same bound as `pathSegmentsOf` itself. */
function isWithinSubtree(store: NodeStore, ancestor: NodeRef, node: NodeRef): boolean {
  for (let n = node; n !== NO_REF; n = store.parentOf(n)) {
    if (n === ancestor) return true
  }
  return false
}

/**
 * Steps 1–3 given an already-built structural path, rather than a
 * `(store, node)` pair to derive one from — the shared core `reresolveSelection`
 * delegates to, and the shape M3-PLAN.md F6 (the undo stack) needs directly:
 * an undo entry outlives the store its recorded selection was captured
 * against (superseded by every reparse since), so it can only carry the
 * store-independent path forward, not a `NodeRef` to re-derive one from.
 *
 * An empty `path` means "nothing was selected" recorded as a fact, not "no
 * information to resolve from" — restores `NO_SELECTION` directly rather
 * than falling back to the caret the way `reresolveSelection`'s own
 * no-old-selection case does (see its own comment for why those two
 * "empty" cases mean different things).
 */
export function resolveFromPath(
  path: readonly PathSegment[],
  newStore: NodeStore,
  caretOffset: Offset
): ReresolveResult {
  if (newStore.nodeCount === 0) return { node: NO_SELECTION, step: 3, silent: false }
  if (path.length === 0) return { node: NO_SELECTION, step: 1, silent: true }

  const ancestor = deepestSurvivingAncestor(newStore, path)

  if (ancestor.depth === path.length - 1) {
    return { node: ancestor.node, step: 1, silent: true }
  }

  const caretCandidate = nodeContainingOffset(newStore, caretOffset)
  if (isWithinSubtree(newStore, ancestor.node, caretCandidate)) {
    return { node: caretCandidate, step: 2, silent: false }
  }

  return { node: ancestor.node, step: 3, silent: false }
}

/**
 * The full three-step cascade. `oldStore`/`oldSelectedNode` describe the
 * selection as of the parse being replaced; `newStore`/`caretOffset` are
 * the reparse's own result and the Raw View's current caret position
 * (already in the new document's coordinates — the caller tracks that
 * independently of this cascade).
 *
 * `oldSelectedNode === NO_SELECTION` means "nothing to preserve" — there is
 * no old path to walk, so the caret is all there is to go on, unscoped
 * (nothing to scope it *to*). Not the same case as `resolveFromPath`'s own
 * empty-path input, which means "we know for a fact nothing was selected"
 * (only reachable via a recorded undo/redo entry) and restores
 * `NO_SELECTION` exactly rather than reaching for the caret.
 */
export function reresolveSelection(
  oldStore: NodeStore,
  oldSelectedNode: NodeRef,
  newStore: NodeStore,
  caretOffset: Offset
): ReresolveResult {
  if (newStore.nodeCount === 0) return { node: NO_SELECTION, step: 3, silent: false }
  if (oldSelectedNode === NO_SELECTION) {
    return { node: nodeContainingOffset(newStore, caretOffset), step: 2, silent: false }
  }

  return resolveFromPath(pathSegmentsOf(oldStore, oldSelectedNode), newStore, caretOffset)
}
