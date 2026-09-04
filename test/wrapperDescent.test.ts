import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, type ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import {
  isTransparentWrapper,
  resolveWrapperTarget,
  skippedComments
} from '../src/renderer/wrapperDescent'

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

// Appendix A's shape, comment included, exactly as CONCEPT.md's worked
// example and spike/generate-fixtures.ts's real fixture both use it.
const APPENDIX_A_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<garage>\n' +
  '  <!-- Fleet inventory, updated 2026-07 -->\n' +
  '  <cars>\n' +
  '    <elements>\n' +
  '      <car id="c-001" color="red"><name>Golf</name></car>\n' +
  '      <car id="c-002" color="blue"><name>Model 3</name></car>\n' +
  '      <car id="c-003"><name>Panda</name></car>\n' +
  '    </elements>\n' +
  '  </cars>\n' +
  '</garage>\n'

describe('isTransparentWrapper (M2-PLAN.md E2, D-015)', () => {
  it('a node with exactly one composite child, no attributes, no text is a wrapper', () => {
    const { store } = parseXml('<cars><elements><car/></elements></cars>')
    const cars = store.firstChildOf(ROOT)
    expect(isTransparentWrapper(store, cars)).toBe(true)
  })

  it('a node with an attribute is not a wrapper even with a single composite child', () => {
    const { store } = parseXml('<cars id="x"><elements><car/></elements></cars>')
    const cars = store.firstChildOf(ROOT)
    expect(isTransparentWrapper(store, cars)).toBe(false)
  })

  it('a node with mixed text content is not a wrapper', () => {
    const { store } = parseXml('<cars>some text<elements><car/></elements></cars>')
    const cars = store.firstChildOf(ROOT)
    expect(isTransparentWrapper(store, cars)).toBe(false)
  })

  it('a node with more than one composite child is not a wrapper', () => {
    const { store } = parseXml('<garage><cars/><trucks/></garage>')
    const garage = store.firstChildOf(ROOT)
    expect(isTransparentWrapper(store, garage)).toBe(false)
  })

  it('a leaf sibling alongside the single composite child disqualifies the wrapper', () => {
    // <cat/> is a real field (an empty-element "presence marker", §4.3's
    // cell table), not metadata — descending past it the way a Comment
    // sibling is ignored would silently hide it from the destination.
    const { store } = parseXml('<zoo><cat/><cat/><dog><puppy>Rex</puppy></dog></zoo>')
    const zoo = store.firstChildOf(ROOT)
    expect(isTransparentWrapper(store, zoo)).toBe(false)
  })

  it('an adjacent Comment sibling does not disqualify a wrapper', () => {
    const { store } = parseXml(APPENDIX_A_XML)
    const garage = store.firstChildOf(ROOT)
    // garage's children are [Comment, cars] — the comment is cars' sibling.
    expect(isTransparentWrapper(store, garage)).toBe(true)
  })

  it('a leaf (no children at all) is not a wrapper', () => {
    const { store } = parseXml('<name>Golf</name>')
    const name = store.firstChildOf(ROOT)
    expect(isTransparentWrapper(store, name)).toBe(false)
  })

  it('a group with repeating children is not itself a wrapper', () => {
    const { store } = parseXml(APPENDIX_A_XML)
    const garage = store.firstChildOf(ROOT)
    const cars = store.firstChildOf(garage)
    const elements = store.firstChildOf(cars)
    expect(isTransparentWrapper(store, elements)).toBe(false)
  })
})

/** garage's first child is the Comment (Appendix A attaches it there,
 * before `<cars>`) — this is the Element sibling that follows it. */
function firstElementChildOf(store: NodeStore, node: number): number {
  let child = store.firstChildOf(node)
  while (child !== -1 && store.kindOf(child) !== NodeKind.Element) {
    child = store.nextSiblingOf(child)
  }
  return child
}

