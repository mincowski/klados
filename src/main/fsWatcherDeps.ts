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
import type { DocumentWatcherDeps, WatchHandle } from '../core/documentWatchers'

/**
 * `onWatchError` is injected rather than logged inline so the test can observe
 * it without reading stdout, and so main can decide what a failure means to it
 * without this module knowing about windows or IPC.
 */
export function createFsWatcherDeps(
  onWatchError?: (path: string, error: Error) => void
): DocumentWatcherDeps {
  return {
    stat: (path) =>
      stat(path)
        .then((info) => ({ mtimeMs: info.mtimeMs }))
        .catch(() => null),

    watch: (path, onEvent, onError): WatchHandle => {
      const fsWatcher = fsWatch(path, { persistent: false }, onEvent)
      // **The three lines whose absence was the crash.** Reproduced in
      // `test/fsWatcherDeps.test.ts` against a real directory: deleting the
      // watched *file* is quiet, but deleting or renaming its parent
      // **directory** raises `EPERM: operation not permitted, watch` — the
      // error from the report, with the same code and message.
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
  }
}
