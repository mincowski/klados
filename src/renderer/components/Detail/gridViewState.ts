/**
 * R213 (`docs/plans/R213-grid-view-state.md`): a table's view state outlives the
 * table. Switching group tabs unmounts the grid (`Detail.tsx` keys it per node
 * and group), and so does selecting another node; this is what the next grid
 * for the same group is initialised from.
 *
 * **Two halves, keyed differently** (§ 3):
 *
 * - **Shape** — sort, extra columns, pins, widths — describes how the user wants
 *   to read *that kind of record*, so it is kept **per group name, per
 *   document**. Sorting `book` by `year` on one shelf sorts every `book` table.
 * - **Content** — filters, the filter row, the active cell, the scroll offset —
 *   describes one table's rows, so it is kept **per node and group**. A quick
 *   filter carried to a sibling shelf would show an empty table with nothing on
 *   screen explaining why.
 *
 * **Names are stored as text, never as name ids, and the document is keyed by
 * tab and path, never by `NodeStore`.** Both were checked rather than assumed
 * (§ 3): every edit replaces `document.store` *and* `document.sourceBuffer`
 * (`documentSession.ts`), so neither object identity survives typing one
 * character; a splice keeps the `Interner` and so the name ids, but a full
 * reparse runs in a worker and returns a new `Interner`, so ids do not survive
 * that. Text does, and resolving it against a grid's columns is O(columns).
 *
 * **Nothing here is sized by row count** (§ 5): no display indices, no sorted
 * order. A restored grid re-derives both from this — unless the one bounded
 * exception, `gridResultCache.ts`, still holds the order it left with.
 */
import type { Interner } from '../../../core/interner'
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { getTabIds } from '../../session/tabs'
import type { GridColumn } from './gridColumns'
import type { GridGroup } from './gridDetection'
import type { SortDirection } from './gridSort'

export interface StoredSort {
  readonly column: string
  readonly direction: SortDirection
}

export interface GridShapeState {
  readonly sort: StoredSort | null
  readonly extraColumns: readonly string[]
  readonly pinned: readonly string[]
  readonly widths: readonly (readonly [column: string, px: number])[]
}

export interface GridContentState {
  readonly quickFilter: string
  readonly columnFilters: readonly (readonly [column: string, text: string])[]
  readonly filterRowOpen: boolean
  readonly active: { readonly row: number; readonly col: number }
  readonly scrollTop: number
  readonly scrollLeft: number
  /** The store's node count when this was written. A node ref is a position,
   * and an edit that adds or removes nodes before it points the same ref at a
   * different node; content state written under another count is discarded
   * rather than applied to whatever node now holds the ref. A value edit keeps
   * the count and the state. */
  readonly nodeCount: number
}

export const EMPTY_SHAPE: GridShapeState = { sort: null, extraColumns: [], pinned: [], widths: [] }

/** How many nodes' content state one document keeps. Every node the user
 * visits that shows a table writes one entry; the entries are O(filtered
 * columns), but the number of nodes is not bounded by anything else. Oldest
 * first out. */
export const GRID_CONTENT_STATE_LIMIT = 200

interface DocumentViewState {
  readonly filePath: string
  selectedGroup: string | null
  readonly shapes: Map<string, GridShapeState>
  readonly contents: Map<string, GridContentState>
}

/** Keyed by tab. One file per tab: opening another file in the tab replaces
 * the entry, so the map is bounded by the open tabs. `null` is "no tab", which
 * only a test rendering `DetailContent` directly produces. */
const byTab = new Map<string | null, DocumentViewState>()

export interface GridViewKey {
  readonly tabId: string | null
  readonly filePath: string
}

function documentState(key: GridViewKey, create: boolean): DocumentViewState | undefined {
  const existing = byTab.get(key.tabId)
  if (existing !== undefined && existing.filePath === key.filePath) return existing
  if (!create) return undefined
  // Closed tabs are pruned on write rather than through a close hook: the
  // entries are small, and a write is the only moment the map grows.
  const open = new Set(getTabIds())
  for (const tabId of byTab.keys()) if (tabId !== null && !open.has(tabId)) byTab.delete(tabId)
  const fresh: DocumentViewState = {
    filePath: key.filePath,
    selectedGroup: null,
    shapes: new Map(),
    contents: new Map()
  }
  byTab.set(key.tabId, fresh)
  return fresh
}

/** A group's identity across reparses: its name as text, or the unnamed group
 * an array's children form. The prefixes keep a JSON key spelled `""` apart
 * from the unnamed group. */
export function groupKeyOf(store: NodeStore, group: GridGroup): string {
  return group.nameId === -1 ? 'u' : `n:${store.textOf(group.nameId)}`
}

/**
 * A number per `Interner`, for a React key. **A grid's column ids are only
 * meaningful against the interner that issued them**: a splice reuses it, so
 * a grid can stay mounted through one; a full reparse returns a new one whose
 * ids can differ for the same names, and a grid still holding the old ids
 * would sort, pin and filter by whichever columns now carry them. Keying the
 * grid by this remounts it instead, and the remount restores by name.
 */
const internerNumbers = new WeakMap<Interner, number>()
let nextInternerNumber = 0

export function internerKeyOf(store: NodeStore): number {
  let n = internerNumbers.get(store.interner)
  if (n === undefined) {
    n = nextInternerNumber++
    internerNumbers.set(store.interner, n)
  }
  return n
}

// --- the selected tab (R211's memory, rekeyed) -----------------------------

export function rememberGroup(key: GridViewKey, groupKey: string): void {
  documentState(key, true)!.selectedGroup = groupKey
}

/** Which of `tables` to show: the remembered group if this node has it, else
 * the first in document order. */
