/**
 * Lets a registry command reach the currently-mounted `Grid` view (E8's
 * copy-as-CSV/TSV/Markdown commands) — invariant 10 requires every command
 * be palette-reachable, and a palette command has no direct handle on a
 * specific component instance's state (the current sort/filter/selection).
 * Same "component registers a live handle with a module-level singleton"
 * shape as `Tree/treeController.ts`.
 *
 * The grid/list override toggle that used to have its own slot here
 * (`DetailGridToggle`) is gone — UI-FEEDBACK.md's M5b "Remove the
 * 'Show as grid' / 'Show as list' button" entry, recorded as D-049.
 *
 * **R211 made "the mounted Grid" plural.** One table per group means several
 * live grids at once, so a single `currentGrid` slot would have handed every
 * command to whichever one registered last — an arbitrary target, which is
 * the unpredictability R210 exists to remove, reappearing in the command
 * layer. The registry is now every mounted grid in mount order (document
 * order, since `Detail.tsx` renders them in it) plus the one most recently
 * focused; commands act on that one, falling back to the first.
 */
import type { GridExportFormat } from './gridExport'

export interface GridController {
  copyAs(format: GridExportFormat): void
  /** Focuses the quick-filter box — the single "find anything in this
   * table" input (not the per-column filter row, which is a separate
   * control with its own toggle). */
  focusQuickFilter(): void
  /** R94 (`R91-focus-into-content.md` §5): focuses `.grid-scroll` itself —
   * Detail's own F6 delegate for grid mode, since the element lives in this
   * child component. `active` already starts `{row: 0, col: 0}`. */
  focusGrid(): void
  /** R21-notifications.md §1/§3g: resolves the export soft-cap choice
   * notification (`Grid.tsx`'s own `pendingExport`) — a no-op if nothing
   * is pending. */
  confirmExport(): void
  cancelExport(): void
}

/**
 * A stable per-`Grid` identity, distinct from the controller object.
 *
 * The two cannot be the same thing: `Grid` re-registers its controller
 * whenever the snapshot a command would read changes (its sort, its filter,
 * its columns), so the controller object is replaced many times during one
 * grid's life. Keying "which grid has the keyboard" on the controller would
 * lose that the moment the user typed into a filter box.
 */
export type GridId = object

const controllers = new Map<GridId, GridController>()
let focusedId: GridId | null = null

export function registerGridController(id: GridId, controller: GridController): () => void {
  controllers.set(id, controller)
  return () => {
    // Only if this exact controller is still the one registered under `id`:
    // a re-registration replaces the entry before the previous effect's
    // cleanup runs in some React orderings, and deleting then would unmount
    // a live grid from the registry.
    if (controllers.get(id) === controller) controllers.delete(id)
    if (focusedId === id && !controllers.has(id)) focusedId = null
  }
}

/** Called from each grid's own `onFocusCapture` — anything inside it taking
 * focus makes it the one commands act on. Never cleared on blur: after the
 * user opens the palette, focus is in the palette, and "the grid I was just
 * in" is exactly the right target for the command they are about to run. */
export function noteGridFocused(id: GridId): void {
  if (controllers.has(id)) focusedId = id
}

/** The most recently focused mounted grid, or the first one — document
 * order, since `Detail.tsx` renders the tables in it. `null` when none is
 * mounted. */
function currentGrid(): GridController | null {
  if (focusedId !== null) {
    const focused = controllers.get(focusedId)
    if (focused !== undefined) return focused
  }
  for (const controller of controllers.values()) return controller
  return null
}

/** Test-only: the registry is module state and a test that mounts grids
 * would otherwise leak them into the next one. */
export function resetGridControllersForTests(): void {
  controllers.clear()
  focusedId = null
}

/** How many grids are currently registered — exposed for tests asserting
 * that several tables really do mount several live grids. */
export function mountedGridCount(): number {
  return controllers.size
}

/** A no-op if no `Grid` is mounted — a command running with nothing to act
 * on is not an error, same reasoning as `treeController.ts`'s own. */
export function copyGridAs(format: GridExportFormat): void {
  currentGrid()?.copyAs(format)
}

export function focusGridQuickFilter(): void {
  currentGrid()?.focusQuickFilter()
}

/** R94 — `false` (not focused) when no `Grid` is mounted, so `Detail`'s
 * own `registerPaneContent` delegate can fall through to `PaneShell`'s
 * shell focus exactly as it would for any other "nothing to focus" case. */
export function focusGrid(): boolean {
  const grid = currentGrid()
  if (grid === null) return false
  grid.focusGrid()
  return true
}

export function confirmGridExport(): void {
  currentGrid()?.confirmExport()
}

export function cancelGridExport(): void {
  currentGrid()?.cancelExport()
}
