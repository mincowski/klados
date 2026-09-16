/**
 * R214 (`docs/plans/R214-filter-pass.md` § 2–3): the grid's filter pass, run so
 * it never freezes the window.
 *
 * - **Up to a frame's worth before paint.** A request is started from a layout
 *   effect and stepped for `SYNC_BUDGET_MS`; a pass that finishes in that time
 *   reaches the screen in the same frame, so small tables never show a pending
 *   state and nothing flickers.
 * - **Then in slices**, `SLICE_MS` at a time between tasks, until it finishes.
 *   Meanwhile the grid keeps showing the rows it had, and `pending` says so.
 * - **A newer request abandons the running pass.** The pass has no timers of its
 *   own (`createFilterPass`); the runner stops scheduling it and it is garbage.
 * - **Narrowing**: each completed pass is kept as the base the next may narrow
 *   from (`narrowedRows`), so typing a filter forward visits fewer rows each time.
 *
 * The work lives in a runner object read through `useSyncExternalStore`, not in
 * render: starting a pass reads the clock and mutates the pass, and React's
 * rules for render forbid both.
 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import type { GridColumn } from './gridColumns'
import {
  createFilterPass,
  narrowedRows,
  type FilterOutcome,
  type FilterPass,
  type GridFilters,
  type NarrowingBase
} from './gridFilter'

/** Work done before paint before a pass moves to slices. */
export const SYNC_BUDGET_MS = 8
/** One slice between yields — well inside a 60 Hz frame. */
export const SLICE_MS = 8
/** Progress is published at most this often; per slice would re-render the
 * grid more than a hundred times a second for nothing anyone can read. */
const PROGRESS_INTERVAL_MS = 100

const EMPTY_OUTCOME: FilterOutcome = {
  indices: [],
  hiddenMatchCount: 0,
  hiddenMatchColumns: [],
  anywhere: null
}

export interface FilterPassState {
  /** The rows to show: the latest completed request's — while a newer one runs,
   * the previous request's for the same rows, or none if the rows changed. */
  readonly result: FilterOutcome
  readonly pending: boolean
  /** 0 to 1 while pending. */
  readonly progress: number
}

export interface FilterRequest {
  readonly store: NodeStore
  readonly source: SourceBuffer
  readonly members: readonly NodeRef[]
  readonly columns: readonly GridColumn[]
  readonly filters: GridFilters
}

/** R213's cached outcome, valid only for the request the grid mounted with. */
export interface InitialFilterOutcome {
  readonly outcome: FilterOutcome
  readonly columns: readonly GridColumn[]
  readonly filters: GridFilters
}

// Test hooks: a pass whose timing a test cannot control is a pass it cannot
// observe mid-way. `syncBudgetMs: 0` sends every non-trivial pass to slices;
// `paused` holds slices until released.
let syncBudgetMs = SYNC_BUDGET_MS
let paused = false
const heldTasks = new Set<() => void>()
const stats = { lastRows: 0, sliced: 0, completedSliced: 0 }

export function setFilterPassForTests(options: { syncBudgetMs?: number; paused?: boolean }): void {
  if (options.syncBudgetMs !== undefined) syncBudgetMs = options.syncBudgetMs
  if (options.paused !== undefined) {
    paused = options.paused
    if (!paused) {
      const tasks = [...heldTasks]
      heldTasks.clear()
      for (const task of tasks) scheduleTask(task)
    }
  }
}

/** `lastRows`: rows the most recently started pass has to visit — all members,
 * or fewer when it narrowed. `sliced`: passes that outlasted the budget before
 * paint. `completedSliced`: those that ran to the end rather than being
 * abandoned. */
export function filterPassStatsForTests(): Readonly<typeof stats> {
  return { ...stats }
}

export function resetFilterPassForTests(): void {
  syncBudgetMs = SYNC_BUDGET_MS
  paused = false
  heldTasks.clear()
  stats.lastRows = 0
  stats.sliced = 0
  stats.completedSliced = 0
}

