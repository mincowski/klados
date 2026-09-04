/**
 * R71 (`R71-text-as-icons.md` §2, acceptance 2) — "no component
 * renders a codepoint outside Basic Latin, Latin-1 Supplement and General
 * Punctuation," except the deferred (per-row/per-column, §4b) and data
 * (§4a) glyphs the plan enumerates explicitly. A source-text scan, not a
 * rendered-DOM one — checkable without mounting every component that could
 * ever draw a glyph, and it's what stops the next `ⓘ` from being added
 * quietly (§2's own stated purpose).
 *
 * Comments are stripped before scanning — this file's own comments (and
 * every other file that discusses *why* a glyph was replaced) legitimately
 * quote the very codepoints being disallowed. A naive line-comment/block-
 * comment strip is good enough for this codebase's actual style: no
 * regex literals containing `//`, no `/*` inside a string literal that
 * would matter here. After stripping, any surviving out-of-range character
 * is inside a string or JSX text node, since every identifier in this
 * codebase is plain ASCII.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER_ROOT = join(__dirname, '..', 'src', 'renderer')

const ALLOWED_RANGES: readonly [number, number][] = [
  [0x00, 0x7f], // Basic Latin
  [0x80, 0xff], // Latin-1 Supplement
  [0x2000, 0x206f] // General Punctuation
]

function isAllowed(codepoint: number): boolean {
  return ALLOWED_RANGES.some(([lo, hi]) => codepoint >= lo && codepoint <= hi)
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p, out)
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      out.push(p)
    }
  }
  return out
}

/** §3/§4's own table: file (relative to `src/renderer`) → the exact
 * out-of-range characters that file is allowed to contain, and why.
 * Enumerated per file rather than a blanket exemption, so a *new*
 * out-of-range character in one of these files still fails — only the
 * specific glyphs the plan already accounted for are excused. */
const ALLOWED_VIOLATIONS: Readonly<Record<string, readonly string[]>> = {
  // §4b: Tree's disclosure twisty — per-row, deferred.
  'components/Tree/Tree.tsx': ['▾', '▸'],
  // §4b: Grid's sort/pin/drill marks — per-column/per-row, deferred.
  'components/Detail/Grid.tsx': ['▲', '▼', '◆', '◇', '●', '▸', '✓'],
  // §4a: the presence marker is exported *data*, not chrome — D-068.
  'components/Detail/gridExport.ts': ['✓']
}

describe('R71 §2 acceptance 2 — no component renders a disallowed codepoint', () => {
  const files = walk(RENDERER_ROOT, [])
  expect(files.length).toBeGreaterThan(50) // sanity: the walk actually found the tree

  for (const file of files) {
    const relative = file.slice(RENDERER_ROOT.length + 1).replace(/\\/g, '/')
    it(`${relative} has no unaccounted-for symbol-block codepoint`, () => {
      const stripped = stripComments(readFileSync(file, 'utf8'))
      const allowed = new Set(ALLOWED_VIOLATIONS[relative] ?? [])
      const unexpected = new Set<string>()
      for (const char of stripped) {
        const codepoint = char.codePointAt(0)!
        if (codepoint <= 0xff) continue // fast path — most of every file
        if (isAllowed(codepoint) || allowed.has(char)) continue
        unexpected.add(`${char} (U+${codepoint.toString(16).toUpperCase()})`)
      }
      expect([...unexpected]).toEqual([])
    })
  }
})
