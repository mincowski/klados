/**
 * R213 (`docs/plans/R213-grid-view-state.md` § 5): the one place a grid's
 * *results* outlive the grid — the display order it computed from its sort and
 * filters — and the deliberate exception to "store view state, never results".
 *
 * **Why it exists.** Restoring re-runs the filter pass and the sort. Measured on
 * the 200 MB fixture (633,268 rows), switching back to a group took **0.5 s**
 * with no state, **1.4 s** sorted and **7.0 s** sorted with a quick filter — the
 * filter pass alone is 5.9 s, the same as typing it. The plan said caching is
 * reconsidered when that measurement says switching is too slow; it did, and the
 * project lead chose this.
 *
 * **What it costs, stated.** One `Int32Array` of display order per entry,
 * **4 bytes per visible row**: 2.5 MB for the 200 MB fixture unfiltered, 8 MB for
 * a two-million-row group. At most two entries, and at most **one** belongs to a
 * grid that is not on screen — the other, when present, is the mounted grid's
 * own, whose rows are held by that grid anyway. That is what makes flipping
 * between two sorted groups instant both ways, which a single slot does not: the
 * slot would always hold the grid just left, never the one being returned to.
 *
 * **What it never holds**: the document. Entries reference the `NodeStore` and
 * `SourceBuffer` weakly, because every edit replaces both, and a strong reference
 * would keep a superseded 200 MB document alive for as long as the entry lived.
 * An entry whose store is gone matches nothing and is pruned.
 */
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import type { GridFilters } from './gridFilter'
import type { SortDirection } from './gridSort'
import type { GridViewKey } from './gridViewState'

export interface ResultIdentity {
  readonly viewKey: GridViewKey
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly node: NodeRef
  readonly groupKey: string
  readonly sort: { readonly nameId: number; readonly direction: SortDirection } | null
  readonly extraColumns: ReadonlySet<number>
  /** The **committed** filters the order was computed from — not the text in
   * the boxes, which can be ahead of it inside the keystroke debounce. */
  readonly filters: GridFilters
}

export interface CachedResult {
  /** Indices into the group's members, in display order. */
  readonly order: Int32Array
  readonly hiddenMatchCount: number
  readonly hiddenMatchColumns: readonly number[]
}

interface Entry {
  readonly tabId: string | null
  readonly filePath: string
  readonly store: WeakRef<NodeStore>
  readonly sourceBuffer: WeakRef<SourceBuffer>
  readonly node: NodeRef
  readonly groupKey: string
  readonly sort: ResultIdentity['sort']
  readonly extraColumns: readonly number[]
  readonly quick: string
  readonly perColumn: readonly (readonly [number, string])[]
  readonly result: CachedResult
}

export const GRID_RESULT_CACHE_ENTRIES = 2

/** Oldest first. */
let entries: Entry[] = []
let hits = 0

function sameGrid(entry: Entry, id: ResultIdentity): boolean {
  return (
    entry.tabId === id.viewKey.tabId &&
    entry.filePath === id.viewKey.filePath &&
    entry.store.deref() === id.store &&
    entry.sourceBuffer.deref() === id.sourceBuffer &&
    entry.node === id.node &&
    entry.groupKey === id.groupKey
  )
}

function sameState(entry: Entry, id: ResultIdentity): boolean {
  if (entry.sort?.nameId !== id.sort?.nameId || entry.sort?.direction !== id.sort?.direction)
    return false
  if (entry.extraColumns.length !== id.extraColumns.size) return false
  for (const c of entry.extraColumns) if (!id.extraColumns.has(c)) return false
  if (entry.quick !== id.filters.quick) return false
  if (entry.perColumn.length !== id.filters.perColumn.size) return false
  for (const [c, text] of entry.perColumn) if (id.filters.perColumn.get(c) !== text) return false
  return true
}

function prune(): void {
  entries = entries.filter((e) => e.store.deref() !== undefined)
}

/**
 * A mounting grid asks for its result. **Also enforces the memory rule**: after
 * this, the only entries left are this grid's own (if it matched) and the most
 * recent entry for any other grid — so at most one grid not on screen is held.
 */
export function takeCachedResult(id: ResultIdentity): CachedResult | null {
  prune()
  const hit = entries.find((e) => sameGrid(e, id) && sameState(e, id))
  const others = entries.filter((e) => !sameGrid(e, id))
  const newestOther = others.at(-1)
  entries = [
    ...(newestOther === undefined ? [] : [newestOther]),
    ...(hit === undefined ? [] : [hit])
  ]
  if (hit !== undefined) hits++
  return hit?.result ?? null
}

/**
 * An unmounting grid leaves its result. Only a grid that paid for one leaves
 * anything: with no sort and no filter the order is the members' own, rebuilt in
 * milliseconds, and caching it would spend memory to save nothing — and would
 * evict an entry that does save something.
 */
export function leaveCachedResult(
  id: ResultIdentity,
  displayIndices: readonly number[],
  hiddenMatchCount: number,
  hiddenMatchColumns: readonly number[]
): void {
  prune()
  entries = entries.filter((e) => !sameGrid(e, id))
  const filtered = id.filters.quick.trim().length > 0 || id.filters.perColumn.size > 0
  if (id.sort === null && !filtered) return
  entries.push({
    tabId: id.viewKey.tabId,
    filePath: id.viewKey.filePath,
    store: new WeakRef(id.store),
    sourceBuffer: new WeakRef(id.sourceBuffer),
    node: id.node,
    groupKey: id.groupKey,
    sort: id.sort,
    extraColumns: [...id.extraColumns],
    quick: id.filters.quick,
    perColumn: [...id.filters.perColumn],
    result: { order: Int32Array.from(displayIndices), hiddenMatchCount, hiddenMatchColumns }
  })
  while (entries.length > GRID_RESULT_CACHE_ENTRIES) entries.shift()
}

/** For tests: how many rows' worth of order the cache holds in total. */
export function cachedRowCountForTests(): number {
  return entries.reduce((sum, e) => sum + e.result.order.length, 0)
}

/** For tests: how many mounts have reused a cached order. The hit path gives the
 * same rows as a recomputation by design, so a test cannot tell them apart from
 * the rendered table alone. */
export function cacheHitCountForTests(): number {
  return hits
}

export function resetGridResultCacheForTests(): void {
  entries = []
  hits = 0
}
