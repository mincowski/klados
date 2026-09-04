/**
 * The pending-delta list (M3-PLAN.md F2, CONCEPT.md §5.2, D-010). A short,
 * ascending `(position, delta)` list is what stands between an edit and
 * rewriting every stored offset in the document — M0a measured a bulk
 * shift at **231.5 ms** at shipped node density, "far past the point
 * where a per-edit fixup is viable." A read pays a binary search instead.
 *
 * **Coordinate space, stated explicitly because nothing else pins it
 * down**: every `Delta.position` is in *original* coordinates — the byte
 * offsets `NodeStore`'s spans, the row index and the line index were
 * built against at the last full reparse. `shiftedOffset` is a one-way,
 * forward transform: original offset in, current (post-edit) offset out.
 *
 * **`position` is the *end* of the edited region, not its start** — easy
 * to get backwards, and getting it backwards produces exactly the kind of
 * bug this module exists to make rare: silently-wrong-but-plausible
 * offsets. An edit replacing original `[start, end)` overwrites that
 * region; it does not shift it. Only offsets at or after `end` describe
 * content that still exists and has simply moved — so `position` must be
 * `end`, and `recordDelta(list, end, newLength - (end - start))` is the
 * call an edit actually makes. An original offset strictly inside
 * `[start, end)` has no well-defined post-edit position (that content was
 * replaced), and `shiftedOffset` does not attempt to give it one — it
 * reads as unshifted, which is a reasonable default for something the
 * next full reparse or subtree splice (F3/F4) will replace anyway, but is
 * not meaningful on its own.
 *
 * Translating a live, current-buffer edit position back into original
 * coordinates before calling `recordDelta` — and deciding when two edits'
 * regions overlap closely enough to need coalescing rather than two
 * independent entries — is F3/F4's job (subtree splicing, debounced
 * reparse), the tasks that actually see real edits. This module assumes
 * whatever it is given already satisfies that contract; it does not
 * derive or validate it.
 *
 * **Why the line index needs no shifting logic of its own**, despite
 * §5.2 naming it alongside the row index and node-store spans as
 * something that "shifts by the same mechanism": `LineIndex.checkpoints`
 * holds newline *counts*, not offsets — a byte-level shift is meaningless
 * against a count. What actually shifts is the row index (an `Int32Array`
 * of offsets, exactly the shape `fold` operates on); the line index is
 * then just rebuilt from the folded row index via the existing
 * `buildLineIndex` (`rowIndex.ts`), already "cheap enough to run
 * unconditionally" per its own doc comment. There is nothing here to
 * build for it beyond reusing what already exists.
 *
 * **`fold` only shifts; it cannot grow or shrink an array — a real
 * boundary, not an edge case.** An edit that adds or removes a row (any
 * edit that inserts or deletes a newline) needs a new or missing entry in
 * the row index, and `fold` mutates each existing element in place; it
 * has no way to insert one. Feeding such an edit through `fold` alone
 * silently produces a row index with the *wrong number of rows* —
 * `test/deltaList.test.ts` has a regression test pinning this down, not
 * just describing it. This module only ever handles the row/line-count-
 * preserving case correctly; splicing rows in or out for one that isn't
 * is F3/F4's job (subtree splicing owns exactly this), not something a
 * caller can paper over by calling `fold` anyway.
 */

export interface Delta {
  readonly position: number
  readonly delta: number
}

/** Ascending by `position`, `recordDelta`'s own invariant to maintain. */
export type DeltaList = readonly Delta[]

export const EMPTY_DELTA_LIST: DeltaList = []

/** Past this many entries, a background full reparse folds the list back
 * to empty (§5.2) — a policy value for whichever task actually schedules
 * that reparse (F3), not enforced here. `shouldFold` just answers the
 * question against the constant, kept in one place. */
export const FOLD_THRESHOLD = 64

export function shouldFold(list: DeltaList): boolean {
  return list.length > FOLD_THRESHOLD
}

/**
 * Inserts `{ position, delta }` keeping the list ascending by position.
 * `position` is the *end* of the edited region in original coordinates,
 * not its start — see this module's own top comment for why.
 * Two entries at exactly the same position merge into one (summed) rather
 * than both being kept — the list stays "few entries" as intended, and a
 * position can only ever need one cumulative shift value regardless of
 * how many times something was recorded there. A merged entry whose sum
 * is `0` is dropped entirely: a net-zero shift at a position is the same
 * as no entry at all, and keeping it would only cost binary-search steps
 * for nothing.
 *
 * Does not attempt to detect or coalesce *overlapping* regions between
 * two non-identical positions — see this module's own top comment.
 */
export function recordDelta(list: DeltaList, position: number, delta: number): DeltaList {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid]!.position < position) lo = mid + 1
    else hi = mid
  }

  const existing = list[lo]
  if (existing !== undefined && existing.position === position) {
    const merged = existing.delta + delta
    if (merged === 0) return [...list.slice(0, lo), ...list.slice(lo + 1)]
    return [...list.slice(0, lo), { position, delta: merged }, ...list.slice(lo + 1)]
  }
  return [...list.slice(0, lo), { position, delta }, ...list.slice(lo)]
}

/**
 * Original offset → current offset: the cumulative sum of every delta at
 * or before `offset`, added to it. Binary-searches for the last entry
 * with `position <= offset`, then sums everything up to and including it
 * — one pass rather than re-walking from the start on every call, since
 * the list is already sorted ascending.
 */
export function shiftedOffset(list: DeltaList, offset: number): number {
  if (list.length === 0) return offset

  let lo = 0
  let hi = list.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (list[mid]!.position <= offset) lo = mid
    else hi = mid - 1
  }

  if (list[lo]!.position > offset) return offset

  let sum = 0
  for (let i = 0; i <= lo; i++) sum += list[i]!.delta
  return offset + sum
}

/**
 * Applies every entry's shift, in place, to a plain `Int32Array` of
 * original-coordinate offsets — `NodeStore`'s `spanStart`/`spanEnd`, or
 * the row index, are exactly this shape regardless of what they mean
 * semantically. The one implementation §5.2 asks for: each element is
 * looked up independently via `shiftedOffset`, so `values` need not
 * itself be sorted (unlike `list`, which must be).
 *
 * Idempotent by construction: folding `EMPTY_DELTA_LIST` — which is what
 * a caller has *after* folding once — is a no-op, since `shiftedOffset`
 * against an empty list returns its input unchanged.
 */
export function fold(values: Int32Array, list: DeltaList): Int32Array {
  if (list.length === 0) return values
  for (let i = 0; i < values.length; i++) {
    values[i] = shiftedOffset(list, values[i]!)
  }
  return values
}
