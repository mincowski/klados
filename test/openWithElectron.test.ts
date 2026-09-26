/**
 * R219 (`docs/plans/R219-open-with.md` §7) — the built app launched the way
 * "Open with" launches it: `Klados "<path>"`. Driven through Playwright's
 * `_electron`, like `mainElectron.test.ts`, because what is under test is the
 * main process reading its own command line, the single-instance lock and the
 * hand-over to the renderer — none of which exist outside a real Electron
 * process.
 *
 * Skips with a warning when `out/main/index.js` is missing, as that suite does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import path from 'path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mainEntry = path.join(__dirname, '..', 'out', 'main', 'index.js')
const builtAppAvailable = existsSync(mainEntry)
const electronBinary = createRequire(import.meta.url)('electron') as unknown as string

if (!builtAppAvailable) {
  console.warn(
    '[openWithElectron.test.ts] out/main/index.js not found — run `npx electron-vite build` first.'
  )
}

async function tabNames(page: Page): Promise<string[]> {
  return page.$$eval('.tab-strip .tab-label', (names) => names.map((n) => n.textContent ?? ''))
}

/** Bounded, as `mainElectron.test.ts` explains: on macOS closing the last
 * window does not quit the app, so a plain `close()` can wait forever. Past
 * this, the process is killed — teardown needs nothing graceful. */
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

describe.skipIf(!builtAppAvailable)('launched with a file, as "Open with" does (R219)', () => {
  let dir: string
  let userDataDir: string
  let xml: string
  let json: string
  let app: ElectronApplication | null = null

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'klados-openwith-'))
    userDataDir = path.join(dir, 'profile')
    xml = path.join(dir, 'shelf.xml')
    json = path.join(dir, 'config.json')
    writeFileSync(xml, '<shelf><book><title>Odyssey</title></book></shelf>')
    writeFileSync(json, '{"name":"klados","tabs":[1,2]}')
  })

  afterAll(async () => {
    if (app !== null) await closeApp(app)
    rmSync(dir, { recursive: true, force: true })
  })

  /** A second launch, as a second "Open with" makes: its exit, and everything
   * it printed, so a failure says why rather than only that it failed. */
  async function launchSecond(
    file: string
  ): Promise<{ code: number | null; signal: string | null; output: string }> {
    const second = spawn(electronBinary, [mainEntry, `--user-data-dir=${userDataDir}`, file], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    second.stdout.on('data', (chunk) => (output += String(chunk)))
    second.stderr.on('data', (chunk) => (output += String(chunk)))
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve) =>
      second.on('exit', (c, s) => resolve([c, s]))
    )
    return { code, signal, output }
  }

  async function launch(...files: string[]): Promise<Page> {
    app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`, ...files] })
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    return page
  }

  it('opens the file in a tab, with no empty tab beside it', async () => {
    const page = await launch(xml)
    await expect.poll(() => tabNames(page), { timeout: 30_000 }).toEqual(['shelf.xml'])
    await expect
      .poll(() => page.locator('.tree-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(1)
  }, 120_000)

  it('a second launch hands its file to the running window and exits', async () => {
    const page = (await app!.firstWindow())!
    const second = await launchSecond(json)
    expect(
      second.code,
      `signal ${second.signal}; output:
${second.output}`
    ).toBe(0)
    await expect
      .poll(() => tabNames(page), { timeout: 30_000 })
      .toEqual(['shelf.xml', 'config.json'])
    expect(app!.windows()).toHaveLength(1)
  }, 120_000)

  it('a second launch with a file already open focuses its tab instead of opening it twice', async () => {
    const page = (await app!.firstWindow())!
    const second = await launchSecond(xml)
    expect(
      second.code,
      `signal ${second.signal}; output:
${second.output}`
    ).toBe(0)
    await expect
      .poll(() => page.$eval('.tab-strip .tab-active .tab-label', (n) => n.textContent), {
        timeout: 30_000
      })
      .toBe('shelf.xml')
    expect(await tabNames(page)).toEqual(['shelf.xml', 'config.json'])
  }, 120_000)

  it('relaunched with a file the restored session already holds: one tab, not two', async () => {
    await closeApp(app!)
    app = null
    const page = await launch(json)
    // The session restore reopens both; the launch path matches the restored
    // `config.json` while it is still opening, and focuses it.
    await expect
      .poll(() => tabNames(page), { timeout: 30_000 })
      .toEqual(['shelf.xml', 'config.json'])
    await expect
      .poll(() => page.$eval('.tab-strip .tab-active .tab-label', (n) => n.textContent), {
        timeout: 30_000
      })
      .toBe('config.json')
  }, 120_000)
})
