/**
 * Open/closed + "which match is current" state for the Find bar (M4-PLAN.md
 * G5). R24-tabs.md §1: search results are per tab (§11.4), and this state
 * is tightly coupled to `activeSearchStore`'s own per-tab result set — "match
 * 3 of 12" would lie the moment a switch showed a different tab's (possibly
 * empty) result under the old index. So `createFindStore()` is now a
 * factory, one instance per tab (`session/tabs.ts`), and every export below
 * is a free function delegating to whichever tab is active — the same
 * "consumers keep their exact call shape" goal `activeSession.ts` has,
 * since `<FindBar>`/`Tree.tsx`/`Raw.tsx`/the palette all import these as
 * plain functions today and none of them should have to learn about tabs.
 *
 * The *query text and options* are still not here — those live in `FindBar`'s
 * own component state and reach `activeSearchStore` directly (`search()`).
 */
import { getActiveFindStore, subscribeTabs } from '../../session/tabs'
import type { SearchMode } from '../../session/searchStore'

/** R88 (`R86-find-as-query-surface.md` §4): what the palette's `/` hand-off
 * gives Find to start from — the same "no component instance to pass a
 * prop to" reasoning `paletteStore.ts`'s own `pendingInitialQuery` gives,
 * one level richer since a hand-off also has to say *which* mode to open
 * in, not just what text to prefill. */
export interface FindPrefill {
  readonly text: string
  readonly mode: SearchMode
}

export interface FindState {
  readonly isOpen: boolean
  /** Index into the active `SearchResult.starts`/`ends` that navigation
   * (next/previous) is currently parked on — `null` before the first
   * next/previous, or whenever the result set is empty. Reset to `null` by
   * a fresh `search()` call (`FindBar` itself does this — a new query
   * invalidates whatever index the old one meant). */
  readonly currentIndex: number | null
  /** M4-PLAN.md G6: the Tree's filter-to-matches mode. Lives here, not in
   * `Tree.tsx`'s own component state, so it can be a palette command
   * (`klados.find.toggleFilterToMatches`) the same way opening Find is —
   * a command has no component instance to call `setState` on. Cleared by
   * `closeFind` alongside everything else: `FindBar`'s own close handler
   * also clears `activeSearchStore`'s result, and "filtered to an empty
   * match set" would otherwise read as "the Tree is now empty" rather than
   * "filtering turned itself off," which is not what closing Find means. */
  readonly filterToMatches: boolean
  /** R90 (`R86-find-as-query-surface.md` §6): the replace row's own
   * disclosure state — collapsed by default, `Ctrl+H` opens Find with it
   * already expanded (the conventional chord). Lives here rather than in
   * `FindBar`'s own component state for the same reason `filterToMatches`
   * does: `klados.find.toggleReplace` is a command, which has no
   * component instance to call `setState` on. Reset to `false` by
   * `closeFind`, same as `filterToMatches` — a closed-then-reopened bar
   * starts collapsed again, not wherever the last session left it. */
  readonly replaceExpanded: boolean
}

export const CLOSED_FIND_STATE: FindState = {
  isOpen: false,
  currentIndex: null,
  filterToMatches: false,
  replaceExpanded: false
}

export interface FindStore {
  getFindState(): FindState
  /** `prefill`, when given, is what R88's palette hand-off supplies —
   * consumed exactly once, by `FindBar`'s own mount/open effect, via
   * `consumePrefill` below. An ordinary `Ctrl+F` open passes nothing. */
  openFind(prefill?: FindPrefill): void
  closeFind(): void
  setCurrentMatchIndex(index: number | null): void
  toggleFilterToMatches(): void
  toggleReplace(): void
  setReplaceExpanded(expanded: boolean): void
  /** Consumes and clears the pending prefill — `null` for an ordinary
   * open, or once it's already been read. Meant to be read exactly once,
   * mirroring `paletteStore.ts`'s own `consumePendingInitialQuery`. */
  consumePrefill(): FindPrefill | null
  subscribeFind(listener: () => void): () => void
}

