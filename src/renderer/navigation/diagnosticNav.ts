/**
 * Pure diagnostic-navigation logic (UI-FEEDBACK.md, CONCEPT.md §11.1 — "on
 * a 200 MB document a marker you can see but cannot jump to is
 * decoration"). Diagnostics aren't guaranteed offset-sorted by the parser
 * (`NodeSink.diagnostic` only promises report-and-continue, not ordering),
 * so both functions search a sorted copy.
 *
 * That copy is made **once per list**, not once per keypress. It used to be
 * the latter — a full copy-and-sort on every next/previous — which R200 §6
 * called out while capping the list itself: a bound on the array is not a
 * licence to keep doing O(n log n) work per keystroke on whatever is left.
 * The cache is keyed on the array's identity, which `NodeStore.diagnostics`
 * guarantees is stable for an unchanged store, and is weak so a closed
 * document's diagnostics are not held alive by it.
 *
 * `null` at either boundary — no wraparound — the same convention
 * `history.ts`'s `stepBack`/`stepForward` already use for this codebase's
 * other next/previous pair, kept consistent rather than inventing cyclic
 * navigation here.
 */
import type { Diagnostic } from '../../core/types'

const sortCache = new WeakMap<readonly Diagnostic[], readonly Diagnostic[]>()

/** Exported for `test/diagnosticVolume.test.ts`, which asserts the cache
 * rather than the ordering — R200 acceptance 8 is about how often this runs,
 * and there is no other way to observe that from outside. */
export function sortedByOffset(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  const cached = sortCache.get(diagnostics)
  if (cached !== undefined) return cached
  const sorted = [...diagnostics].sort((a, b) => a.offset - b.offset)
  sortCache.set(diagnostics, sorted)
  return sorted
}

/** The closest diagnostic after `currentOffset`, or `null` if none. */
export function nextDiagnostic(
  diagnostics: readonly Diagnostic[],
  currentOffset: number
): Diagnostic | null {
  return sortedByOffset(diagnostics).find((d) => d.offset > currentOffset) ?? null
}

/** The closest diagnostic before `currentOffset`, or `null` if none. */
export function previousDiagnostic(
  diagnostics: readonly Diagnostic[],
  currentOffset: number
): Diagnostic | null {
  let result: Diagnostic | null = null
  for (const d of sortedByOffset(diagnostics)) {
    if (d.offset >= currentOffset) break
    result = d
  }
  return result
}
