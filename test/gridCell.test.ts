import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { CellKind, cellOf } from '../src/renderer/components/Detail/gridCell'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const jsonOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  xmlFormatModule.parse(bytes, store, xmlOptions)
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

function parseJson(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  jsonFormatModule.parse(bytes, store, jsonOptions)
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

const ROOT = 0

function namedChildId(store: NodeStore, node: number, name: string): number {
  for (const child of store.childrenOf(node)) {
    if (store.nameOf(child) === name) return store.nameIdOf(child)
  }
  throw new Error(`no child named ${name}`)
}

describe("cellOf (M2-PLAN.md E4, §4.3's cell table)", () => {
  it('attribute → literal', () => {
    const { store, source } = parseXml('<car color="red"/>')
    const car = store.firstChildOf(ROOT)
    const colorId = [...store.attributesOf(car)][0]!.nameId

    const cell = cellOf(store, source, car, colorId)
    expect(cell.kind).toBe(CellKind.Literal)
    expect(cell.text).toBe('red')
    expect(cell.multiplicity).toBe(1)
    // An attribute isn't an independent node — nothing for E9's "activate
    // a cell" to select but the row itself.
    expect(cell.node).toBeNull()
  })

  it('scalar child (folded value) → literal, with its own node for activation (E9)', () => {
    const { store, source } = parseXml('<car><name>Golf</name></car>')
    const car = store.firstChildOf(ROOT)
    const name = store.firstChildOf(car)
    const nameNameId = store.nameIdOf(name)

    const cell = cellOf(store, source, car, nameNameId)
    expect(cell.kind).toBe(CellKind.Literal)
    expect(cell.text).toBe('Golf')
    expect(cell.node).toBe(name)
  })

  it('empty element → derived presence marker (no text)', () => {
    const { store, source } = parseXml('<car><sunroof/></car>')
    const car = store.firstChildOf(ROOT)
    const sunroof = store.firstChildOf(car)
    const sunroofNameId = store.nameIdOf(sunroof)

    const cell = cellOf(store, source, car, sunroofNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.text).toBeNull()
    expect(cell.multiplicity).toBe(1)
  })

  it('composite child → derived summary with a drill-in target', () => {
    const { store, source } = parseXml(
      '<car><engine><type>diesel</type><kw>110</kw></engine></car>'
    )
    const car = store.firstChildOf(ROOT)
    const engine = store.firstChildOf(car)
    const engineNameId = store.nameIdOf(engine)

    const cell = cellOf(store, source, car, engineNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.text).toBe('diesel · 110')
    expect(cell.node).toBe(engine)
    expect(cell.mixed).toBe(false)
  })

  it('a scalar-folded engine on another row renders literal, same column', () => {
    // §4.3: "Kind is per cell, not per column" — <engine>petrol</engine>
    // in one row must render literal even though `engine` is composite on
    // other rows.
    const { store, source } = parseXml('<car><engine>petrol</engine></car>')
    const car = store.firstChildOf(ROOT)
    const engine = store.firstChildOf(car)
    const engineNameId = store.nameIdOf(engine)

    const cell = cellOf(store, source, car, engineNameId)
    expect(cell.kind).toBe(CellKind.Literal)
    expect(cell.text).toBe('petrol')
  })

  it('repeated scalar → derived, joined and dimmed, with the real multiplicity', () => {
    const { store, source } = parseXml('<car><owner>Smith</owner><owner>Jones</owner></car>')
    const car = store.firstChildOf(ROOT)
    const owner = store.firstChildOf(car)
    const ownerNameId = store.nameIdOf(owner)

    const cell = cellOf(store, source, car, ownerNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.text).toBe('Smith, Jones')
    expect(cell.multiplicity).toBe(2)
  })

  it('a single owner is literal, not dimmed — multiplicity alone decides it', () => {
    const { store, source } = parseXml('<car><owner>Lee</owner></car>')
    const car = store.firstChildOf(ROOT)
    const owner = store.firstChildOf(car)
    const ownerNameId = store.nameIdOf(owner)

    const cell = cellOf(store, source, car, ownerNameId)
    expect(cell.kind).toBe(CellKind.Literal)
    expect(cell.text).toBe('Lee')
  })

  it('repeated composite → derived "N items", no drill-in', () => {
    const { store, source } = parseXml(
      '<car><part><sku>A</sku></part><part><sku>B</sku></part><part><sku>C</sku></part></car>'
    )
    const car = store.firstChildOf(ROOT)
    const part = store.firstChildOf(car)
    const partNameId = store.nameIdOf(part)

    const cell = cellOf(store, source, car, partNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.text).toBe('3 items')
    expect(cell.multiplicity).toBe(3)
    expect(cell.node).toBeNull()
  })

  it('mixed content → derived, its own text, marked mixed', () => {
    const { store, source } = parseXml('<car><desc>a <b>x</b></desc></car>')
    const car = store.firstChildOf(ROOT)
    const desc = store.firstChildOf(car)
    const descNameId = store.nameIdOf(desc)

    const cell = cellOf(store, source, car, descNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.mixed).toBe(true)
    expect(cell.text).toBe('a')
  })

  it('absent → no text, zero multiplicity', () => {
    const { store, source } = parseXml('<car><name>Golf</name></car>')
    const car = store.firstChildOf(ROOT)
    const unrelated = 999999 // an id never interned for this document

    const cell = cellOf(store, source, car, unrelated)
    expect(cell.kind).toBe(CellKind.Absent)
    expect(cell.text).toBeNull()
    expect(cell.multiplicity).toBe(0)
  })

  it('a JSON array-valued property renders identically to XML repeating elements', () => {
    // JSON has no direct equivalent of repeating sibling Elements — a
    // repeated field is always one Property whose value is a single Array
    // node (D-030). Unwrapping that Array's own elements as the
    // occurrences is what makes this match XML's <owner>Smith</owner>
    // <owner>Jones</owner> rather than rendering as a one-off composite
    // summary of a Property with "1 field" (the Array itself).
    const { store, source } = parseJson('{"owner":["Smith","Jones"]}')
    const car = store.firstChildOf(ROOT)
    const owner = store.firstChildOf(car)
    const ownerNameId = store.nameIdOf(owner)

    const cell = cellOf(store, source, car, ownerNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.text).toBe('Smith, Jones')
    expect(cell.multiplicity).toBe(2)
  })

  it('a JSON array with one element renders literal, not dimmed (multiplicity 1)', () => {
    const { store, source } = parseJson('{"owner":["Lee"]}')
    const car = store.firstChildOf(ROOT)
    const owner = store.firstChildOf(car)
    const ownerNameId = store.nameIdOf(owner)

    const cell = cellOf(store, source, car, ownerNameId)
    expect(cell.kind).toBe(CellKind.Literal)
    expect(cell.text).toBe('Lee')
    expect(cell.multiplicity).toBe(1)
  })

  it('an empty JSON array value renders "0 items", not a nonsense field-count fallback', () => {
    // resolveWrapperTarget never descends into an empty array (it isn't
    // "composite" — CONCEPT.md §3.2 — so the wrapping Property fails its
    // own "exactly one composite child" test) — this exercises the
    // fallback path that still finds the array.
    const { store, source } = parseJson('{"owner":[]}')
    const car = store.firstChildOf(ROOT)
    const owner = store.firstChildOf(car)
    const ownerNameId = store.nameIdOf(owner)

    const cell = cellOf(store, source, car, ownerNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.text).toBe('0 items')
    expect(cell.multiplicity).toBe(0)
  })

  it('a JSON array of objects renders "N items" like repeated XML composites', () => {
    const { store, source } = parseJson('{"part":[{"sku":"A"},{"sku":"B"},{"sku":"C"}]}')
    const car = store.firstChildOf(ROOT)
    const part = store.firstChildOf(car)
    const partNameId = store.nameIdOf(part)

    const cell = cellOf(store, source, car, partNameId)
    expect(cell.kind).toBe(CellKind.Derived)
    expect(cell.text).toBe('3 items')
    expect(cell.multiplicity).toBe(3)
    expect(cell.node).toBeNull()
  })

  it('every row of the table renders through the same code for XML and JSON', () => {
    const xml = parseXml(
      '<car id="c-001" color="red">' +
        '<name>Golf</name>' +
        '<engine><type>diesel</type><kw>110</kw></engine>' +
        '<owner>Smith</owner><owner>Jones</owner>' +
        '<sunroof/>' +
        '</car>'
    )
    const xmlCar = xml.store.firstChildOf(ROOT)
    const xmlColorId = [...xml.store.attributesOf(xmlCar)].find(
      (a) => xml.store.textOf(a.nameId) === 'color'
    )!.nameId
    const xmlEngineId = namedChildId(xml.store, xmlCar, 'engine')

    const json = parseJson(
      '{"color":"red","name":"Golf","engine":{"type":"diesel","kw":110},' +
        '"owner":["Smith","Jones"],"sunroof":true}'
    )
    const jsonCar = json.store.firstChildOf(ROOT)
    const jsonColorId = namedChildId(json.store, jsonCar, 'color')
    const jsonEngineId = namedChildId(json.store, jsonCar, 'engine')

    const xmlColorCell = cellOf(xml.store, xml.source, xmlCar, xmlColorId)
    const jsonColorCell = cellOf(json.store, json.source, jsonCar, jsonColorId)
    expect(xmlColorCell.kind).toBe(jsonColorCell.kind)
    expect(xmlColorCell.text).toBe(jsonColorCell.text)

    const xmlEngineCell = cellOf(xml.store, xml.source, xmlCar, xmlEngineId)
    const jsonEngineCell = cellOf(json.store, json.source, jsonCar, jsonEngineId)
    expect(xmlEngineCell.kind).toBe(jsonEngineCell.kind)
    expect(xmlEngineCell.text).toBe(jsonEngineCell.text)
  })
})

describe('gridCell.ts has no branch on formatId (M2-PLAN.md rule 2)', () => {
  it('the source contains no reference to formatId', () => {
    const source = readFileSync(
      join(__dirname, '../src/renderer/components/Detail/gridCell.ts'),
      'utf-8'
    )
    expect(source).not.toMatch(/formatId/)
  })
})
