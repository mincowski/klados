/**
 * Pure diagnostic-navigation logic (UI-FEEDBACK.md, CONCEPT.md §11.1 — "on
 * a 200 MB document a marker you can see but cannot jump to is
 * decoration"). Diagnostics aren't guaranteed offset-sorted by the parser
 * (`NodeSink.diagnostic` only promises report-and-continue, not ordering),
 * so both functions sort a copy before searching.
 *
 * `null` at either boundary — no wraparound — the same convention
 * `history.ts`'s `stepBack`/`stepForward` already use for this codebase's
 * other next/previous pair, kept consistent rather than inventing cyclic
 * navigation here.
 */
import type { Diagnostic } from '../../core/types'

function sortedByOffset(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => a.offset - b.offset)
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
