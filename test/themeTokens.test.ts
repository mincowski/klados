/**
 * D2 — CONCEPT.md §9.6 predicts theme rot because dark mode isn't a
 * user-facing v1 feature. This test is the automated half of the
 * mitigation: light.css and dark.css must define exactly the same set of
 * custom property names, so a token added to one and forgotten in the
 * other fails the suite instead of surfacing as a missing color at runtime.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES_DIR = join(__dirname, '../src/renderer/styles')

function tokenNames(cssPath: string): Set<string> {
  const css = readFileSync(cssPath, 'utf-8')
  const names = new Set<string>()
  for (const match of css.matchAll(/(^|[\s{;])(--[a-z0-9-]+)\s*:/gi)) {
    names.add(match[2]!)
  }
  return names
}

describe('theme token parity (D2)', () => {
  it('light.css and dark.css define exactly the same token names', () => {
    const light = tokenNames(join(STYLES_DIR, 'themes/light.css'))
    const dark = tokenNames(join(STYLES_DIR, 'themes/dark.css'))

    const onlyInLight = [...light].filter((t) => !dark.has(t))
    const onlyInDark = [...dark].filter((t) => !light.has(t))

    expect(onlyInLight, 'tokens defined in light.css but missing from dark.css').toEqual([])
    expect(onlyInDark, 'tokens defined in dark.css but missing from light.css').toEqual([])
    expect(light.size).toBeGreaterThan(0)
  })

  it('every token used by base.css is defined somewhere — a theme file or tokens.css', () => {
    // base.css draws on both categories: theme tokens (--surface-bg, colors)
    // from light.css/dark.css, and theme-agnostic structural tokens
    // (--font-ui, --row-height) declared directly in tokens.css.
    const light = tokenNames(join(STYLES_DIR, 'themes/light.css'))
    const structural = tokenNames(join(STYLES_DIR, 'tokens.css'))
    const defined = new Set([...light, ...structural])

    const base = readFileSync(join(STYLES_DIR, 'base.css'), 'utf-8')
    const used = [...base.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]!)
    expect(used.length).toBeGreaterThan(0)
    for (const token of used) {
      expect(defined.has(token), `${token} is used in base.css but not defined anywhere`).toBe(true)
    }
  })
})
