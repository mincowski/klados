/**
 * The chunked job scheduler (M4-PLAN.md G3, CONCEPT.md §6.6/§8) — the one
 * place that decides how a whole-document operation is sliced. Everything
 * in this milestone that touches the whole document runs through it: G2's
 * text-find scans, G8's path evaluation, and G1's rebuild if patching ever
 * turns out to cost more than it saves.
 *
 * **Why chunking, not a worker.** §6.6 says queries run in the worker; the
 * architecture that exists doesn't support that today (see M4-PLAN.md's own
 * "Where search runs" section) — a parse's worker terminates the instant
 * its `done` message transfers the store away, so there is no worker-side
 * store left to query. §8's actual requirement is "chunked *or* moved
 * off-thread so the UI never blocks," and chunking satisfies it without a
 * seam change this milestone has no independent reason to make. Search jobs
 * are expressed against this scheduler rather than `setTimeout` directly so
 * a future worker/SharedArrayBuffer swap (M5 has its own reason to revisit
 * shared memory) is a later swap behind this interface, not a rewrite of
 * every call site.
 *
 * **A slice is sized by elapsed time, not item count** (§6.6: "4 MB of
 * ASCII bytes and 4 MB of dense markup are not the same amount of work").
 * Yielding is a real `setTimeout(0)` between slices, not just a time cap on
 * one slice — giving control back to the event loop (and a paint) is the
 * actual requirement, not merely bounding how long a single slice runs.
 *
 * **Cancellation has no race window**, unlike the `AbortController`-based
 * discipline `documentSession.ts` needs (and once got wrong — `174606f`,
 * "clear, don't just abort"): here, `cancel()` sets a flag checked
 * synchronously at the top of every slice, before that slice can ever
 * resolve the job's promise. JavaScript's single-threaded execution means
 * there is no window in which an already-scheduled slice can resolve after
 * `cancel()` has run — no separate "is this still the active job" check is
 * needed at the call site the way `runReparse` needs `reparseAbort !==
 * controller`.
 */

/** Default slice budget, in milliseconds — small enough to leave headroom
 * for layout/paint within a ~16 ms frame even when a slice runs slightly
 * over (the check is "have I used at least this much," not a hard cap on
 * the step that pushes past it). */
export const DEFAULT_SLICE_MS = 8

export type StepResult<S, T> =
  { readonly done: false; readonly state: S } | { readonly done: true; readonly value: T }

export interface RunChunkedJobOptions<S> {
  readonly sliceMs?: number
  /** Called once per slice boundary (not once per step) with the
   * in-progress state — §6.6's "progress after ~50 ms" is a property of how
   * often slices yield, which this mirrors directly rather than adding a
   * separate timer. */
  readonly onProgress?: (state: S) => void
}

export interface SearchJob<T> {
  /** Resolves with the final value, or rejects with an `AbortError`
   * `DOMException` if `cancel()` was called first. */
  readonly result: Promise<T>
  cancel(): void
}

/**
 * Runs `step` repeatedly against `initialState`, slicing by elapsed time
 * within each `setTimeout(0)`-scheduled turn. `step` itself must be a pure,
 * synchronous, single unit of work per call — the scheduler decides how
 * many calls fit in a slice, not the step function.
 */
export function runChunkedJob<S, T>(
  initialState: S,
  step: (state: S) => StepResult<S, T>,
  options: RunChunkedJobOptions<S> = {}
): SearchJob<T> {
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS
  let cancelled = false
  let resolveResult: ((value: T) => void) | null = null
  let rejectResult: ((reason: unknown) => void) | null = null

  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  function runSlice(state: S): void {
    if (cancelled) return
    const start = performance.now()
    let current = state
    while (true) {
      const outcome = step(current)
      if (outcome.done) {
        resolveResult?.(outcome.value)
        return
      }
      current = outcome.state
      if (performance.now() - start >= sliceMs) break
    }
    if (cancelled) return
    options.onProgress?.(current)
    setTimeout(() => runSlice(current), 0)
  }

  setTimeout(() => runSlice(initialState), 0)

  return {
    result,
    cancel(): void {
      if (cancelled) return
      cancelled = true
      rejectResult?.(new DOMException('Search job cancelled', 'AbortError'))
    }
  }
}

/**
 * Holds at most one running job. Starting a new one cancels whatever is
 * currently running first — "a new query supersedes the running one; so
 * does an edit, so does closing the document" (G4), and G8's path
 * evaluation needs the identical rule. Because `runChunkedJob`'s
 * cancellation has no race window (see module comment), a consumer never
 * needs its own "is this still the active job" guard the way
 * `documentSession.ts` needs `reparseAbort !== controller` — the superseded
 * job's promise simply never resolves.
 */
export class JobSlot<T> {
  private active: SearchJob<T> | null = null

  /** Cancels whatever job currently occupies the slot, then starts `run`'s
   * job as the new occupant. */
  start(run: () => SearchJob<T>): SearchJob<T> {
    this.active?.cancel()
    const job = run()
    this.active = job
    // Once settled (resolved or cancelled), a job is no longer "the active
    // one to cancel" — without this, a later `cancel()` on the slot would
    // try to cancel an already-finished job (harmless, since `cancel()` is
    // itself a no-op once settled, but leaves a dangling reference).
    // Handles both branches explicitly (not `.finally`, whose own derived
    // promise would still reject and go unhandled) — this is bookkeeping
    // only, never the caller's own view of the result.
    const clear = (): void => {
      if (this.active === job) this.active = null
    }
    job.result.then(clear, clear)
    return job
  }

  /** Cancels the active job, if any. Idempotent. */
  cancel(): void {
    this.active?.cancel()
    this.active = null
  }
}
