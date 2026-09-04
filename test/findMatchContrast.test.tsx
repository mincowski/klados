/**
 * R81 (`R78-find-affordances.md` §4) — R80's own contrast table shipped
 * once already and nobody saw it, because "looks right" was the only
 * check there was (§3's table: the old current-match fill measured down to
 * 1.04:1 for a comment). Modelled on `test/scrollbarContrast.test.tsx`
 * (R33/D-051) — real Chromium, computed colours, not eyeballed.
 *
 * Asserts every `--syntax-*` foreground and `--surface-fg` clears 3:1 over
 * `--find-match-bg` (the fill every match gets) in both themes, plus the
 * current-match ring's own >= 3:1 against the fill it sits in. 3:1 rather
 * than 4.5:1: `--syntax-comment` is already only 4.20 (dark) / 4.10 (light)
 * over the *plain* surface, so a 4.5 bar would fail the unhighlighted
 * editor — not what this round is about. 3:1 is what R33 and R57 both used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/styles/base.css'

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
})

afterEach(() => {
  delete document.documentElement.dataset.theme
})

function parseRgb(color: string): [number, number, number] {
  const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color)
  if (match === null) throw new Error(`unparseable color: ${color}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(parseRgb(a))
  const l2 = relativeLuminance(parseRgb(b))
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/** Resolves a custom property to its computed `color` — the same trick
 * `r8Layout.test.tsx`'s own `colorFromVar` uses, needed because
 * `getPropertyValue` returns the raw `var(...)` chain, not a resolved rgb(). */
function resolveColor(varName: string): string {
  const probe = document.createElement('div')
  probe.style.color = `var(${varName})`
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return resolved
}

const SYNTAX_FOREGROUNDS = [
  '--syntax-tag-name',
  '--syntax-attr-name',
  '--syntax-string',
  '--syntax-number',
  '--syntax-comment',
  '--syntax-keyword',
  '--syntax-punctuation',
  '--surface-fg'
] as const

describe('R81 — find match fill and current-match ring clear 3:1', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`every syntax foreground clears 3:1 over --find-match-bg in ${theme}`, () => {
      document.documentElement.dataset.theme = theme
      const fill = resolveColor('--find-match-bg')
      for (const fg of SYNTAX_FOREGROUNDS) {
        const ratio = contrastRatio(fill, resolveColor(fg))
        expect(
          ratio,
          `${fg} over --find-match-bg in ${theme} (${ratio.toFixed(2)}:1)`
        ).toBeGreaterThanOrEqual(3)
      }
    })

    it(`the current-match ring clears 3:1 against --find-match-bg in ${theme}`, () => {
      document.documentElement.dataset.theme = theme
      const fill = resolveColor('--find-match-bg')
      const ring = resolveColor('--find-match-current-border')
      const ratio = contrastRatio(fill, ring)
      expect(ratio, `ring over fill in ${theme} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(3)
    })
  }
})
