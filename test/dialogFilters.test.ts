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
 * These are pure functions, which is the reason the filter-building lives here
 * rather than in the main process: the native dialog cannot be driven by a
 * test, but everything that decides what it shows can be.
 */
import { describe, expect, it } from 'vitest'
import {
  openDialogFilters,
  saveAsDialogFilters,
  getFormatCapabilities
} from '../src/formats/registry'

const ALL_FILES = { name: 'All files', extensions: ['*'] }

describe('saveAsDialogFilters — the file, not the format', () => {
  it('offers the extension the file already has, then All files', () => {
    expect(saveAsDialogFilters('data.json')).toEqual([
      { name: 'JSON files', extensions: ['json'] },
      ALL_FILES
    ])
  })

  it('carries through an extension this app has never heard of', () => {
    // The case that settled the design: an `.abc` file containing XML is
    // opened by content, and whoever named it `.abc` had a reason. Offering
    // `.xml`/`.xsd`/`.svg` there guesses at something the file already stated.
    expect(saveAsDialogFilters('payload.abc')).toEqual([
      { name: 'ABC files', extensions: ['abc'] },
      ALL_FILES
    ])
  })

  it('never offers a sibling extension the format merely also opens', () => {
    // CSV declares `.csv`, `.tsv` and `.tab`. A comma-delimited document must
    // not be offered `.tsv`: invariant 6 means Save writes the byte buffer
    // verbatim, so the result would be a file full of commas called `.tsv` —
    // a conversion implied and never performed.
    const filters = saveAsDialogFilters('export.csv')
    expect(filters).toHaveLength(2)
    expect(filters[0]?.extensions).toEqual(['csv'])
    expect(filters[0]?.extensions).not.toContain('tsv')
    expect(filters[0]?.extensions).not.toContain('tab')
  })

  it('keeps a .tsv file a .tsv file', () => {
    expect(saveAsDialogFilters('export.tsv')[0]?.extensions).toEqual(['tsv'])
  })

  it('offers All files alone when the file has no extension', () => {
    // No current ending to offer, and inventing the format's canonical one is
    // the same guess in smaller clothing.
    expect(saveAsDialogFilters('data')).toEqual([ALL_FILES])
  })

  it('treats a dotfile as having no extension', () => {
    // `.gitignore`'s leading dot names the file rather than typing it.
    expect(saveAsDialogFilters('.gitignore')).toEqual([ALL_FILES])
  })

  it('ignores a trailing dot', () => {
    expect(saveAsDialogFilters('export.')).toEqual([ALL_FILES])
  })

  it('normalizes case', () => {
    expect(saveAsDialogFilters('EXPORT.TSV')).toEqual([
      { name: 'TSV files', extensions: ['tsv'] },
      ALL_FILES
    ])
  })

  it('takes the last extension of a multi-dot name', () => {
    expect(saveAsDialogFilters('archive.tar.gz')[0]?.extensions).toEqual(['gz'])
  })

  it('never emits a leading dot — Electron matches nothing if it does', () => {
    for (const name of ['a.json', 'b.abc', 'c.TAR.GZ', 'd']) {
      for (const filter of saveAsDialogFilters(name)) {
        for (const extension of filter.extensions) {
          expect(extension.startsWith('.')).toBe(false)
        }
      }
    }
  })
})

describe('openDialogFilters — the formats, not the file', () => {
  // Open is the other question, and keeps the other answer: there is no
  // current file, so what it can show is exactly what the registry claims.
  it('offers every registered format, derived from the registry', () => {
    const [documents, all] = openDialogFilters()
    expect(documents?.extensions).toEqual(['xml', 'json', 'toml', 'csv', 'tsv', 'tab'])
    expect(all).toEqual(ALL_FILES)
  })

  it('names itself from the registered formats too', () => {
    expect(openDialogFilters()[0]?.name).toBe('XML/JSON/TOML/CSV documents')
  })

  it('claims exactly the extensions the formats declare, and no others', () => {
    // Asserted against the registry rather than against the literal
    // `main/documents.ts` used to hold, so registering a format updates this
    // without anyone editing a second place — the reason that literal went.
    const declared = new Set(
      ['xml', 'json', 'toml', 'csv'].flatMap(
        (id) => getFormatCapabilities(id)?.extensions.map((e) => e.replace(/^\./, '')) ?? []
      )
    )
    expect(new Set(openDialogFilters()[0]?.extensions)).toEqual(declared)
  })
})
