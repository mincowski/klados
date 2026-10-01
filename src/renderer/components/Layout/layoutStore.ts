/**
 * Layout state (M1-PLAN.md D7): pane visibility plus the two divider
 * positions, persisted across restarts. A module-level store rather than
 * React state, in the same shape as `theme.ts` and `Palette/paletteStore.ts`
 * — toggling a pane is a *command* (`klados.layout.toggle*`, run from a
 * keybinding or the palette), which has no component instance to call
 * `setState` on.
 */
import {
  clampRawHeight,
  clampTreeWidth,
  DEFAULT_PANE_VISIBILITY,
  toggleDetail,
  toggleRaw,
  toggleTree,
  type PaneVisibility
} from './layoutLogic'

export interface LayoutState extends PaneVisibility {
  readonly treeWidth: number
  readonly rawHeight: number
}

/** R223 (`docs/plans/R223-raw-pane-default.md` § Results): `rawHeight` was
 * 0.4 while Raw was hidden by default, so almost nobody saw it. Chosen by the
 * project lead from renders: at 0.4 the Detail pane overflows its own height
 * at 1280×800 (the grid's 230 px floor plus the heading above it no longer
 * fit) and scrolls around the grid's own scrollbar. At 0.3 it fits at
 * 1280×800 and larger; at 1024×700 it overflows by 8 px. */
const DEFAULT_STATE: LayoutState = {
  ...DEFAULT_PANE_VISIBILITY,
  treeWidth: 260,
  rawHeight: 0.3
}

const STORAGE_KEY = 'klados.layout'

function isLayoutState(value: unknown): value is LayoutState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.treeVisible === 'boolean' &&
    typeof v.detailVisible === 'boolean' &&
    typeof v.rawVisible === 'boolean' &&
    typeof v.treeWidth === 'number' &&
    typeof v.rawHeight === 'number'
  )
}

function readPersisted(): LayoutState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_STATE
    const parsed: unknown = JSON.parse(raw)
    if (!isLayoutState(parsed)) return DEFAULT_STATE
    return {
      ...parsed,
      treeWidth: clampTreeWidth(parsed.treeWidth),
      rawHeight: clampRawHeight(parsed.rawHeight)
    }
  } catch {
    return DEFAULT_STATE
  }
}

let state: LayoutState = readPersisted()
const listeners = new Set<() => void>()

function setState(next: LayoutState): void {
  state = next
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  for (const listener of listeners) listener()
}

export function getLayoutState(): LayoutState {
  return state
}

export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `toggleDetail` in particular is often a guarded no-op (hiding Detail is
 * illegal except from Tree+Detail+Raw — see `layoutLogic.ts`) and returns
 * its input unchanged in that case; comparing the three visibility fields
 * rather than always calling `setState` is what keeps that a true no-op
 * (no listener notification, no `localStorage` write) rather than merely a
 * state change that happens not to be visible. */
function applyVisibility(next: PaneVisibility): void {
  if (
    next.treeVisible === state.treeVisible &&
    next.detailVisible === state.detailVisible &&
    next.rawVisible === state.rawVisible
  ) {
    return
  }
  setState({ ...state, ...next })
}

export function toggleTreePane(): void {
  applyVisibility(toggleTree(state))
}

export function toggleDetailPane(): void {
  applyVisibility(toggleDetail(state))
}

export function toggleRawPane(): void {
  applyVisibility(toggleRaw(state))
}

/** R223: shows Raw if it is hidden, for a command that needs it (Locate in
 * Source and the rest — `Raw/rawController.ts`'s `withRawView`). Goes
 * through `toggleRaw`, so it can only reach a layout §4.1 allows. A no-op
 * when Raw is already visible; never hides it. */
export function showRawPane(): void {
  if (!state.rawVisible) applyVisibility(toggleRaw(state))
}

export function setTreeWidth(px: number): void {
  setState({ ...state, treeWidth: clampTreeWidth(px) })
}

export function setRawHeight(fraction: number): void {
  setState({ ...state, rawHeight: clampRawHeight(fraction) })
}

/** Test-only: resets module state between test cases. */
export function resetLayoutForTests(): void {
  state = DEFAULT_STATE
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
  listeners.clear()
}
