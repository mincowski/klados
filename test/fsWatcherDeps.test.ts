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
 *
 * **The trigger is Windows-only, and CI is what established that.** The first
 * run of this file went green on `windows-latest` and red on `macos-latest` and
 * `ubuntu-latest` — all three error-inducing tests, both platforms, `no watcher
 * error arrived`. Deleting the watched file's parent directory emits no
 * `'error'` event at all on those platforms; the probing that found the trigger
 * was done on Windows only, and a real-filesystem test inherits every platform
 * difference of the thing it is driving.
 *
 * So those three are gated below, and the gate is not a workaround: **the defect
 * being fixed is platform-independent and the reproduction is not.** The
 * listener is attached unconditionally, `windows-latest` is in the CI matrix, so
 * removing it still turns CI red — and `documentWatchers.test.ts` carries the
 * cross-platform coverage of the *consequence* (release, close, no re-arm)
 * against injected failures, which needs no OS cooperation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createFsWatcherDeps,
  WATCHES_THROUGH_DIRECTORY,
  watchDirectoryWithFs,
  type WatchDirectory
} from '../src/main/fsWatcherDeps'
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
/** Whether this platform's `fs.watch` reports the failure R171 is about at all.
 * Measured, not assumed — see the platform note above. Only the *reproduction*
 * is gated on this; the listener it exercises is attached everywhere. */
const REPORTS_WATCH_ERRORS = process.platform === 'win32'

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
  it.runIf(REPORTS_WATCH_ERRORS)(
    'deleting the watched directory reports EPERM instead of raising it',
    async () => {
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
    }
  )

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

  it.runIf(REPORTS_WATCH_ERRORS)('the injected reporter sees the path and the error', async () => {
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

  it.runIf(REPORTS_WATCH_ERRORS)(
    'end to end: the registry releases the path after a real failure',
    async () => {
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
    }
  )
})

/**
 * R236 (`docs/plans/R236-save-and-watch.md` §2, criterion 16) — one directory
 * watch per directory, shared by every open file in it.
 *
 * Against an injected directory watcher, because what is asserted is how many
 * OS watches exist, which the real one cannot be asked. The real one is
 * driven end to end by `mainElectron.test.ts`'s R236 tests on all three runners.
 */
