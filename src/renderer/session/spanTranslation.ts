/**
 * R42 (`R42-stale-spans.md`, D-070): the single seam every UI read path
 * translates a `NodeStore` span through before decoding text from a buffer
 * that may already have moved past it. Between an edit landing and the
 * debounced reparse (or splice) replacing `store`, `store`'s spans are the
 * *previous* parse's — `OpenDocument.pendingSpanDeltas` is the shift
 * recorded since then, and `translateSpan` is what every call site funnels
 * through rather than reading `Span.start`/`Span.end` raw. Kept to one
 * function precisely so a future read path can't forget the translation the
 * way `deltaList.ts`'s own doc comment names as the exact failure mode this
 * exists to make rare.
 */
import { shiftedOffset, type DeltaList } from '../../core/deltaList'
import type { Span } from '../../core/nodeStore'

/** `deltas.length === 0` — the overwhelming common case, between reparses —
 * returns `span` itself rather than an equivalent copy, so a caller that
 * never edits pays nothing beyond this one check. */
export function translateSpan(span: Span, deltas: DeltaList): Span {
  if (deltas.length === 0) return span
  return { start: shiftedOffset(deltas, span.start), end: shiftedOffset(deltas, span.end) }
}
