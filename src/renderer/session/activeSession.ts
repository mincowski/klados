/**
 * R24-tabs.md: a lookup against the active tab, not a module-level
 * `DocumentSession` instance — `tabs.ts` holds the real instances now.
 * Every consumer (`activeSession.openFileDialog()`,
 * `activeSession.applyEdit(...)`, and the rest) keeps the exact same call
 * shape it always had; that's the whole point (R24 §2's "panes and
 * commands do not learn about tabs at all"). The 17 action methods below
 * are plain delegation — resolved against whichever tab is active at the
 * moment of the call, nothing cached. `getSnapshot`/`subscribe` need one
 * more thing those don't: `useSyncExternalStore` calls `subscribe` once
 * and expects a stable subscription for as long as nothing changes, so
 * switching the *active tab* — not a change within one tab's own session —
 * has to be an event that subscription itself reacts to, or a component
 * would keep rendering the previous tab's document after a switch.
 */
import { getActiveSession, subscribeTabs } from './tabs'
import type { DocumentSession } from './documentSession'

export const activeSession: DocumentSession = {
  getSnapshot: () => getActiveSession().getSnapshot(),
  subscribe: (listener) => {
    let unsubscribeSession = getActiveSession().subscribe(listener)
    // A tab switch is itself a snapshot change (a different document, or
    // none) — resubscribe to the newly active session and tell React so,
    // in that order: the new subscription must be live before `listener()`
    // can trigger the `getSnapshot()` read that follows it.
    const unsubscribeTabs = subscribeTabs(() => {
      unsubscribeSession()
      unsubscribeSession = getActiveSession().subscribe(listener)
      listener()
    })
    return () => {
      unsubscribeSession()
      unsubscribeTabs()
    }
  },
  openFileDialog: () => getActiveSession().openFileDialog(),
  openPath: (path) => getActiveSession().openPath(path),
  confirmOpenAnyway: () => getActiveSession().confirmOpenAnyway(),
  cancel: () => getActiveSession().cancel(),
  setSelectedNode: (node, options) => getActiveSession().setSelectedNode(node, options),
  setCaretOffset: (offset) => getActiveSession().setCaretOffset(offset),
  applyEdit: (request) => getActiveSession().applyEdit(request),
  applyReplaceAll: (matches, replacementText) =>
    getActiveSession().applyReplaceAll(matches, replacementText),
  save: () => getActiveSession().save(),
  saveAs: () => getActiveSession().saveAs(),
  reloadAndDiscard: () => getActiveSession().reloadAndDiscard(),
  keepMine: () => getActiveSession().keepMine(),
  undo: () => getActiveSession().undo(),
  redo: () => getActiveSession().redo(),
  requestTransform: (kind) => getActiveSession().requestTransform(kind),
  confirmTransformAnyway: () => getActiveSession().confirmTransformAnyway(),
  cancelTransform: () => getActiveSession().cancelTransform(),
  dismissMinifiedBanner: () => getActiveSession().dismissMinifiedBanner(),
  clearUndoHistory: () => getActiveSession().clearUndoHistory(),
  resyncContext: () => getActiveSession().resyncContext(),
  // Disposal is per-tab lifecycle (`tabs.ts`'s `closeTab`), not something a
  // consumer of "whichever tab is active" should be able to trigger — same
  // reasoning `activeSearchStore.ts`'s own `dispose` no-op documents.
  dispose: () => {}
}
