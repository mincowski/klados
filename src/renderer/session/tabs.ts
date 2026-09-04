/**
 * R24-tabs.md — the renderer's tab registry. Each tab bundles the four
 * things §11.4/§1 names as genuinely per-document: a `DocumentSession`
 * (`documentSession.ts`'s own factory), a `SearchStore` (`searchStore.ts`,
 * whose own header already anticipated this — "each tab gets its own
 * `createSearchStore(session)`"), a `FindStore` (bar open/current-index/
 * filter-mode — tightly coupled to the search result, so it follows the
 * same per-tab rule), and a `NavigationStore` (back/forward history).
 * `commands/context` is *not* bundled here — it's a derived projection of
 * the active tab (§1's table), which is why the per-tab stores that write
 * into it (`documentSession`, `navigationStore`) take an `isActive` gate
 * instead of owning any context state themselves.
 *
 * `activeSession.ts`, `activeSearchStore.ts`, `findStore.ts` and
 * `navigationStore.ts` are the only consumers of this module — every other
 * pane and command keeps reading through those exactly as before (R24 §2's
 * "panes and commands do not learn about tabs at all").
 *
 * M1 through R24 still has exactly one tab, created lazily on first access
 * — see `getActiveSession`'s own comment.
 */
import {
  createDocumentSession,
  type DocumentSession,
  type DocumentSessionDeps
} from './documentSession'
import type { SaveOutcome } from './save'
import { setContext } from '../commands/context'
import { createSearchStore, type SearchStore } from './searchStore'
import { createFindStore, type FindStore } from '../components/Find/findStore'
import { createNavigationStore, type NavigationStore } from '../navigation/navigationStore'
import { computeMemoryBudget } from '../components/StatusBar/memoryBudget'

export type TabId = string

interface TabEntry {
  readonly id: TabId
  readonly session: DocumentSession
  readonly searchStore: SearchStore
  readonly findStore: FindStore
  readonly navigationStore: NavigationStore
}

let tabs: readonly TabEntry[] = []
// R25: `getTabIds` needs to be usable as a `useSyncExternalStore` snapshot
// getter directly (the tab strip's own `[role="tab"]` list). A fresh
// `tabs.map(...)` on every call would return a new array identity even when
// the tab set hasn't changed, which `useSyncExternalStore` reads as "always
// different" and re-renders forever — cached here, recomputed only where
// `tabs` itself is reassigned below, the same "stable until it actually
// changes" contract every other per-tab lookup in this module already
// gives its own consumers.
let tabIds: readonly TabId[] = []
let activeTabId: TabId | null = null
// R26 (`R24-tabs.md` §4): the tab a close was requested for while it
// had unsaved changes — "closing a dirty tab prompts" per §11.4, and
// R21-notifications.md §3a's rule is that a choice is *derived* from
// pending state, not pushed, so this needs to be state something can
// render from rather than a one-shot dialog. Never more than one at a time
// — requesting a close activates the tab first (`requestCloseTab`), so the
// prompt is always visible where it was requested.
let pendingCloseTabId: TabId | null = null
let nextId = 0
const listeners = new Set<() => void>()

function emit(): void {
  // R26: `hasPendingCloseTab` mirrors "the pending close belongs to the tab
  // that's actually active" — cheap to recompute on every `emit()` (a
  // no-op `setContext` call when nothing changed, per its own dedupe) and
  // simpler than auditing every call site that could affect either half.
  const hasPendingCloseTab = pendingCloseTabId !== null && pendingCloseTabId === activeTabId
  setContext('hasPendingCloseTab', hasPendingCloseTab)
  setContext('hasPendingQuit', hasPendingCloseTab && quitQueue !== null)
  for (const listener of listeners) listener()
}

function activate(entry: TabEntry): void {
  activeTabId = entry.id
  entry.session.resyncContext()
  entry.navigationStore.resyncContext()
}

/**
 * Creates a new tab with its own session, search store, find state and
 * navigation history, wired so the two that write `commands/context`
 * (session, navigation) only do so while this tab is active. Does not
 * activate it — the first tab ever created becomes active automatically
 * (nothing else could be active), any tab after that stays background
 * until `setActiveTab`. Returns the new tab's id.
 */
