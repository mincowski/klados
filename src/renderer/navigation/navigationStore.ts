/**
 * Back/forward history for the current document (M1-PLAN.md D14).
 * R24-tabs.md §1: history is per document, so `createNavigationStore` is now
 * a factory — one instance per tab (`session/tabs.ts`), each bound to that
 * tab's own `DocumentSession` directly (not the tab-aware `activeSession`
 * delegate — an instance already only ever needs to know about its own
 * tab's document, so there's no lookup to do). `recordNavigation`/`goBack`/
 * `goForward` stay free functions delegating to whichever tab is active —
 * `selectNode.ts` and `navigation/commands.ts` keep calling them exactly as
 * before.
 *
 * `commands/context`'s `canGoBack`/`canGoForward` are a projection of the
 * *active* tab (same reasoning `documentSession.ts`'s `setCtx`/
 * `resyncContext` document) — `isActive` gates every write here the same
 * way, and `resyncContext` is what `tabs.ts` calls right after a switch.
 */
import type { NodeStore } from '../../core/nodeStore'
import type { NodeRef } from '../../core/types'
import { setContext } from '../commands/context'
import type { DocumentSession } from '../session/documentSession'
import { getActiveNavigationStore } from '../session/tabs'
import {
  canStepBack,
  canStepForward,
  EMPTY_HISTORY,
  recordVisit,
  stepBack,
  stepForward,
  type HistoryState
} from './history'

export interface NavigationStore {
  recordNavigation(node: NodeRef): void
  /** `null` when there's nowhere to go — the caller (the command) should
   * treat that as a no-op, not an error. */
  goBack(): NodeRef | null
  goForward(): NodeRef | null
  /** R24-tabs.md: forces `canGoBack`/`canGoForward` to be rewritten from
   * this instance's own current history — see this module's own top
   * comment for why gated writes need this on activation. */
  resyncContext(): void
  /** Test-only: drops all history, unconditionally (bypasses `isActive`). */
  resetForTests(): void
}

/** Exported for `session/tabs.ts` to construct one per tab, bound to that
 * tab's own session. `isActive` defaults to always-active, so a direct call
 * (every existing test) behaves exactly as the old module-level singleton
 * did. */
export function createNavigationStore(
  session: DocumentSession,
  isActive: () => boolean = () => true
): NavigationStore {
  let history: HistoryState = EMPTY_HISTORY
  let lastStore: NodeStore | null = null

  function setCtx(key: 'canGoBack' | 'canGoForward', value: boolean): void {
    if (isActive()) setContext(key, value)
  }

  function syncContext(): void {
    setCtx('canGoBack', canStepBack(history))
    setCtx('canGoForward', canStepForward(history))
  }

  // Resets history whenever the document underneath it changes — old node
  // refs are meaningless once a new parse replaces the store, and holding
  // onto them would let "back" land on a ref that now addresses an
  // unrelated node in a different document, or none at all.
  session.subscribe(() => {
    const snapshot = session.getSnapshot()
    const store = snapshot.phase === 'ready' ? snapshot.document.store : null
    if (store !== lastStore) {
      lastStore = store
      history = EMPTY_HISTORY
      syncContext()
    }
  })

  return {
    recordNavigation(node) {
      history = recordVisit(history, node)
      syncContext()
    },
    goBack() {
      const step = stepBack(history)
      if (step === null) return null
      history = step.state
      syncContext()
      return step.node
    },
    goForward() {
      const step = stepForward(history)
      if (step === null) return null
      history = step.state
      syncContext()
      return step.node
    },
    resyncContext() {
      setContext('canGoBack', canStepBack(history))
      setContext('canGoForward', canStepForward(history))
    },
    resetForTests() {
      history = EMPTY_HISTORY
      lastStore = null
      setContext('canGoBack', false)
      setContext('canGoForward', false)
    }
  }
}

export function recordNavigation(node: NodeRef): void {
  getActiveNavigationStore().recordNavigation(node)
}

export function goBack(): NodeRef | null {
  return getActiveNavigationStore().goBack()
}

export function goForward(): NodeRef | null {
  return getActiveNavigationStore().goForward()
}

/** Test-only: resets the active tab's navigation history between test
 * cases. */
export function resetNavigationForTests(): void {
  getActiveNavigationStore().resetForTests()
}
