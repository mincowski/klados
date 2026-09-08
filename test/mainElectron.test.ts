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
})