/** Runs `callback` as soon as the current task has yielded — without
 * `setTimeout`'s clamping of nested timers to 4 ms. */
function scheduleTask(callback: () => void): () => void {
  if (paused) {
    heldTasks.add(callback)
    return () => heldTasks.delete(callback)
  }
  const channel = new MessageChannel()
  channel.port1.onmessage = () => callback()
  channel.port2.postMessage(null)
  return () => {
    channel.port1.onmessage = null
    channel.port1.close()
  }
}

export class FilterPassRunner {
  private request: FilterRequest | null = null
  private base: NarrowingBase | null = null
  private shown: { readonly members: readonly NodeRef[]; readonly outcome: FilterOutcome } | null =
    null
  private cancelTask: () => void = () => {}
  private initial: InitialFilterOutcome | null
  private snapshot: FilterPassState
  private readonly listeners = new Set<() => void>()

  constructor(initial: InitialFilterOutcome | null) {
    this.initial = initial
    this.snapshot = {
      result: initial?.outcome ?? EMPTY_OUTCOME,
      pending: initial === null,
      progress: 0
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): FilterPassState => this.snapshot

  private publish(snapshot: FilterPassState): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private complete(request: FilterRequest, outcome: FilterOutcome): void {
    this.base = { ...request, outcome }
    this.shown = { members: request.members, outcome }
    this.publish({ result: outcome, pending: false, progress: 1 })
  }

  run(request: FilterRequest): void {
    const previous = this.request
    if (
      previous !== null &&
      previous.store === request.store &&
      previous.source === request.source &&
      previous.members === request.members &&
      previous.columns === request.columns &&
      previous.filters === request.filters
    )
      return
    this.request = request
    this.cancelTask()
    this.cancelTask = () => {}

    const initial = this.initial
    this.initial = null
    if (
      initial !== null &&
      initial.filters === request.filters &&
      initial.columns === request.columns
    ) {
      this.complete(request, initial.outcome)
      return
    }

    const { store, source, members, columns, filters } = request
    const within = narrowedRows(this.base, store, source, members, filters)
    const pass = createFilterPass(store, source, members, columns, filters, { within })
    stats.lastRows = pass.total
    const done = pass.step(performance.now() + syncBudgetMs)
    if (done !== null) {
      this.complete(request, done)
      return
    }

    stats.sliced++
    this.publish({
      result:
        this.shown !== null && this.shown.members === members ? this.shown.outcome : EMPTY_OUTCOME,
      pending: true,
      progress: pass.visited / Math.max(1, pass.total)
    })
    this.slice(request, pass, performance.now())
  }

  private slice(request: FilterRequest, pass: FilterPass, lastProgress: number): void {
    this.cancelTask = scheduleTask(() => {
      if (this.request !== request) return
      const outcome = pass.step(performance.now() + SLICE_MS)
      if (outcome !== null) {
        stats.completedSliced++
        this.complete(request, outcome)
        return
      }
      const now = performance.now()
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        this.publish({ ...this.snapshot, progress: pass.visited / Math.max(1, pass.total) })
        this.slice(request, pass, now)
      } else {
        this.slice(request, pass, lastProgress)
      }
    })
  }

  dispose(): void {
    this.cancelTask()
    this.request = null
  }
}

export function useFilterPass(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  columns: readonly GridColumn[],
  filters: GridFilters,
  initial: InitialFilterOutcome | null
): FilterPassState {
  const [runner] = useState(() => new FilterPassRunner(initial))
  const state = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot)
  // A layout effect, so a pass that finishes within its budget is on screen in
  // the same frame the filter changed.
  useLayoutEffect(() => {
    runner.run({ store, source, members, columns, filters })
  }, [runner, store, source, members, columns, filters])
  useEffect(() => () => runner.dispose(), [runner])
  return state
}
