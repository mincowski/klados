/**
 * R98 (`R98-glyph-font-per-glyph.md` §2) — `glyphFontClass`, pure. `<>` is
 * the one marker Cascadia closes into a diamond at UI sizes (R98 §1); every
 * other marker `KIND_GLYPHS`/`FORMAT_GLYPHS` currently produce stays
 * `--font-mono`. The function is total (`glyph === '<>' ? … : …`), so a
 * glyph nobody has thought of yet can't fall through to `undefined` — the
 * definition-of-done concern this guards is a *silent* diamond regression:
 * a future glyph landing in `glyph-mono` by default rather than being
 * type-checked into oblivion, which is exactly the "resolves to a font
 * class" property asserted below for every glyph the app actually emits
 * today.
 */
import { describe, expect, it } from 'vitest'
import { NodeKind } from '../src/core/types'
import { glyphOf } from '../src/renderer/nodeDisplay'
import { formatGlyphOf } from '../src/renderer/components/TabStrip/tabDisplay'
import { glyphFontClass } from '../src/renderer/glyphFont'

// Every `NodeKind` member, spelled out rather than enumerated at runtime —
// `NodeKind` is a `const enum` (inlined, no runtime object to iterate), and
// `KIND_GLYPHS: Record<NodeKind, string>` in `nodeDisplay.ts` already makes
// TypeScript itself refuse to compile if a member here is missing a glyph;
// this list exists so this test also breaks (not silently passes) if a
// kind is ever added without its glyph's font being checked here too.
const ALL_KINDS: readonly NodeKind[] = [
  NodeKind.Document,
  NodeKind.Element,
  NodeKind.Object,
  NodeKind.Array,
  NodeKind.Property,
  NodeKind.Scalar,
  NodeKind.Text,
  NodeKind.CData,
  NodeKind.Comment,
  NodeKind.ProcessingInstruction,
  NodeKind.DocType
]

const ALL_FORMAT_IDS: readonly (string | null)[] = ['xml', 'json', 'toml', null, 'unknown-format']

describe('glyphFontClass (R98)', () => {
  it('<> alone resolves to glyph-ui', () => {
    expect(glyphFontClass('<>')).toBe('glyph-ui')
  })

  it('every other marker resolves to glyph-mono', () => {
    for (const marker of ['{}', '[]', 'D', ':', '"', '¶', '#', '?', '!', '—']) {
      expect(glyphFontClass(marker)).toBe('glyph-mono')
    }
  })

  it('every KIND_GLYPHS entry (via glyphOf) resolves to a font class, and only <> is glyph-ui', () => {
    for (const kind of ALL_KINDS) {
      const glyph = glyphOf(kind)
      const cls = glyphFontClass(glyph)
      expect(['glyph-ui', 'glyph-mono']).toContain(cls)
      expect(cls).toBe(glyph === '<>' ? 'glyph-ui' : 'glyph-mono')
    }
  })

  it('every FORMAT_GLYPHS entry (via formatGlyphOf) resolves to a font class, and only <> is glyph-ui', () => {
    for (const formatId of ALL_FORMAT_IDS) {
      const { glyph } = formatGlyphOf(formatId)
      const cls = glyphFontClass(glyph)
      expect(['glyph-ui', 'glyph-mono']).toContain(cls)
      expect(cls).toBe(glyph === '<>' ? 'glyph-ui' : 'glyph-mono')
    }
  })
})
