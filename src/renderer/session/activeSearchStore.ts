/**
 * R24-tabs.md §1: search results are per tab (§11.4) — `tabs.ts` now owns
 * one real `SearchStore` per tab, built via `createSearchStore(session)`
 * bound to that tab's own session. This is the lookup against whichever
 * tab is active, same shape as `activeSession.ts` — every consumer
 * (`Tree.tsx`, `Raw.tsx`, `Grid.tsx`, `Scrubber.tsx`, `FindBar.tsx`,
 * `Palette.tsx`) keeps calling `activeSearchStore.search(...)`,
 * `.getSnapshot()` etc. exactly as before.
 */
import { getActiveSearchStoreInstance, subscribeTabs } from './tabs'
import type { SearchStore } from './searchStore'

export const activeSearchStore: SearchStore = {
  getSnapshot: () => getActiveSearchStoreInstance().getSnapshot(),
  getQuery: () => getActiveSearchStoreInstance().getQuery(),
  getPathDiagnostic: () => getActiveSearchStoreInstance().getPathDiagnostic(),
  subscribe: (listener) => {
    let unsubscribeStore = getActiveSearchStoreInstance().subscribe(listener)
    // Same composition `activeSession.ts` uses: a tab switch is itself a
    // result-set change (a different tab's matches, or none), so it has to
    // trigger the same listener a change within one tab's own store would.
    const unsubscribeTabs = subscribeTabs(() => {
      unsubscribeStore()
      unsubscribeStore = getActiveSearchStoreInstance().subscribe(listener)
      listener()
    })
    return () => {
      unsubscribeStore()
      unsubscribeTabs()
    }
  },
  search: (query) => getActiveSearchStoreInstance().search(query),
  clear: () => getActiveSearchStoreInstance().clear(),
  // Disposal is per-tab lifecycle now (`tabs.ts`'s `closeTab`), not
  // something a consumer of "whichever tab is active" should be able to
  // trigger — a no-op here rather than disposing whatever happens to be
  // active at the call site.
  dispose: () => {}
}
