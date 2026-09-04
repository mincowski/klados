/**
 * Transparent wrapper detection and descent (M2-PLAN.md E2, CONCEPT.md
 * §4.3 "Transparent wrappers", D-015). Pure logic, no React — the same
 * `*Model.ts`/`*Logic.ts` split `gridDetection.ts` (E1) uses, so
 * `test/wrapperDescent.test.ts` can exercise it directly. R33/D-065: lives
 * at the renderer root, a peer of `nodeDisplay.ts`, rather than under
 * `components/Detail/` — `documentSession.ts` (not a component) now uses
 * `resolveWrapperTarget` too, to make the initial selection agree with what
 * Detail displays instead of independently landing on the raw root.
 */
import { NodeFlags, type NodeStore } from '../core/nodeStore'
import { NodeKind, type NodeRef } from '../core/types'
import { hasChildren, labelOf } from './nodeDisplay'
import { adjacentCommentOf } from './components/Detail/detailModel'

/**
 * A safety bound against a degenerate document (a single-child chain
 * thousands of nodes deep), not a UX limit — see M2-RESULTS.md's "wrapper
 * descent depth" finding (§13): a hop count tuned to feel right for XML
 * measurably truncates the equivalent JSON descent partway through the
 * same document shape, because D-030 keeps a Property's composite value as
 * a separate Object/Array node while XML's Element folds name and children
 * onto one node. Each hop is O(1) — a wrapper has exactly one composite
 * child by definition — so there is no cost argument for capping this
 * tightly, only a correctness one for capping it at all.
 */
export const DEFAULT_WRAPPER_DESCENT_DEPTH = 1000

/**
 * `node`'s single composite child, if `node` qualifies as a transparent
 * wrapper (§4.3, D-015) — `null` otherwise. All three conditions are
 * checked in one pass over `node`'s children, no decoding:
 *
 * - exactly one composite child (CONCEPT.md §3.2: composite = has children)
 * - no scalar facets — `node` itself carries no attributes
 * - no text content of its own — no `Text`/`CData` child (`ownValueOf` can
 *   never be non-null here regardless: `closeNode` clears a composite
 *   node's own value the moment any child opens, so this only needs to
 *   rule out mixed content, not the folded-scalar case, which already
 *   implies zero children and so already fails "exactly one")
 *
 * A node's own attached *comment* is a `Comment` sibling, not a `Comment`
 * child, and never disqualifies it — Appendix A's `garage` and `cars` both
 * carry one and are still wrappers. `Comment`/`ProcessingInstruction`/
 * `DocType` children are likewise ignored by this test, since they are pure
 * document metadata, never a data field a consumer could lose visibility
 * into by descending past their parent.
 *
 * Any *other* non-composite child — a leaf `Element`/`Property` (a folded
 * scalar) or a bare `Scalar` — is real sibling content and disqualifies the
 * wrapper, even though it isn't itself composite. `<zoo><cat/><cat/>
 * <dog>...</dog></zoo>` must not be treated as a transparent wrapper around
 * `dog`: the two `<cat/>` leaves are exactly the kind of field E4's cell
 * model renders, and silently descending past them would hide them from
 * the destination's own header entirely, not just fold them into a
 * breadcrumb the way a skipped wrapper's comment is preserved.
 */
function wrapperCompositeChild(store: NodeStore, node: NodeRef): NodeRef | null {
  let compositeCount = 0
  let compositeChild: NodeRef | null = null

  for (const child of store.childrenOf(node)) {
    const kind = store.kindOf(child)
    if (
      kind === NodeKind.Comment ||
      kind === NodeKind.ProcessingInstruction ||
      kind === NodeKind.DocType
    ) {
      continue
    }
    if (kind === NodeKind.Text || kind === NodeKind.CData) return null
    if (!hasChildren(store, child)) return null
    compositeCount++
    if (compositeCount > 1) return null
    compositeChild = child
  }

  if (compositeCount !== 1) return null
  if (store.hasFlag(node, NodeFlags.HasAttributes)) return null
  return compositeChild
}

/** Whether `node` is a transparent wrapper (§4.3, D-015) — the yes/no
 * question `resolveWrapperTarget` answers per hop while walking a chain.
 * Exported (and directly tested) as the standalone predicate the rule
 * itself is stated as, for a caller that only needs one answer rather than
 * a descent. */
export function isTransparentWrapper(store: NodeStore, node: NodeRef): boolean {
  return wrapperCompositeChild(store, node) !== null
}

export interface WrapperDescent {
  /** The first node reached that is not itself a transparent wrapper (or
   * `node` unchanged, if it never was one) — what E1's grid detection and
   * the rest of the Detail view should actually run against. */
  readonly destination: NodeRef
  /** The wrapper chain skipped to reach `destination`, root-first (`node`
   * itself first, when it qualifies) — empty when `node` was not a
   * transparent wrapper. What the breadcrumb chip (§4.3) is built from. */
  readonly skipped: readonly NodeRef[]
}

/**
 * Descends through a chain of transparent wrappers starting at `node`,
 * stopping at the first node that is not one — §4.3's "the first node that
 * has repeating children," which for a genuinely single-occurrence child is
 * simply the first non-wrapper node, repeating or not. `maxDepth` is a
 * safety bound (see `DEFAULT_WRAPPER_DESCENT_DEPTH`), not a tuning knob.
 */
export function resolveWrapperTarget(
  store: NodeStore,
  node: NodeRef,
  maxDepth: number = DEFAULT_WRAPPER_DESCENT_DEPTH
): WrapperDescent {
  const skipped: NodeRef[] = []
  let current = node

  while (skipped.length < maxDepth) {
    const child = wrapperCompositeChild(store, current)
    if (child === null) break
    skipped.push(current)
    current = child
  }

  return { destination: current, skipped }
}

export interface SkippedComment {
  readonly node: NodeRef
  /** `labelOf` of the skipped node — what the comment is labelled with in
   * the destination's comment block (`cars: Fleet inventory…`). */
  readonly label: string
  readonly commentNode: NodeRef
}

/**
 * The comment attached to each skipped wrapper node, if any — "Comments on
 * skipped nodes are not lost" (§4.3): compaction must never hide
 * documentation. Reuses `detailModel.ts`'s own comment-adjacency rule
 * (§5.3's real leading/trailing association is a later milestone) rather
 * than inventing a stronger one for wrappers specifically.
 */
export function skippedComments(store: NodeStore, skipped: readonly NodeRef[]): SkippedComment[] {
  const comments: SkippedComment[] = []
  for (const node of skipped) {
    const commentNode = adjacentCommentOf(store, node)
    if (commentNode !== null) {
      comments.push({ node, label: labelOf(store, node), commentNode })
    }
  }
  return comments
}
