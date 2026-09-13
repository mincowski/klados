/**
 * R212 (`docs/plans/R212-dark-elevation-shadow.md`) — the *other* half of
 * the elevation pair, after `test/elevationBorders.test.ts` took the border.
 *
 * The question this round answered was measured, not argued: sampling the
 * ring of pixels just outside each of the nine elevated surfaces in the
 * running application, dark's shipped `0 2px 8px rgba(0, 0, 0, 0.3)` moved
 * the pane behind it by 4–9 of 255 — **1.03:1 to 1.06:1**, which is nothing.
 * The replacement measures 8–17, or 1.05:1 to 1.10:1.
 *
 * **There is a hard ceiling of 1.171:1 on any black shadow in this theme**,
 * that being `--gray-900` against pure black, so the assertion below cannot
 * be a contrast figure — the interesting range is a few hundredths wide and
 * a raster sample of it would be a CI flake waiting to happen (`R183-ci-
 * flakes.md` §6). What actually regresses is the token: someone tunes it
 * back toward invisible, or to `none`, and nothing says otherwise. So this
 * pins the token's own properties, which is where the decision lives.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const THEMES_DIR = join(__dirname, '..', 'src', 'renderer', 'styles', 'themes')

/** Comments are stripped first: this round's own comment in `dark.css`
 * quotes the value it replaced, and a naive match would read that. */
function declaredValue(theme: string, token: string): string {
  const css = readFileSync(join(THEMES_DIR, `${theme}.css`), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )
  const match = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(css)
  expect(match, `${token} is declared in ${theme}.css`).not.toBeNull()
  return match![1]!.trim()
}

/** The largest alpha among a value's `rgba(...)` layers — the one that
 * decides how far the strongest layer moves the pane behind it. */
function peakAlpha(value: string): number {
  const alphas = [...value.matchAll(/rgba\([^)]*,\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1]))
  return alphas.length === 0 ? 0 : Math.max(...alphas)
}

describe('R212 — dark’s elevation shadow contributes something measurable', () => {
  it('is not none, and not the near-invisible value it replaced', () => {
    const value = declaredValue('dark', '--elev-2-shadow')
    expect(value).not.toBe('none')
    // 0.3 measured 1.03:1–1.06:1 across all nine surfaces. 0.5 is the floor
    // below which the round's own measurement says the token stops earning
    // its place; the shipped value is 0.55.
    expect(peakAlpha(value)).toBeGreaterThanOrEqual(0.5)
  })

  it('darkens rather than glows — the two themes describe the same physics', () => {
    // R212 §3 rejected the inverted (light) shadow, which measured *better*
    // (1.14:1–1.41:1) precisely because a near-black pane only has headroom
    // upward. Rejected on consistency, so consistency is what is pinned:
    // light's shadow is near-black, and dark's must be too.
    const value = declaredValue('dark', '--elev-2-shadow')
    const layers = [...value.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+)/g)]
    // Asserted before the loop, because a loop over zero matches asserts
    // nothing and passes — the shape R209 was bitten by one round ago.
    expect(layers.length).toBeGreaterThan(0)
    for (const [, r, g, b] of layers) {
      expect(Math.max(Number(r), Number(g), Number(b))).toBeLessThan(64)
    }
  })

  it('leaves light’s key + ambient pair alone', () => {
    // R212 §7: "make the two themes consistent" is the tempting
    // generalization and would be a regression — light's shadow is the one
    // mechanism that works unaided, and CONCEPT.md §9.3 specifies its
    // two-layer structure (a sharp key shadow plus a soft ambient one).
    const value = declaredValue('light', '--elev-2-shadow')
    expect(value.match(/rgba\(/g)?.length).toBe(2)
  })

  it('keeps the pair’s first half doing the work in dark', () => {
    // Invariant 9: elevation is a *pair*. The shadow is the half with a
    // 1.171:1 ceiling in this theme, so the background step is not optional
    // — `--elev-2-bg` stepping back to `--surface-bg` would leave the tier
    // on its hairline alone.
    expect(declaredValue('dark', '--elev-2-bg')).not.toBe(declaredValue('dark', '--surface-bg'))
  })
})
