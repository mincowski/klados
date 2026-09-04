/**
 * Chunks a path-query evaluation through G3's scheduler (M4-PLAN.md G8's
 * own "runs through G3's scheduler: lazy, chunked, cancellable, progress
 * past ~50 ms" — and hard rule 3: "anything that could exceed ~50 ms is
 * chunked, cancellable, and reports progress"). `core/path/evaluate.ts`'s
 * `evaluatePathStep` does one step at a time; this is the thin renderer-
 * side wrapper that turns a whole path into a resumable `runChunkedJob`.
 *
 * **What this bounds, and what it did not until R130.** Slicing used to
 * happen at step granularity only — G10 measured a facet predicate at
 * 163–314 ms on a 100–200 MB fixture and this module disclosed it as a
 * single unit the scheduler could not interrupt (`M4-RESULTS.md` §4). R129
 * makes that worse in principle rather than better: a comparison predicate
 * is linear in candidate count, so a large enough document crosses
 * M4-PLAN.md hard rule 3's ~50 ms bar inside one step no matter how cheap
 * the per-candidate work is. So R130 splits a predicate too:
 * `startPathStep` hands back a job that filters `PREDICATE_BATCH`
 * candidates per call, and one `runChunkedJob` step is one batch. The
 * scheduler therefore reads the clock once per batch rather than once per
 * candidate, which R129 §6 measured as the difference between +2 ms and
 * +27.5 ms of overhead — a `performance.now()` per candidate costs more
 * than the entire evaluation it guards.
 *
 * Cancellation keeps the guarantee it already had, now mid-predicate as
 * well as mid-path: a cancelled job's promise rejects and no partial
 * `Int32Array` is ever handed out, because a partial filter simply never
 * becomes a value (`advance` returns `null` until it is complete).
 */
import type { SourceBuffer } from '../../core/buffer'
import type { NameIndex } from '../../core/nameIndex'
import type { NodeStore } from '../../core/nodeStore'
import { PREDICATE_BATCH, startPathStep, type PathStepJob } from '../../core/path/evaluate'
import type { ParsedPath } from '../../core/path/parse'
import { runChunkedJob, type SearchJob } from '../session/searchJob'

const ROOT = 0

interface PathJobState {
  readonly stepIndex: number
  readonly context: Int32Array
  /** The in-progress step, or `null` before it has been started. Held in
   * the state rather than in a closure so the shape stays what
   * `runChunkedJob` documents: one immutable state threaded through. */
  readonly job: PathStepJob | null
}

export function evaluatePathChunked(
  store: NodeStore,
  nameIndex: NameIndex,
  source: SourceBuffer,
  path: ParsedPath
): SearchJob<Int32Array> {
  return runChunkedJob<PathJobState, Int32Array>(
    { stepIndex: 0, context: Int32Array.from([ROOT]), job: null },
    (state) => {
      if (state.stepIndex >= path.steps.length || state.context.length === 0) {
        return { done: true, value: state.context }
      }
      const job =
        state.job ??
        startPathStep(store, nameIndex, source, state.context, path.steps[state.stepIndex]!)
      const nextContext = job.advance(PREDICATE_BATCH)
      if (nextContext === null) {
        // Same step, more candidates — yield with the job carried forward.
        return { done: false, state: { ...state, job } }
      }
      return {
        done: false,
        state: { stepIndex: state.stepIndex + 1, context: nextContext, job: null }
      }
    }
  )
}
