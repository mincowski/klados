#!/usr/bin/env -S npx tsx
/**
 * R239's measurement: what a regex Find costs in the built application's
 * renderer, end to end, and what a catastrophically backtracking pattern
 * does to the window.
 *
 * Usage: npx tsx spike/r239-regex-find.ts [fixture] [runs]
 *   fixture defaults to spike/fixtures/cars-200mb.xml; runs to 3 (median).
 *
 *  1. **Backtracking in the renderer.** `(a+)+$` timed by `page.evaluate` on a
 *     64 KB string whose last line is `n` × `a` then `b`, for growing `n`.
 *     Every evaluate is the renderer's own main thread, so this is how long
 *     the window would be frozen by one window's `exec`.
 *  2. **Regex Find over the fixture**, through the Find bar, for each pattern
 *     below. Timed in the page from the count changing to "Searching…" to it
 *     changing to anything else, so Find's debounce is excluded. A long-task
 *     observer records the longest main-thread task while it runs.
 *
 * Needs `npx electron-vite build` (it launches `out/main/index.js`) and
 * `npm run fixtures:generate`. Not wired into `npm test`. A fresh temporary
 * profile per run, so nothing the developer has open is restored.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const fixture = path.resolve(process.argv[2] ?? 'spike/fixtures/cars-200mb.xml')
const RUNS = Number(process.argv[3] ?? 3)
const PATTERNS = ['\\d{4}-\\d{2}', '<year>\\d{4}']
const BACKTRACK_LENGTHS = process.env.R239_SKIP_BACKTRACK ? [] : [16, 18, 20, 22, 24, 26, 30]

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function main(): Promise<void> {
  const profile = mkdtempSync(path.join(tmpdir(), 'klados-r239-'))
  const app = await electron.launch({
    args: [path.resolve('out/main/index.js'), `--user-data-dir=${profile}`]
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('load')

    // --- 1. backtracking ------------------------------------------------------
    console.log('(a+)+$ on a 64 KB window, renderer main thread:')
    for (const n of BACKTRACK_LENGTHS) {
      const ms = await page.evaluate((n) => {
        const filler = 'x'.repeat(79) + '\n'
        const text = filler.repeat(Math.floor((64 * 1024 - n - 1) / filler.length)) + 'a'.repeat(n) + 'b'
        const t0 = performance.now()
        new RegExp('(a+)+$', 'g').exec(text)
        return performance.now() - t0
      }, n)
      console.log(`  n=${n}: ${ms.toFixed(1)} ms`)
    }

    // --- 2. regex Find over the fixture --------------------------------------
    await app.evaluate(({ BrowserWindow }, p) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('app:openPaths', [p])
    }, fixture)
    await page
      .locator('.title-bar-title', { hasText: path.basename(fixture) })
      .waitFor({ timeout: 300_000 })
    await page.locator('.cm-content').waitFor({ timeout: 300_000 })
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!
      w.show()
      w.focus()
    })
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+F')
    const input = page.locator('.find-input').first()
    await input.waitFor()
    await page.locator('[title="Use regular expression"]').click()

    await page.evaluate(() => {
      const w = window as unknown as { __r239: { longest: number; start: number; end: number } }
      w.__r239 = { longest: 0, start: 0, end: 0 }
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__r239.longest = Math.max(w.__r239.longest, e.duration)
      }).observe({ entryTypes: ['longtask'] })
      const count = document.querySelector('.find-count-value')!
      new MutationObserver(() => {
        const t = count.textContent ?? ''
        if (t === 'Searching…') w.__r239.start = performance.now()
        else if (w.__r239.start !== 0 && w.__r239.end === 0) w.__r239.end = performance.now()
      }).observe(count, { childList: true, characterData: true, subtree: true })
    })

    for (const pattern of PATTERNS) {
      const times: number[] = []
      let longest = 0
      let label = ''
      for (let run = 0; run < RUNS; run++) {
        await input.fill('')
        await page.waitForFunction(
          () => document.querySelector('.find-count-value')?.textContent !== 'Searching…'
        )
        await page.evaluate(() => {
          const s = (window as unknown as { __r239: { longest: number; start: number; end: number } }).__r239
          s.longest = 0
          s.start = 0
          s.end = 0
        })
        await input.fill(pattern)
        await page.waitForFunction(
          () => {
            const s = (window as unknown as { __r239: { end: number } }).__r239
            return s.end !== 0
          },
          undefined,
          { timeout: 600_000 }
        )
        const s = await page.evaluate(
          () => (window as unknown as { __r239: { longest: number; start: number; end: number } }).__r239
        )
        times.push(s.end - s.start)
        longest = Math.max(longest, s.longest)
        label = (await page.locator('.find-count-value').textContent()) ?? ''
      }
      console.log(
        `${pattern}: median ${median(times).toFixed(0)} ms over ${RUNS} (${times.map((t) => t.toFixed(0)).join(', ')}), ` +
          `longest task ${longest.toFixed(0)} ms, count "${label}"`
      )
    }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
}

void main()
