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
   * callback did, now scoped per path-entry rather than per module.
   *
   * **R171 — `onError` is not optional, and its absence was a crash.**
   * `fs.FSWatcher` is an `EventEmitter`, so an `'error'` event with no
   * listener *throws*; in the main process that is an uncaught exception and
   * Electron's own "A JavaScript error occurred in the main process" dialog,
   * which is what a user hit by hand. Reproduced since: deleting a watched
   * file is fine, but **deleting or renaming its parent directory raises
   * `EPERM: operation not permitted, watch`** — the reported error exactly.
   *
   * The implementation must call `onError` instead of letting the event
   * escape. The registry's own handler is what keeps its bookkeeping honest
   * afterwards; an implementation that merely swallowed the event would stop
   * the crash and leave the registry believing it still watches a path whose
   * watcher is dead. */
  watch(path: string, onEvent: () => void, onError: (error: Error) => void): WatchHandle
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
  /**
   * R175 (`docs/plans/R175-self-write-suppression.md`) — runs `write`
   * inside a window during which `path`'s own watcher events belong to us,
   * and re-establishes the baseline before the window closes.
   *
   * **Without this the registry cannot tell our save from someone else's.**
   * It decides "did the content change" by comparing `mtimeMs` against a
   * baseline captured when the watch was established, and nothing ever
   * updated that baseline when *we* were the writer — so every save looked
   * exactly like a third-party edit. The visible cost was two banners
   * flashing; the real one was that the resulting auto-reload discarded the
   * undo stack and re-parsed the whole document on every save.
   *
   * Events arriving while the window is open are **dropped**, not compared:
   * the re-baseline at release covers every event the write produced, and
   * one `writeFile` demonstrably produces more than one, with genuinely
   * different intermediate mtimes (§3 measured two events 1 ms apart on
   * Windows, which is exactly why comparing mtimes cannot collapse them).
   * An event arriving *after* release stats the final mtime, finds it equal
   * to the new baseline, and is quiet on its own.
   *
   * The window covers the re-stat, not just the write — §3 saw an event
   * land 0.4 ms after the write resolved, which would otherwise have been
   * compared against the stale baseline.
   *
   * Not a timer (R159–R163 removed four of those; a slow write outlives a
   * fixed window and a genuine change is delayed by one) and not a content
   * hash (invariant 1 — a 200 MB document must not be pulled through memory
   * to answer a bookkeeping question). The window is bounded by a
   * condition: the write and its re-stat having completed.
   *
   * A path nobody watches is a no-op that still performs the write, the
   * result and the rejection both propagate, and concurrent writes to one
   * path nest — the mark is a count, not a boolean, or the inner release
   * would re-open the outer window.
   */
  selfWrite<T>(path: string, write: () => Promise<T>): Promise<T>
}

interface PathEntry {
  handle: WatchHandle | null
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
  /** R175 — how many `selfWrite` windows are currently open on each path.
   * A count rather than a flag so nested writes to one path release
   * correctly; absent means zero. */
  const selfWriteDepth = new Map<string, number>()

  /** R171: closing a watcher that has already failed can itself throw — the
   * handle is being discarded either way, and a throw here would re-raise the
   * very uncaught exception this round exists to remove. */
  function closeQuietly(handle: WatchHandle | null): void {
    if (handle === null) return
    try {
      handle.close()
    } catch {
      // Nothing to do: the watcher is being abandoned regardless.
    }
  }

