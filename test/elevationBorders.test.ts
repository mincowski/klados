/**
 * R60-dark-elevation.md §5 acceptance 3: every `--elev-2-bg` surface
 * resolves a real border, in both themes — enumerated from §4's table
 * rather than spot-checked, so the next elevated surface someone adds
 * without a border fails here instead of joining a silent majority.
 *
 * `.notification` itself already gets a real-Chromium computed-style check
 * in `test/notifications.test.tsx` (it has a mount harness; the others
 * don't). This test covers the rest by reading the actual source CSS: for
 * each selector block that sets `background: var(--elev-2-bg)`, the same
 * block must also declare a `border` naming `--surface-border`. A text
 * check, not a rendered one — but it fails exactly the way a missing border
 * fails (a new elev-2-bg block with no border line), which is the
 * regression this test exists to catch.
 *
 * **R212 §5 made the enumeration itself the defect.** `.raw-wrapping-overlay`
 * was added by D12 *after* R60 gave the hairline to every elevated surface
 * then existing, the list below was not extended, and it sat borderless for
 * four rounds — white-on-white in light for the one frame it shows. An
 * enumeration only catches what it enumerates, so the list is no longer the
 * authority: the third test below walks `src/renderer` for every file
 * declaring `var(--elev-2-bg)` and fails if one is not named here. R60's
 * finding was that the border belongs to the **tier**, and the tier is
 * whatever sets `--elev-2-bg`.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

const RENDERER_DIR = join(__dirname, '..', 'src', 'renderer')

const ELEV_2_SURFACES = [
  'components/Find/Find.css',
  'components/Palette/CommandPalette.css',
  'components/StatusBar/StatisticsPanel.css',
  'components/TabStrip/TabStrip.css',
  'components/Detail/Grid.css',
  // R65 (`R65-shortcuts-help.md` §5) — the first new elevated surface
  // since R60, and the first real exercise of this test's own point: a
  // surface added without the tier's hairline should fail here.
  'components/Help/Shortcuts.css',
  // R212 §5 — `.raw-wrapping-overlay`, the one this list had missed.
  'components/Raw/Raw.css',
  // Also checked as rendered computed styles in `test/notifications.test.tsx`,
  // which is why R60 left it out here. The completeness test below does not
  // know about that, and should not have to: a surface covered twice costs
  // nothing, whereas the one exemption is how the list drifted before.
  'notifications/Notifications.css'
]

/** Every `.css` under `src/renderer`, as forward-slashed relative paths, so
 * the comparison below reads the same on Windows and on CI. */
function allStylesheets(): string[] {
  return readdirSync(RENDERER_DIR, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.split(sep).join('/'))
    .filter((entry) => entry.endsWith('.css'))
}

function ruleBlocksContaining(css: string, needle: string): string[] {
  const blocks: string[] = []
  const ruleRe = /[^{}]+\{[^{}]*\}/g
  let match: RegExpExecArray | null
  while ((match = ruleRe.exec(css)) !== null) {
    if (match[0].includes(needle)) blocks.push(match[0])
  }
  return blocks
}

describe('R60 §5 acceptance 3 — every --elev-2-bg block also declares a --surface-border', () => {
  for (const relPath of ELEV_2_SURFACES) {
    const css = readFileSync(join(RENDERER_DIR, relPath), 'utf8')
    const blocks = ruleBlocksContaining(css, 'var(--elev-2-bg)')

    it(`${relPath} has at least one --elev-2-bg rule`, () => {
      expect(blocks.length).toBeGreaterThan(0)
    })

    blocks.forEach((block, i) => {
      it(`${relPath} block #${i + 1} declares a border using --surface-border`, () => {
        expect(block).toMatch(/border:\s*var\(--border-width\)\s+solid\s+var\(--surface-border\)/)
      })
    })
  }

  // R212 §5: the list above is checked against the stylesheets rather than
  // trusted, because trusting it is how `.raw-wrapping-overlay` stayed
  // borderless through four rounds of this test passing.
  it('names every stylesheet that declares --elev-2-bg', () => {
    const declaring = allStylesheets().filter((relPath) =>
      // Tolerant of `background-color` and of spacing, and deliberately not
      // a bare substring search: `--elev-2-bg` is mentioned in prose in
      // several of these files' header comments.
      /background(-color)?\s*:\s*var\(--elev-2-bg\)/.test(
        readFileSync(join(RENDERER_DIR, relPath), 'utf8')
      )
    )
    expect([...declaring].sort()).toEqual([...ELEV_2_SURFACES].sort())
  })
})
