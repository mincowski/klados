import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import {
  collectColumns,
  collectGroupMembers,
  FieldKind,
  GRID_COLUMN_CAP,
  isRepeatingColumn,
  widestKind
} from '../src/renderer/components/Detail/gridColumns'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const jsonOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, xmlOptions)
  return { store }
}

function parseJson(text: string): { store: NodeStore } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  jsonFormatModule.parse(source, store, jsonOptions)
  return { store }
}

const ROOT = 0

// Appendix A's three cars, minus the wrapper levels (E2 already covers
// those) — one column set exercising every row of §4.3's cell table.
const APPENDIX_A_CARS =
  '<elements>' +
  '<car id="c-001" color="red">' +
  '<name>Golf</name><year>2019</year>' +
  '<engine><type>diesel</type><kw>110</kw></engine>' +
  '<owner>Smith</owner><owner>Jones</owner>' +
  '<sunroof/>' +
  '</car>' +
  '<car id="c-002" color="blue">' +
  '<name>Model 3</name><year>2023</year>' +
  '<engine><type>electric</type><kw>239</kw></engine>' +
  '<owner>Lee</owner>' +
  '</car>' +
  '<car id="c-003">' +
  '<name>Panda</name><year>2011</year>' +
  '<engine>petrol</engine>' +
  '<owner>Weber</owner>' +
  '</car>' +
  '</elements>'

describe('collectGroupMembers (M2-PLAN.md E3)', () => {
  it('collects only the composite children matching the group name id', () => {
    const { store } = parseXml(APPENDIX_A_CARS)
    const elements = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(elements))

    const members = collectGroupMembers(store, elements, carNameId)

    expect(members).toHaveLength(3)
    expect(members.every((m) => store.nameOf(m) === 'car')).toBe(true)
  })
})

