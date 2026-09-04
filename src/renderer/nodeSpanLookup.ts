/**
 * Offset → node, the shared primitive M1-PLAN.md D14 asks for explicitly
 * ("it is the same primitive D11 uses and should be written once"):
 * binary search on `spanStart` for the last node opened at or before a
 * point, then walk up through ancestors for the one whose span actually
 * contains it — D11's decoration walk uses the first half
 * (`lastNodeStartingAtOrBefore`) to find where a viewport range begins;
 * D14's caret-to-node resolution and "go to position" need the second
 * half too, to land on the right node rather than just the right
 * neighbourhood.
 */
import type { NodeStore } from '../core/nodeStore'
import type { NodeRef, Offset } from '../core/types'

/** Last node ref (0-based, node refs sorted by `spanStart` — CONCEPT.md's
 * own "allocated in open order, which is document order") whose
 * `spanStart` is `<= offset`, or `-1` if `offset` precedes every node
 * (impossible for a non-empty store, since node 0's span always starts
 * at 0). */
export function lastNodeStartingAtOrBefore(store: NodeStore, offset: Offset): NodeRef {
  let lo = 0
  let hi = store.nodeCount - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (store.spanOf(mid).start <= offset) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * The innermost node whose span contains `offset` — the node a byte
 * offset (a Raw View caret position, a "go to" input) actually belongs to.
 *
 * `lastNodeStartingAtOrBefore` alone isn't enough: the node it finds may
 * have already *closed* before `offset` (a gap between siblings, or
 * trailing whitespace inside a parent after its last child), in which case
 * the right answer is one of its ancestors, not itself. Walking up is
 * exactly D11's ancestor walk for the same underlying reason — bounded by
 * document depth, cheap regardless of document size.
 *
 * Falls back to the Document root (node 0) if nothing else contains
 * `offset` — true only for a `0`-node store or an offset past the root's
 * own span, neither of which should happen for a real selection but
 * shouldn't throw if it somehow does.
 */
export function nodeContainingOffset(store: NodeStore, offset: Offset): NodeRef {
  if (store.nodeCount === 0) return 0

  for (
    let node = lastNodeStartingAtOrBefore(store, offset);
    node !== -1;
    node = store.parentOf(node)
  ) {
    const span = store.spanOf(node)
    if (span.start <= offset && offset < span.end) return node
  }
  return 0
}

/**
 * The innermost node whose span *fully contains* `[start, end)` — M3-PLAN.md
 * F4's "the innermost node whose span fully contains the edit," the unit
 * subtree splicing reparses. Same walk-up-through-ancestors shape as
 * `nodeContainingOffset`, generalized from a point to a range: the node
 * found by descending from `start` may not extend far enough to also cover
 * `end`, in which case its parent (always wider) is the next candidate.
 *
 * **A zero-width insertion landing exactly on a node's own boundary is
 * deliberately biased toward the parent, not the touching node.** A
 * replacement spanning right up to a node's edge (`end === span.end`) is
 * unambiguous — it's replacing that node's own trailing content. But an
 * *insertion* exactly there (`start === end === span.end`, e.g. new text
 * typed right before a closing delimiter) is really adding a new sibling
 * inside the *parent*, not extending the touching node's own content —
 * splicing it into the touching node instead feeds `parseRange` a range
 * whose grammar no longer makes sense on its own (a scalar's value with
 * trailing structural punctuation appended), which produces a wrong,
 * *not* a failed, reparse rather than the safe fallback a genuinely
 * malformed range gets. So for a zero-width edit, containment requires
 * `start`/`end` to fall *strictly inside* a candidate's span, not merely
 * touch either edge — which walks up to the parent whenever the insertion
 * point coincides with a child boundary. Always safe (a wider reparse is
 * still correct, just larger than the theoretical minimum); genuinely
 * optimizing which side an edge insertion prefers is a granularity
 * question §13 explicitly leaves to measurement, not this function.
 *
 * `null` only when nothing does — an out-of-range `start`/`end` (past the
 * document, or spanning before offset 0), or an empty store. A real edit
 * inside an open document should never produce this: the root's own span
 * covers the whole buffer.
 */
export function nodeContainingRange(store: NodeStore, start: Offset, end: Offset): NodeRef | null {
  if (store.nodeCount === 0) return null
  const isInsertion = start === end

  for (
    let node = lastNodeStartingAtOrBefore(store, start);
    node !== -1;
    node = store.parentOf(node)
  ) {
    const span = store.spanOf(node)
    const contains = isInsertion
      ? span.start < start && start < span.end
      : span.start <= start && end <= span.end
    if (contains) return node
  }
  return null
}
