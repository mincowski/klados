/**
 * Lets a registry command reach the currently-mounted `Tree` view — D14's
 * "Locate in tree," which needs to expand whatever ancestors of a node
 * aren't already expanded and scroll to it, both of which are Tree's own
 * internal state (`expandedRef`). Same "component registers a live handle
 * with a module-level singleton" shape as `rawController.ts` and
 * `focus.ts`'s `registerPane`. M1 ships exactly one Tree view (no tabs,
 * §11.4), so "the current one" is unambiguous.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'

export interface TreeController {
  locateNode(node: NodeRef): void
  /** M5c-PLAN.md J6 / D-052 — both scoped to whatever `Tree.tsx` itself
   * currently resolves as "the selection, or the root when there is
   * none." Renamed from `expandAll`; kept as one interface entry per verb
   * rather than two (a document-wide vs. scoped variant) since selecting
   * Document and expanding is already exactly the old document-wide
   * behaviour (D-053 records why the Tree keeps that row). */
  expandSubtree(): void
  collapseSubtree(): void
}

let current: TreeController | null = null

export function registerTreeController(controller: TreeController): () => void {
  current = controller
  return () => {
    if (current === controller) current = null
  }
}

/** A no-op if no Tree view is mounted — a command running with nothing to
 * act on is not an error. Safe to call synchronously from a user-triggered
 * command handler (`navigation/commands.ts`'s `goBack`/`gotoDiagnostic`
 * etc.): `store` hasn't changed underneath the currently-mounted Tree in
 * that same tick, so `current`'s closure is already correct. **Not** safe
 * to call synchronously right after a reparse replaces `store` — see
 * `requestReveal` below for that case. */
export function locateInTree(node: NodeRef): void {
  current?.locateNode(node)
}

/**
 * A reparse-driven relocation (M3-PLAN.md F5) can't use `locateInTree`
 * directly: `documentSession.ts` calls this the moment its own `setState`
 * lands a brand-new `NodeStore`, but Tree's `registerTreeController` effect
 * — the thing that closes `expandAncestors` over the *current* `store` —
 * only re-runs once React has actually re-rendered `Tree` with that new
 * store, which has not happened yet in the same synchronous continuation.
 * Calling the still-registered controller then would walk `parentOf` on
 * the *old* store with a `NodeRef` from the *new* one: silently wrong at
 * best (a numerically valid but unrelated ancestor chain), an infinite
 * loop at worst (`NodeStore.parentOf` never throws on an out-of-range
 * index — a plain typed-array read returns `undefined`, and `undefined
 * !== -1` never terminates the walk).
 *
 * So this is a request, not a call: `store` is recorded alongside `node`,
 * and `Tree`'s own `[store]`-keyed effect — which by construction only
 * runs after it has actually re-rendered with that exact store — is what
 * consumes it, via `consumePendingReveal`. If Tree isn't mounted when the
 * request lands, or a *later* reparse replaces `store` again before Tree
 * ever reads it, `consumePendingReveal`'s store-identity check refuses to
 * apply the stale request against a store it wasn't made for — a mismatch
 * leaves it pending rather than discarding it outright, in case Tree
 * later renders with the exact store it *was* requested for (deliberately
 * conservative: dropping a request whose target store hasn't been
 * observed yet could lose a genuine relocation, where retaining one stale
 * `NodeStore` reference until the next document open costs one document's
 * worth of memory once, not per edit). `documentSession.ts` clears it
 * explicitly via `clearPendingReveal` whenever a document closes or a
 * different one starts opening, which is the actual bound on how long a
 * stale reference can live.
 */
export function requestReveal(node: NodeRef, store: NodeStore): void {
  pendingReveal = { node, store }
}

let pendingReveal: { readonly node: NodeRef; readonly store: NodeStore } | null = null

/** `null` unless a reveal is pending for exactly `forStore` — see
 * `requestReveal`'s own doc comment for why the store identity must match
 * exactly rather than just returning whatever is pending, and why a
 * mismatch leaves `pendingReveal` alone instead of clearing it. */
export function consumePendingReveal(forStore: NodeStore): NodeRef | null {
  if (pendingReveal === null || pendingReveal.store !== forStore) return null
  const node = pendingReveal.node
  pendingReveal = null
  return node
}

/** Drops any pending reveal unconditionally — `documentSession.ts` calls
 * this whenever the document it could have referred to is going away
 * (closing, or being replaced by a different file entirely), the one
 * place it's safe to say for certain no future store will ever match it. */
export function clearPendingReveal(): void {
  pendingReveal = null
}

/** Same no-op-when-unmounted rule as `locateInTree`. */
export function expandSubtreeInTree(): void {
  current?.expandSubtree()
}

/** Same no-op-when-unmounted rule as `locateInTree`. */
export function collapseSubtreeInTree(): void {
  current?.collapseSubtree()
}