describe('resolveWrapperTarget (M2-PLAN.md E2)', () => {
  it("descends garage > cars > elements to the car group (Appendix A's shape)", () => {
    const { store } = parseXml(APPENDIX_A_XML)
    const garage = store.firstChildOf(ROOT)
    const cars = firstElementChildOf(store, garage)
    const elements = store.firstChildOf(cars)

    const result = resolveWrapperTarget(store, garage)

    expect(result.destination).toBe(elements)
    expect(result.skipped).toEqual([garage, cars])
  })

  it('does not descend through a wrapper carrying an attribute', () => {
    const { store } = parseXml('<cars id="x"><elements><car/></elements></cars>')
    const cars = store.firstChildOf(ROOT)

    const result = resolveWrapperTarget(store, cars)

    expect(result.destination).toBe(cars)
    expect(result.skipped).toEqual([])
  })

  it('a non-wrapper node resolves to itself with nothing skipped', () => {
    const { store } = parseXml(APPENDIX_A_XML)
    const garage = store.firstChildOf(ROOT)
    const cars = store.firstChildOf(garage)
    const elements = store.firstChildOf(cars)

    const result = resolveWrapperTarget(store, elements)

    expect(result.destination).toBe(elements)
    expect(result.skipped).toEqual([])
  })

  it("surfaces the skipped cars node's comment, labelled", () => {
    const { store } = parseXml(APPENDIX_A_XML)
    const garage = store.firstChildOf(ROOT)

    const { skipped } = resolveWrapperTarget(store, garage)
    const comments = skippedComments(store, skipped)

    expect(comments).toHaveLength(1)
    expect(comments[0]!.label).toBe('cars')
  })

  it(
    'JSON needs more hops than XML for the equivalent shape (D-030 keeps a composite ' +
      "Property's value as a separate node) — the default depth is generous enough to " +
      'still reach the array, but a tight cap of 3 (tuned to XML) truncates early',
    () => {
      // garage -> { cars -> { items -> [car, car, car] } }. Five nodes
      // separate "garage" the Property from the Array that actually repeats:
      // garageProperty -> garageObject -> carsProperty -> carsObject ->
      // itemsProperty -> itemsArray. D-030 keeps each Property/Object value
      // pair as two nodes; XML's Element would fold the equivalent chain
      // into half as many hops.
      const jsonText = '{"garage":{"cars":{"items":[{"id":1},{"id":2},{"id":3}]}}}'
      const { store } = parseJson(jsonText)
      const topObject = store.firstChildOf(ROOT)
      const garageProperty = store.firstChildOf(topObject)
      const garageObject = store.firstChildOf(garageProperty)
      const carsProperty = store.firstChildOf(garageObject)
      const carsObject = store.firstChildOf(carsProperty)
      const itemsProperty = store.firstChildOf(carsObject)
      const itemsArray = store.firstChildOf(itemsProperty)

      const unbounded = resolveWrapperTarget(store, garageProperty)
      expect(unbounded.destination).toBe(itemsArray)
      expect(unbounded.skipped).toEqual([
        garageProperty,
        garageObject,
        carsProperty,
        carsObject,
        itemsProperty
      ])

      const tight = resolveWrapperTarget(store, garageProperty, 3)
      expect(tight.skipped).toHaveLength(3)
      expect(tight.destination).not.toBe(itemsArray)
    }
  )

  it('the same document shape resolves to an equivalent destination through XML and JSON', () => {
    const { store: xmlStore } = parseXml(
      '<root><cars><car><name>Golf</name></car><car><name>Polo</name></car></cars></root>'
    )
    const xmlRoot = xmlStore.firstChildOf(ROOT)
    const xmlCars = xmlStore.firstChildOf(xmlRoot)
    const xmlResult = resolveWrapperTarget(xmlStore, xmlCars)
    // <cars> has two composite <car> children — not a wrapper, resolves to itself.
    expect(xmlResult.destination).toBe(xmlCars)
    expect(xmlResult.skipped).toEqual([])

    const { store: jsonStore } = parseJson('{"cars":[{"name":"Golf"},{"name":"Polo"}]}')
    const jsonTopObject = jsonStore.firstChildOf(ROOT)
    const carsProperty = jsonStore.firstChildOf(jsonTopObject)
    const jsonResult = resolveWrapperTarget(jsonStore, carsProperty)
    // "cars" Property's only child is the Array, whose two Object elements
    // are themselves composite — the Array has 2 composite children, so
    // it is not a wrapper either, but the Property itself has exactly one
    // composite child (the array) and so is a wrapper around it.
    expect(jsonResult.skipped).toEqual([carsProperty])
    expect(jsonResult.destination).toBe(jsonStore.firstChildOf(carsProperty))
  })
})
