/**
 * R113–R116 (`R113-inactive-selection.md` §8) — a static-source guard, not
 * a rendered one: the sites enumerated in the plan's own §8 table read
 * `--focus-ring`/`--row-selected-bg` directly and must keep doing so, since
 * each is a toggle/hover/focus-visible affordance rather than a selection
 * that should dim when the keyboard leaves the pane. Lives in a `.test.ts`
 * (node project) because `node:fs` is externalized in the browser project's
 * Vite build — `test/inactiveSelection.test.tsx` covers the rendered half.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const gridCss = readFileSync('src/renderer/components/Detail/Grid.css', 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(gridCss)
  if (match === null) throw new Error(`rule not found: ${selector}`)
  return match[0]
}

describe('§8 — sites that deliberately do not participate stay on their original tokens', () => {
  it('.grid-quick-filter:focus-visible still reads --focus-ring, not --selection-ring', () => {
    const r = rule('.grid-quick-filter:focus-visible')
    expect(r).toContain('var(--focus-ring)')
    expect(r).not.toContain('--selection-ring')
  })

  it(".grid-filter-toggle[aria-pressed='true'] still reads --row-selected-bg, not --selection-bg", () => {
    const r = rule(".grid-filter-toggle[aria-pressed='true']")
    expect(r).toContain('var(--row-selected-bg)')
    expect(r).not.toContain('--selection-bg')
  })

  it('.grid-header-filter-active still reads --focus-ring, not --selection-ring', () => {
    const r = rule('.grid-header-filter-active')
    expect(r).toContain('var(--focus-ring)')
    expect(r).not.toContain('--selection')
  })

  it('.grid-header-resize-handle:hover still reads --focus-ring, not --selection-ring', () => {
    const r = rule('.grid-header-resize-handle:hover')
    expect(r).toContain('var(--focus-ring)')
    expect(r).not.toContain('--selection')
  })
})
