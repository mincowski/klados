/**
 * R52 (`R51-main-process.md`) — the per-document file watcher. The
 * predecessor (`main/documents.ts` before this round) kept exactly one
 * `FSWatcher` at module scope: `document:watch` replaced whatever it was
 * watching, correct when M1 had one document but a real gap once tabs
 * exist (R24) — open two files in two tabs, change the first on disk, and
 * nothing happens, because the second `document:watch` call silently
 * replaced the first watcher.
 *
 * This registry keys watch registrations by `key` (the renderer's own tab
 * identity, `session/tabs.ts`'s `TabId`) while still holding exactly **one
 * real OS watcher per unique path** — two tabs can legally have the same
 * file open, and refcounting one watcher per path is the sane shape for
 * that rather than duplicating the OS-level watch.
 *
 * No Electron import: `main/documents.ts` is the thin wiring that turns a
 * notified key into a `BrowserWindow.webContents.send`. `stat`/`watch` are
 * injected (the same reasoning `readTokenRegistry.ts`'s `now`/`randomToken`
 * injection uses) so this is unit-testable against fakes, never a real
 * filesystem or a real Electron process.
 */

export interface WatchHandle {
  close(): void
}

export interface DocumentWatcherDeps {
  /** Resolves to the file's current `mtimeMs`, or `null` if it can't be
   * stat'd (deleted, permission error, never existed) — `watch` treats
   * that as "nothing to watch," the same tolerance the single-watcher
   * predecessor gave a failed initial `stat`. */
  stat(path: string): Promise<{ mtimeMs: number } | null>
  /** Starts an OS-level watch on `path`, calling `onEvent` on every
   * underlying filesystem event — unfiltered; this registry is what turns
   * "the OS noticed something" into "the content actually changed"
   * (mtime comparison), the same job the predecessor's own `fs.watch`
   * callback did, now scoped per path-entry rather than per module. */
  watch(path: string, onEvent: () => void): WatchHandle
}

export interface DocumentWatcherRegistry {
  /**
   * Starts (or joins) watching `path` under `key`, calling `onChange(key)`
   * whenever the file's content genuinely changes. If `key` was already
   * watching a different path, that registration is released first — one
   * key watches at most one path at a time, the per-key version of the
   * predecessor's "watch replaces whatever it was watching." A no-op,
   * watching nothing, if `path` can't be stat'd.
   */
  watch(key: string, path: string, onChange: (key: string) => void): Promise<void>
  /** Releases `key`'s registration, if any — decrements the shared
   * per-path watcher's refcount rather than always closing it, since
   * another key may still be watching the same path. */
  unwatch(key: string): void
  /** Releases every currently-registered key `matches` accepts — for a
   * caller that wants to tear down every watch belonging to, say, a
   * closing window, without tracking that mapping itself. */
  unwatchMatching(matches: (key: string) => boolean): void
}

interface PathEntry {
  handle: WatchHandle
  lastKnownMtimeMs: number
  /** Every key currently watching this path, each with its own
   * `onChange` — two tabs on the same file each get their own
   * notification, independently, even though there is only one real
   * watcher underneath. */
  readonly keys: Map<string, (key: string) => void>
}

export function createDocumentWatcherRegistry(deps: DocumentWatcherDeps): DocumentWatcherRegistry {
  const pathEntries = new Map<string, PathEntry>()
  const keyToPath = new Map<string, string>()

  function releaseKey(key: string): void {
    const path = keyToPath.get(key)
    if (path === undefined) return
    keyToPath.delete(key)
    const entry = pathEntries.get(path)
    if (entry === undefined) return
    entry.keys.delete(key)
    if (entry.keys.size === 0) {
      entry.handle.close()
      pathEntries.delete(path)
    }
  }

  return {
    async watch(key, path, onChange) {
      releaseKey(key) // this key might already be watching a different path

      const info = await deps.stat(path)
      if (info === null) return // nothing to watch if the stat itself fails

      let entry = pathEntries.get(path)
      if (entry === undefined) {
        // `fresh` (not `entry`) is what the watch callback closes over —
        // `entry` is reassigned below and the callback must keep pointing
        // at the specific entry it was created for, so a stale callback
        // from a torn-down-and-replaced watcher on the same path can tell
        // it no longer owns `pathEntries.get(path)` and bail. Mirrors the
        // predecessor's own `watchedPath !== path` re-check, generalized
        // from "is this still the watched path" to "is this still the
        // watching entry," since a path can now be re-watched under a
        // fresh entry while an old callback for it is still in flight.
        const fresh: PathEntry = {
          handle: null as unknown as WatchHandle,
          lastKnownMtimeMs: info.mtimeMs,
          keys: new Map()
        }
        fresh.handle = deps.watch(path, () => {
          void (async () => {
            if (pathEntries.get(path) !== fresh) return
            const current = await deps.stat(path)
            if (pathEntries.get(path) !== fresh) return
            if (current === null || current.mtimeMs === fresh.lastKnownMtimeMs) return
            fresh.lastKnownMtimeMs = current.mtimeMs
            for (const [watchingKey, notify] of fresh.keys) notify(watchingKey)
          })()
        })
        pathEntries.set(path, fresh)
        entry = fresh
      }
      keyToPath.set(key, path)
      entry.keys.set(key, onChange)
    },
    unwatch(key) {
      releaseKey(key)
    },
    unwatchMatching(matches) {
      for (const key of [...keyToPath.keys()]) {
        if (matches(key)) releaseKey(key)
      }
    }
  }
}
