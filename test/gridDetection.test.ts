import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import {
  detectGrid,
  GRID_MIN_COVERAGE,
  GRID_MIN_MEMBERS
} from '../src/renderer/components/Detail/gridDetection'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const jsonOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, xmlOptions)
  return { store }
}

/** Namespace resolution enabled — R136's own tests need this; every test
 * above uses the plain `parseXml` above, matching `nameIdOf`'s raw
 * behaviour unchanged. */
function parseXmlNamespaced(text: string): { store: NodeStore } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner(undefined, true))
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

describe('detectGrid (M2-PLAN.md E1)', () => {
  it('detects one car group under the Appendix A shape (garage > cars > elements > car*3)', () => {
    const { store } = parseXml(
      '<garage><cars><elements>' +
        '<car id="c-001"><name>Golf</name></car>' +
        '<car id="c-002"><name>Model 3</name></car>' +
        '<car id="c-003"><name>Panda</name></car>' +
        '</elements></cars></garage>'
    )
    const garage = store.firstChildOf(ROOT)
    const cars = store.firstChildOf(garage)
    const elements = store.firstChildOf(cars)

    const result = detectGrid(store, elements)

    expect(result.compositeChildCount).toBe(3)
    expect(result.grid).not.toBeNull()
    expect(store.textOf(result.grid!.nameId)).toBe('car')
    expect(result.grid!.memberCount).toBe(3)
  })

  it('picks the largest qualifying group and still reports the smaller one', () => {
    let xml = '<library>'
    for (let i = 0; i < 40; i++) xml += `<book><title>b${i}</title></book>`
    for (let i = 0; i < 3; i++) xml += `<magazine><title>m${i}</title></magazine>`
    xml += '</library>'

    const { store } = parseXml(xml)
    const library = store.firstChildOf(ROOT)
    const result = detectGrid(store, library)

    expect(result.compositeChildCount).toBe(43)
    expect(result.grid).not.toBeNull()
    expect(store.textOf(result.grid!.nameId)).toBe('book')
    expect(result.grid!.memberCount).toBe(40)

    expect(result.groups).toHaveLength(2)
    const magazine = result.groups.find((g) => store.textOf(g.nameId) === 'magazine')
    expect(magazine?.memberCount).toBe(3)
  })

  it('produces no grid for a single occurrence (below GRID_MIN_MEMBERS)', () => {
    const { store } = parseXml('<garage><car id="c-001"><name>Golf</name></car></garage>')
    const garage = store.firstChildOf(ROOT)
    const result = detectGrid(store, garage)

    expect(result.compositeChildCount).toBe(1)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]!.memberCount).toBeLessThan(GRID_MIN_MEMBERS)
    expect(result.grid).toBeNull()
  })

  it('never groups scalar (non-composite) children', () => {
    // Leaf elements (folded scalar values, D-030) and an empty element have
    // no children of their own — non-composite, per CONCEPT.md §3.2 — and
    // must not enter a group even though several share a name.
    const { store } = parseXml(
      '<car>' +
        '<owner>Smith</owner>' +
        '<owner>Jones</owner>' +
        '<owner>Lee</owner>' +
        '<sunroof/>' +
        '<engine><type>diesel</type></engine>' +
        '</car>'
    )
    const car = store.firstChildOf(ROOT)
    const result = detectGrid(store, car)

    // Only <engine> has a child of its own; three <owner> and one <sunroof>
    // are leaves and never counted as composite.
    expect(result.compositeChildCount).toBe(1)
    expect(result.grid).toBeNull()
  })

  it('groups repeating attribute-only leaf elements (D-088, from R149/CSV)', () => {
    // <car/> here has no child nodes at all, only attributes — the exact
    // shape a CSV row is, since R145 §2 emits fields as facets rather than
    // children. Excluded from grouping before D-088 (the plain "has
    // children" test), which meant a CSV file could never produce a grid.
    const { store } = parseXml(
      '<cars>' +
        '<car color="red" make="Toyota"/>' +
        '<car color="blue" make="Honda"/>' +
        '<car color="green" make="Ford"/>' +
        '</cars>'
    )
    const cars = store.firstChildOf(ROOT)
    const result = detectGrid(store, cars)
    expect(result.compositeChildCount).toBe(3)
    expect(result.grid).not.toBeNull()
    expect(result.grid!.memberCount).toBe(3)
  })

  it('still excludes an attribute-less, child-less leaf like <sunroof/> (D-088 does not widen this case)', () => {
    const { store } = parseXml('<car><sunroof/><sunroof/></car>')
    const car = store.firstChildOf(ROOT)
    const result = detectGrid(store, car)
    expect(result.compositeChildCount).toBe(0)
    expect(result.grid).toBeNull()
  })

  it('a coverage floor below 5% does not qualify even with enough members', () => {
    let xml = '<root>'
    // 100 filler composite groups of 1 each (100 total), plus a repeat group
    // of exactly 2 members — 2/102 < 5%.
    for (let i = 0; i < 100; i++) xml += `<filler${i}><v>${i}</v></filler${i}>`
    xml += '<rare><v>1</v></rare><rare><v>2</v></rare>'
    xml += '</root>'

    const { store } = parseXml(xml)
    const root = store.firstChildOf(ROOT)
    const result = detectGrid(store, root)

    const rare = result.groups.find((g) => store.textOf(g.nameId) === 'rare')
    expect(rare?.memberCount).toBe(2)
    expect(rare!.memberCount / result.compositeChildCount).toBeLessThan(GRID_MIN_COVERAGE)
    expect(result.grid).toBeNull()
  })

  it('groups unnamed composite JSON array elements together (all share NO_NAME)', () => {
    const { store } = parseJson(
      '{"items":[{"id":1,"name":"a"},{"id":2,"name":"b"},{"id":3,"name":"c"}]}'
    )
    const topObject = store.firstChildOf(ROOT)
    const itemsProperty = store.firstChildOf(topObject)
    const itemsArray = store.firstChildOf(itemsProperty)

    const result = detectGrid(store, itemsArray)

    expect(result.compositeChildCount).toBe(3)
    expect(result.grid).not.toBeNull()
    expect(result.grid!.memberCount).toBe(3)
  })

  it('the same document shape produces the same result through JSON as XML (no formatId branch)', () => {
    const { store: xmlStore } = parseXml(
      '<root><car><name>Golf</name></car><car><name>Polo</name></car></root>'
    )
    const xmlRoot = xmlStore.firstChildOf(ROOT)
    const xmlResult = detectGrid(xmlStore, xmlRoot)

    const { store: jsonStore } = parseJson('{"cars":[{"name":"Golf"},{"name":"Polo"}]}')
    const jsonTopObject = jsonStore.firstChildOf(ROOT)
    const carsProperty = jsonStore.firstChildOf(jsonTopObject)
    const carsArray = jsonStore.firstChildOf(carsProperty)
    const jsonResult = detectGrid(jsonStore, carsArray)

    expect(xmlResult.compositeChildCount).toBe(jsonResult.compositeChildCount)
    expect(xmlResult.grid?.memberCount).toBe(jsonResult.grid?.memberCount)
  })

  it('returns no grid and no groups for a node with no composite children', () => {
    const { store } = parseXml('<leaf>just text</leaf>')
    const leaf = store.firstChildOf(ROOT)
    const result = detectGrid(store, leaf)

    expect(result.compositeChildCount).toBe(0)
    expect(result.groups).toHaveLength(0)
    expect(result.grid).toBeNull()
  })

  it('detection is a single pass: stays fast for a large, wide fan-out', () => {
    let xml = '<root>'
    const n = 100_000
    for (let i = 0; i < n; i++) xml += `<car><v>${i}</v></car>`
    xml += '</root>'
    const { store } = parseXml(xml)
    const root = store.firstChildOf(ROOT)

    const start = performance.now()
    const result = detectGrid(store, root)
    const elapsed = performance.now() - start

    expect(result.grid?.memberCount).toBe(n)
    // Generous bound for CI variance — the point is "linear and cheap", not
    // a precise budget; §4.3's real number is measured in E10.
    expect(elapsed).toBeLessThan(500)
  })
})

