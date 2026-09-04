/**
 * R95 (`R95-recent-files.md` §1–2): a history of recently opened files, for
 * the start pane's Recent column — distinct from `sessionRestore.ts`'s
 * `klados.sessionRestore`, which is a snapshot of the *currently* open tab
 * set and loses an entry the instant its tab closes. Paths only, never
 * content — the same rule `sessionRestore.ts` states for itself.
 *
 * Same subscribable-module-store shape as `theme.ts`: a mutable module-level
 * value, a `Set<() => void>` of listeners, `localStorage` persistence that
 * degrades corrupt/missing data to "nothing" rather than throwing.
 */
import { setContext } from '../commands/context'

const STORAGE_KEY = 'klados.recentFiles'
const MAX_ENTRIES = 6

export interface RecentFile {
  readonly path: string
  readonly fileName: string
  readonly formatId: string
}

function isRecentFile(value: unknown): value is RecentFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.fileName === 'string' &&
    typeof candidate.formatId === 'string'
  )
}

function readPersisted(): readonly RecentFile[] {
  if (typeof localStorage === 'undefined') return []
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    // A corrupted or hand-edited value degrades to "no recent files," the
    // same way `sessionRestore.ts`'s own `readPersisted` does — never a
    // crash on launch, and a single bad entry doesn't discard every good one.
    return Array.isArray(parsed) ? parsed.filter(isRecentFile) : []
  } catch {
    return []
  }
}

function writePersisted(entries: readonly RecentFile[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

let current: readonly RecentFile[] = readPersisted()
const listeners = new Set<() => void>()

setContext('hasRecentFiles', current.length > 0)

function publish(next: readonly RecentFile[]): void {
  current = next
  writePersisted(next)
  setContext('hasRecentFiles', next.length > 0)
  for (const listener of listeners) listener()
}

export function getRecentFiles(): readonly RecentFile[] {
  return current
}

export function subscribeRecentFiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Moves `entry.path` to the front, or prepends it, then truncates to
 * `MAX_ENTRIES`. **The guard that matters: already at index 0 returns before
 * writing** — no `localStorage` write, no listener notification for a
 * no-op. Given how few call sites there are (§2), this is belt-and-braces
 * rather than load-bearing, which is exactly why it belongs here: it makes
 * the recorder safe to call from anywhere without re-deriving whether that
 * site can fire twice for the same document.
 */
export function recordRecentFile(entry: RecentFile): void {
  if (current[0]?.path === entry.path) return
  const rest = current.filter((e) => e.path !== entry.path)
  publish([entry, ...rest].slice(0, MAX_ENTRIES))
}

/** R97: a failed open of a recent path removes it — the next thing the
 * user sees shouldn't offer them the file that just failed. A no-op if
 * `path` isn't in the list, so callers don't need to check first. */
export function removeRecentFile(path: string): void {
  if (!current.some((e) => e.path === path)) return
  publish(current.filter((e) => e.path !== path))
}

export function clearRecentFiles(): void {
  if (current.length === 0) return
  publish([])
}

/** Test-only: resets module state between test cases, mirroring
 * `resetSessionRestoreForTests`. */
export function resetRecentFilesForTests(): void {
  current = []
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
  setContext('hasRecentFiles', false)
}
