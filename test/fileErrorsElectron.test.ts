/**
 * R220 (`docs/plans/R220-file-error-messages.md` § 5) — the built app, so the
 * errors cross real IPC and the real read protocol. § 1 measured what IPC does
 * to an error (the message only, behind Electron's prefix); this is the check
 * that the tagged kind survives exactly that.
 *
 * The first case is the report that raised the round: a file in the restored
 * session that no longer exists.
 *
 * Skips with a warning when `out/main/index.js` is missing, as
 * `mainElectron.test.ts` does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import path from 'path'
import { holdWithoutSharing } from './support/holdWithoutSharing'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mainEntry = path.join(__dirname, '..', 'out', 'main', 'index.js')
const builtAppAvailable = existsSync(mainEntry)

if (!builtAppAvailable) {
  console.warn(
    '[fileErrorsElectron.test.ts] out/main/index.js not found — run `npx electron-vite build` first.'
  )
}

/** As `openWithElectron.test.ts`: past this, teardown kills the process. */
const CLOSE_BUDGET_MS = 10_000

async function closeApp(app: ElectronApplication): Promise<void> {
  const closed = app.close().then(
    () => true,
    () => true
  )
  const exited = await Promise.race([
    closed,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_BUDGET_MS))
  ])
  if (!exited) app.process().kill()
}

async function banner(page: Page): Promise<{ text: string; path: string | null }> {
  const alert = page.locator('.document-area-banner-error')
  await alert.waitFor({ timeout: 30_000 }).catch(async (err: unknown) => {
    throw new Error(`no error banner; the window shows:\n${await page.innerText('body')}`, {
      cause: err
    })
  })
  const pathLine = alert.locator('.document-area-banner-path')
  return {
    text: (await alert.evaluate((el) => el.firstChild?.textContent ?? '')).trim(),
    path: (await pathLine.count()) === 0 ? null : await pathLine.textContent()
  }
}

describe.skipIf(!builtAppAvailable)('file errors in the built app (R220)', () => {
  let dir: string
  let app: ElectronApplication | null = null

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'klados-r220-'))
  })

  afterAll(async () => {
    if (app !== null) await closeApp(app)
    // Retried: Electron's helper processes can still hold the profile for a
    // moment after the app has closed (EPERM on Windows).
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  })

  async function launch(userDataDir: string, ...files: string[]): Promise<Page> {
    app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`, ...files] })
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    return page
  }

  it('a restored file that no longer exists: its name in words, its path below', async () => {
    const profile = path.join(dir, 'profile-missing')
    const probe = path.join(dir, 'probe.json')
    writeFileSync(probe, '{"a":1}')

    let page = await launch(profile, probe)
    // The tree, not the tab label: the label shows while the file is still
    // opening, and the session records a tab only once it is ready.
    await expect
      .poll(() => page.locator('.tree-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(0)
    await closeApp(app!)
    app = null
    rmSync(probe)

    page = await launch(profile)
    expect(await banner(page)).toEqual({
      text: "probe.json can't be opened: it no longer exists.",
      path: probe
    })
    await closeApp(app!)
    app = null
  }, 120_000)

  it.runIf(process.platform === 'win32')(
    'a file another program holds: told through the read protocol, not as HTTP 404',
    async () => {
      const held = path.join(dir, 'held.csv')
      writeFileSync(held, 'a,b\n1,2\n')
      // Held without sharing, as Excel holds a CSV — `stat` still succeeds on
      // Windows, so this fails in the protocol handler's open, not in IPC.
      const release = await holdWithoutSharing(held)
      try {
        const page = await launch(path.join(dir, 'profile-locked'), held)
        expect(await banner(page)).toEqual({
          text: "held.csv can't be opened: another program is using it.",
          path: held
        })
      } finally {
        await release()
        await closeApp(app!)
        app = null
      }
    },
    120_000
  )
})
