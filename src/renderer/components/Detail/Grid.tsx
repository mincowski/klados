/**
 * Grid mode (M2-PLAN.md E5–E9, CONCEPT.md §4.3) — the signature feature.
 * One row per group member; columns collected from the union of their
 * first-level fields (E3); each cell literal, derived or absent (E4).
 *
 * Both rows and columns are virtualized (`@tanstack/react-virtual`), same
 * as D8's Tree for the row axis. Rows are `NodeRef`s throughout — `members`
 * never becomes an array of row objects, and sorting/filtering (E6/E7)
 * work by permuting/subsetting an index list into `members`, never `members`
 * itself (hard rule 1).
 */
import { useVirtualizer, type ReactVirtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeRef } from '../../../core/types'
import { EMPTY_DELTA_LIST, type DeltaList } from '../../../core/deltaList'
import { effectiveChordFor, formatChord } from '../../commands/keybindings'
import { hasMatchInRange } from '../../navigation/matchSpanLookup'
import { activeDocumentId } from '../../notifications/documentId'
import { notify } from '../../notifications/notificationStore'
import { selectNode } from '../../selectNode'
import { activeSearchStore } from '../../session/activeSearchStore'
import { formatBytes } from '../../session/documentSession'
import { Icon } from '../Icon/Icon'
import { CellKind, cellOf, type GridCell } from './gridCell'
import {
  collectColumns,
  GRID_COLUMN_PICKER_CAP,
  isRepeatingColumn,
  widestKind,
  type GridColumn
} from './gridColumns'
import {
  estimateExportBytes,
  exportGrid,
  GRID_EXPORT_CONFIRM_ROWS,
  type GridExportFormat
} from './gridExport'
import { EMPTY_GRID_FILTERS, filterIndices, type GridFilters } from './gridFilter'
import { registerGridController } from './gridController'
import { isColumnSortable, sortByColumn, type SortDirection } from './gridSort'
import { defaultColumnWidthPx, sampleColumnStats, type ColumnStats } from './gridColumnWidth'
import { Scrollbar } from '../Scrollbar/Scrollbar'
import { useRovingTabIndex } from '../../rovingTabIndex'
import './Grid.css'

const ROW_HEIGHT = 23
const ROW_HEADER_WIDTH = 56
const PAGE_ROWS = 20

export interface GridProps {
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  /** The group's members, document order — E1's detection plus E3's
   * `collectGroupMembers`, computed by the caller (`Detail.tsx`). */
  readonly members: readonly NodeRef[]
  /** R42/D-070: `document.pendingSpanDeltas` — translated through before
   * every cell this view decodes. Defaults to nothing pending so a test
   * that doesn't care about the mid-edit window doesn't have to pass it. */
  readonly deltas?: DeltaList
}

interface SortState {
  readonly nameId: number
  readonly direction: SortDirection
}

/** Filter text commits to `filters` (which drives the O(members) scan in
 * `filterIndices`) this long after the last keystroke — typing into either
 * filter box updates `filterInputs` (what the text boxes actually show)
 * immediately, but re-scanning a 2M-row group on every single keystroke
 * would make typing itself feel laggy on the fixture size this feature
 * exists for. */
const FILTER_DEBOUNCE_MS = 200