describe('collectColumns (M2-PLAN.md E3)', () => {
  it("orders Appendix A's car columns by first appearance", () => {
    const { store } = parseXml(APPENDIX_A_CARS)
    const elements = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, carNameId)

    const { columns } = collectColumns(store, members)

    expect(columns.map((c) => store.textOf(c.nameId))).toEqual([
      'id',
      'color',
      'name',
      'year',
      'engine',
      'owner',
      'sunroof'
    ])
  })

  it('a field present on only one member still becomes a column, absent on the rest', () => {
    const { store } = parseXml(APPENDIX_A_CARS)
    const elements = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, carNameId)

    const { columns } = collectColumns(store, members)
    const color = columns.find((c) => store.textOf(c.nameId) === 'color')!
    const sunroof = columns.find((c) => store.textOf(c.nameId) === 'sunroof')!

    // color: c-001 and c-002 have it, c-003 doesn't.
    expect(color.frequency).toBe(2)
    // sunroof: only c-001 has it.
    expect(sunroof.frequency).toBe(1)
  })

  it('column order is stable across repeated calls on the same members', () => {
    const { store } = parseXml(APPENDIX_A_CARS)
    const elements = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, carNameId)

    const first = collectColumns(store, members).columns.map((c) => c.nameId)
    const second = collectColumns(store, members).columns.map((c) => c.nameId)
    expect(second).toEqual(first)
  })

  it('caps at GRID_COLUMN_CAP, dropping the least frequent fields to overflow', () => {
    // One member with 70 distinct fields, each appearing once — frequency
    // alone can't break the tie, so the cap must still produce exactly 60
    // kept + 10 overflow, deterministically.
    let xml = '<row>'
    for (let i = 0; i < 70; i++) xml += `<f${i}>v</f${i}>`
    xml += '</row>'
    const { store } = parseXml(xml)
    const row = store.firstChildOf(ROOT)

    const { columns, overflow } = collectColumns(store, [row])

    expect(columns.length + overflow.length).toBe(70)
    expect(columns).toHaveLength(GRID_COLUMN_CAP)
    expect(overflow).toHaveLength(70 - GRID_COLUMN_CAP)
  })

  it('a field repeating within one member counts once, as a repeating kind', () => {
    const { store } = parseXml(APPENDIX_A_CARS)
    const elements = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, carNameId)

    const { columns } = collectColumns(store, members)
    const owner = columns.find((c) => store.textOf(c.nameId) === 'owner')!

    // c-001 has owner×2 (one RepeatingScalarChild occurrence), c-002 and
    // c-003 have owner×1 each (ScalarChild) — frequency is 3 members, not 4.
    expect(owner.frequency).toBe(3)
    expect(owner.kindCounts[FieldKind.RepeatingScalarChild]).toBe(1)
    expect(owner.kindCounts[FieldKind.ScalarChild]).toBe(2)
  })

  it('widestKind reports composite when any row is composite for that column', () => {
    const { store } = parseXml(APPENDIX_A_CARS)
    const elements = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, carNameId)
    const { columns } = collectColumns(store, members)

    const engine = columns.find((c) => store.textOf(c.nameId) === 'engine')!
    // c-001/c-002 have composite <engine>, c-003 has a scalar one.
    expect(widestKind(engine)).toBe('composite')

    const name = columns.find((c) => store.textOf(c.nameId) === 'name')!
    expect(widestKind(name)).toBe('scalar')
  })

  it('isRepeatingColumn is true only for a field that repeats on some row', () => {
    const { store } = parseXml(APPENDIX_A_CARS)
    const elements = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, carNameId)
    const { columns } = collectColumns(store, members)

    expect(isRepeatingColumn(columns.find((c) => store.textOf(c.nameId) === 'owner')!)).toBe(true)
    expect(isRepeatingColumn(columns.find((c) => store.textOf(c.nameId) === 'name')!)).toBe(false)
  })

  it('an attribute wins a same-named-child collision on one member, deterministically', () => {
    const { store } = parseXml('<car color="red"><color>Blue</color></car>')
    const car = store.firstChildOf(ROOT)
    const { columns } = collectColumns(store, [car])

    expect(columns).toHaveLength(1)
    expect(columns[0]!.kindCounts[FieldKind.Attribute]).toBe(1)
    expect(columns[0]!.kindCounts[FieldKind.ScalarChild]).toBe(0)
  })

  it('the same document shape produces the same columns through XML and JSON', () => {
    const { store: xmlStore } = parseXml(APPENDIX_A_CARS)
    const xmlElements = xmlStore.firstChildOf(ROOT)
    const xmlCarId = xmlStore.nameIdOf(xmlStore.firstChildOf(xmlElements))
    const xmlMembers = collectGroupMembers(xmlStore, xmlElements, xmlCarId)
    const xmlColumns = collectColumns(xmlStore, xmlMembers).columns.map((c) =>
      xmlStore.textOf(c.nameId)
    )

    const jsonText =
      '{"items":[' +
      '{"id":"c-001","color":"red","name":"Golf"},' +
      '{"id":"c-002","color":"blue","name":"Model 3"},' +
      '{"id":"c-003","name":"Panda"}' +
      ']}'
    const { store: jsonStore } = parseJson(jsonText)
    const topObject = jsonStore.firstChildOf(ROOT)
    const itemsProperty = jsonStore.firstChildOf(topObject)
    const itemsArray = jsonStore.firstChildOf(itemsProperty)
    const jsonMembers = collectGroupMembers(jsonStore, itemsArray, -1) // array elements are unnamed
    const jsonColumns = collectColumns(jsonStore, jsonMembers).columns.map((c) =>
      jsonStore.textOf(c.nameId)
    )

    expect(jsonMembers).toHaveLength(3)
    expect(jsonColumns).toEqual(['id', 'color', 'name'])
    expect(xmlColumns.slice(0, 3)).toEqual(['id', 'color', 'name'])
  })
})
