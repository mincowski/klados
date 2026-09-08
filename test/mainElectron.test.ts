/**
 * R51/R58/R59 (`R51-main-process.md`, `R58-zoom.md`) — the handful
 * of behaviours that are genuinely about Electron itself, not extractable
 * logic: the preload bridge's actual exposed surface, and the "starts at
 * zoom 1" acceptance test R58 wrote and R59 now proves via a different
 * mechanism (the renderer's own `zoom.ts` calling `view:setZoomFactor` on
 * boot, not main's own `did-finish-load` handler, which R59 removed —
 * `main/index.ts`'s own comment explains why keeping both would race).
 * Driven via Playwright's `_electron` against the *built* app, the same
 * route `scripts/electron-screenshot.mjs` already uses — there is no way to
 * exercise `contextBridge` or Chromium's real zoom handling outside a real
 * Electron process.
 *
 * **The `close`-interception behaviour (R26) is deliberately not tested
 * here.** Verified directly: a `BrowserWindow` closed while under
 * Playwright's `_electron` automation tears down regardless of
 * `event.preventDefault()` — a standalone, non-Playwright Electron script
 * running the identical prevent-default logic keeps the window open, so
 * this is `_electron`'s own limitation, not a bug in the app. That
 * behaviour is unit-tested instead, against the extracted
 * `src/core/mainQuitFlow.ts` (`test/mainQuitFlow.test.ts`) — see
 * `R51-main-process.md`'s Results section for the full account.
 *
 * `docs/FINDINGS.md`'s own trap applies: nothing in the normal workflow
 * rebuilds `out/`, so this suite skips (with an explanatory warning, not a
 * silent pass) rather than testing a stale binary when `out/main/index.js`
 * is missing. Run `npx electron-vite build` first — CI already does, as
 * its own step before `npm test`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import path from 'path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const mainEntry = path.join(root, 'out', 'main', 'index.js')
const builtAppAvailable = existsSync(mainEntry)

if (!builtAppAvailable) {
  console.warn(
    '[mainElectron.test.ts] out/main/index.js not found — run `npx electron-vite build` ' +
      'first. Skipping the built-app suite rather than testing a stale or absent binary.'
  )
}

describe.skipIf(!builtAppAvailable)('the built app via _electron (R51, R58)', () => {
  let app: ElectronApplication
  let page: Page
  let userDataDir: string

  beforeAll(async () => {
    // **An isolated profile, because this suite was running against the
    // developer's real one.**
    //
    // `electron.launch` with no `--user-data-dir` inherits the app's normal
    // `userData` path — the same one the installed Klados uses — so every run
    // of this file shared `localStorage`, the recent-files list, persisted
    // keybindings and the title-bar theme with whatever the person running it
    // had open. `main.tsx` calls `beginSessionRestore()` at module load, so the
    // test app **reopened their documents**: a run on this machine restored a
    // 10 MB XML fixture and registered a real file watcher on it, which is how
    // the shared profile was noticed at all.
    //
    // Two separate problems, both closed by one switch. The test's outcome
    // could depend on what the developer last had open — invisible on CI, where
    // the profile is always fresh, which is the worst place for that difference
    // to hide. And the tests were writing to a real user's state.
    userDataDir = mkdtempSync(path.join(tmpdir(), 'klados-e2e-'))
    app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
    page = await app.firstWindow()
    await page.waitForLoadState('load')
    // R154 (`docs/plans/R151-ci-matrix.md` §4a): 120 s, overriding
    // `vitest.config.ts`'s 30 s hook default for this hook alone rather than
    // raising it for every hook in the suite — this is the only one that
    // cold-starts a real GUI application.
    //
    // Found by the R151 matrix on its first run, and it is a *new* fact rather
    // than a regression: this suite had never executed anywhere but Linux.
    // `release.yml` runs `npm test` before `npm run package`, so `out/` does
    // not exist there and the `builtAppAvailable` guard above skips the whole
    // describe — which is why four green release jobs on Windows and macOS
    // said nothing about it. `ci.yml` builds first, so the matrix is the first
    // thing ever to launch Electron on a macOS runner, and 30 s was not enough.
  }, 120_000)

  afterAll(async () => {
    // The close-interception test below may already have closed the app's
    // only window, which quits the process on its own (non-macOS) — guard
    // against double-closing an already-exited app.
    //
    // R154 (`docs/plans/R151-ci-matrix.md` §4a): the "(non-macOS)" in that
    // sentence is load-bearing, and on macOS this hook hung until it hit the
    // 30 s hook timeout. It is **not** a bug in the app: `main/index.ts`'s
    // `window-all-closed` handler calls `app.quit()` only when
    // `process.platform !== 'darwin'`, which is the platform convention that a
    // Mac application stays running when its last window closes. Playwright's
    // `close()` waits for the process to exit, so on a macOS runner it waits
    // for something that is deliberately never going to happen.
    //
    // Bound it and kill the process instead. This is teardown — nothing after
    // it needs a graceful shutdown — and killing is what the platform's own
    // behaviour leaves as the only way to end the run.
    const CLOSE_BUDGET_MS = 10_000
    const closed = app.close().then(
      () => true,
      () => true // already gone; either way there is nothing left to wait for
    )
    const exited = await Promise.race([
      closed,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_BUDGET_MS))
    ])
    if (!exited) app.process().kill()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('starts at zoom factor 1 on a fresh file:// load, not the unexplained 1.25 (R58/R59)', async () => {
    // R59 (`R58-zoom.md` §4): the mechanism is now the renderer's own
    // `zoom.ts`, applied as an `ipcRenderer.invoke` round trip during
    // module load rather than main's own synchronous `did-finish-load`
    // handler — `waitForLoadState('load')` only guarantees that call was
    // *dispatched*, not that main has finished handling it, so this polls
    // briefly instead of asserting immediately.
    await expect
      .poll(
        async () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor()
          ),
        { timeout: 2000 }
      )
      .toBe(1)
  })

  it('preload exposes exactly the surface api.ts declares — no accidental passthrough (R51)', async () => {
    const shape = await page.evaluate(() => {
      function shapeOf(value: unknown): unknown {
        if (typeof value === 'function') return 'function'
        if (value !== null && typeof value === 'object') {
          const entries = Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, shapeOf((value as Record<string, unknown>)[key])])
          return Object.fromEntries(entries)
        }
        return typeof value
      }
      return shapeOf((window as unknown as { api: unknown }).api)
    })

    expect(shape).toEqual({
      app: {
        cancelQuit: 'function',
        confirmQuit: 'function',
        onQuitRequested: 'function'
      },
      document: {
        getPathForFile: 'function',
        mintReadToken: 'function',
        onExternalChange: 'function',
        openDialog: 'function',
        saveAsDialog: 'function',
        stat: 'function',
        unwatch: 'function',
        watch: 'function',
        write: 'function'
      },
      keybindings: {
        read: 'function',
        write: 'function'
      },
      titleBar: {
        onFocusChange: 'function',
        onFullscreenChange: 'function',
        platform: 'string',
        setOverlayColors: 'function'
      },
      view: {
        setZoomFactor: 'function'
      }
    })
  })

  /**
   * R164 (`docs/plans/R164-release-security-hardening.md` §2d) — the sender
   * guard, end to end against the real thing.
   *
   * **This test exists because the guard is the one change in the round that
   * can brick the application.** Every IPC call now goes through
   * `isTrustedSender`, which compares `event.senderFrame.url` against the URL
   * `createWindow` recorded. If those two strings ever fail to agree — a
   * `loadFile` path that normalises differently from `pathToFileURL`, a drive
   * letter in the other case on Windows, a dev URL with a trailing slash — then
   * *every* handler refuses, the renderer cannot read a file or save one, and
   * the app is dead on arrival. That is not a failure any unit test of the
   * predicate can see, because the predicate would be entirely correct.
   *
   * `keybindings:read` is the probe: it reaches main, touches no fixture, and
   * returns `null` when nothing is persisted. What is asserted is that it
   * *resolves* — a refusal rejects with "Refused … from an untrusted frame".
   */
  it('R164: the real renderer is a trusted IPC sender — a round trip resolves', async () => {
    const outcome = await page.evaluate(async () => {
      try {
        const api = (
          window as unknown as { api: { keybindings: { read: () => Promise<unknown> } } }
        ).api
        await api.keybindings.read()
        return 'resolved'
      } catch (error) {
        return `rejected: ${String(error)}`
      }
    })

    expect(outcome).toBe('resolved')
  })

  /**
   * R166 (`docs/plans/R164-release-security-hardening.md` §4) — the document
   * read path through the real preload bridge, under `sandbox: true`.
   *
   * **This is what makes the sandbox a verified change rather than a flipped
   * option.** The plan asked for a manual lifecycle pass; a manual pass
   * confirms the seam on the day it is run and says nothing on any later day.
   * The read path is what a sandbox would most plausibly break, and `stat` and
   * `mintReadToken` are the two calls that actually cross `contextBridge` into
   * main — so they are the ones worth pinning.
   *
   * **The `klados-file://` half is asserted as a refusal, and finding out why
   * corrected the plan.** §2b called the scheme "fetchable from any script in
   * the renderer, not just the worker". It is not fetchable from *this* page:
   * `index.html`'s own CSP is `default-src 'self'` with no `connect-src`, so
   * Chromium refuses the connection outright —
   *
   *   Connecting to 'klados-file://…' violates the following Content Security
   *   Policy directive: "default-src 'self'". … The action has been blocked.
   *
   * — while the parse worker, loaded from a bundled script with no CSP of its
   * own, is unaffected. That is a **second control on the read primitive that
   * neither the plan nor the review had noticed**, and it is worth a test
   * because nothing else in the tree records that it exists: someone widening
   * the CSP for an unrelated reason would remove it silently.
   *
   * It does not weaken R164. A page the renderer is *navigated to* carries its
   * own CSP or none — §2a.3's whole point is that the `<meta>` tag does not
   * travel — so the primitive is still reachable by hostile content. What is
   * corrected is the reach *from the app's own page*, not the threat.
   */
  it('R166: the read path crosses the bridge, and the CSP still blocks it from page context', async () => {
    const target = path.join(root, 'package.json')

    const result = await page.evaluate(async (filePath: string) => {
      const api = (
        window as unknown as {
          api: {
            document: {
              stat: (p: string) => Promise<{ size: number; readOnly: boolean }>
              mintReadToken: (p: string) => Promise<string>
            }
          }
        }
      ).api
      const stat = await api.document.stat(filePath)
      const token = await api.document.mintReadToken(filePath)
      let fetchRefused = false
      try {
        await fetch(`klados-file://${token}/`)
      } catch {
        fetchRefused = true
      }
      return { size: stat.size, tokenLength: token.length, fetchRefused }
    }, target)

    // Both IPC calls returned real answers through the bridge — the part
    // `sandbox: true` could have broken.
    expect(result.size).toBeGreaterThan(0)
    expect(result.tokenLength).toBeGreaterThan(0)
    // And the privileged scheme stays unreachable from the document's context.
    expect(result.fetchRefused).toBe(true)
  })

  /**
   * R165 (`docs/plans/R164-release-security-hardening.md` §3) — the blanket
   * permission deny, asserted where it actually runs.
   *
   * The decision itself is a constant, so a unit test of it would prove
   * nothing. What is worth pinning is that the handlers are **registered**:
   * they live inside `app.on('web-contents-created')` in main, and a refactor
   * that moved or dropped that block would leave Chromium's defaults in place
   * with nothing to notice. Asking the real renderer for a real permission is
   * the only check that sees the difference.
   */
  it('R165: the renderer cannot obtain a permission — every request is denied', async () => {
    const permission = await page.evaluate(async () => Notification.requestPermission())
    expect(permission).toBe('denied')
  })

  /**
   * Waits for the renderer to report an external change, **re-applying the
   * change while it waits**.

   * This started as a plain poll with the rewrite done once, up front, and it
   * **failed on macOS in CI** — 10 seconds, no notification, while the same
   * test passed on Linux and Windows and the atomic-save variant passed
   * everywhere. Two mechanisms could produce that and **I could not
   * distinguish them from a Windows machine**, which is the honest reason this
   * guards against both rather than fixing one:
   *
   * - **A missed event.** `await api.document.watch(...)` resolves when main's
   *   handler returns, which is not necessarily when the platform watcher is
   *   delivering events. A write landing in that gap is not late — it is gone,
   *   and no amount of polling recovers it.
   * - **A suppressed event.** The registry compares `mtimeMs` to tell "the
   *   watcher noticed something" from "the contents actually changed"
   *   (`main/documents.ts`). A rewrite fast enough to land on the same
   *   timestamp is correctly ignored.
   *
   * Re-applying the change on each poll covers both: a missed first event gets
   * a second chance, and `utimesSync` guarantees each attempt carries a
   * strictly newer timestamp than the last. It still fails loudly if watching
   * is genuinely broken, which is the property that matters.
   *
   * **Worth recording as its own small lesson**: the 200 ms sleep this test
   * originally had was deleted as superstition when R163's lint rule flagged
   * it, after I checked that the `await` already covers watcher *registration*.
   * That reasoning was right about registration and wrong about the platform,
   * and only the macOS runner knew.
   */
  async function waitForExternalChange(globalKey: string, rewrite: () => void): Promise<void> {
    await expect
      .poll(
        async () => {
          const seen = await page.evaluate(
            (key: string) => (window as unknown as Record<string, string[]>)[key]?.length ?? 0,
            globalKey
          )
          if (seen > 0) return seen
          rewrite()
          return 0
        },
        { timeout: 15_000, interval: 500 }
      )
      .toBeGreaterThan(0)
  }

  /**
   * Releases a watch **before** the test deletes what it was watching.
   *
   * Without this the tests leak a live watcher onto a path they then remove,
   * and on Windows that surfaces as an uncaught `EPERM: operation not
   * permitted, watch` inside `FSWatcher._handle.onchange` — a main-process
   * exception dialog, because `main/documents.ts` attaches no `'error'`
   * listener to `fs.watch`. The underlying defect is the missing listener and
   * is R171's; leaving these tests as a way to trigger it is separately wrong,
   * since a test that can pop a modal dialog on a CI runner is a test that can
   * hang one.
   */
  async function releaseWatch(key: string): Promise<void> {
    await page.evaluate(
      (k: string) =>
        (
          window as unknown as { api: { document: { unwatch: (key: string) => Promise<void> } } }
        ).api.document.unwatch(k),
      key
    )
  }

  /** A write that is always distinguishable from the one before it, whatever
   * the filesystem's timestamp granularity. */
  function rewriteWithNewerMtime(target: string, contents: string): void {
    writeFileSync(target, contents)
    const future = new Date(Date.now() + 1000)
    utimesSync(target, future, future)
  }

  /**
   * File watching, end to end through the real IPC in both directions.
   *
   * Written because a manual pass of R166's owed lifecycle reported that
   * **neither watcher behaviour fired** — a clean document did not reload and a
   * dirty one raised no prompt. That is either a regression this round caused
   * or a defect it merely surfaced, and the difference is not something to
   * reason about from the code: `document:watch` goes renderer → main through
   * the new sender guard, and the notification comes back main → renderer over
   * `webContents.send`, which the guard does not touch.
   *
   * So this drives the actual seam: watch a real file from the page, change it
   * from the test process, and wait for the renderer to hear about it.
   */
  it('file watching notifies the renderer when the file changes on disk', async () => {
    const watched = path.join(tmpdir(), `klados-watch-${Date.now()}.json`)
    writeFileSync(watched, '{"a":1}')

    try {
      await page.evaluate(async (filePath: string) => {
        const api = (
          window as unknown as {
            api: {
              document: {
                watch: (p: string, key: string) => Promise<void>
                onExternalChange: (cb: (key: string) => void) => () => void
              }
            }
          }
        ).api
        const seen: string[] = []
        ;(window as unknown as { __watchSeen: string[] }).__watchSeen = seen
        api.document.onExternalChange((key) => seen.push(key))
        await api.document.watch(filePath, 'manual-check')
      }, watched)

      await waitForExternalChange('__watchSeen', () =>
        rewriteWithNewerMtime(watched, `{"a":2,"b":${Date.now()}}`)
      )
    } finally {
      await releaseWatch('manual-check')
      rmSync(watched, { force: true })
    }
  })

  /**
   * The same seam, but saved the way editors actually save.
   *
   * A direct `writeFileSync` over the path is the easy case. Most editors do an
   * **atomic save** instead — write a sibling temp file, then rename it over
   * the target — which replaces the directory entry rather than the file's
   * contents. `fs.watch` handling that is not something to assume: the registry
   * compares `mtimeMs` to turn "the watcher noticed something" into "the
   * contents actually changed", and a rename produces a different event shape
   * from a write.
   *
   * Kept as a test rather than left as the one-off probe it started as, because
   * this is the shape a user's real editor produces, and it is the shape a
   * manual check would exercise without anyone realising it was a distinct
   * case.
   */
  it('file watching survives an atomic save — write a temp file, rename it over', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'klados-watch-'))
    const watched = path.join(dir, 'doc.json')
    const staging = path.join(dir, 'doc.json.tmp')
    writeFileSync(watched, '{"a":1}')

    try {
      await page.evaluate(async (filePath: string) => {
        const api = (
          window as unknown as {
            api: {
              document: {
                watch: (p: string, key: string) => Promise<void>
                onExternalChange: (cb: (key: string) => void) => () => void
              }
            }
          }
        ).api
        const seen: string[] = []
        ;(window as unknown as { __atomicSeen: string[] }).__atomicSeen = seen
        api.document.onExternalChange((key) => seen.push(key))
        await api.document.watch(filePath, 'atomic-save')
      }, watched)

      await waitForExternalChange('__atomicSeen', () => {
        writeFileSync(staging, `{"a":2,"b":${Date.now()}}`)
        const future = new Date(Date.now() + 1000)
        utimesSync(staging, future, future)
        renameSync(staging, watched)
      })
    } finally {
      await releaseWatch('atomic-save')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
