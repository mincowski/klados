/**
 * R29 (`R24-tabs.md` §7, `CONCEPT.md` §11.4): reopens the previous tab
 * set on launch. Persists only **paths** (plus which one was active) —
 * never document content, per §7's own instruction; per-tab view state
 * (scroll position, layout) is not persisted here, disclosed as out of
 * scope in this round's own Results section rather than silently dropped.
 *
 * **Must run before the first React render**, not from a `useEffect` —
 * every pane/store reads `getActiveSession()`, which lazily mints an empty
 * tab the instant nothing is active yet (`tabs.ts`'s own `getActiveEntry`).
 * An effect fires after the first commit, by which point that lazy tab
 * already exists and restore would land its own tabs alongside a stray
 * blank one. `beginSessionRestore()` is called from `main.tsx`, before
 * `createRoot(...).render(...)`, and creates every restored tab
 * *synchronously* (`createTab()` itself is synchronous) — only the actual
 * file reads that follow are async.
 */
import { notify } from '../notifications/notificationStore'
import type { DocumentSessionDeps } from './documentSession'
import {
  createTab,
  getActiveTabId,
  getSessionFor,
  getTabIds,
  setActiveTab,
  subscribeTabs
} from './tabs'

const STORAGE_KEY = 'klados.sessionRestore'

interface PersistedSession {
  readonly paths: readonly string[]
  readonly activeIndex: number
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.paths) &&
    candidate.paths.every((p) => typeof p === 'string') &&
    typeof candidate.activeIndex === 'number'
  )
}

function readPersisted(): PersistedSession | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPersistedSession(parsed) ? parsed : null
  } catch {
    // A corrupted or hand-edited value degrades to "no session to
    // restore," the same way a missing key does — never a crash on launch.
    return null
  }
}

function writePersisted(session: PersistedSession): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

/**
 * Captures the current tab set as the thing to restore next launch — every
 * *ready* tab's own `filePath`, in strip order, plus which one is active.
 * A tab still opening (empty/parsing/confirmSize/error) has no confirmed
 * path yet and is simply omitted; if it later reaches `ready`, the next
 * call (this module's own subscriptions trigger one on every relevant
 * change) picks it up. Exported for direct testing.
 */
export function persistSessionState(): void {
  const activeId = getActiveTabId()
  const paths: string[] = []
  let activeIndex = -1
  for (const id of getTabIds()) {
    const snapshot = getSessionFor(id)?.getSnapshot()
    if (snapshot?.phase !== 'ready') continue
    if (id === activeId) activeIndex = paths.length
    paths.push(snapshot.document.filePath)
  }
  writePersisted({ paths, activeIndex })
}

let persistenceUnsubscribes: Array<() => void> = []
let unsubscribeTabsForPersistence: (() => void) | null = null

function resubscribePersistence(): void {
  persistenceUnsubscribes.forEach((unsubscribe) => unsubscribe())
  persistenceUnsubscribes = getTabIds().map(
    (id) => getSessionFor(id)?.subscribe(persistSessionState) ?? ((): void => {})
  )
}

/** Persists on every tab-set change and on every change *within* any tab's
 * own session (opening, closing, a Save As that changes `filePath`) — a
 * plain `subscribeTabs` alone would miss the moment a tab actually reaches
 * `ready`, which is the one moment its path becomes persistable.
 *
 * `unsubscribeTabsForPersistence` is captured (not discarded the way an
 * earlier version of this function left it) — `subscribeTabs` never expires
 * on its own, and `resetSessionRestoreForTests` needs a real handle to tear
 * it down or every test in this file would leave one more stray listener
 * registered against `tabs.ts`'s module-level `listeners` set, which
 * `resetTabsForTests` does not itself clear. */
function startSessionPersistence(): void {
  unsubscribeTabsForPersistence?.()
  resubscribePersistence()
  unsubscribeTabsForPersistence = subscribeTabs(() => {
    resubscribePersistence()
    persistSessionState()
  })
}

let restoreStarted = false

/** Opens `path` into `id` and reports whether it actually landed —
 * `openPath` never throws (every failure degrades to the `'error'` phase,
 * per `documentSession.ts`'s own contract), so "did it work" is read back
 * from the resulting phase rather than a try/catch. */
async function openAndReport(id: string, path: string): Promise<boolean> {
  await getSessionFor(id)?.openPath(path)
  return getSessionFor(id)?.getSnapshot().phase === 'ready'
}

type TabDeps = Omit<DocumentSessionDeps, 'isActive' | 'estimateOtherTabsBytes'>

/**
 * Call once, before the first render. A no-op on every call after the
 * first (`restoreStarted`) and when there is nothing persisted to restore
 * — in both cases `startSessionPersistence()` still runs, so a fresh app
 * starts recording a session to restore *next* time.
 *
 * `createDeps` overrides each restored tab's `DocumentSession` dependencies
 * (real `parseInWorker`/`window.api` by default) — tests inject a fake
 * parse/api per path, the same reason every other factory in this codebase
 * (`createTab` itself, `createDocumentSession`) takes one.
 */
export function beginSessionRestore(createDeps: (path: string) => TabDeps = () => ({})): void {
  if (restoreStarted) return
  restoreStarted = true

  const persisted = readPersisted()
  if (persisted === null || persisted.paths.length === 0) {
    startSessionPersistence()
    return
  }

  const entries = persisted.paths.map((path) => ({ id: createTab(createDeps(path)), path }))
  const activeEntry = entries[persisted.activeIndex] ?? entries[0]
  if (activeEntry !== undefined) setActiveTab(activeEntry.id)

  void Promise.all(entries.map(({ id, path }) => openAndReport(id, path))).then((results) => {
    // §7: "must not turn 'one missing file' into 'no session'" — every
    // other tab already opened independently by the time any one fails;
    // this only ever adds one summary notification, never blocks the rest.
    const failedCount = results.filter((ok) => !ok).length
    if (failedCount > 0) {
      notify({
        severity: 'warning',
        message:
          failedCount === results.length
            ? `None of your ${results.length} previously open files could be reopened.`
            : `${failedCount} of your ${results.length} previously open files could not be reopened.`,
        // §7 / R21-notifications.md §3b: application-scoped, not any one
        // tab's — this is about the restore as a whole, not a single
        // document.
        documentId: null
      })
    }
    startSessionPersistence()
  })
}

/** Test-only: undoes `beginSessionRestore`'s one-shot guard and drops every
 * live subscription, mirroring `resetTabsForTests`'s own role. */
export function resetSessionRestoreForTests(): void {
  restoreStarted = false
  persistenceUnsubscribes.forEach((unsubscribe) => unsubscribe())
  persistenceUnsubscribes = []
  unsubscribeTabsForPersistence?.()
  unsubscribeTabsForPersistence = null
}
