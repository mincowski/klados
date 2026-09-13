/**
 * The uncapped record of *where* every diagnostic was, kept as typed arrays
 * alongside the capped list of diagnostic records themselves
 * (`docs/plans/R200-diagnostic-volume.md` §5).
 *
 * WHY IT EXISTS: `NodeStore.diagnostic` used to be an unbounded `push`, and
 * a defect that repeats per item — a CSV export with a stray trailing
 * delimiter on every data row, an encoder that never escapes `&` — produces
 * one diagnostic per item in every format. At 2 M of them that is ~300 MB of
 * objects and message strings, and the scrubber rendered one `<div>` per
 * diagnostic into a strip a few hundred pixels tall.
 *
 * Capping the records alone would have broken the scrubber in the worst
 * possible way: parsers walk forward, so the first N diagnostics are very
 * nearly the first N *by offset*, and a strip drawn from a capped list would
 * put every mark in its top slice and leave the rest of the document looking
 * clean. So the positions are kept separately and in full — 4 bytes each,
 * no allocation per item — and the strip buckets them the way `matchMarkers`
 * already buckets search hits.
 *
 * WHY THREE ARRAYS RATHER THAN OFFSETS + A PARALLEL SEVERITY BYTE: the strip
 * draws a *kind* per marker and the status bar counts per severity, so both
 * consumers want the positions grouped by severity anyway. Splitting at write
 * time makes each list independently sortable (no permutation sort to keep a
 * parallel array paired), makes the per-severity totals free, and costs 4
 * bytes per entry instead of 5.
 *
 * Invariant 2's shape, applied to diagnostics: parallel typed arrays rather
 * than an object per item. That is what makes leaving this half uncapped
 * affordable at all.
 */
import { Severity, type Offset } from './types'

/** How many records of any one `code` the navigable list keeps. Per code, not
 * overall, so a file with 500,000 `csv.long-row` warnings does not push out
 * the three `xml.mismatched-end-tag` errors that are the interesting part.
 * The set of codes is closed — every one is a string literal in a parser — so
 * a per-code bound is still a bound overall. */
export const DIAGNOSTIC_CAP_PER_CODE = 100

/** The code of the synthesized entry `NodeStore.diagnostics` appends when
 * anything was suppressed. Not emitted by any parser. */
export const DIAGNOSTICS_CAPPED_CODE = 'klados.diagnostics-capped'

/** Sorted, trimmed positions — the form the scrubber's bucketing needs
 * (`countMatchesInRange` binary-searches, so ascending is a precondition).
 * Also what crosses the worker boundary. */
export interface DiagnosticIndexBuffers {
  readonly warning: Int32Array
  readonly error: Int32Array
  readonly fatal: Int32Array
}

const SEVERITY_COUNT = 3
const INITIAL_CAPACITY = 64

function slotOf(severity: Severity): number {
  // `Severity` is Warning = 0, Error = 1, Fatal = 2, so the enum value is the
  // slot. Clamped rather than trusted: `diagnostic()` is reachable from the
  // worker's own hand-built diagnostics as well as from parsers, and an
  // out-of-range slot would silently write past the array set.
  const s = severity as number
  return s >= 0 && s < SEVERITY_COUNT ? s : 0
}

export class DiagnosticIndex {
  private lists: Int32Array[] = [new Int32Array(0), new Int32Array(0), new Int32Array(0)]
  private counts: number[] = [0, 0, 0]
  /** Sorted/trimmed view, built once and reused. Invalidated by `add`, so the
   * sort happens once per parse rather than once per render — the trap
   * `diagnosticNav` fell into with a full copy-and-sort per keypress. */
  private view: DiagnosticIndexBuffers | null = null

  add(severity: Severity, offset: Offset): void {
    const slot = slotOf(severity)
    let list = this.lists[slot]!
    const n = this.counts[slot]!
    if (n === list.length) {
      const grown = new Int32Array(Math.max(INITIAL_CAPACITY, list.length * 2))
      grown.set(list)
      this.lists[slot] = grown
      list = grown
    }
    list[n] = offset
    this.counts[slot] = n + 1
    this.view = null
  }

  /** Every position recorded, including the ones whose records were not
   * retained — which is what makes the status bar's counts truthful against a
   * capped list. */
  get total(): number {
    return this.counts[0]! + this.counts[1]! + this.counts[2]!
  }

  countOf(severity: Severity): number {
    return this.counts[slotOf(severity)]!
  }

  /** The highest severity anything was recorded at, or `null` for an empty
   * index. */
  get maxSeverity(): Severity | null {
    if (this.counts[2]! > 0) return Severity.Fatal
    if (this.counts[1]! > 0) return Severity.Error
    if (this.counts[0]! > 0) return Severity.Warning
    return null
  }

  /**
   * Ascending positions per severity. Emission order is *nearly* but not
   * strictly ascending — XML's unwind loop emits `xml.unclosed-element` at
   * each still-open frame's `nameStart` after reaching EOF, which runs
   * backwards — so this sorts rather than trusting the parser's order.
   */
  positions(): DiagnosticIndexBuffers {
    if (this.view === null) {
      this.view = {
        warning: this.lists[0]!.slice(0, this.counts[0]!).sort(),
        error: this.lists[1]!.slice(0, this.counts[1]!).sort(),
        fatal: this.lists[2]!.slice(0, this.counts[2]!).sort()
      }
    }
    return this.view
  }

  /** Every recorded position, in emission order — for callers that have to
   * rebuild an index rather than read one (`subtreeSplice.ts`, which shifts
   * offsets across a graft). */
  forEach(fn: (severity: Severity, offset: Offset) => void): void {
    for (let slot = 0; slot < SEVERITY_COUNT; slot++) {
      const list = this.lists[slot]!
      const n = this.counts[slot]!
      for (let i = 0; i < n; i++) fn(slot as Severity, list[i]!)
    }
  }

  /** `positions()` by another name — the two halves of a worker transfer are
   * `exportBuffers`/`fromBuffers`, matching `NodeStore`'s own naming. */
  exportBuffers(): DiagnosticIndexBuffers {
    return this.positions()
  }

  static fromBuffers(buffers: DiagnosticIndexBuffers): DiagnosticIndex {
    const index = new DiagnosticIndex()
    index.lists = [buffers.warning, buffers.error, buffers.fatal]
    index.counts = [buffers.warning.length, buffers.error.length, buffers.fatal.length]
    // Already sorted and trimmed by the `exportBuffers` that produced them,
    // so the view is valid as-is; re-sorting on first read would be correct
    // but would repeat the one piece of work this transfer exists to carry.
    index.view = buffers
    return index
  }
}
