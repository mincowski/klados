/**
 * Pure layout logic (M1-PLAN.md D7, CONCEPT.md §4.1): which of the three
 * panes are visible, and the two divider positions. Kept free of React and
 * `localStorage` (`layoutStore.ts` adds persistence) so the toggle rules can
 * be exercised directly by `test/layout.test.ts`, the same split
 * `paletteLogic.ts`/`paletteStore.ts` uses.
 *
 * CONCEPT.md §4.1 describes "two independent toggles — show/hide Tree,
 * show/hide Raw" but then lists five reachable layouts, one of which
 * (Tree + Raw, Detail hidden) is unreachable from only those two toggles —
 * Detail has to be toggleable too. This module adds that third toggle and
 * constrains it so the reachable set is exactly the five CONCEPT.md names,
 * not the eight a fully independent third boolean would allow: Tree-alone
 * and Raw-alone stay unreachable because Detail is "the primary working
 * surface" (§4.1) and never leaves the user with neither Detail nor a
 * companion pane visible.
 */

export interface PaneVisibility {
  readonly treeVisible: boolean
  readonly detailVisible: boolean
  readonly rawVisible: boolean
}

export const DEFAULT_PANE_VISIBILITY: PaneVisibility = {
  treeVisible: true,
  detailVisible: true,
  rawVisible: false
}

/** Tree + Raw with Detail hidden is the one legal state with two panes and
 * no Detail; a single visible pane is legal only when it's Detail. Anything
 * else (Tree alone, Raw alone, nothing at all) is not a state this module
 * will settle in. */
function isForbidden(v: PaneVisibility): boolean {
  const visibleCount = Number(v.treeVisible) + Number(v.detailVisible) + Number(v.rawVisible)
  if (visibleCount === 0) return true
  if (visibleCount === 1 && !v.detailVisible) return true
  return false
}

/** Flips `treeVisible`, recovering into Detail rather than landing on the
 * forbidden "Raw alone" (reachable only from Tree + Raw, by hiding Tree). */
export function toggleTree(v: PaneVisibility): PaneVisibility {
  const next = { ...v, treeVisible: !v.treeVisible }
  return isForbidden(next) ? { ...next, detailVisible: true } : next
}

/** Flips `rawVisible`, recovering into Detail rather than landing on the
 * forbidden "Tree alone" (reachable only from Tree + Raw, by hiding Raw). */
export function toggleRaw(v: PaneVisibility): PaneVisibility {
  const next = { ...v, rawVisible: !v.rawVisible }
  return isForbidden(next) ? { ...next, detailVisible: true } : next
}

/**
 * Showing Detail is always allowed. Hiding it is the one operation this
 * module actually guards — the only way to reach "Tree + Raw" — and it's
 * only legal from "Tree + Detail + Raw", i.e. when both other panes are
 * already visible. A no-op otherwise, rather than reaching for a state
 * `isForbidden` would have to repair.
 */
export function toggleDetail(v: PaneVisibility): PaneVisibility {
  if (!v.detailVisible) return { ...v, detailVisible: true }
  if (v.treeVisible && v.rawVisible) return { ...v, detailVisible: false }
  return v
}

export const TREE_WIDTH_RANGE = { min: 160, max: 600 } as const
export const RAW_HEIGHT_RANGE = { min: 0.15, max: 0.85 } as const

export function clampTreeWidth(px: number): number {
  return Math.min(TREE_WIDTH_RANGE.max, Math.max(TREE_WIDTH_RANGE.min, px))
}

/** Raw's share of the Detail+Raw column's height, as a fraction. */
export function clampRawHeight(fraction: number): number {
  return Math.min(RAW_HEIGHT_RANGE.max, Math.max(RAW_HEIGHT_RANGE.min, fraction))
}
