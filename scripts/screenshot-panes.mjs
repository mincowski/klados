// R197 — regenerates `docs/screenshots/three-panes.png`, the README's hero
// image: the three panes in both themes, split on the diagonal.
//
// **It exists because the image it replaces could not be regenerated.** The
// previous composite was made by hand, so a UI change silently dated it and
// nobody could refresh it without redoing unknown steps. This is the same
// argument as R190's packaging allowlist and R155's spike policy — an artifact
// whose recipe is lost is an artifact that rots.
//
// Run it after `npm run build`, since it launches the built `out/main`:
//
//     npm run build && node scripts/screenshot-panes.mjs
//
// Nothing in CI runs this. It needs a display, a 10 MB fixture that is
// gitignored, and a human to look at the result — which is the point of a
// screenshot.
import { _electron as electron, chromium } from 'playwright'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/')
const outDir = `${root}/docs/screenshots`
const tmpDir = `${outDir}/.tmp`
const fixture = `${root}/spike/fixtures/cars-10mb.xml`
const target = `${outDir}/three-panes.png`

// Matches the image this replaces, so the README's layout does not shift.
const WIDTH = 1120
const HEIGHT = 700

/**
 * The dark frame takes the **upper-left** triangle, the light frame the rest;
 * the split runs bottom-left to top-right.
 *
 * Chosen by rendering all four combinations and looking at them, per
 * `docs/PLANNING.md` §1. It wins because the diagonal passes through the empty
 * space right of the Tree and above the table, so it cuts almost nothing that
 * carries information — the tree rows, the grid and the Raw source each stay
 * whole. The mirror image puts the same line through the source code.
 *
 * **No seam.** An amber hairline along the join was rendered and rejected: it
 * reads as decoration without doing work. Revisit only with a reference where
 * it demonstrably helps.
 */
const DARK_CLIP = 'polygon(0 0, 100% 0, 0 100%)'

// Plain .mjs, run directly by Node with no build step — a TS return-type annotation
// here would be a syntax error, so the rule cannot be satisfied (same as
// `electron-screenshot.mjs`).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function captureThemes() {
  const app = await electron.launch({
    args: [`${root}/out/main/index.js`, `--user-data-dir=${tmpDir}/udata`]
  })
  const w = await app.firstWindow()
  await w.waitForLoadState('domcontentloaded')
  await w.waitForTimeout(600)

  // Sized from the main process: `setViewportSize` resizes the page, not the
  // OS window, and the capture has to include the app's own title bar. Called
  // after `firstWindow()` — `getAllWindows()` is empty before that.
  await app.evaluate(
    ({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0].setContentSize(width, height)
    },
    [WIDTH, HEIGHT]
  )
  await w.waitForTimeout(400)

  // The document is seeded through the app's own restore-on-launch path
  // (R24/R29 persists open paths), because a harness cannot drive the native
  // Open dialog — the same boundary R164 §10 records.
  await w.evaluate(
    ([file, theme]) => {
      localStorage.setItem(
        'klados.sessionRestore',
        JSON.stringify({ paths: [file], activeIndex: 0 })
      )
      localStorage.setItem('klados.theme', theme)
    },
    [fixture, 'light']
  )
  await w.reload()
  await w.waitForLoadState('domcontentloaded')

  // Wait for the document to be *on screen* rather than for a duration — R159:
  // wait for the condition, never for a guess at how long it takes.
  await w.waitForSelector('text=31.655 children', { timeout: 120_000 })
  await w.waitForTimeout(1500)

  // The Raw pane via the command palette, not a button: invariant 10 makes the
  // palette the one surface every command is reachable from, so this does not
  // break when the title bar is rearranged.
  await w.keyboard.press('Control+Shift+P')
  await w.waitForTimeout(400)
  await w.keyboard.type('Raw Pane')
  await w.waitForTimeout(500)
  await w.keyboard.press('Enter')
  await w.waitForTimeout(1500)

  await w.screenshot({ path: `${tmpDir}/light.png` })
  await w.keyboard.press('Control+Shift+L')
  await w.waitForTimeout(1200)
  await w.screenshot({ path: `${tmpDir}/dark.png` })

  await app.close()
}

/**
 * Composited in Chromium with `clip-path` rather than by an image library:
 * Playwright is already a devDependency and this needs no other one
 * (`CLAUDE.md` § Conventions).
 */
// Plain .mjs, run directly by Node with no build step — a TS return-type annotation
// here would be a syntax error, so the rule cannot be satisfied (same as
// `electron-screenshot.mjs`).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function composite() {
  const light = (await readFile(`${tmpDir}/light.png`)).toString('base64')
  const dark = (await readFile(`${tmpDir}/dark.png`)).toString('base64')

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await page.setContent(`
    <style>
      html,body{margin:0;padding:0}
      #frame{position:relative;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
      #frame img{position:absolute;inset:0;width:${WIDTH}px;height:${HEIGHT}px;display:block}
      #top{clip-path:${DARK_CLIP}}
    </style>
    <div id="frame">
      <img src="data:image/png;base64,${light}">
      <img id="top" src="data:image/png;base64,${dark}">
    </div>
  `)
  await page.waitForTimeout(300)
  await page.locator('#frame').screenshot({ path: target })
  await browser.close()
}

// Plain .mjs, run directly by Node with no build step — a TS return-type annotation
// here would be a syntax error, so the rule cannot be satisfied (same as
// `electron-screenshot.mjs`).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function main() {
  try {
    await access(fixture)
  } catch {
    console.error(
      `Fixture missing: ${fixture}\nRun \`npm run fixtures:generate\` first — it is gitignored.`
    )
    process.exit(1)
  }
  try {
    await access(`${root}/out/main/index.js`)
  } catch {
    console.error('out/main/index.js missing — run `npm run build` first.')
    process.exit(1)
  }

  await mkdir(tmpDir, { recursive: true })
  await captureThemes()
  await composite()
  await rm(tmpDir, { recursive: true, force: true })
  console.log(`Wrote ${target}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