export function createTab(
  deps: Omit<DocumentSessionDeps, 'isActive' | 'estimateOtherTabsBytes' | 'watchKey'> = {}
): TabId {
  const id = `tab-${nextId++}`
  const isActive = (): boolean => activeTabId === id
  const session = createDocumentSession({
    ...deps,
    isActive,
    // R28: excludes this tab's own (not-yet-existing) entry — `tabs` here
    // is whatever it is *at call time*, which is correct: this closure
    // only ever runs later, when `openPath` actually needs the figure, by
    // which point `tabs` includes every tab that exists then.
    estimateOtherTabsBytes: () => getCrossTabMemoryBytes(id),
    // R52: the tab's own id is the identity `document:watch`/`unwatch`
    // registers under — main can now watch each tab's file independently
    // instead of one watcher for the whole app.
    watchKey: id
  })
  const entry: TabEntry = {
    id,
    session,
    searchStore: createSearchStore(session),
    findStore: createFindStore(),
    navigationStore: createNavigationStore(session, isActive)
  }
  tabs = [...tabs, entry]
  tabIds = tabs.map((tab) => tab.id)
  if (activeTabId === null) activate(entry)
  emit()
  return id
}

/** Removes a tab. A no-op for an id that isn't open — the same tolerance
 * `treeController.ts`'s own commands give a call with nothing to act on.
 * Activating a neighbor when the closed tab was active is `tabs.ts`'s own
 * job here rather than the caller's, so no caller can forget it. */
export function closeTab(id: TabId): void {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return
  const [closed] = tabs.filter((tab) => tab.id === id)
  tabs = tabs.filter((tab) => tab.id !== id)
  tabIds = tabs.map((tab) => tab.id)
  closed?.searchStore.dispose()
  closed?.session.dispose()
  if (activeTabId === id) {
    const next = tabs[index] ?? tabs[index - 1]
    activeTabId = next?.id ?? null
    if (next !== undefined) activate(next)
  }
  emit()
}

function isDirty(id: TabId): boolean {
  const snapshot = tabs.find((tab) => tab.id === id)?.session.getSnapshot()
  return snapshot?.phase === 'ready' && snapshot.document.dirty
}

function beginClosePrompt(id: TabId): void {
  if (activeTabId !== id) setActiveTab(id)
  pendingCloseTabId = id
  emit()
}

/**
 * §11.4: "closing a dirty tab prompts *Save* / *Discard* / *Cancel*;
 * closing a clean tab is silent." A clean tab (or one that's gone, or
 * mid-open) closes immediately via the plain `closeTab` above — no reason
 * to prompt over nothing to lose. A dirty tab is activated (so the
 * notification the caller renders from `getPendingCloseTabId()` is visible
 * in context, not on a tab the user isn't looking at) and left open until
 * `saveAndCloseTab`/`discardAndCloseTab`/`cancelCloseTab` resolves it.
 *
 * R26: guarded against a quit flow already asking about a *different* tab
 * — without this, a manual close click on some other dirty tab while a
 * quit-time prompt is up would overwrite `pendingCloseTabId`, silently
 * dropping the tab the quit flow was waiting on from both `pendingCloseTabId`
 * and `quitQueue` (it's in neither once overwritten) — the quit flow would
 * then finish and the app would actually quit with that tab's edits still
 * unsaved. Found in review, not by a failing test. The quit flow itself
 * drives prompts through `promptOrSkip` below, not this function, so it
 * never trips its own guard.
 */
export function requestCloseTab(id: TabId): void {
  if (!isDirty(id)) {
    closeTab(id)
    return
  }
  if (quitQueue !== null && pendingCloseTabId !== id) return
  beginClosePrompt(id)
}

/** Used only by the quit flow (`startQuitFlow`/`advanceQuitQueue`) to move
 * to the next tab in the queue. Unlike `requestCloseTab`, always proceeds
 * — it *is* what's driving the flow, so there's no "someone else's prompt"
 * to protect — and if the tab turned clean in the meantime (saved through
 * some other path while a different tab's prompt was up), closes it and
 * keeps the queue moving rather than stalling on a tab with nothing left
 * to ask about. */
function promptOrSkip(id: TabId): void {
  if (!isDirty(id)) {
    closeTab(id)
    advanceQuitQueue()
    return
  }
  beginClosePrompt(id)
}

export function cancelCloseTab(): void {
  if (pendingCloseTabId === null) return
  pendingCloseTabId = null
  emit()
}

/** *Discard* — closes without saving, per §11.4. */
export function discardAndCloseTab(id: TabId): void {
  if (pendingCloseTabId === id) pendingCloseTabId = null
  closeTab(id)
  advanceQuitQueue()
}

