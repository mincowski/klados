import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { NodeRef, ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { cellOf } from '../src/renderer/components/Detail/gridCell'
import {
  collectColumns,
  collectGroupMembers,
  type GridColumn
} from '../src/renderer/components/Detail/gridColumns'
import {
  isColumnSortable,
  isNumericColumn,
  sortByColumn
} from '../src/renderer/components/Detail/gridSort'

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
  '<car><name>Golf</name><year>2019</year><engine><type>diesel</type></engine></car>' +
  '<car><name>Model 3</name><year>2023</year><engine><type>electric</type></engine></car>' +
  '<car><name>Panda</name><year>2011</year><engine><type>petrol</type></engine></car>' +
  '</garage>'

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

describe('isColumnSortable (M2-PLAN.md E6)', () => {
  it('a scalar column is sortable', () => {
    const { store, columns } = setup(CARS)
    const name = columns.find((c) => store.textOf(c.nameId) === 'name')!
    expect(isColumnSortable(name)).toBe(true)
  })

  it('a composite column is not sortable', () => {
    const { store, columns } = setup(CARS)
    const engine = columns.find((c) => store.textOf(c.nameId) === 'engine')!
    expect(isColumnSortable(engine)).toBe(false)
  })
})

describe('isNumericColumn (M2-PLAN.md E6/E5)', () => {
  it('a column of numeric text is numeric', () => {
    const { store, source, members, columns } = setup(CARS)
    const year = columns.find((c) => store.textOf(c.nameId) === 'year')!
    expect(isNumericColumn(store, source, members, year)).toBe(true)
  })

  it('a column of non-numeric text is not numeric', () => {
    const { store, source, members, columns } = setup(CARS)
    const name = columns.find((c) => store.textOf(c.nameId) === 'name')!
    expect(isNumericColumn(store, source, members, name)).toBe(false)
  })
})

describe('sortByColumn (M2-PLAN.md E6)', () => {
  it('sorts a numeric column ascending/descending by value, not lexicographically', () => {
    const { store, source, members, columns } = setup(CARS)
    const year = columns.find((c) => store.textOf(c.nameId) === 'year')!
    const identity = members.map((_, i) => i)

    const asc = sortByColumn(store, source, members, identity, year, 'asc', true)
    expect(asc.map((i) => textAt(store, source, members, i, year))).toEqual([
      '2011',
      '2019',
      '2023'
    ])

    const desc = sortByColumn(store, source, members, identity, year, 'desc', true)
    expect(desc).toEqual([...asc].reverse())
  })

  it('sorts a string column lexicographically', () => {
    const { store, source, members, columns } = setup(CARS)
    const name = columns.find((c) => store.textOf(c.nameId) === 'name')!
    const identity = members.map((_, i) => i)

    const asc = sortByColumn(store, source, members, identity, name, 'asc', false)
    const names = asc.map((i) => textAt(store, source, members, i, name))
    expect(names).toEqual(['Golf', 'Model 3', 'Panda'])
  })

  it('does not mutate members — sorting is a permutation of indices only', () => {
    const { store, source, members, columns } = setup(CARS)
    const name = columns.find((c) => store.textOf(c.nameId) === 'name')!
    const before = [...members]
    sortByColumn(store, source, members, [0, 1, 2], name, 'desc', false)
    expect(members).toEqual(before)
  })

  it('sorts absent cells last regardless of direction', () => {
    const { store, source } = parseXml(
      '<garage>' +
        '<car><name>Golf</name><color>red</color></car>' +
        '<car><name>Polo</name></car>' +
        '<car><name>Panda</name><color>blue</color></car>' +
        '</garage>'
    )
    const garage = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(garage))
    const members = collectGroupMembers(store, garage, carNameId)
    const columns = collectColumns(store, members).columns
    const color = columns.find((c) => store.textOf(c.nameId) === 'color')!
    const identity = members.map((_, i) => i)

    const asc = sortByColumn(store, source, members, identity, color, 'asc', false)
    const desc = sortByColumn(store, source, members, identity, color, 'desc', false)
    // Polo (index 1) has no color — last in both directions.
    expect(asc[asc.length - 1]).toBe(1)
    expect(desc[desc.length - 1]).toBe(1)
  })
})

function textAt(
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[],
  i: number,
  column: GridColumn
): string | null {
  return cellOf(store, source, members[i]!, column.nameId).text
}

// `isNumericColumn` decides text alignment, nothing more — so it samples
// rather than scanning every member. Exhaustive scanning cost 1522 ms on
// cars-200mb.xml, more than half the grid's whole time to first paint, and
// the worst a wrong answer can do is right-align a column that should have
// been left-aligned.
describe('isNumericColumn sampling (M2 review)', () => {
  function manyCars(count: number, valueAt: (i: number) => string): string {
    let xml = '<garage>'
    for (let i = 0; i < count; i++) xml += `<car><n>${valueAt(i)}</n></car>`
    return xml + '</garage>'
  }

  it('stops after the value sample rather than reading every member', () => {
    // Numeric for the first 300 rows, textual afterwards. A full scan would
    // say "not numeric"; the sample says "numeric" — the documented, accepted
    // trade-off, asserted so a future change to it is deliberate.
    const { store, source, members, columns } = setup(
      manyCars(600, (i) => (i < 300 ? String(i) : 'x'))
    )
    expect(members).toHaveLength(600)
    expect(isNumericColumn(store, source, members, columns[0]!, 200)).toBe(true)
    // With a sample larger than the numeric prefix, the textual tail is
    // reached and the answer flips — which is what proves it is the sample
    // bound doing the work, not some other early exit.
    expect(isNumericColumn(store, source, members, columns[0]!, 400)).toBe(false)
  })

  it('still rejects a column whose very first value is non-numeric', () => {
    const { store, source, members, columns } = setup(
      manyCars(50, (i) => (i === 0 ? 'x' : String(i)))
    )
    expect(isNumericColumn(store, source, members, columns[0]!)).toBe(false)
  })

  it('a column with no present values anywhere is not numeric', () => {
    const { store, source, members, columns } = setup(
      '<garage><car><a>1</a></car><car><a>2</a></car></garage>'
    )
    const absent: GridColumn = { ...columns[0]!, nameId: 999_999 }
    expect(isNumericColumn(store, source, members, absent)).toBe(false)
  })
})
