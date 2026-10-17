/**
 * R171 (`docs/plans/R171-watcher-error-handling.md`) — the real `fs`-backed
 * implementation of `DocumentWatcherDeps`, split out of `main/documents.ts`.
 *
 * **Why it is its own module: so a test can drive it against a real
 * filesystem.** `main/documents.ts` imports `electron` at module scope, so
 * nothing in it can be loaded by the node test project — which meant the one
 * place `fs.watch` is actually constructed was the one place no test could
 * reach. That is exactly where the defect was: the watcher had no `'error'`
 * listener, `fs.FSWatcher` is an `EventEmitter`, and an `'error'` event with no
 * listener *throws* — in the main process, Electron's own "A JavaScript error
 * occurred in the main process" dialog, which is how a user found it by hand.
 *
 * This module imports only `node:fs`, so `test/fsWatcherDeps.test.ts` can make
 * a real watcher fail and assert the process survives it. The same split
 * `mainSecurity.ts`, `mainQuitFlow.ts` and `mainDocumentIO.ts` already use, for
 * the same reason: **a guard nobody can test is a guard nobody can trust.**
 */
import { watch as fsWatch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { DocumentWatcherDeps, WatchHandle } from '../core/documentWatchers'

/**
 * R236 (`docs/plans/R236-save-and-watch.md` §2) — one OS watch on a
 * **directory**, reporting the name of the entry each event is about (`null`
 * when the platform does not say).
 */
export type WatchDirectory = (
  dir: string,
  onEvent: (fileName: string | null) => void,
  onError: (error: Error) => void
) => WatchHandle

/**
 * R236 — whether a file is watched through its directory. **Not on Windows**,
 * where it is unnecessary and harmful:
 * - unnecessary, because libuv's file watch there is already a directory watch
 *   filtered by name, and follows the path (the R236 built-app tests pass on
 *   `windows-latest` against a plain file watch);
 * - harmful, because a directory watch whose directory is deleted **never
 *   stops firing**. Measured on Windows 11 / Node 24: an unbroken stream of
 *   `rename` events naming the directory itself, about 1 MB of log in two
 *   seconds, and no error — a busy loop in the main process, which R171 §6
 *   forbids. A file watch reports the same deletion once, as `EPERM`, and
 *   stops.
 */
export const WATCHES_THROUGH_DIRECTORY = process.platform !== 'win32'

export const watchDirectoryWithFs: WatchDirectory = (dir, onEvent, onError) => {
  const fsWatcher = fsWatch(dir, { persistent: false }, (_eventType, fileName) =>
    onEvent(fileName === null ? null : String(fileName))
  )
  fsWatcher.on('error', onError)
  return {
    close: () => {
      fsWatcher.close()
    }
  }
}

/** The watch every platform used before R236, and Windows still does. */
function watchFileWithFs(
  path: string,
  onEvent: () => void,
  onError: (error: Error) => void,
  onWatchError?: (path: string, error: Error) => void
): WatchHandle {
  const fsWatcher = fsWatch(path, { persistent: false }, onEvent)
  // **The three lines whose absence was the crash** (R171). Reproduced in
  // `test/fsWatcherDeps.test.ts` against a real directory: deleting the
  // watched *file* is quiet, but deleting its parent **directory** raises
  // `EPERM: operation not permitted, watch` on Windows — the error from the
  // report, with the same code and message.
  fsWatcher.on('error', (error: Error) => {
    onWatchError?.(path, error)
    onError(error)
  })
  return {
    close: () => {
      fsWatcher.close()
    }
  }
}

/** Windows and macOS compare names without case by default, so an event may
 * spell the name differently from the path that was opened. A false match
 * costs one `stat`, which the registry's mtime comparison then ignores; a
 * false miss would lose the change. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

interface Listener {
  readonly path: string
  readonly fileName: string
  readonly onEvent: () => void
  readonly onError: (error: Error) => void
}

interface DirectoryEntry {
  handle: WatchHandle | null
  readonly listeners: Set<Listener>
  failure: Error | null
}

/**
 * `onWatchError` is injected rather than logged inline so the test can observe
 * it without reading stdout, and so main can decide what a failure means to it
 * without this module knowing about windows or IPC.
 *
 * **R236 — the file is watched through its directory.** `fs.watch` of a file
 * is, on Linux and macOS, a watch on the file's inode: after another program
 * saves by renaming a new file over it (Vim, Emacs, most "safe" saves), the
 * watch follows the old inode and no later change is noticed. Measured on CI:
 * the second change after a rename-over, a second rename-over, and a recreate
 * after a delete all went unnoticed on `ubuntu-latest` and `macos-latest`, and
 * were noticed on Windows, where libuv already watches the parent and filters
 * by name. This makes that explicit on Linux and macOS;
 * `WATCHES_THROUGH_DIRECTORY` says why not on Windows.
 *
 * One OS watch per directory, shared by every file in it and closed with the
 * last. An event is passed to the files it names, or to all of them when the
 * platform names none; the registry's mtime comparison decides whether
 * anything changed. A directory watch that fails is reported to every file in
 * it, since none of them is watched any more.
 */
export function createFsWatcherDeps(
  onWatchError?: (path: string, error: Error) => void,
  // `null` watches each file itself; tests inject a fake directory watcher.
  watchDirectory: WatchDirectory | null = WATCHES_THROUGH_DIRECTORY ? watchDirectoryWithFs : null
): DocumentWatcherDeps {
  const directories = new Map<string, DirectoryEntry>()

  function closeQuietly(handle: WatchHandle | null): void {
    if (handle === null) return
    try {
      handle.close()
    } catch {
      // The watch is being abandoned regardless (R171).
    }
  }

  return {
    stat: (path) =>
      stat(path)
        .then((info) => ({ mtimeMs: info.mtimeMs }))
        .catch(() => null),

    watch: (path, onEvent, onError): WatchHandle => {
      if (watchDirectory === null) return watchFileWithFs(path, onEvent, onError, onWatchError)
      const dir = dirname(path)
      const listener: Listener = { path, fileName: basename(path), onEvent, onError }
      let entry = directories.get(dir)
      if (entry === undefined) {
        // `handle` is null until `watchDirectory` returns (R171).
        const fresh: DirectoryEntry = { handle: null, listeners: new Set(), failure: null }
        directories.set(dir, fresh)
        try {
          fresh.handle = watchDirectory(
            dir,
            (fileName) => {
              for (const l of [...fresh.listeners]) {
                if (fileName === null || sameName(fileName, l.fileName)) l.onEvent()
              }
            },
            (error) => {
              if (directories.get(dir) !== fresh) return
              fresh.failure = error
              directories.delete(dir)
              const failed = [...fresh.listeners]
              fresh.listeners.clear()
              closeQuietly(fresh.handle)
              for (const l of failed) {
                onWatchError?.(l.path, error)
                l.onError(error)
              }
            }
          )
        } catch (err) {
          directories.delete(dir)
          throw err
        }
        // A watch that failed before it returned had no listener to tell yet.
        if (fresh.failure !== null) {
          onWatchError?.(path, fresh.failure)
          onError(fresh.failure)
          return { close: () => {} }
        }
        entry = fresh
      }
      entry.listeners.add(listener)
      const owner = entry
      return {
        close: () => {
          owner.listeners.delete(listener)
          if (owner.listeners.size > 0 || directories.get(dir) !== owner) return
          directories.delete(dir)
          closeQuietly(owner.handle)
        }
      }
    }
  }
}
