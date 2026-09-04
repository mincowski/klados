import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { NodeRef, ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import {
  collectColumns,
  collectGroupMembers,
  type GridColumn
} from '../src/renderer/components/Detail/gridColumns'
import {
  defaultColumnWidthPx,
  sampleColumnStats
} from '../src/renderer/components/Detail/gridColumnWidth'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  xmlFormatModule.parse(bytes, store, xmlOptions)
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

const ROOT = 0

function setup(text: string): {
  store: NodeStore
  source: SourceBuffer
  members: NodeRef[]
  columns: readonly GridColumn[]
} {
  const { store, source } = parseXml(text)
  const garage = store.firstChildOf(ROOT)
  const carNameId = store.nameIdOf(store.firstChildOf(garage))
  const members = collectGroupMembers(store, garage, carNameId)
  const columns = collectColumns(store, members).columns
  return { store, source, members, columns }
}

const CARS =
  '<garage>' +
  '<car><name>Golf</name><year>2019</year><engine><type>diesel</type></engine></car>' +
  '<car><name>Model 3</name><year>2023</year><engine><type>electric</type></engine></car>' +
  '<car><name>Panda</name><year>2011</year><engine><type>petrol</type></engine></car>' +
  '</garage>'

describe('sampleColumnStats (R43/D-071)', () => {
  it('agrees with isNumericColumn on numeric-ness', () => {
    const { store, source, members, columns } = setup(CARS)
    const year = columns.find((c) => store.textOf(c.nameId) === 'year')!
    const name = columns.find((c) => store.textOf(c.nameId) === 'name')!
    expect(sampleColumnStats(store, source, members, year).numeric).toBe(true)
    expect(sampleColumnStats(store, source, members, name).numeric).toBe(false)
  })

  it('maxContentChars reflects the longest sampled value, not just the first row', () => {
    const { store, source, members, columns } = setup(CARS)
    const name = columns.find((c) => store.textOf(c.nameId) === 'name')!
    // "Model 3" (7 chars) is the longest of "Golf"/"Model 3"/"Panda", and it
    // is not the first row — a width sample that stopped at row 0 would
    // report 4 (Golf's own length) instead.
    expect(sampleColumnStats(store, source, members, name).maxContentChars).toBe('Model 3'.length)
  })

  it('a mixed (non-numeric) column still gets a full width sample past the row that decided it', () => {
    // The first row's `id` value is non-numeric, so `isNumericColumn`'s own
    // early-exit would stop scanning immediately — the width sample must
    // not inherit that early exit, or every text column would be sized off
    // one row.
    const xml =
      '<rows>' +
      '<row><id>x</id></row>' +
      '<row><id>a much longer value than the first row</id></row>' +
      '</rows>'
    const { store, source } = parseXml(xml)
    const rows = store.firstChildOf(ROOT)
    const rowNameId = store.nameIdOf(store.firstChildOf(rows))
    const members = collectGroupMembers(store, rows, rowNameId)
    const columns = collectColumns(store, members).columns
    const id = columns.find((c) => store.textOf(c.nameId) === 'id')!

    const stats = sampleColumnStats(store, source, members, id)
    expect(stats.numeric).toBe(false)
    expect(stats.maxContentChars).toBe('a much longer value than the first row'.length)
  })

  it('an absent value on some rows does not count toward the width sample', () => {
    const xml = '<rows><row><id>1</id></row><row></row></rows>'
    const { store, source } = parseXml(xml)
    const rows = store.firstChildOf(ROOT)
    const rowNameId = store.nameIdOf(store.firstChildOf(rows))
    const members = collectGroupMembers(store, rows, rowNameId)
    const columns = collectColumns(store, members).columns
    const id = columns.find((c) => store.textOf(c.nameId) === 'id')!
    expect(sampleColumnStats(store, source, members, id).maxContentChars).toBe(1)
  })
})

describe('defaultColumnWidthPx (R43/D-071)', () => {
  it('a longer header than content still gets room for the header', () => {
    const short = defaultColumnWidthPx(2, { numeric: false, maxContentChars: 1 })
    const long = defaultColumnWidthPx(30, { numeric: false, maxContentChars: 1 })
    expect(long).toBeGreaterThan(short)
  })

  it('clamps to a floor for very short columns and a ceiling for very long ones', () => {
    const tiny = defaultColumnWidthPx(1, { numeric: false, maxContentChars: 1 })
    const huge = defaultColumnWidthPx(500, { numeric: false, maxContentChars: 500 })
    expect(tiny).toBeGreaterThanOrEqual(64)
    expect(huge).toBeLessThanOrEqual(320)
  })

  it('is monotonic in the longer of header/content length', () => {
    const narrow = defaultColumnWidthPx(4, { numeric: false, maxContentChars: 4 })
    const wide = defaultColumnWidthPx(4, { numeric: false, maxContentChars: 20 })
    expect(wide).toBeGreaterThan(narrow)
  })
})
