/**
 * R219 (`docs/plans/R219-open-with.md` §4): files the operating system asks
 * Klados to open — "Open with", at launch or into the running window.
 *
 * Each opens into a new tab and becomes the active one, the rule drag-and-drop
 * and `klados.document.open` already follow (R26) — **except a file already
 * open, which is focused instead.** The common case is double-clicking a file
 * that was open last time: session restore reopens it, and a second tab of the
 * same file would let the two diverge on save.
 *
 * A tab still opening does not expose its path (`DocumentSessionState` carries
 * only a file name before `ready`, and nothing at all in the `empty` moment
 * before its `stat` returns — which is exactly where session restore's tabs are
 * when the launch paths are matched against them). So the path each tab was
 * opened for, by session restore or from here, is kept **while its open is in
 * flight**, and dropped once it settles: a `ready` tab answers from its own
 * document, which also follows a Save As; a failed or emptied one holds
 * nothing.
 */
import { getKladosApi } from '../preloadApi'
import { createTab, getSessionFor, getTabIds, setActiveTab, type TabId } from './tabs'

type TabDeps = NonNullable<Parameters<typeof createTab>[0]>

/** Tabs whose open is in flight, and the path each is opening. */
const opening = new Map<TabId, { readonly path: string; readonly unsubscribe: () => void }>()

function forget(id: TabId): void {
  opening.get(id)?.unsubscribe()
  opening.delete(id)
}

/** Records the path a tab is opening — session restore's tabs, and this
 * module's own — until that open settles. Call before starting the open. */
export function rememberOpenedPath(id: TabId, path: string): void {
  const session = getSessionFor(id)
  if (session === undefined) return
  forget(id)
  let started = session.getSnapshot().phase !== 'empty'
  const unsubscribe = session.subscribe(() => {
    const phase = session.getSnapshot().phase
    if (phase === 'ready' || phase === 'error' || (phase === 'empty' && started)) forget(id)
    else if (phase !== 'empty') started = true
  })
  opening.set(id, { path, unsubscribe })
}

/** Windows and macOS file systems are case-insensitive by default; Linux's
 * are not. */
function samePath(a: string, b: string): boolean {
  if (a === b) return true
  const platform = getKladosApi()?.titleBar.platform
  return (platform === 'win32' || platform === 'darwin') && a.toLowerCase() === b.toLowerCase()
}

function tabHolding(path: string): TabId | null {
  const live = new Set(getTabIds())
  for (const id of opening.keys()) if (!live.has(id)) forget(id)

  for (const id of live) {
    const snapshot = getSessionFor(id)?.getSnapshot()
    if (snapshot?.phase === 'ready') {
      if (samePath(snapshot.document.filePath, path)) return id
      continue
    }
    const inFlight = opening.get(id)
    if (inFlight !== undefined && samePath(inFlight.path, path)) return id
  }
  return null
}

/** `createDeps` overrides each new tab's session dependencies — tests inject a
 * fake parse and API, as `beginSessionRestore` allows. */
export function openPathsFromSystem(
  paths: readonly string[],
  createDeps: (path: string) => TabDeps = () => ({})
): void {
  for (const path of paths) {
    const existing = tabHolding(path)
    if (existing !== null) {
      setActiveTab(existing)
      continue
    }
    const id = createTab(createDeps(path))
    rememberOpenedPath(id, path)
    setActiveTab(id)
    void getSessionFor(id)?.openPath(path)
  }
}

/** The launch paths, taken once from main. `[]` without a preload bridge
 * (tests) or if the call fails — a launch must never be blocked by it. */
export async function takeLaunchPaths(): Promise<string[]> {
  try {
    return (await getKladosApi()?.app.takeLaunchPaths()) ?? []
  } catch {
    return []
  }
}

/** Files handed to the running window after launch. */
export function listenForSystemOpens(): () => void {
  return getKladosApi()?.app.onOpenPaths((paths) => openPathsFromSystem(paths)) ?? ((): void => {})
}

export function resetOpenFromSystemForTests(): void {
  for (const id of [...opening.keys()]) forget(id)
}