/** Exported for `session/tabs.ts` to construct one per tab. Everything
 * below this point is the per-window delegate every other file imports. */
export function createFindStore(): FindStore {
  let state: FindState = CLOSED_FIND_STATE
  let pendingPrefill: FindPrefill | null = null
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of listeners) listener()
  }

  return {
    getFindState: () => state,
    openFind(prefill) {
      if (prefill !== undefined) pendingPrefill = prefill
      if (state.isOpen) return
      state = { ...state, isOpen: true }
      notify()
    },
    // Matches themselves (`activeSearchStore`'s own result) are cleared by
    // whoever calls this, typically alongside `activeSearchStore.clear()`,
    // not by this function itself: `findStore` only owns bar-open/current-
    // index/filter-mode state.
    closeFind() {
      if (state === CLOSED_FIND_STATE) return
      state = CLOSED_FIND_STATE
      notify()
    },
    setCurrentMatchIndex(index) {
      if (state.currentIndex === index) return
      state = { ...state, currentIndex: index }
      notify()
    },
    toggleFilterToMatches() {
      state = { ...state, filterToMatches: !state.filterToMatches }
      notify()
    },
    toggleReplace() {
      state = { ...state, replaceExpanded: !state.replaceExpanded }
      notify()
    },
    setReplaceExpanded(expanded) {
      if (state.replaceExpanded === expanded) return
      state = { ...state, replaceExpanded: expanded }
      notify()
    },
    consumePrefill() {
      const prefill = pendingPrefill
      pendingPrefill = null
      return prefill
    },
    subscribeFind(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export function getFindState(): FindState {
  return getActiveFindStore().getFindState()
}

export function openFind(prefill?: FindPrefill): void {
  getActiveFindStore().openFind(prefill)
}

/** R88 — the palette's `/` hand-off, named separately from `openFind`
 * rather than overloaded silently: a call site reading `openFindWithQuery`
 * knows at a glance it's prefilling, the way `openPalette(initialQuery)`
 * makes the palette's own equivalent visible in its own call shape. */
export function openFindWithQuery(text: string, mode: SearchMode): void {
  getActiveFindStore().openFind({ text, mode })
}

export function consumeFindPrefill(): FindPrefill | null {
  return getActiveFindStore().consumePrefill()
}

/** R90 §6 — `Ctrl+H`'s own command (`klados.find.openWithReplace`):
 * opens Find, same as `openFind`, with the replace row already expanded —
 * the conventional chord's whole point is skipping the extra click. */
export function openFindWithReplace(): void {
  const store = getActiveFindStore()
  store.openFind()
  store.setReplaceExpanded(true)
}

export function closeFind(): void {
  getActiveFindStore().closeFind()
}

export function setCurrentMatchIndex(index: number | null): void {
  getActiveFindStore().setCurrentMatchIndex(index)
}

export function toggleFilterToMatches(): void {
  getActiveFindStore().toggleFilterToMatches()
}

export function toggleReplace(): void {
  getActiveFindStore().toggleReplace()
}

/** Composes with a tab switch exactly like `activeSession.ts`'s own
 * `subscribe` — a switch is itself a state change (a different tab's bar
 * may be open, or not), so it has to be something this subscription reacts
 * to, not just changes within one tab's own find store. */
export function subscribeFind(listener: () => void): () => void {
  let unsubscribeStore = getActiveFindStore().subscribeFind(listener)
  const unsubscribeTabs = subscribeTabs(() => {
    unsubscribeStore()
    unsubscribeStore = getActiveFindStore().subscribeFind(listener)
    listener()
  })
  return () => {
    unsubscribeStore()
    unsubscribeTabs()
  }
}

/** Test-only: resets the active tab's find state between test cases. */
export function resetFindStoreForTests(): void {
  const active = getActiveFindStore()
  active.closeFind()
  active.setCurrentMatchIndex(null)
  if (active.getFindState().filterToMatches) active.toggleFilterToMatches()
  active.setReplaceExpanded(false)
  active.consumePrefill()
}
