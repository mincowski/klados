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

let currentGrid: GridController | null = null

export function registerGridController(controller: GridController): () => void {
  currentGrid = controller
  return () => {
    if (currentGrid === controller) currentGrid = null
  }
}

/** A no-op if no `Grid` is mounted — a command running with nothing to act
 * on is not an error, same reasoning as `treeController.ts`'s own. */
export function copyGridAs(format: GridExportFormat): void {
  currentGrid?.copyAs(format)
}

export function focusGridQuickFilter(): void {
  currentGrid?.focusQuickFilter()
}

/** R94 — `false` (not focused) when no `Grid` is mounted, so `Detail`'s
 * own `registerPaneContent` delegate can fall through to `PaneShell`'s
 * shell focus exactly as it would for any other "nothing to focus" case. */
export function focusGrid(): boolean {
  if (currentGrid === null) return false
  currentGrid.focusGrid()
  return true
}

export function confirmGridExport(): void {
  currentGrid?.confirmExport()
}

export function cancelGridExport(): void {
  currentGrid?.cancelExport()
}