export function selectedGroupIndex(
  key: GridViewKey,
  store: NodeStore,
  tables: readonly GridGroup[]
): number {
  const remembered = documentState(key, false)?.selectedGroup
  if (remembered === undefined || remembered === null) return 0
  const index = tables.findIndex((t) => groupKeyOf(store, t) === remembered)
  return index === -1 ? 0 : index
}

// --- shape: per group name ---------------------------------------------------

export function readShape(key: GridViewKey, groupKey: string): GridShapeState {
  return documentState(key, false)?.shapes.get(groupKey) ?? EMPTY_SHAPE
}

export function writeShape(key: GridViewKey, groupKey: string, shape: GridShapeState): void {
  documentState(key, true)!.shapes.set(groupKey, shape)
}

// --- content: per node and group ---------------------------------------------

function contentKey(node: NodeRef, groupKey: string): string {
  return `${node}|${groupKey}`
}

export function readContent(
  key: GridViewKey,
  store: NodeStore,
  node: NodeRef,
  groupKey: string
): GridContentState | null {
  const content = documentState(key, false)?.contents.get(contentKey(node, groupKey))
  if (content === undefined || content.nodeCount !== store.nodeCount) return null
  return content
}

export function writeContent(
  key: GridViewKey,
  node: NodeRef,
  groupKey: string,
  content: GridContentState | null
): void {
  const contents = documentState(key, true)!.contents
  const k = contentKey(node, groupKey)
  // Delete first, so a rewrite moves the entry to the newest end of the
  // insertion order the limit below evicts from.
  contents.delete(k)
  if (content === null) return
  contents.set(k, content)
  while (contents.size > GRID_CONTENT_STATE_LIMIT) {
    const oldest = contents.keys().next().value
    if (oldest === undefined) break
    contents.delete(oldest)
  }
}

/** Default content writes nothing: an untouched table is the common case, and
 * the limit above is for tables someone actually changed. */
export function isDefaultContent(content: GridContentState): boolean {
  return (
    content.quickFilter.length === 0 &&
    content.columnFilters.length === 0 &&
    !content.filterRowOpen &&
    content.active.row === 0 &&
    content.active.col === 0 &&
    content.scrollTop === 0 &&
    content.scrollLeft === 0
  )
}

// --- resolving names against one grid's columns ------------------------------

/** Name → name id for every column this grid could show, capped or overflow.
 * A stored name missing from it is a column this group does not have (here,
 * or any more), and is dropped rather than restored as a ghost. */
export function columnIdsByName(
  store: NodeStore,
  columns: readonly GridColumn[],
  overflow: readonly GridColumn[]
): Map<string, number> {
  const byName = new Map<string, number>()
  for (const c of columns) byName.set(store.textOf(c.nameId), c.nameId)
  for (const c of overflow) byName.set(store.textOf(c.nameId), c.nameId)
  return byName
}

export interface ResolvedShape {
  readonly sort: { readonly nameId: number; readonly direction: SortDirection } | null
  readonly extraColumns: ReadonlySet<number>
  readonly pinned: ReadonlySet<number>
  readonly widths: ReadonlyMap<number, number>
}

export function resolveShape(
  shape: GridShapeState,
  byName: ReadonlyMap<string, number>,
  overflowIds: ReadonlySet<number>,
  pickerCap: number
): ResolvedShape {
  const sortId = shape.sort === null ? undefined : byName.get(shape.sort.column)
  const extraColumns = new Set<number>()
  for (const name of shape.extraColumns) {
    const id = byName.get(name)
    // Only overflow columns can be "extra"; a stored extra that this group
    // shows anyway needs no entry, and the picker's own cap still holds.
    if (id !== undefined && overflowIds.has(id) && extraColumns.size < pickerCap)
      extraColumns.add(id)
  }
  const shown = (id: number): boolean => !overflowIds.has(id) || extraColumns.has(id)
  const pinned = new Set<number>()
  for (const name of shape.pinned) {
    const id = byName.get(name)
    if (id !== undefined && shown(id)) pinned.add(id)
  }
  const widths = new Map<number, number>()
  for (const [name, px] of shape.widths) {
    const id = byName.get(name)
    if (id !== undefined) widths.set(id, px)
  }
  return {
    sort:
      sortId !== undefined && shape.sort !== null && shown(sortId)
        ? { nameId: sortId, direction: shape.sort.direction }
        : null,
    extraColumns,
    pinned,
    widths
  }
}

/**
 * The shape to store after a change in one grid. **Names this grid does not
 * have are kept from the previous shape**: a sibling node's `book` table may
 * lack a column another `book` table was pinned by, and pinning something here
 * must not quietly unpin it there.
 */
export function mergeShape(
  previous: GridShapeState,
  current: ResolvedShape,
  store: NodeStore,
  byName: ReadonlyMap<string, number>
): GridShapeState {
  const absent = (name: string): boolean => !byName.has(name)
  const names = (ids: ReadonlySet<number>): string[] => [...ids].map((id) => store.textOf(id))
  const sort: StoredSort | null =
    current.sort !== null
      ? { column: store.textOf(current.sort.nameId), direction: current.sort.direction }
      : previous.sort !== null && absent(previous.sort.column)
        ? previous.sort
        : null
  return {
    sort,
    extraColumns: [...previous.extraColumns.filter(absent), ...names(current.extraColumns)],
    pinned: [...previous.pinned.filter(absent), ...names(current.pinned)],
    widths: [
      ...previous.widths.filter(([name]) => absent(name)),
      ...[...current.widths].map(([id, px]) => [store.textOf(id), px] as const)
    ]
  }
}

export function resetGridViewStateForTests(): void {
  byTab.clear()
}
