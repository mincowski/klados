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
import { existsSync } from 'fs'
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

  beforeAll(async () => {
    app = await electron.launch({ args: [mainEntry] })
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
})