/**
 * *Save* — saves, then closes only if the save actually succeeded; a
 * failed save leaves the tab and the prompt exactly where they were. The
 * caller (`components/TabStrip/commands.ts`'s `klados.tabs.saveAndCloseActive`)
 * pushes an error notification with the returned message on failure —
 * `document.save`'s own `Save` command silently drops a failed outcome
 * today (a discarded return value, not a documented behaviour worth
 * matching here).
 */
export async function saveAndCloseTab(id: TabId): Promise<SaveOutcome> {
  const tab = tabs.find((t) => t.id === id)
  if (tab === undefined) return { ok: true }
  const outcome = await tab.session.save()
  if (outcome.ok) {
    if (pendingCloseTabId === id) pendingCloseTabId = null
    closeTab(id)
    advanceQuitQueue()
  }
  return outcome
}

export function getPendingCloseTabId(): TabId | null {
  return pendingCloseTabId
}

// R26 (`R24-tabs.md` §4): the consolidated quit flow — Notepad++'s
// shape, not a single list-view modal (confirmed with the project lead):
// one dirty tab at a time, through the exact same Save/Discard/Cancel
// prompt a single ad-hoc close already uses, plus a "Discard All" bulk
// action once more than one is queued. Main-process interception and the
// IPC round trip (`preload/api.ts`'s `app` namespace) are the same either
// way — only the UI shape changed from the plan's original "one
// consolidated list."

/** The dirty tabs still waiting their turn, **not** including whichever one
 * `pendingCloseTabId` currently points at — that one is mid-prompt, this is
 * the rest of the line. `null` means no quit flow is in progress. */
let quitQueue: readonly TabId[] | null = null

/** Set once, by `session/quitFlow.ts`, to the two things only that module
 * knows how to do: tell main to actually close the window, or tell main
 * the user backed out. `tabs.ts` itself has no IPC/preload dependency —
 * same reasoning `documentSession.ts` takes `api`/`parse` as injected deps
 * rather than reaching for `window.api` directly. */
interface QuitFlowHandlers {
  readonly onAllResolved: () => void
  readonly onCancelled: () => void
}
let quitFlowHandlers: QuitFlowHandlers | null = null

export function setQuitFlowHandlers(handlers: QuitFlowHandlers): void {
  quitFlowHandlers = handlers
}

export function isQuitInProgress(): boolean {
  return quitQueue !== null
}

/** Advances to the next queued tab, or — once the queue and the current
 * prompt are both empty — reports completion. Called after every close
 * that happens *during* a quit flow (both `discardAndCloseTab` and a
 * successful `saveAndCloseTab`); a no-op the rest of the time
 * (`quitQueue === null`), so those two functions don't need to know
 * whether a quit is even in progress. */
function advanceQuitQueue(): void {
  if (quitQueue === null) return
  const [next, ...rest] = quitQueue
  if (next === undefined) {
    quitQueue = null
    quitFlowHandlers?.onAllResolved()
    return
  }
  quitQueue = rest
  promptOrSkip(next)
}

/**
 * Starts the flow: every currently dirty tab, in strip order. Zero dirty
 * tabs resolves immediately — the common case, and indistinguishable from
 * "nothing to ask about" from the caller's point of view.
 */
export function startQuitFlow(): void {
  const dirtyIds = getTabIds().filter(isDirty)
  if (dirtyIds.length === 0) {
    quitFlowHandlers?.onAllResolved()
    return
  }
  const [first, ...rest] = dirtyIds
  quitQueue = rest
  promptOrSkip(first!)
}

/** Notepad++'s own "No to All" — discards whichever tab is mid-prompt plus
 * everything still queued, in one step, then reports completion. */
export function discardAllAndQuit(): void {
  const remaining = [
    ...(pendingCloseTabId !== null ? [pendingCloseTabId] : []),
    ...(quitQueue ?? [])
  ]
  quitQueue = null
  pendingCloseTabId = null
  for (const id of remaining) closeTab(id)
  emit()
  quitFlowHandlers?.onAllResolved()
}

/** Backs out of the whole flow — the tab mid-prompt and everything still
 * queued are left open, exactly as they were; nothing closes. */
export function cancelQuitFlow(): void {
  const wasActive = quitQueue !== null || pendingCloseTabId !== null
  quitQueue = null
  pendingCloseTabId = null
  if (wasActive) emit()
  quitFlowHandlers?.onCancelled()
}