export function Grid({
  store,
  sourceBuffer,
  members,
  deltas = EMPTY_DELTA_LIST
}: GridProps): JSX.Element {
  const [sort, setSort] = useState<SortState | null>(null)
  const [filterInputs, setFilterInputs] = useState<GridFilters>(EMPTY_GRID_FILTERS)
  const [filters, setFilters] = useState<GridFilters>(EMPTY_GRID_FILTERS)
  const filterCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pinned, setPinned] = useState<ReadonlySet<number>>(new Set())
  const [filterRowOpen, setFilterRowOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [hiddenMatchesOpen, setHiddenMatchesOpen] = useState(false)
  const [extraColumns, setExtraColumns] = useState<ReadonlySet<number>>(new Set())
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const [pendingExport, setPendingExport] = useState<GridExportFormat | null>(null)
  const quickFilterRef = useRef<HTMLInputElement>(null)

  // M4-PLAN.md G5: an overlay, not a filter — the grid's own quick/column
  // filters (`gridFilter.ts`) are a separate mechanism and both stay; a row
  // can be filtered out by one and matched by the other.
  const searchResult = useSyncExternalStore(
    activeSearchStore.subscribe,
    activeSearchStore.getSnapshot,
    activeSearchStore.getSnapshot
  )

  const { columns: cappedColumns, overflow } = useMemo(
    () => collectColumns(store, members),
    [store, members]
  )
  const columns = useMemo(() => {
    if (extraColumns.size === 0) return cappedColumns
    const extra = overflow.filter((c) => extraColumns.has(c.nameId))
    return [...cappedColumns, ...extra]
  }, [cappedColumns, overflow, extraColumns])

  const orderedColumns = useMemo(() => {
    const pin: GridColumn[] = []
    const rest: GridColumn[] = []
    for (const c of columns) (pinned.has(c.nameId) ? pin : rest).push(c)
    return [...pin, ...rest]
  }, [columns, pinned])
  const pinnedCount = useMemo(
    () => orderedColumns.filter((c) => pinned.has(c.nameId)).length,
    [orderedColumns, pinned]
  )

  const filterResult = useMemo(
    () => filterIndices(store, sourceBuffer, members, columns, filters),
    [store, sourceBuffer, members, columns, filters]
  )
  const filteredIndices = filterResult.indices

  // R34 §3: `orderedColumns` changes on every column-picker tick, and this
  // used to re-run `isNumericColumn` — an O(rows) scan — over the *entire*
  // set on every one of those ticks, not just the column that changed.
  // Cached per `nameId` instead: numeric-ness only changes when the
  // document does, so a column already answered stays answered, and only
  // columns actually rendered (`isNumeric`/`columnWidth` below are called
  // per rendered cell) ever pay the scan at all.
  //
  // R43/D-071: `sampleColumnStats` (`gridColumnWidth.ts`) replaces
  // `isNumericColumn` here — one scan answers both "is this numeric" and
  // "how wide should this column default to," reusing the same bounded
  // sample rather than a second O(rows) pass over the same members.
  const columnStatsCacheRef = useRef(new Map<number, ColumnStats>())
  useEffect(() => {
    columnStatsCacheRef.current = new Map()
  }, [store, sourceBuffer, members])

  const statsOf = useCallback(
    (column: GridColumn): ColumnStats => {
      const cache = columnStatsCacheRef.current
      const cached = cache.get(column.nameId)
      if (cached !== undefined) return cached
      const result = sampleColumnStats(store, sourceBuffer, members, column, deltas)
      cache.set(column.nameId, result)
      return result
    },
    [store, sourceBuffer, members, deltas]
  )

  const isNumeric = useCallback((column: GridColumn): boolean => statsOf(column).numeric, [statsOf])

  // R43/D-071: an explicitly-dragged width wins over the derived one —
  // double-click (`GridHeaderCell`'s own resize handle) clears a column's
  // entry, resetting it to derived. Scoped to this Grid instance's own
  // lifetime (reset alongside the stats cache below), the same "persisted
  // for the session" `R43-grid-sizing-and-scroll.md` asks for — a
  // *different* group's Grid (a different node selected) starts fresh
  // rather than carrying over widths that described a different column set.
  const [widthOverrides, setWidthOverrides] = useState<ReadonlyMap<number, number>>(new Map())
  useEffect(() => {
    setWidthOverrides(new Map())
  }, [store, sourceBuffer, members])

  const columnWidth = useCallback(
    (column: GridColumn): number => {
      const override = widthOverrides.get(column.nameId)
      if (override !== undefined) return override
      const headerChars = store.textOf(column.nameId).length
      return defaultColumnWidthPx(headerChars, statsOf(column))
    },
    [widthOverrides, store, statsOf]
  )

  function setColumnWidth(nameId: number, width: number): void {
    setWidthOverrides((prev) => {
      const next = new Map(prev)
      next.set(nameId, width)
      return next
    })
  }

  function resetColumnWidth(nameId: number): void {
    setWidthOverrides((prev) => {
      if (!prev.has(nameId)) return prev
      const next = new Map(prev)
      next.delete(nameId)
      return next
    })
  }

  const displayIndices = useMemo(() => {
    if (sort === null) return filteredIndices
    const column = orderedColumns.find((c) => c.nameId === sort.nameId)
    if (column === undefined || !isColumnSortable(column)) return filteredIndices
    return sortByColumn(
      store,
      sourceBuffer,
      members,
      filteredIndices,
      column,
      sort.direction,
      isNumeric(column)
    )
  }, [filteredIndices, sort, orderedColumns, store, sourceBuffer, members, isNumeric])

  const parentRef = useRef<HTMLDivElement>(null)

  // R34 §4: pinning has no limit (a cap was proposed and rejected, D-066 —
  // pin order is legitimately used to arrange columns), so pinned columns
  // must degrade instead. Sticky positioning is meaningless once pinned
  // width exceeds the viewport anyway — you haven't kept anything in sight,
  // you've filled the screen. Only the pinned columns that actually *fit*
  // stay sticky and unvirtualized; the rest render as ordinary virtualized
  // leading columns, in the same order (`orderedColumns` is already
  // `[pinned…, rest…]`, so this only changes where the sticky/virtualized
  // split falls, not the order itself).
  const [viewportWidth, setViewportWidth] = useState(0)
  useEffect(() => {
    const el = parentRef.current
    if (el === null) return
    const update = (): void => setViewportWidth(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // R43/D-071: widths are no longer one constant, so "how many pinned
  // columns fit" is a running sum over their own (possibly resized) widths
  // rather than a division — `stickyLefts` below is the same sum, kept so
  // every sticky cell's `left` doesn't recompute it independently.
  const { stickyCount, stickyLefts, stickyWidth } = useMemo(() => {
    const lefts: number[] = []
    const available = Math.max(0, viewportWidth - ROW_HEADER_WIDTH)
    let used = 0
    let count = 0
    for (const column of orderedColumns) {
      if (count >= pinnedCount) break
      const width = columnWidth(column)
      if (used + width > available) break
      lefts.push(ROW_HEADER_WIDTH + used)
      used += width
      count++
    }
    return { stickyCount: count, stickyLefts: lefts, stickyWidth: used }
  }, [viewportWidth, orderedColumns, pinnedCount, columnWidth])

  const rowVirtualizer = useVirtualizer({
    count: displayIndices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })
  const virtualizedColumns = orderedColumns.slice(stickyCount)
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: virtualizedColumns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => columnWidth(virtualizedColumns[index]!),
    overscan: 4
  })
  // R43/D-071: `colVirtualizer` only recomputes an index's size the first
  // time it's asked (`@tanstack/virtual-core`'s own `itemSizeCache`) —
  // `estimateSize` changing identity every render does not, by itself,
  // invalidate an index already answered. `.measure()` is the library's own
  // escape hatch (clears that cache, forces every visible index to call
  // `estimateSize` again) — called whenever something `columnWidth` itself
  // depends on changes, so a resize or a new document's derived widths
  // actually reach the columns already on screen.
  useEffect(() => {
    colVirtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `colVirtualizer` itself is stable per mount (`@tanstack/react-virtual`'s own contract); re-running this effect on its own identity would be a no-op dependency, not a real one
  }, [columnWidth])

  const bodyLeft = ROW_HEADER_WIDTH + stickyWidth

  // R93 (`R91-focus-into-content.md` §4): mirrors `Tree.tsx:191` — without
  // this, ArrowDown past the last *rendered* row moved `active.row` to a
  // row the virtualizer had never mounted, so the highlight vanished and
  // further presses looked dead. `row === -1` is the header row (R62),
  // which is sticky and always visible, so there's nothing to scroll to.
  useEffect(() => {
    if (active.row === -1) return
    rowVirtualizer.scrollToIndex(active.row, { align: 'auto' })
  }, [active.row, rowVirtualizer])

  // The column axis needs the sticky/pinned columns' width folded in as a
  // left inset, or the target lands underneath them (§4's own reasoning) —
  // `colVirtualizer`'s own coordinate space excludes `bodyLeft` entirely
  // (its items start at 0, `bodyLeft` is only added at render time), so its
  // built-in `scrollToIndex`/'auto' would consider a column "already
  // visible" the moment its un-shifted position falls inside
  // `[scrollLeft, scrollLeft + viewport)` — including the leading
  // `bodyLeft` px that's actually covered by the sticky columns on screen.
  // Computed by hand instead: the same "clamp scrollLeft into the range
  // that keeps both edges on screen" `auto` align does, just with the inset
  // applied to the *right* edge check (an item's left screen position is
  // `bodyLeft + start - scrollLeft`, so aligning it flush with the sticky
  // columns is `scrollLeft = start`, needing no inset at all — only the
  // right-edge target, which must reach exactly to `viewport`, needs it).
  useEffect(() => {
    const el = parentRef.current
    if (el === null || active.col < stickyCount) return
    const virtualizedIndex = active.col - stickyCount
    const column = virtualizedColumns[virtualizedIndex]
    if (column === undefined) return
    const offset = colVirtualizer.getOffsetForIndex(virtualizedIndex, 'start')
    if (offset === undefined) return
    const [start] = offset
    const size = columnWidth(column)
    const viewport = el.clientWidth
    const maxScroll = start
    const minScroll = bodyLeft + start + size - viewport
    if (el.scrollLeft > maxScroll) el.scrollLeft = maxScroll
    else if (minScroll <= maxScroll && el.scrollLeft < minScroll) el.scrollLeft = minScroll
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `virtualizedColumns`/`columnWidth`/`colVirtualizer` are recreated every render; the dependency that actually needs to retrigger this is `active.col` moving, with the others read fresh at that moment
  }, [active.col, stickyCount, bodyLeft])
  const totalWidth = bodyLeft + colVirtualizer.getTotalSize()
  // R44b (`R43-grid-sizing-and-scroll.md`): `Scrollbar` decides for
  // itself whether it renders a horizontal track (comparing the scroll
  // host's own `scrollWidth`/`clientWidth`), and the grid has no way to ask
  // it — so this mirrors that same comparison against the geometry this
  // component already tracks, rather than reserving the gutter
  // unconditionally the way `margin-right` does. `viewportWidth` is 0 until
  // the `ResizeObserver` above fires once, which is also the state where a
  // scrollbar can't be showing yet either — the same "nothing to reserve
  // room for" case as a table that never overflows in the first place.
  const hasHorizontalOverflow = viewportWidth > 0 && totalWidth > viewportWidth
  const totalHeight = rowVirtualizer.getTotalSize()

  // A filter that is set must never be hidden (UI-FEEDBACK.md) — the
  // row shows itself whenever a per-column filter is active, regardless of
  // whether it was ever explicitly opened.
  const anyColumnFilterSet = filterInputs.perColumn.size > 0
  const filterRowVisible = filterRowOpen || anyColumnFilterSet
  const headerHeight = filterRowVisible ? ROW_HEIGHT * 2 : ROW_HEIGHT

  function toggleSort(column: GridColumn): void {
    if (!isColumnSortable(column)) return
    setSort((prev) => {
      if (prev === null || prev.nameId !== column.nameId)
        return { nameId: column.nameId, direction: 'asc' }
      if (prev.direction === 'asc') return { nameId: column.nameId, direction: 'desc' }
      return null
    })
  }

  function togglePin(nameId: number): void {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(nameId)) next.delete(nameId)
      else next.add(nameId)
      return next
    })
  }

  function commitFiltersDebounced(next: GridFilters): void {
    setFilterInputs(next)
    if (filterCommitRef.current !== null) clearTimeout(filterCommitRef.current)
    filterCommitRef.current = setTimeout(() => setFilters(next), FILTER_DEBOUNCE_MS)
  }

  function setQuickFilter(text: string): void {
    setHiddenMatchesOpen(false)
    commitFiltersDebounced({ ...filterInputs, quick: text })
  }

  function setPerColumnFilter(nameId: number, text: string): void {
    const next = new Map(filterInputs.perColumn)
    if (text.length === 0) next.delete(nameId)
    else next.set(nameId, text)
    commitFiltersDebounced({ ...filterInputs, perColumn: next })
  }

  /** The toggle button in the toolbar. Hiding an active filter would leave
   * the grid silently showing a subset of the document (UI-FEEDBACK.md),
   * so closing the row while a filter is set clears it instead of pretending
   * to hide it — the row itself has nothing to close in that case. */
  function toggleFilterRow(): void {
    if (anyColumnFilterSet) {
      if (filterCommitRef.current !== null) clearTimeout(filterCommitRef.current)
      const next = { ...filterInputs, perColumn: new Map() }
      setFilterInputs(next)
      setFilters(next)
      setFilterRowOpen(false)
    } else {
      setFilterRowOpen((v) => !v)
    }
  }

  // §4.3: "Activating a cell selects the corresponding node in every
  // view." An attribute-sourced or absent cell has no node of its own
  // (`cell.node` is `null`) — the row itself is the nearest meaningful
  // target, not a dead click.
  function activate(row: NodeRef, cell: GridCell): void {
    selectNode(store, cell.node ?? row)
  }

  async function runExport(format: GridExportFormat): Promise<void> {
    const text = exportGrid(store, sourceBuffer, members, displayIndices, orderedColumns, format)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard access can be denied — not worth an error banner for a
      // copy button, same reasoning as Detail's own "Copy path."
    }
  }

  /**
   * Above `GRID_EXPORT_CONFIRM_ROWS`, ask before building the string —
   * §11.2's soft-cap shape (a confirmation showing the estimated cost, never
   * a refusal), and for the same reason: the cost is real, the user may well
   * want to pay it, and the one thing that isn't acceptable is spending it
   * silently. An unbounded export on a 200 MB document is ~8 s and ~97 MB of
   * UTF-16 from a single button click.
   *
   * R21-notifications.md §1: the confirmation is a pushed choice
   * notification rather than component-local JSX — `pendingExport` still
   * holds which format is waiting (nothing elevates it to session state;
   * there's exactly one `Grid` instance at a time), but the prompt itself
   * lives in the notification stack, resolved through
   * `klados.grid.confirmExport`/`cancelExport` (§3g) via `gridController.ts`.
   */
  function copyAs(format: GridExportFormat): void {
    if (displayIndices.length > GRID_EXPORT_CONFIRM_ROWS) {
      setPendingExport(format)
      notify({
        severity: 'warning',
        message: `Copying ${displayIndices.length.toLocaleString()} rows as ${format.toUpperCase()} builds about ${formatBytes(estimateExportBytes(store, sourceBuffer, members, displayIndices, orderedColumns))} of text. Continue?`,
        actions: [
          { label: 'Copy Anyway', commandId: 'klados.grid.confirmExport' },
          { label: 'Cancel', commandId: 'klados.grid.cancelExport' }
        ],
        documentId: activeDocumentId(),
        dedupeKey: 'grid.exportConfirm'
      })
      return
    }
    void runExport(format)
  }

  function confirmExport(): void {
    if (pendingExport === null) return
    const format = pendingExport
    setPendingExport(null)
    void runExport(format)
  }

  function cancelExport(): void {
    setPendingExport(null)
  }

  function focusQuickFilter(): void {
    quickFilterRef.current?.focus()
    quickFilterRef.current?.select()
  }

  // R94 (`R91-focus-into-content.md` §5): Detail's own registerPaneContent
  // delegate for grid mode — the `.grid-scroll` element lives in this child
  // component, so `GridController` is what carries the handle to it.
  function focusGrid(): void {
    parentRef.current?.focus()
  }

  // Invariant 10: the palette's own "Copy Grid as CSV/TSV/Markdown"
  // commands (E8) need a live handle on *this* grid's current
  // sort/filter/selection, which only the mounted component has.
  useEffect(
    () =>
      registerGridController({ copyAs, focusQuickFilter, confirmExport, cancelExport, focusGrid }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-registers whenever the exported snapshot would change; the closures here are recreated every render and aren't meaningful dependencies on their own
    [store, sourceBuffer, members, displayIndices, orderedColumns, pendingExport]
  )

  // The debounced filter commit (above) must not fire setFilters after
  // this Grid has unmounted — selecting a different node while a filter
  // keystroke's timer is still pending would otherwise leak state into
  // whatever Grid instance (or none) replaces this one.
  useEffect(() => {
    return () => {
      if (filterCommitRef.current !== null) clearTimeout(filterCommitRef.current)
    }
  }, [])

  // R62 (`R61-keyboard-workflow.md` §3): the grid header's per-column
  // controls (Pin, the sortable label) are no longer their own Tab stops —
  // they're arrow-reachable from here instead, the same roving-tabindex
  // pattern the toolbar/breadcrumb use, but woven into the existing 2D
  // cell-navigation state rather than a separate group: `row === -1` means
  // "the header row is active," reached by pressing ArrowUp from row 0.
  // `activeCol` still means the same thing either way, so Left/Right/Home/
  // End need no special case for the header row at all.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const maxRow = displayIndices.length - 1
    const maxCol = orderedColumns.length - 1
    if (maxRow < 0 || maxCol < 0) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((a) => ({ ...a, row: Math.min(maxRow, a.row + 1) }))
        return
      case 'ArrowUp':
        event.preventDefault()
        setActive((a) => ({ ...a, row: Math.max(-1, a.row - 1) }))
        return
      case 'ArrowRight':
        event.preventDefault()
        setActive((a) => ({ ...a, col: Math.min(maxCol, a.col + 1) }))
        return
      case 'ArrowLeft':
        event.preventDefault()
        setActive((a) => ({ ...a, col: Math.max(0, a.col - 1) }))
        return
      case 'Home':
        event.preventDefault()
        setActive((a) => ({ ...a, col: 0 }))
        return
      case 'End':
        event.preventDefault()
        setActive((a) => ({ ...a, col: maxCol }))
        return
      case 'PageDown':
        event.preventDefault()
        setActive((a) => ({ ...a, row: Math.min(maxRow, a.row + PAGE_ROWS) }))
        return
      case 'PageUp':
        event.preventDefault()
        setActive((a) => ({ ...a, row: Math.max(0, a.row - PAGE_ROWS) }))
        return
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const column = orderedColumns[active.col]
        if (column === undefined) return
        if (active.row === -1) {
          if (isColumnSortable(column)) toggleSort(column)
          return
        }
        const memberIndex = displayIndices[active.row]
        if (memberIndex === undefined) return
        const row = members[memberIndex]!
        activate(row, cellOf(store, sourceBuffer, row, column.nameId, deltas))
        return
      }
      // The header row's own second action — Pin has no obvious mapping
      // onto an existing editor convention (Shift+Enter reads as "insert a
      // line," Ctrl+Enter as "submit"), so this follows the same
      // local-to-the-widget precedent `Grid.tsx`'s own arrow/Home/End keys
      // already set: bare, because focus here is a non-text-input `div`
      // where a printable key means nothing else.
      case 'p':
      case 'P':
        if (active.row === -1) {
          event.preventDefault()
          const column = orderedColumns[active.col]
          if (column !== undefined) togglePin(column.nameId)
        }
        return
      default:
        return
    }
  }

  // R62 (`R61-keyboard-workflow.md` §3): the toolbar's action buttons
  // (filter toggle, then the three copy commands) are one Tab stop, not
  // four — ArrowLeft/Right/Home/End move which one is current. The quick
  // filter text box and the column picker button aren't part of this group
  // (a textbox isn't a roving-tabindex member, and the plan names only
  // "filter, the three copy commands").
  const toolbarRoving = useRovingTabIndex(4)

  // R65 (`R65-shortcuts-help.md` §2): the effective chord, not the
  // shipped default.
  const quickFilterChord = effectiveChordFor('klados.grid.focusFilter')
  const quickFilterLabel =
    quickFilterChord === null
      ? 'Filter grid rows'
      : `Filter grid rows (${formatChord(quickFilterChord)})`

  return (
    <div className="grid-wrapper">
      <div className="grid-toolbar">
        <input
          ref={quickFilterRef}
          type="text"
          className="grid-quick-filter"
          placeholder="Filter rows…"
          value={filterInputs.quick}
          onChange={(e) => setQuickFilter(e.target.value)}
          title={quickFilterLabel}
          aria-label={quickFilterLabel}
        />
        {filters.quick.length > 0 && filterResult.hiddenMatchCount > 0 && (
          // R34 §5: the quick filter's scope stays the visible column set —
          // this says what it excluded rather than silently narrowing an
          // "anywhere" search to "the columns currently shown," and clicking
          // reveals exactly which hidden columns matched rather than
          // auto-enabling them (only ever a click, never while typing).
          <div className="grid-hidden-matches">
            <button
              type="button"
              className="grid-hidden-matches-toggle"
              aria-expanded={hiddenMatchesOpen}
              onClick={() => setHiddenMatchesOpen((v) => !v)}
            >
              {filterResult.hiddenMatchCount} more match
              {filterResult.hiddenMatchCount === 1 ? '' : 'es'} in hidden columns
            </button>
            {hiddenMatchesOpen && (
              <ul className="grid-hidden-matches-list">
                {filterResult.hiddenMatchColumns.map((nameId) => (
                  <li key={nameId}>{store.textOf(nameId)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button
          type="button"
          className="grid-filter-toggle"
          aria-pressed={filterRowVisible}
          title={anyColumnFilterSet ? 'Clear column filters' : 'Toggle per-column filter row'}
          aria-label={
            anyColumnFilterSet
              ? `Clear column filters (${filterInputs.perColumn.size} set)`
              : 'Toggle per-column filter row'
          }
          onClick={toggleFilterRow}
          {...toolbarRoving.itemProps(0)}
        >
          <Icon name="filter" />
          <span className="grid-toolbar-label">Filters</span>
          {anyColumnFilterSet && (
            <span className="grid-toolbar-badge">{filterInputs.perColumn.size}</span>
          )}
        </button>
        {overflow.length > 0 && (
          <div className="grid-column-picker">
            <button
              type="button"
              title="Show more columns"
              aria-label={`Show ${overflow.length - extraColumns.size} more columns`}
              onClick={() => setPickerOpen((v) => !v)}
            >
              <Icon name="table-settings" />
              <span className="grid-toolbar-label">Columns</span>
              <span className="grid-toolbar-badge">{overflow.length - extraColumns.size}</span>
            </button>
            {pickerOpen && (
              <ul className="grid-column-picker-list">
                {overflow.map((c) => (
                  <li key={c.nameId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={extraColumns.has(c.nameId)}
                        // R34 §6: the picker's own ceiling — GRID_COLUMN_CAP
                        // no longer needs to be small (§4/§5 already keep
                        // pinning and the quick filter honest past it), but
                        // shown columns still can't grow without bound.
                        disabled={
                          !extraColumns.has(c.nameId) && extraColumns.size >= GRID_COLUMN_PICKER_CAP
                        }
                        onChange={(e) => {
                          if (e.target.checked && extraColumns.size >= GRID_COLUMN_PICKER_CAP) {
                            notify({
                              severity: 'info',
                              message: `Already showing ${GRID_COLUMN_PICKER_CAP} extra columns, the most the picker allows at once.`,
                              documentId: activeDocumentId(),
                              dedupeKey: 'grid.columnPickerCap'
                            })
                            return
                          }
                          setExtraColumns((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(c.nameId)
                            else next.delete(c.nameId)
                            return next
                          })
                          if (!e.target.checked) {
                            // A filter or sort left active on a column that's
                            // no longer shown anywhere would silently keep
                            // constraining/ordering the grid with no visible
                            // way to tell why.
                            if (filterInputs.perColumn.has(c.nameId))
                              setPerColumnFilter(c.nameId, '')
                            setSort((prev) => (prev?.nameId === c.nameId ? null : prev))
                            if (pinned.has(c.nameId)) togglePin(c.nameId)
                          }
                        }}
                      />
                      {store.textOf(c.nameId)}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="grid-copy-buttons">
          <button
            type="button"
            title="Copy Grid as CSV"
            aria-label="Copy Grid as CSV"
            onClick={() => copyAs('csv')}
            {...toolbarRoving.itemProps(1)}
          >
            <Icon name="copy" />
            <span className="grid-toolbar-label">CSV</span>
          </button>
          <button
            type="button"
            title="Copy Grid as TSV"
            aria-label="Copy Grid as TSV"
            onClick={() => copyAs('tsv')}
            {...toolbarRoving.itemProps(2)}
          >
            <Icon name="copy" />
            <span className="grid-toolbar-label">TSV</span>
          </button>
          <button
            type="button"
            title="Copy Grid as Markdown"
            aria-label="Copy Grid as Markdown"
            onClick={() => copyAs('markdown')}
            {...toolbarRoving.itemProps(3)}
          >
            <Icon name="copy" />
            <span className="grid-toolbar-label">MD</span>
          </button>
        </div>
      </div>

      <div className="grid-viewport">
        <div
          className={`grid-scroll scrollbar-host${hasHorizontalOverflow ? ' grid-scroll-has-horizontal-track' : ''}`}
          ref={parentRef}
          role="grid"
          aria-label="Data grid"
          aria-rowcount={members.length}
          aria-colcount={orderedColumns.length}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          <div
            style={{ width: totalWidth, height: totalHeight + headerHeight, position: 'relative' }}
          >
            <GridHeaderRow
              store={store}
              sourceBuffer={sourceBuffer}
              members={members}
              orderedColumns={orderedColumns}
              stickyCount={stickyCount}
              stickyLefts={stickyLefts}
              bodyLeft={bodyLeft}
              columnWidth={columnWidth}
              onResizeColumn={setColumnWidth}
              onResetColumnWidth={resetColumnWidth}
              sort={sort}
              pinned={pinned}
              isNumeric={isNumeric}
              filters={filterInputs}
              colVirtualizer={colVirtualizer}
              activeCol={active.row === -1 ? active.col : -1}
              onToggleSort={toggleSort}
              onTogglePin={togglePin}
            />

            {filterRowVisible && (
              <GridFilterRow
                store={store}
                orderedColumns={orderedColumns}
                stickyCount={stickyCount}
                stickyLefts={stickyLefts}
                bodyLeft={bodyLeft}
                columnWidth={columnWidth}
                filters={filterInputs}
                colVirtualizer={colVirtualizer}
                onFilterChange={setPerColumnFilter}
              />
            )}

            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const memberIndex = displayIndices[virtualRow.index]!
              const row = members[memberIndex]!
              return (
                <GridBodyRow
                  key={row}
                  store={store}
                  sourceBuffer={sourceBuffer}
                  deltas={deltas}
                  row={row}
                  documentPosition={memberIndex + 1}
                  orderedColumns={orderedColumns}
                  stickyCount={stickyCount}
                  stickyLefts={stickyLefts}
                  bodyLeft={bodyLeft}
                  columnWidth={columnWidth}
                  top={virtualRow.start + headerHeight}
                  isNumeric={isNumeric}
                  colVirtualizer={colVirtualizer}
                  selected={virtualRow.index === active.row}
                  matched={
                    searchResult.starts.length > 0 &&
                    hasMatchInRange(
                      searchResult.starts,
                      store.spanOf(row).start,
                      store.spanOf(row).end
                    )
                  }
                  activeCol={virtualRow.index === active.row ? active.col : -1}
                  onActivateCell={activate}
                  onSelectRow={(col) => setActive({ row: virtualRow.index, col })}
                />
              )
            })}
          </div>
        </div>
        <Scrollbar target={parentRef} axis="both" horizontalInset={bodyLeft} />
      </div>
    </div>
  )
}

interface GridHeaderRowProps {
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly members: readonly NodeRef[]
  readonly orderedColumns: readonly GridColumn[]
  /** R34 §4: how many leading `orderedColumns` render sticky/unvirtualized —
   * the pinned columns that actually fit the viewport, not `pinned.size`.
   * Pins beyond this render in the virtualized section below, in the same
   * order. */
  readonly stickyCount: number
  /** R43/D-071: each sticky column's own `left`, precomputed once by the
   * parent from `columnWidth` — an index into it lines up with
   * `orderedColumns.slice(0, stickyCount)`, the same slice this component
   * takes independently below. */
  readonly stickyLefts: readonly number[]
  readonly bodyLeft: number
  readonly columnWidth: (column: GridColumn) => number
  readonly onResizeColumn: (nameId: number, width: number) => void
  readonly onResetColumnWidth: (nameId: number) => void
  readonly sort: SortState | null
  readonly pinned: ReadonlySet<number>
  readonly isNumeric: (column: GridColumn) => boolean
  readonly filters: GridFilters
  readonly colVirtualizer: ReactVirtualizer<HTMLDivElement, Element>
  /** R62 — the column index the grid's own `onKeyDown` currently has
   * "header-focused" (`active.row === -1`), or `-1` when the header isn't
   * the active row. Index into `orderedColumns`, matching `active.col`'s
   * own meaning for the body. */
  readonly activeCol: number
  readonly onToggleSort: (column: GridColumn) => void
  readonly onTogglePin: (nameId: number) => void
}

function GridHeaderRow({
  store,
  orderedColumns,
  stickyCount,
  stickyLefts,
  bodyLeft,
  columnWidth,
  onResizeColumn,
  onResetColumnWidth,
  sort,
  pinned,
  isNumeric,
  filters,
  colVirtualizer,
  activeCol,
  onToggleSort,
  onTogglePin
}: GridHeaderRowProps): JSX.Element {
  const stickyColumns = orderedColumns.slice(0, stickyCount)

  return (
    <div
      className="grid-header-row"
      style={{ position: 'sticky', top: 0, zIndex: 2, height: ROW_HEIGHT }}
    >
      <div
        className="grid-cell grid-row-header-cell grid-header-cell"
        style={{ position: 'sticky', left: 0, width: ROW_HEADER_WIDTH, zIndex: 3 }}
      >
        #
      </div>
      {stickyColumns.map((column, i) => (
        <GridHeaderCell
          key={column.nameId}
          store={store}
          column={column}
          style={{
            position: 'sticky',
            left: stickyLefts[i]!,
            width: columnWidth(column),
            zIndex: 3
          }}
          sort={sort}
          isPinned={pinned.has(column.nameId)}
          isNumeric={isNumeric(column)}
          isFiltered={(filters.perColumn.get(column.nameId) ?? '').length > 0}
          width={columnWidth(column)}
          active={i === activeCol}
          onToggleSort={onToggleSort}
          onTogglePin={onTogglePin}
          onResizeColumn={onResizeColumn}
          onResetColumnWidth={onResetColumnWidth}
        />
      ))}
      {colVirtualizer.getVirtualItems().map((virtualCol) => {
        const column = orderedColumns[stickyCount + virtualCol.index]!
        return (
          <GridHeaderCell
            key={column.nameId}
            store={store}
            column={column}
            style={{
              position: 'absolute',
              left: bodyLeft + virtualCol.start,
              width: virtualCol.size,
              top: 0,
              height: '100%'
            }}
            sort={sort}
            isPinned={pinned.has(column.nameId)}
            isNumeric={isNumeric(column)}
            isFiltered={(filters.perColumn.get(column.nameId) ?? '').length > 0}
            width={virtualCol.size}
            active={stickyCount + virtualCol.index === activeCol}
            onToggleSort={onToggleSort}
            onTogglePin={onTogglePin}
            onResizeColumn={onResizeColumn}
            onResetColumnWidth={onResetColumnWidth}
          />
        )
      })}
    </div>
  )
}

interface GridHeaderCellProps {
  readonly store: NodeStore
  readonly column: GridColumn
  readonly style: CSSProperties
  readonly sort: SortState | null
  readonly isPinned: boolean
  readonly isNumeric: boolean
  readonly isFiltered: boolean
  /** R43/D-071: this cell's own current width in px — `style.width` already
   * carries it for layout, but the resize handle needs the plain number to
   * compute a drag delta against. */
  readonly width: number
  /** R62 — this column is the grid's current "header-focused" column
   * (`active.row === -1 && active.col` matches). Drives the same
   * `grid-cell-active` visual the body already uses for its own active
   * cell, so header-focus reads as a continuation of one selection model
   * rather than a second, unrelated one. */
  readonly active: boolean
  readonly onToggleSort: (column: GridColumn) => void
  readonly onTogglePin: (nameId: number) => void
  /** Drag the right edge to set an explicit width for the session (until
   * this Grid's document/group changes). */
  readonly onResizeColumn: (nameId: number, width: number) => void
  /** Double-click the edge — the spreadsheet convention for "fit to
   * content," which an explicit width reset already gives for free since
   * the derived width *is* the content-fit one. */
  readonly onResetColumnWidth: (nameId: number) => void
}

/** Below this a header's own label is unreadable regardless of what the
 * derived/default width happened to compute — the same floor
 * `gridColumnWidth.ts`'s `MIN_COLUMN_WIDTH_PX` applies to a derived width,
 * kept here too since a user dragging past it is a different code path. */
const MIN_DRAG_WIDTH_PX = 48

/** `@` for an XML attribute, a text glyph for a scalar, braces for
 * composite, layered dots for repeating — a placeholder glyph set, same as
 * D8's Tree (M2-PLAN.md E5 explicitly defers a real icon mechanism to
 * M2b). */
function columnGlyph(column: GridColumn, repeating: boolean): string {
  const base = widestKind(column) === 'composite' ? '{}' : '"'
  return repeating ? `${base}×` : base
}

function GridHeaderCell({
  store,
  column,
  style,
  sort,
  isPinned,
  isNumeric,
  isFiltered,
  width,
  active,
  onToggleSort,
  onTogglePin,
  onResizeColumn,
  onResetColumnWidth
}: GridHeaderCellProps): JSX.Element {
  const sortable = isColumnSortable(column)
  const repeating = isRepeatingColumn(column)
  const sortIndicator =
    sort?.nameId === column.nameId ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''
  const kind = widestKind(column)
  const breakdownBase =
    kind === 'composite'
      ? `${store.textOf(column.nameId)} — composite in ${column.kindCounts[2]! + column.kindCounts[4]!} of ${column.frequency} rows`
      : store.textOf(column.nameId)
  // R136: the only way a user can tell *why* this column exists under a
  // namespace-resolved name — the header itself still shows the prefix as
  // written (`store.textOf` above), never the URI.
  const namespaceUri = store.namespaceUriOfName(column.nameId)
  const breakdown =
    namespaceUri === null ? breakdownBase : `${breakdownBase} — namespace: ${namespaceUri}`

  // R43/D-071: same `window`-level listener shape `Scrollbar.tsx`'s own
  // thumb drag uses, for the same reason — a drag must keep tracking the
  // pointer even once it leaves this 6px handle, which only a listener on
  // `window` (not the handle itself) guarantees.
  function onResizeHandlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = width

    function onMove(moveEvent: PointerEvent): void {
      const next = Math.max(MIN_DRAG_WIDTH_PX, startWidth + (moveEvent.clientX - startX))
      onResizeColumn(column.nameId, next)
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={
        `grid-cell grid-header-cell${isNumeric ? ' grid-cell-numeric' : ''}` +
        (active ? ' grid-cell-active' : '')
      }
      style={style}
      role="columnheader"
      aria-selected={active}
      title={sortable ? breakdown : `${breakdown} (not sortable — composite values)`}
    >
      {/* R62 (`R61-keyboard-workflow.md` §3): `tabIndex={-1}` on both
       * buttons — they're no longer their own Tab stops (that was the
       * grid header's O(columns) tab-stop count, §2). Still clickable by
       * mouse; reachable by keyboard via the grid pane's own `onKeyDown`
       * (ArrowUp into the header row, then Enter to sort / `P` to pin). */}
      <button
        type="button"
        className="grid-header-pin"
        tabIndex={-1}
        aria-pressed={isPinned}
        aria-label={isPinned ? 'Unpin column' : 'Pin column'}
        title={isPinned ? 'Unpin column' : 'Pin column'}
        onClick={() => onTogglePin(column.nameId)}
      >
        {isPinned ? '◆' : '◇'}
      </button>
      <span className="grid-header-glyph" aria-hidden="true">
        {columnGlyph(column, repeating)}
      </span>
      <button
        type="button"
        className="grid-header-label"
        tabIndex={-1}
        disabled={!sortable}
        onClick={() => onToggleSort(column)}
      >
        {store.textOf(column.nameId)}
        {sortIndicator}
      </button>
      {isFiltered && (
        <span
          className="grid-header-filter-active"
          aria-hidden="true"
          title={`${store.textOf(column.nameId)} is filtered`}
        >
          ●
        </span>
      )}
      <div
        className="grid-header-resize-handle"
        aria-hidden="true"
        onPointerDown={onResizeHandlePointerDown}
        onDoubleClick={(event) => {
          event.stopPropagation()
          onResetColumnWidth(column.nameId)
        }}
      />
    </div>
  )
}

interface GridFilterRowProps {
  readonly store: NodeStore
  readonly orderedColumns: readonly GridColumn[]
  readonly stickyCount: number
  readonly stickyLefts: readonly number[]
  readonly bodyLeft: number
  readonly columnWidth: (column: GridColumn) => number
  readonly filters: GridFilters
  readonly colVirtualizer: ReactVirtualizer<HTMLDivElement, Element>
  readonly onFilterChange: (nameId: number, text: string) => void
}

/**
 * A toggled row of per-column filter boxes (UI-FEEDBACK.md), not a
 * per-header-cell icon: a header cell had no room left for icon + label +
 * a live filter box on one 23px line, and a per-column indicator would
 * still be needed for a filtered column scrolled off-screen either way.
 * One row, reusing `GridHeaderRow`'s own sticky/virtualized column geometry
 * so pinned and scrolled columns line up with the header for free.
 */
function GridFilterRow({
  store,
  orderedColumns,
  stickyCount,
  stickyLefts,
  bodyLeft,
  columnWidth,
  filters,
  colVirtualizer,
  onFilterChange
}: GridFilterRowProps): JSX.Element {
  const stickyColumns = orderedColumns.slice(0, stickyCount)

  return (
    <div
      className="grid-filter-row"
      role="row"
      aria-label="Column filters"
      style={{ position: 'sticky', top: ROW_HEIGHT, zIndex: 2, height: ROW_HEIGHT }}
    >
      <div
        className="grid-cell grid-row-header-cell"
        aria-hidden="true"
        style={{ position: 'sticky', left: 0, width: ROW_HEADER_WIDTH, zIndex: 3 }}
      />
      {stickyColumns.map((column, i) => (
        <GridFilterCell
          key={column.nameId}
          store={store}
          column={column}
          style={{
            position: 'sticky',
            left: stickyLefts[i]!,
            width: columnWidth(column),
            zIndex: 3
          }}
          filterText={filters.perColumn.get(column.nameId) ?? ''}
          onFilterChange={onFilterChange}
        />
      ))}
      {colVirtualizer.getVirtualItems().map((virtualCol) => {
        const column = orderedColumns[stickyCount + virtualCol.index]!
        return (
          <GridFilterCell
            key={column.nameId}
            store={store}
            column={column}
            style={{
              position: 'absolute',
              left: bodyLeft + virtualCol.start,
              width: virtualCol.size,
              top: 0,
              height: '100%'
            }}
            filterText={filters.perColumn.get(column.nameId) ?? ''}
            onFilterChange={onFilterChange}
          />
        )
      })}
    </div>
  )
}

interface GridFilterCellProps {
  readonly store: NodeStore
  readonly column: GridColumn
  readonly style: CSSProperties
  readonly filterText: string
  readonly onFilterChange: (nameId: number, text: string) => void
}

function GridFilterCell({
  store,
  column,
  style,
  filterText,
  onFilterChange
}: GridFilterCellProps): JSX.Element {
  return (
    <div className="grid-cell grid-filter-cell" style={style} role="gridcell">
      <input
        type="text"
        className="grid-header-filter"
        placeholder="filter…"
        value={filterText}
        onChange={(e) => onFilterChange(column.nameId, e.target.value)}
        aria-label={`Filter ${store.textOf(column.nameId)}`}
      />
    </div>
  )
}

interface GridBodyRowProps {
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly deltas: DeltaList
  readonly row: NodeRef
  readonly documentPosition: number
  readonly orderedColumns: readonly GridColumn[]
  readonly stickyCount: number
  readonly stickyLefts: readonly number[]
  readonly bodyLeft: number
  readonly columnWidth: (column: GridColumn) => number
  readonly top: number
  readonly isNumeric: (column: GridColumn) => boolean
  readonly colVirtualizer: ReactVirtualizer<HTMLDivElement, Element>
  readonly selected: boolean
  /** M4-PLAN.md G5: this row's node span contains a Find match. */
  readonly matched: boolean
  /** Index into `orderedColumns` of the keyboard-focused cell in this row,
   * or -1 when this row isn't the active one at all (`selected` false) —
   * without a per-cell indicator, ArrowLeft/ArrowRight changed keyboard
   * state with no visible feedback at all (caught on review: E9 requires
   * "arrows between cells," not just an internal index that only becomes
   * observable once Enter is pressed). */
  readonly activeCol: number
  readonly onActivateCell: (row: NodeRef, cell: GridCell) => void
  /** `col` is the clicked cell's index into `orderedColumns`, or -1 for the
   * row-header cell — a click now sets the active *cell*, not just the
   * active row, so mouse and keyboard agree on what's focused. */
  readonly onSelectRow: (col: number) => void
}

function GridBodyRow({
  store,
  sourceBuffer,
  deltas,
  row,
  documentPosition,
  orderedColumns,
  stickyCount,
  stickyLefts,
  bodyLeft,
  columnWidth,
  top,
  isNumeric,
  colVirtualizer,
  selected,
  matched,
  activeCol,
  onActivateCell,
  onSelectRow
}: GridBodyRowProps): JSX.Element {
  const stickyColumns = orderedColumns.slice(0, stickyCount)
  const alt = documentPosition % 2 === 0

  return (
    <div
      className={`grid-row${selected ? ' grid-row-selected' : ''}${alt ? ' grid-row-alt' : ''}${matched ? ' grid-row-matched' : ''}`}
      role="row"
      aria-rowindex={documentPosition}
      style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_HEIGHT }}
    >
      <div
        className="grid-cell grid-row-header-cell"
        style={{ position: 'sticky', left: 0, width: ROW_HEADER_WIDTH }}
        onMouseDown={() => onSelectRow(-1)}
      >
        {documentPosition.toLocaleString()}
      </div>
      {stickyColumns.map((column, i) => (
        <GridBodyCell
          key={column.nameId}
          store={store}
          sourceBuffer={sourceBuffer}
          deltas={deltas}
          row={row}
          column={column}
          style={{
            position: 'sticky',
            left: stickyLefts[i]!,
            width: columnWidth(column),
            zIndex: 1
          }}
          numeric={isNumeric(column)}
          active={i === activeCol}
          onActivate={onActivateCell}
          onSelect={() => onSelectRow(i)}
        />
      ))}
      {colVirtualizer.getVirtualItems().map((virtualCol) => {
        const colIndex = stickyCount + virtualCol.index
        const column = orderedColumns[colIndex]!
        return (
          <GridBodyCell
            key={column.nameId}
            store={store}
            sourceBuffer={sourceBuffer}
            deltas={deltas}
            row={row}
            column={column}
            style={{
              position: 'absolute',
              left: bodyLeft + virtualCol.start,
              width: virtualCol.size,
              top: 0,
              height: '100%'
            }}
            numeric={isNumeric(column)}
            active={colIndex === activeCol}
            onActivate={onActivateCell}
            onSelect={() => onSelectRow(colIndex)}
          />
        )
      })}
    </div>
  )
}

interface GridBodyCellProps {
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly deltas: DeltaList
  readonly row: NodeRef
  readonly column: GridColumn
  readonly style: CSSProperties
  readonly numeric: boolean
  readonly active: boolean
  readonly onActivate: (row: NodeRef, cell: GridCell) => void
  readonly onSelect: () => void
}

function GridBodyCell({
  store,
  sourceBuffer,
  deltas,
  row,
  column,
  style,
  numeric,
  active,
  onActivate,
  onSelect
}: GridBodyCellProps): JSX.Element {
  const cell = cellOf(store, sourceBuffer, row, column.nameId, deltas)

  const className = [
    'grid-cell',
    numeric ? 'grid-cell-numeric' : '',
    cell.kind === CellKind.Derived ? 'grid-cell-derived' : '',
    cell.kind === CellKind.Absent ? 'grid-cell-absent' : '',
    active ? 'grid-cell-active' : ''
  ]
    .filter(Boolean)
    .join(' ')

  // §11.5: derived cells carry a label distinguishing them from literal
  // ones for assistive tech, since the dimming that conveys it visually
  // has no non-visual equivalent otherwise.
  const ariaLabel =
    cell.kind === CellKind.Derived
      ? `${store.textOf(column.nameId)}, derived: ${cell.text ?? (cell.multiplicity > 0 ? 'present' : 'empty')}`
      : undefined

  let content: JSX.Element | string
  if (cell.kind === CellKind.Absent) {
    content = '—'
  } else if (cell.text === null) {
    content = '✓' // presence marker (an empty element/property with no value)
  } else {
    content = cell.text
  }

  return (
    <div
      className={className}
      style={style}
      role="gridcell"
      aria-label={ariaLabel}
      aria-selected={active}
      onMouseDown={onSelect}
      onDoubleClick={() => onActivate(row, cell)}
    >
      <span className="grid-cell-text">{content}</span>
      {cell.multiplicity > 1 && <span className="grid-cell-badge">×{cell.multiplicity}</span>}
      {cell.node !== null && cell.multiplicity <= 1 && cell.kind === CellKind.Derived && (
        <span className="grid-cell-drill" aria-hidden="true">
          ▸
        </span>
      )}
    </div>
  )
}
