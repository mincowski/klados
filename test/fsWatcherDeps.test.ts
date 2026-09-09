/**
 * R171 (`docs/plans/R171-watcher-error-handling.md`) — a watcher error must
 * not be able to crash the main process.
 *
 * **Against a real filesystem, deliberately.** Acceptance 2 asks for this to be
 * demonstrated *by inducing a real error*, not by reading the code, and that is
 * the whole point: the defect was that `fs.FSWatcher` is an `EventEmitter` and
 * an `'error'` event with no listener throws. A fake watcher that calls a
 * callback proves nothing about whether the real one is wired to it, and
 * `main/documents.ts` — where the real watcher used to be constructed — imports
 * `electron` at module scope and so is unreachable from any test. That is
 * exactly why `fsWatcherDeps.ts` exists as its own module.
 *
 * **The trigger, found by probing rather than assumed.** Deleting the watched
 * *file* is quiet; deleting its parent **directory** raises
 * `EPERM: operation not permitted, watch` — the reported error, by code and
 * message.
 *
 * A first pass also credited *renaming* the directory, and that was wrong: the
 * probe that appeared to show it went on to delete the renamed directory too,
 * so the deletion was doing the work. Driven on its own here, a rename produced
 * no error within four seconds, so it is not claimed and not tested — a
 * scenario that reproduces once and then does not is a flaky test, not a
 * finding.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFsWatcherDeps } from '../src/main/fsWatcherDeps'
import { createDocumentWatcherRegistry, type WatchHandle } from '../src/core/documentWatchers'

/** How long a test waits for a watcher error before calling it a failure.
 * Not a pace-setter — every one of these resolves in milliseconds when the
 * mechanism works; this only turns a hang into a red test rather than a stuck
 * run. Named because R163's rule asks for a name, and because a bare 4000 in a
 * test reads as though something needs four seconds. */
const WATCH_ERROR_TIMEOUT_MS = 4000
/** The margin for the one *negative* assertion here — that deleting the file
 * alone raises nothing. There is no condition to wait for when the expected
 * outcome is 'no event ever arrives', which is the case R163's rule names as
 * the legitimate use of a duration. */
const NO_ERROR_SETTLE_MS = 300

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Already gone: several of these tests delete the directory themselves.
    }
  }
})

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'klados-r171-'))
  created.push(dir)
  const file = path.join(dir, 'watched.json')
  writeFileSync(file, '{"a":1}')
  return { dir, file }
}

/** Resolves with the error the watcher reported, or rejects if none arrives.
 * The wait is on the condition, never a duration (R159) — beyond the outer
 * timeout, which exists only so a failure is a failure rather than a hang. */
function watchUntilError(
  file: string,
  disturb: () => void
): Promise<{ error: Error; handle: WatchHandle }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('no watcher error arrived')),
      WATCH_ERROR_TIMEOUT_MS
    )
    const deps = createFsWatcherDeps()
    const handle = deps.watch(
      file,
      () => {},
      (error) => {
        clearTimeout(timer)
        resolve({ error, handle })
      }
    )
    disturb()
  })
}

describe('R171 — a real watcher error is reported, not thrown', () => {
  it('deleting the watched directory reports EPERM instead of raising it', async () => {
    const { dir, file } = tempFile()
    const { error, handle } = await watchUntilError(file, () => {
      rmSync(dir, { recursive: true, force: true })
    })

    // The reported error, matched on its code rather than its prose.
    expect((error as NodeJS.ErrnoException).code).toBe('EPERM')
    expect(error.message).toContain('watch')
    // Closing an already-failed watcher must not throw either — the handle is
    // discarded on this path, and a throw here would be the same uncaught
    // exception in a new place.
    expect(() => handle.close()).not.toThrow()
  })

  it('deleting only the file is not an error, and the watch stays healthy', async () => {
    // Recorded because it is the hypothesis §3 started from, and it is wrong —
    // which is why the round had to go looking rather than assume.
    const { dir, file } = tempFile()
    let errored: Error | null = null
    const deps = createFsWatcherDeps()
    const handle = deps.watch(
      file,
      () => {},
      (error) => {
        errored = error
      }
    )
    rmSync(file, { force: true })
    await new Promise((resolve) => setTimeout(resolve, NO_ERROR_SETTLE_MS))
    handle.close()
    expect(errored).toBeNull()
    expect(dir).toBeTruthy()
  })

  it('the injected reporter sees the path and the error', async () => {
    const { dir, file } = tempFile()
    const seen: { path: string; message: string }[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no watcher error arrived')),
        WATCH_ERROR_TIMEOUT_MS
      )
      const deps = createFsWatcherDeps((watchedPath, error) => {
        seen.push({ path: watchedPath, message: error.message })
      })
      deps.watch(
        file,
        () => {},
        () => {
          clearTimeout(timer)
          resolve()
        }
      )
      rmSync(dir, { recursive: true, force: true })
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.path).toBe(file)
    expect(seen[0]!.message).toContain('watch')
  })

  it('end to end: the registry releases the path after a real failure', async () => {
    // Acceptance 3 — the bookkeeping has to match reality afterwards.
    //
    // **Observed by re-watching, not by asking.** The first version of this
    // asserted that `unwatch` did not throw, which it never does either way:
    // the test passed whether or not the entry had been released, and proved
    // nothing. The release *is* observable, though — a released path builds a
    // fresh entry next time, so the real `fs.watch` is constructed a second
    // time, whereas a surviving entry would simply be joined.
    const { dir, file } = tempFile()
    let watchCalls = 0
    let reportError: (() => void) | null = null
    const failed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no watcher error arrived')),
        WATCH_ERROR_TIMEOUT_MS
      )
      reportError = () => {
        clearTimeout(timer)
        resolve()
      }
    })

    const real = createFsWatcherDeps(() => reportError?.())
    const registry = createDocumentWatcherRegistry({
      stat: real.stat,
      watch: (watchedPath, onEvent, onError) => {
        watchCalls++
        return real.watch(watchedPath, onEvent, onError)
      }
    })

    await registry.watch('tab-1', file, () => {})
    expect(watchCalls).toBe(1)

    rmSync(dir, { recursive: true, force: true })
    await failed

    // Put the file back and watch it again. A second construction proves the
    // failed entry was dropped rather than reused.
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '{"a":2}')
    await registry.watch('tab-2', file, () => {})
    expect(watchCalls).toBe(2)

    // And the key from the failed watch is gone, so releasing it is a no-op
    // rather than a decrement against the *new* entry — which would tear down
    // a healthy watcher that has nothing to do with the failure.
    registry.unwatch('tab-1')
    await registry.watch('tab-3', file, () => {})
    expect(watchCalls).toBe(2) // 'tab-3' joined the live entry, so no new watcher
  })
})
