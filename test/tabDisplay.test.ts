/**
 * R25 (`R24-tabs.md` §3) — the tab strip's pure logic: deriving what
 * a tab shows from its session's phase, the format-glyph map, and the
 * same-name disambiguation rule.
 */
import { describe, expect, it } from 'vitest'
import type { DocumentSessionState } from '../src/renderer/session/documentSession'
import {
  formatGlyphOf,
  tabDisplayInfoOf,
  tabLabelsOf
} from '../src/renderer/components/TabStrip/tabDisplay'

describe('tabDisplayInfoOf', () => {
  it('empty and error phases carry no document info', () => {
    expect(tabDisplayInfoOf({ phase: 'empty' })).toEqual({
      fileName: null,
      filePath: null,
      formatId: null,
      dirty: false
    })
    expect(tabDisplayInfoOf({ phase: 'error', message: 'boom' })).toEqual({
      fileName: null,
      filePath: null,
      formatId: null,
      dirty: false
    })
  })

  it('parsing/confirmSize carry a fileName but no path or format yet', () => {
    const parsing: DocumentSessionState = {
      phase: 'parsing',
      fileName: 'data.xml',
      bytesConsumed: 0,
      totalBytes: 100
    }
    expect(tabDisplayInfoOf(parsing)).toEqual({
      fileName: 'data.xml',
      filePath: null,
      formatId: null,
      dirty: false
    })
  })

  it('ready carries the full document info, including dirty', () => {
    const ready = {
      phase: 'ready',
      document: {
        fileName: 'data.xml',
        filePath: 'C:/docs/data.xml',
        formatId: 'xml',
        dirty: true
      },
      selection: { selectedNode: 0, caretOffset: 0 }
    } as unknown as Extract<DocumentSessionState, { phase: 'ready' }>
    expect(tabDisplayInfoOf(ready)).toEqual({
      fileName: 'data.xml',
      filePath: 'C:/docs/data.xml',
      formatId: 'xml',
      dirty: true
    })
  })
})

describe('formatGlyphOf', () => {
  it('maps each known format to its own glyph and color token', () => {
    expect(formatGlyphOf('xml').glyph).toBe('<>')
    expect(formatGlyphOf('json').glyph).toBe('{}')
    // R71 (`R71-text-as-icons.md` §5a): was `'[ ]'` — the space did
    // nothing once `.tab-icon` became a fixed-width centred box, and
    // disagreed with `nodeDisplay.ts`'s own `'[]'` for the same format.
    expect(formatGlyphOf('toml').glyph).toBe('[]')
  })

  it('falls back to a neutral glyph for an unknown or absent format', () => {
    expect(formatGlyphOf(null).colorVar).toBe('var(--surface-fg-secondary)')
    expect(formatGlyphOf('yaml').colorVar).toBe('var(--surface-fg-secondary)')
  })

  it('every known format gets a visually distinct color token', () => {
    const vars = new Set(['xml', 'json', 'toml'].map((id) => formatGlyphOf(id).colorVar))
    expect(vars.size).toBe(3)
  })
})

describe('tabLabelsOf', () => {
  it('uses the plain filename when there is no collision', () => {
    const labels = tabLabelsOf([
      { id: 'a', fileName: 'data.xml', filePath: 'C:/docs/data.xml' },
      { id: 'b', fileName: 'other.json', filePath: 'C:/docs/other.json' }
    ])
    expect(labels).toEqual([
      { id: 'a', text: 'data.xml' },
      { id: 'b', text: 'other.json' }
    ])
  })

  it('disambiguates same-name tabs with the parent directory (CONCEPT.md §11.4)', () => {
    const labels = tabLabelsOf([
      { id: 'a', fileName: 'config.yaml', filePath: 'C:/proj/data/config.yaml' },
      { id: 'b', fileName: 'config.yaml', filePath: 'C:/proj/test/config.yaml' }
    ])
    expect(labels).toEqual([
      { id: 'a', text: 'data/config.yaml' },
      { id: 'b', text: 'test/config.yaml' }
    ])
  })

  it('a tab with no document yet (empty or error) gets a placeholder label', () => {
    const labels = tabLabelsOf([{ id: 'a', fileName: null, filePath: null }])
    expect(labels).toEqual([{ id: 'a', text: 'New Tab' }])
  })

  it('a colliding name with no path falls back to the bare filename', () => {
    const labels = tabLabelsOf([
      { id: 'a', fileName: 'x.json', filePath: null },
      { id: 'b', fileName: 'x.json', filePath: 'C:/docs/x.json' }
    ])
    expect(labels[0]).toEqual({ id: 'a', text: 'x.json' })
  })
})
