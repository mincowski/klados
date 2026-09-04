import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import {
  collectColumns,
  collectGroupMembers,
  type GridColumn
} from '../src/renderer/components/Detail/gridColumns'
import { EMPTY_GRID_FILTERS, filterIndices } from '../src/renderer/components/Detail/gridFilter'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  xmlFormatModule.parse(bytes, store, xmlOptions)
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

const ROOT = 0

const CARS =
  '<garage>' +
  '<car><name>Golf</name><color>red</color></car>' +
  '<car><name>Model 3</name><color>blue</color></car>' +
  '<car><name>Panda</name></car>' +
  '</garage>'

function setup(text: string): {
  store: NodeStore
  source: SourceBuffer
  members: number[]
  columns: readonly GridColumn[]
} {
  const { store, source } = parseXml(text)
  const garage = store.firstChildOf(ROOT)
  const carNameId = store.nameIdOf(store.firstChildOf(garage))
  const members = collectGroupMembers(store, garage, carNameId)
  const columns = collectColumns(store, members).columns
  return { store, source, members, columns }
}

describe('filterIndices (M2-PLAN.md E7)', () => {
  it('returns every row, in document order, with no filters', () => {
    const { store, source, members, columns } = setup(CARS)
    expect(filterIndices(store, source, members, columns, EMPTY_GRID_FILTERS).indices).toEqual([
      0, 1, 2
    ])
  })

  it('quick filter narrows to rows matching any column, case-insensitively', () => {
    const { store, source, members, columns } = setup(CARS)
    const result = filterIndices(store, source, members, columns, {
      quick: 'BLUE',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([1])
  })

  it('quick filter matches across different columns', () => {
    const { store, source, members, columns } = setup(CARS)
    // "panda" matches the name column on row 2, "red" matches color on row 0.
    const result = filterIndices(store, source, members, columns, {
      quick: 'pand',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([2])
  })

  it('per-column filter narrows to rows whose specific column matches', () => {
    const { store, source, members, columns } = setup(CARS)
    const colorId = columns.find((c) => store.textOf(c.nameId) === 'color')!.nameId
    const result = filterIndices(store, source, members, columns, {
      quick: '',
      perColumn: new Map([[colorId, 'red']])
    })
    expect(result.indices).toEqual([0])
  })

  it('a row absent from a filtered column never matches that column filter', () => {
    const { store, source, members, columns } = setup(CARS)
    const colorId = columns.find((c) => store.textOf(c.nameId) === 'color')!.nameId
    // Panda (row 2) has no color at all — must not match any substring.
    const result = filterIndices(store, source, members, columns, {
      quick: '',
      perColumn: new Map([[colorId, '']])
    })
    // Empty per-column filter text is treated as "no filter" (trimmed to
    // nothing), so this should behave like EMPTY_GRID_FILTERS.
    expect(result.indices).toEqual([0, 1, 2])
  })

  it('multiple per-column filters combine with AND', () => {
    const { store, source, members, columns } = setup(CARS)
    const nameId = columns.find((c) => store.textOf(c.nameId) === 'name')!.nameId
    const colorId = columns.find((c) => store.textOf(c.nameId) === 'color')!.nameId
    const result = filterIndices(store, source, members, columns, {
      quick: '',
      perColumn: new Map([
        [nameId, 'golf'],
        [colorId, 'blue']
      ])
    })
    expect(result.indices).toEqual([]) // no row is both named Golf and colored blue
  })

  it('preserves document order in a non-contiguous surviving subset', () => {
    const { store, source } = parseXml(
      '<garage>' +
        '<car><name>Golf</name><color>red</color></car>' +
        '<car><name>Model 3</name><color>blue</color></car>' +
        '<car><name>Panda</name><color>red</color></car>' +
        '</garage>'
    )
    const garage = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(garage))
    const members = collectGroupMembers(store, garage, carNameId)
    const columns = collectColumns(store, members).columns

    // Rows 0 and 2 are red, row 1 is blue — the surviving subset skips the
    // middle row, so [0, 2] (not [2, 0]) is the only order that's still
    // "document order."
    const result = filterIndices(store, source, members, columns, {
      quick: 'red',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([0, 2])
  })
})

// R34 §5: the quick filter is scoped to visible columns, but reports what it
// excluded rather than silently narrowing "matches anywhere" to "matches in
// the columns I happen to be showing."
describe('filterIndices hidden-match reporting (R34 §5)', () => {
  it('a match confined to a column outside the visible set is excluded but counted', () => {
    const { store, source, members, columns } = setup(CARS)
    // "color" carries the only "red"/"blue" — drop it from the visible set,
    // as if it had scrolled past GRID_COLUMN_CAP or been unticked.
    const visibleColumns = columns.filter((c) => store.textOf(c.nameId) !== 'color')
    const result = filterIndices(store, source, members, visibleColumns, {
      quick: 'blue',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([])
    expect(result.hiddenMatchCount).toBe(1)
    expect(result.hiddenMatchColumns.map((id) => store.textOf(id))).toEqual(['color'])
  })

  it('a row matching both a visible and a hidden column counts as a visible match, not hidden', () => {
    const { store, source, members, columns } = setup(CARS)
    const visibleColumns = columns.filter((c) => store.textOf(c.nameId) !== 'color')
    // "red" is only in "color" here, so this exercises the hidden-only path;
    // give it a query that also matches the visible "name" column instead.
    const result = filterIndices(store, source, members, visibleColumns, {
      quick: 'golf',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([0])
    expect(result.hiddenMatchCount).toBe(0)
  })

  it('reports zero hidden matches when every match is already visible', () => {
    const { store, source, members, columns } = setup(CARS)
    const result = filterIndices(store, source, members, columns, {
      quick: 'blue',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([1])
    expect(result.hiddenMatchCount).toBe(0)
    expect(result.hiddenMatchColumns).toEqual([])
  })
})