/**
 * R26 (`R24-tabs.md` §4): "open into a new tab" — the behaviour change
 * `klados.document.open` (Ctrl+O, the title bar, the palette) and the tab
 * strip's own "+" both need. Lives here rather than in a commands module so
 * both can import it without either depending on the other's feature
 * folder. Always creates a new tab, even for the very first document opened
 * in an otherwise-empty app — CONCEPT.md §11.4 gives no "reuse an empty
 * tab" exception, and inventing one wasn't attempted here.
 */
export function openNewTab(): void {
  const id = createTab()
  setActiveTab(id)
  void getSessionFor(id)?.openFileDialog()
}

/** The drag-and-drop equivalent of `openNewTab` — a known path rather than
 * the native dialog (`Layout.tsx`'s own `onDrop`). */
export function openPathInNewTab(path: string): void {
  const id = createTab()
  setActiveTab(id)
  void getSessionFor(id)?.openPath(path)
}

export function setActiveTab(id: TabId): void {
  if (activeTabId === id) return
  const tab = tabs.find((t) => t.id === id)
  if (tab === undefined) return
  activate(tab)
  emit()
}

/** R26: keyboard switching (Ctrl+Tab/Ctrl+Shift+Tab) — wraps around, and is
 * a no-op with zero or one tab (nothing to switch to). */
function activateByOffset(offset: 1 | -1): void {
  if (tabIds.length < 2 || activeTabId === null) return
  const index = tabIds.indexOf(activeTabId)
  const next = tabIds[(index + offset + tabIds.length) % tabIds.length]
  if (next !== undefined) setActiveTab(next)
}

export function activateNextTab(): void {
  activateByOffset(1)
}

export function activatePreviousTab(): void {
  activateByOffset(-1)
}

export function getActiveTabId(): TabId | null {
  return activeTabId
}

export function getTabIds(): readonly TabId[] {
  return tabIds
}

function getActiveEntry(): TabEntry {
  if (activeTabId === null) createTab()
  const tab = tabs.find((t) => t.id === activeTabId)
  if (tab === undefined) throw new Error('tabs.ts: no active tab after createTab')
  return tab
}

/** The active tab's session, minting the first tab on first access — this
 * is what preserves "there is always exactly one document session" for
 * every existing call site until `R24-tabs.md` R25's strip lets a
 * second tab actually exist. */
export function getActiveSession(): DocumentSession {
  return getActiveEntry().session
}

export function getActiveSearchStoreInstance(): SearchStore {
  return getActiveEntry().searchStore
}

export function getActiveFindStore(): FindStore {
  return getActiveEntry().findStore
}

export function getActiveNavigationStore(): NavigationStore {
  return getActiveEntry().navigationStore
}

export function getSessionFor(id: TabId): DocumentSession | undefined {
  return tabs.find((tab) => tab.id === id)?.session
}

/** R28 (`R24-tabs.md` §6): the summed `computeMemoryBudget(...).totalBytes`
 * of every *ready* open tab, optionally excluding one (`createTab`'s own
 * `estimateOtherTabsBytes` dependency excludes the tab asking). A tab that
 * hasn't finished opening yet (`empty`/`parsing`/`confirmSize`/`error`)
 * contributes nothing — there is no `OpenDocument` to measure, and its own
 * eventual size is exactly the estimate the caller is already folding in
 * separately. Also read directly by `StatisticsPanel.tsx` (no exclusion)
 * for the cross-tab figure §6 asks the panel to carry. */
export function getCrossTabMemoryBytes(excludeId?: TabId): number {
  let total = 0
  for (const tab of tabs) {
    if (tab.id === excludeId) continue
    const snapshot = tab.session.getSnapshot()
    if (snapshot.phase === 'ready') total += computeMemoryBudget(snapshot.document).totalBytes
  }
  return total
}

/** Fires whenever the tab *set* or the active *pointer* changes — not on a
 * change within one tab's own stores (each store's own `subscribe` already
 * covers that; `activeSession.ts`/`activeSearchStore.ts`/`findStore.ts`
 * each compose both). */
export function subscribeTabs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: restores the module to its initial (no-tabs) state. */
export function resetTabsForTests(): void {
  for (const tab of tabs) {
    tab.searchStore.dispose()
    tab.session.dispose()
  }
  tabs = []
  tabIds = []
  activeTabId = null
  pendingCloseTabId = null
  quitQueue = null
  quitFlowHandlers = null
  nextId = 0
}
