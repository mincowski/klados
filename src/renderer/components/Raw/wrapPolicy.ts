/**
 * The Raw View's wrap decision (M1-PLAN.md D12, CONCEPT.md §3.1). Soft
 * wrap is load-bearing, not a preference: a single-line window has no
 * vertical scroll surface, and the window advances on scroll, so without
 * wrap it can never move.
 *
 * The one testable rule, kept pure: whether a window's content has a
 * vertical scroll surface at all. Everything else about *when* this gets
 * checked and how a manual override interacts with it is DOM-dependent
 * (measuring `scrollHeight`/`clientHeight` needs a live `EditorView`) and
 * lives in `Raw.tsx` instead — see that file's `reevaluateWrap` for why the
 * check has to run in the unwrapped state to mean anything (wrapping only
 * ever *adds* visual rows, so measuring while already wrapped can't tell
 * you whether unwrapped content would still scroll).
 *
 * The decision is tested directly on the window (`scrollHeight <=
 * clientHeight`), never inferred from a document-wide statistic like mean
 * row length — a file of otherwise normal lines can still produce a
 * single-line *window* over one pathological region, so the decision has
 * to belong to the window, not the document.
 */
export function needsWrapToScroll(scrollHeight: number, clientHeight: number): boolean {
  // `clientHeight <= 0` means the element hasn't been laid out yet (or is
  // detached) — not evidence one way or the other, so don't act on it.
  if (clientHeight <= 0) return false
  return scrollHeight <= clientHeight
}
