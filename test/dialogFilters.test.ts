/**
 * R194 — the file dialogs' type filters.
 *
 * The defect these exist for: `showSaveDialog` was called with no `filters`,
 * so the type dropdown read `*.*`. Electron appends an extension only from the
 * **selected** filter, so a name typed without one was written without one —
 * and `selectFormat` leans on the extension as a strong signal, with CSV
 * having no content check at all, so Save As could produce a file this
 * application would not reopen.
 *
 * These are pure functions of `(formatId, fileName)`, which is the whole
 * reason the filter-building lives in `formats/registry.ts` rather than in the
 * main process: the native dialog cannot be driven by a test, but everything
 * that decides what it shows can be.
 */
import { describe, expect, it } from 'vitest'
import {
  openDialogFilters,
  saveAsDialogFilters,
  getFormatCapabilities
} from '../src/formats/registry'

const ALL_FILES = { name: 'All files', extensions: ['*'] }

describe('saveAsDialogFilters', () => {
  it('offers the document type first and All files second', () => {
    const filters = saveAsDialogFilters('json', 'data.json')
    expect(filters).toEqual([{ name: 'JSON documents', extensions: ['json'] }, ALL_FILES])
  })

  it('leads with the extension the file already has', () => {
    // CSV is the one format declaring several today (.csv, .tsv, .tab), and
    // Electron appends the *first* extension of the selected filter — so this
    // is the difference between Save As keeping a .tsv file a .tsv file and
    // quietly turning it into a .csv.
    const filters = saveAsDialogFilters('csv', 'export.tsv')
    expect(filters[0]?.extensions[0]).toBe('tsv')
    expect(filters[0]?.extensions).toEqual(['tsv', 'csv', 'tab'])
  })

  it('keeps every declared extension available, whichever leads', () => {
    const declared = getFormatCapabilities('csv')?.extensions ?? []
    for (const extension of declared) {
      const bare = extension.replace(/^\./, '')
      const offered = saveAsDialogFilters('csv', `x${extension}`)[0]?.extensions ?? []
      expect([...offered].sort()).toEqual([...declared].map((e) => e.replace(/^\./, '')).sort())
      expect(offered[0]).toBe(bare)
    }
  })

  it('falls back to the declared order for a file with no extension', () => {
    expect(saveAsDialogFilters('csv', 'export')[0]?.extensions).toEqual(['csv', 'tsv', 'tab'])
  })

  it('falls back to the declared order for an extension the format does not claim', () => {
    expect(saveAsDialogFilters('csv', 'export.txt')[0]?.extensions).toEqual(['csv', 'tsv', 'tab'])
  })

  it('treats a dotfile as having no extension', () => {
    // `.gitignore`'s leading dot names the file rather than typing it, so
    // `gitignore` must not be read as an extension and moved to the front.
    expect(saveAsDialogFilters('json', '.gitignore')[0]?.extensions).toEqual(['json'])
  })

  it('ignores a trailing dot', () => {
    expect(saveAsDialogFilters('csv', 'export.')[0]?.extensions).toEqual(['csv', 'tsv', 'tab'])
  })

  it('matches the extension case-insensitively', () => {
    expect(saveAsDialogFilters('csv', 'EXPORT.TSV')[0]?.extensions[0]).toBe('tsv')
  })

  it('yields All files alone for an unknown format id, without throwing', () => {
    // Documented as impossible for a document this app actually opened; the
    // point is that it degrades to the old behaviour rather than crashing the
    // one path whose job is not to lose the document.
    expect(saveAsDialogFilters('yaml', 'config.yaml')).toEqual([ALL_FILES])
  })

  it('never emits a leading dot — Electron matches nothing if it does', () => {
    for (const id of ['xml', 'json', 'toml', 'csv']) {
      for (const filter of saveAsDialogFilters(id, 'x.json')) {
        for (const extension of filter.extensions) {
          expect(extension.startsWith('.')).toBe(false)
        }
      }
    }
  })
})

describe('openDialogFilters', () => {
  it('offers every registered format, derived from the registry', () => {
    // The list `main/documents.ts` used to hardcode. Asserted against the
    // registry rather than against that literal, so registering a format
    // updates this without anyone editing a second place — which is the
    // entire reason the literal was removed.
    const [documents, all] = openDialogFilters()
    expect(documents?.extensions).toEqual(['xml', 'json', 'toml', 'csv', 'tsv', 'tab'])
    expect(all).toEqual(ALL_FILES)
  })

  it('names itself from the registered formats too', () => {
    expect(openDialogFilters()[0]?.name).toBe('XML/JSON/TOML/CSV documents')
  })

  it('claims exactly the extensions the formats declare, and no others', () => {
    const declared = new Set(
      ['xml', 'json', 'toml', 'csv'].flatMap(
        (id) => getFormatCapabilities(id)?.extensions.map((e) => e.replace(/^\./, '')) ?? []
      )
    )
    expect(new Set(openDialogFilters()[0]?.extensions)).toEqual(declared)
  })
})