describe('R136 — grid grouping on the resolved name', () => {
  it('two sections with different prefixes for one URI produce ONE grid group (fails without R136)', () => {
    const { store } = parseXmlNamespaced(
      '<root>' +
        '<a:car xmlns:a="urn:cars"><v>1</v></a:car>' +
        '<b:car xmlns:b="urn:cars"><v>2</v></b:car>' +
        '<c:car xmlns:c="urn:cars"><v>3</v></c:car>' +
        '</root>'
    )
    const root = store.firstChildOf(ROOT)
    const result = detectGrid(store, root)

    expect(result.groups).toHaveLength(1)
    expect(result.grid).not.toBeNull()
    expect(result.grid!.memberCount).toBe(3)
  })

  it('two sections with the SAME prefix bound to different URIs produce TWO groups', () => {
    const { store } = parseXmlNamespaced(
      '<root>' +
        '<x xmlns:p="urn:one"><p:car><v>1</v></p:car><p:car><v>2</v></p:car></x>' +
        '<y xmlns:p="urn:two"><p:car><v>3</v></p:car><p:car><v>4</v></p:car></y>' +
        '</root>'
    )
    const root = store.firstChildOf(ROOT)
    // Both <p:car> groups live under <root>'s grandchildren, not directly
    // under <root> — detectGrid groups one node's own children, so
    // exercise it on a synthetic parent holding both sets of <p:car>
    // siblings directly, which is the shape §4.3 actually groups.
    const x = store.firstChildOf(root)
    const y = store.nextSiblingOf(x)
    const carsUnderX = detectGrid(store, x)
    const carsUnderY = detectGrid(store, y)
    expect(carsUnderX.grid!.memberCount).toBe(2)
    expect(carsUnderY.grid!.memberCount).toBe(2)
    // The two groups' resolved ids differ — "p:car" means something
    // different in each subtree.
    expect(carsUnderX.grid!.nameId).not.toBe(carsUnderY.grid!.nameId)
  })

  it('the column header tooltip contains the resolved URI, while the header text stays the prefix as written', () => {
    const { store } = parseXmlNamespaced('<root><a:car xmlns:a="urn:cars">1</a:car></root>')
    const root = store.firstChildOf(ROOT)
    const car = store.firstChildOf(root)
    expect(store.nameOf(car)).toBe('a:car') // displayed as written
    expect(store.namespaceUriOfName(store.nameIdOf(car))).toBe('urn:cars') // tooltip material
  })
})
