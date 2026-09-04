/**
 * R98 (`R98-glyph-font-per-glyph.md` §2): which font a marker glyph draws
 * in is a property of the glyph string itself, not of the surface it's
 * rendered on. Cascadia (`--font-mono`'s second entry, matched ahead of
 * `Consolas`) draws `<>`'s two chevrons meeting at a point at UI sizes —
 * one font's letterform, not a property of monospace in general (measured:
 * the same string in Consolas renders open) — so `<>` alone needs
 * `--font-ui` instead. Every other marker (`{}`, `[]`, `D`, `:`, `"`, `¶`,
 * `#`, `?`, `!`) keeps `--font-mono`, exactly where R83 measured it.
 *
 * Keyed on the glyph string rather than on `NodeKind` or a format id: both
 * `KIND_GLYPHS` (`nodeDisplay.ts`) and `FORMAT_GLYPHS` (`tabDisplay.ts`)
 * independently emit `<>`, and a string-keyed rule serves both without
 * adding a second format-id switch to the renderer (invariant 8's own
 * concern — that existing switch inside `formatGlyphOf` predates this round
 * and is left alone).
 */
export type GlyphFontClass = 'glyph-ui' | 'glyph-mono'

export function glyphFontClass(glyph: string): GlyphFontClass {
  return glyph === '<>' ? 'glyph-ui' : 'glyph-mono'
}