  /**
   * R175 — commits `path`'s current mtime as the baseline, so the events our
   * own write produced compare equal and stay quiet.
   *
   * A path nobody watches has no entry and nothing to update. A stat that
   * fails leaves the baseline alone rather than throwing: this runs in a
   * `finally` inside a save, and `deps.stat` already returns `null` for a
   * file that cannot be stat'd — a rejection from a different implementation
   * must not become the save's own failure.
   */
  async function rebaseline(path: string): Promise<void> {
    const entry = pathEntries.get(path)
    if (entry === undefined) return
    let current: { mtimeMs: number } | null = null
    try {
      current = await deps.stat(path)
    } catch {
      return
    }
    if (current === null) return
    // Re-checked after the await for the same reason the watch callback
    // re-checks: the entry can have been torn down and replaced while the
    // stat was in flight, and writing a baseline into a discarded entry
    // would leave the live one stale.
    if (pathEntries.get(path) !== entry) return
    entry.lastKnownMtimeMs = current.mtimeMs
  }

  function releaseKey(key: string): void {
    const path = keyToPath.get(key)
    if (path === undefined) return
    keyToPath.delete(key)
    const entry = pathEntries.get(path)
    if (entry === undefined) return
    entry.keys.delete(key)
    if (entry.keys.size === 0) {
      closeQuietly(entry.handle)
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
          // R171: genuinely `null` until `deps.watch` returns, because the error
          // callback below can fire *during* that call — a watch that fails
          // immediately. `closeQuietly` tolerates it; the previous
          // `null as unknown as WatchHandle` would have thrown on a property
          // access, which is the same crash in a new place.
          handle: null,
          lastKnownMtimeMs: info.mtimeMs,
          keys: new Map()
        }
        fresh.handle = deps.watch(
          path,
          () => {
            void (async () => {
              if (pathEntries.get(path) !== fresh) return
              // R175 — this event is one our own write produced. Dropped
              // rather than compared: `selfWrite` re-baselines at release,
              // which covers every event the write emitted, including the
              // intermediate-mtime ones a comparison would wrongly accept.
              //
              // Checked here and **not** again after the stat below. A
              // re-check would suppress a *genuine* external change whose
              // event happened to be mid-stat when a save started — the
              // stat was taken before that save, so notifying is the right
              // answer, and the save's own re-baseline stops it repeating.
              if ((selfWriteDepth.get(path) ?? 0) > 0) return
              const current = await deps.stat(path)
              if (pathEntries.get(path) !== fresh) return
              if (current === null || current.mtimeMs === fresh.lastKnownMtimeMs) return
              fresh.lastKnownMtimeMs = current.mtimeMs
              for (const [watchingKey, notify] of fresh.keys) notify(watchingKey)
            })()
          },
          // R171 — the watcher for this path has failed and will not recover.
          //
          // **Released, not re-armed** (§6: "a failing watcher must not spin").
          // The confirmed trigger is the parent directory going away, so there
          // is nothing to retry against — and a watcher that re-registered on
          // every error would log and fail on every filesystem tick.
          //
          // Every key watching this path is dropped from `keyToPath` as well as
          // from the entry, so the registry's own bookkeeping matches reality:
          // a later `unwatch` for one of those keys is then a no-op rather than
          // a decrement of a refcount that no longer exists, and re-watching the
          // same path builds a fresh entry instead of joining a dead one.
          () => {
            if (pathEntries.get(path) !== fresh) return
            for (const watchingKey of fresh.keys.keys()) keyToPath.delete(watchingKey)
            fresh.keys.clear()
            pathEntries.delete(path)
            closeQuietly(fresh.handle)
          }
        )
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
    },
    async selfWrite(path, write) {
      selfWriteDepth.set(path, (selfWriteDepth.get(path) ?? 0) + 1)
      try {
        return await write()
      } finally {
        // Order matters: re-baseline first, drop the mark second. Between
        // those two the window is still open, so an event arriving during
        // the stat is still ours to ignore. Decrementing first would leave
        // a gap in which an event is compared against the stale baseline —
        // which is the whole defect, in a smaller window.
        await rebaseline(path)
        const remaining = (selfWriteDepth.get(path) ?? 1) - 1
        if (remaining <= 0) selfWriteDepth.delete(path)
        else selfWriteDepth.set(path, remaining)
      }
    }
  }
}
