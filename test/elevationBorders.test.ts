/**
 * R60-dark-elevation.md §5 acceptance 3: every `--elev-2-bg` surface
 * resolves a real border, in both themes — enumerated from §4's table
 * rather than spot-checked, so the next elevated surface someone adds
 * without a border fails here instead of joining a silent majority.
 *
 * `.notification` itself already gets a real-Chromium computed-style check
 * in `test/notifications.test.tsx` (it has a mount harness; the other six
 * don't). This test covers the remaining six by reading the actual source
 * CSS: for each selector block that sets `background: var(--elev-2-bg)`,
 * the same block must also declare a `border` naming `--surface-border`.
 * A text check, not a rendered one — but it fails exactly the way a
 * missing border fails (a new elev-2-bg block with no border line), which
 * is the regression this test exists to catch.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ELEV_2_SURFACES = [
  'components/Find/Find.css',
  'components/Palette/CommandPalette.css',
  'components/StatusBar/StatisticsPanel.css',
  'components/TabStrip/TabStrip.css',
  'components/Detail/Grid.css',
  // R65 (`R65-shortcuts-help.md` §5) — the first new elevated surface
  // since R60, and the first real exercise of this test's own point: a
  // surface added without the tier's hairline should fail here.
  'components/Help/Shortcuts.css'
]

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
    const css = readFileSync(join(__dirname, '..', 'src', 'renderer', relPath), 'utf8')
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
})