describe('R236 — files are watched through one shared directory watch', () => {
  function fakeDirectories(): {
    watchDirectory: WatchDirectory
    opened: {
      dir: string
      emit: (name: string | null) => void
      fail: (e: Error) => void
      closed: boolean
    }[]
  } {
    const opened: {
      dir: string
      emit: (name: string | null) => void
      fail: (e: Error) => void
      closed: boolean
    }[] = []
    return {
      opened,
      watchDirectory: (dir, onEvent, onError) => {
        const record = { dir, emit: onEvent, fail: onError, closed: false }
        opened.push(record)
        return {
          close: () => {
            record.closed = true
          }
        }
      }
    }
  }

  const dir = path.join(tmpdir(), 'r236-dir')
  const a = path.join(dir, 'a.json')
  const b = path.join(dir, 'b.json')

  it('two files in one directory share one watch, closed with the last of them', () => {
    const fake = fakeDirectories()
    const deps = createFsWatcherDeps(undefined, fake.watchDirectory)

    const first = deps.watch(
      a,
      () => {},
      () => {}
    )
    const second = deps.watch(
      b,
      () => {},
      () => {}
    )
    expect(fake.opened.map((o) => o.dir)).toEqual([dir])

    first.close()
    expect(fake.opened[0]!.closed).toBe(false)
    second.close()
    expect(fake.opened[0]!.closed).toBe(true)
  })

  it('files in two directories get two watches', () => {
    const fake = fakeDirectories()
    const deps = createFsWatcherDeps(undefined, fake.watchDirectory)
    deps.watch(
      a,
      () => {},
      () => {}
    )
    deps.watch(
      path.join(tmpdir(), 'r236-other', 'c.json'),
      () => {},
      () => {}
    )
    expect(fake.opened).toHaveLength(2)
  })

  it('an event reaches the file it names, ignoring case, or every file when it names none', () => {
    const fake = fakeDirectories()
    const deps = createFsWatcherDeps(undefined, fake.watchDirectory)
    const seen: string[] = []
    deps.watch(
      a,
      () => seen.push('a'),
      () => {}
    )
    deps.watch(
      b,
      () => seen.push('b'),
      () => {}
    )

    fake.opened[0]!.emit('a.json')
    fake.opened[0]!.emit('A.JSON')
    fake.opened[0]!.emit('a.json.tmp') // a sibling's temp file
    fake.opened[0]!.emit(null)

    expect(seen).toEqual(['a', 'a', 'a', 'b'])
  })

  it('an event spelling the name decomposed reaches a file opened composed, and back', () => {
    const fake = fakeDirectories()
    const deps = createFsWatcherDeps(undefined, fake.watchDirectory)
    const seen: string[] = []
    deps.watch(
      path.join(dir, 'ü.json'),
      () => seen.push('composed'),
      () => {}
    )
    deps.watch(
      path.join(dir, 'ö.json'),
      () => seen.push('decomposed'),
      () => {}
    )

    fake.opened[0]!.emit('ü.json')
    fake.opened[0]!.emit('ö.json')

    expect(seen).toEqual(['composed', 'decomposed'])
  })

  /** A target in its own folder and a symlink to it in another, or `null`
   * where this process may not create symlinks (Windows without developer
   * mode). */
  function symlinkedFile(): { link: string; target: string } | null {
    const root = mkdtempSync(path.join(tmpdir(), 'klados-r236-link-'))
    created.push(root)
    mkdirSync(path.join(root, 'real'))
    mkdirSync(path.join(root, 'links'))
    const target = path.join(root, 'real', 'data.json')
    const link = path.join(root, 'links', 'shortcut.json')
    writeFileSync(target, '{"a":1}')
    try {
      symlinkSync(target, link, 'file')
    } catch {
      return null
    }
    return { link, target: realpathSync(target) }
  }

  it("a symlink is watched through its target's directory, under the target's name", (context) => {
    const files = symlinkedFile()
    if (files === null) return context.skip('symlinks need developer mode on Windows')
    const fake = fakeDirectories()
    const reported: string[] = []
    const deps = createFsWatcherDeps((p) => reported.push(p), fake.watchDirectory)
    let events = 0
    deps.watch(
      files.link,
      () => events++,
      () => {}
    )

    expect(fake.opened.map((o) => o.dir)).toEqual([path.dirname(files.target)])
    fake.opened[0]!.emit('shortcut.json')
    expect(events).toBe(0)
    fake.opened[0]!.emit('data.json')
    expect(events).toBe(1)
    // A failure is still reported under the path the tab opened.
    fake.opened[0]!.fail(new Error('EPERM'))
    expect(reported).toEqual([files.link])
  })

  it.runIf(WATCHES_THROUGH_DIRECTORY)(
    'a real directory watch sees a change made to a symlinked file',
    async (context) => {
      const files = symlinkedFile()
      if (files === null) return context.skip('symlinks are not available here')
      let events = 0
      const handle = createFsWatcherDeps().watch(
        files.link,
        () => events++,
        () => {}
      )
      try {
        appendFileSync(files.link, ' ')
        await vi.waitFor(() => expect(events).toBeGreaterThan(0), {
          timeout: WATCH_ERROR_TIMEOUT_MS
        })
      } finally {
        handle.close()
      }
    }
  )

  it('a failed directory watch is reported to every file in it, and the next watch opens a new one', () => {
    const fake = fakeDirectories()
    const reported: string[] = []
    const deps = createFsWatcherDeps((p) => reported.push(p), fake.watchDirectory)
    const errors: string[] = []
    deps.watch(
      a,
      () => {},
      () => errors.push('a')
    )
    deps.watch(
      b,
      () => {},
      () => errors.push('b')
    )

    fake.opened[0]!.fail(new Error('EPERM: operation not permitted, watch'))

    expect(errors).toEqual(['a', 'b'])
    expect(reported).toEqual([a, b])
    expect(fake.opened[0]!.closed).toBe(true)
    deps.watch(
      a,
      () => {},
      () => {}
    )
    expect(fake.opened).toHaveLength(2)
  })

  it.runIf(WATCHES_THROUGH_DIRECTORY)(
    'a real directory watch whose directory is deleted does not keep firing',
    async () => {
      // The reason Windows is excluded: there, this measured an unbroken
      // stream of events (`WATCHES_THROUGH_DIRECTORY`). Here it must stay a
      // handful, or the directory watch is a busy loop in the main process.
      const { dir } = tempFile()
      let events = 0
      const handle = watchDirectoryWithFs(
        dir,
        () => {
          events++
        },
        () => {}
      )
      rmSync(dir, { recursive: true, force: true })
      await new Promise((resolve) => setTimeout(resolve, NO_ERROR_SETTLE_MS))
      handle.close()
      expect(events).toBeLessThan(20)
    }
  )

  it('a directory watch that fails during its own construction is still reported', () => {
    const reported: string[] = []
    const errors: string[] = []
    const deps = createFsWatcherDeps(
      (p) => reported.push(p),
      (_dir, _onEvent, onError) => {
        onError(new Error('EPERM'))
        return { close: () => {} }
      }
    )

    deps.watch(
      a,
      () => {},
      () => errors.push('a')
    )

    expect(errors).toEqual(['a'])
    expect(reported).toEqual([a])
  })

  it('a watch closed after its directory failed does not close the replacement', () => {
    const fake = fakeDirectories()
    const deps = createFsWatcherDeps(undefined, fake.watchDirectory)
    const old = deps.watch(
      a,
      () => {},
      () => {}
    )
    fake.opened[0]!.fail(new Error('EPERM'))
    deps.watch(
      b,
      () => {},
      () => {}
    )

    old.close()

    expect(fake.opened[1]!.closed).toBe(false)
  })
})
