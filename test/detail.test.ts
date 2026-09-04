import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { parsePath } from '../src/core/path/parse'
import { SourceBuffer } from '../src/core/buffer'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { getFormatCapabilities } from '../src/formats/registry'
import {
  adjacentCommentOf,
  childrenColumnLayout,
  copyPathFor,
  pathSegmentsOf,
  scalarFacetsOf,
  sourceRangeLabel,
  toJsonPointer,
  toKladosPath,
  toXPath,
  valueTextOf
} from '../src/renderer/components/Detail/detailModel'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const jsonOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: Uint8Array } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, xmlOptions)
  return { store, source }
}

function parseJson(text: string): { store: NodeStore; source: Uint8Array } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  jsonFormatModule.parse(source, store, jsonOptions)
  return { store, source }
}

const ROOT = 0

describe('getFormatCapabilities (D9)', () => {
  it('resolves xml and json by id', () => {
    expect(getFormatCapabilities('xml')?.hasAttributes).toBe(true)
    expect(getFormatCapabilities('json')?.hasAttributes).toBe(false)
  })

  it('is undefined for an unregistered id', () => {
    // 'toml' itself was this test's example until M6-PLAN.md (R14)
    // registered it — 'yaml' is next in line (M8) and still unregistered.
    expect(getFormatCapabilities('yaml')).toBeUndefined()
  })
})

describe('pathSegmentsOf / toXPath / toJsonPointer (D9)', () => {
  it('an XML element with a unique tag name gets no predicate', () => {
    const { store } = parseXml('<zoo><cat/><dog/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const dog = store.nextSiblingOf(store.firstChildOf(zoo))
    const segments = pathSegmentsOf(store, dog)
    expect(toXPath(segments)).toBe('/zoo/dog')
  })

  it('an XML element with same-named siblings gets a 1-based predicate', () => {
    const { store } = parseXml('<zoo><cat/><cat/><cat/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const secondCat = store.nextSiblingOf(store.firstChildOf(zoo))
    const segments = pathSegmentsOf(store, secondCat)
    expect(toXPath(segments)).toBe('/zoo/cat[2]')
  })

  it('the root alone produces just "/"', () => {
    const { store } = parseXml('<a/>')
    const a = store.firstChildOf(ROOT)
    expect(toXPath(pathSegmentsOf(store, a))).toBe('/a')
  })

  it('a JSON object property is a named JSON Pointer segment', () => {
    const { store } = parseJson('{"a":{"b":1}}')
    const topObject = store.firstChildOf(ROOT)
    const propA = store.firstChildOf(topObject)
    const innerObject = store.firstChildOf(propA)
    const propB = store.firstChildOf(innerObject)
    expect(toJsonPointer(pathSegmentsOf(store, propB))).toBe('/a/b')
  })

  it('a JSON array element is a positional JSON Pointer segment', () => {
    const { store } = parseJson('{"list":[10,20,30]}')
    const topObject = store.firstChildOf(ROOT)
    const propList = store.firstChildOf(topObject)
    const array = store.firstChildOf(propList)
    const second = store.nextSiblingOf(store.firstChildOf(array))
    expect(toJsonPointer(pathSegmentsOf(store, second))).toBe('/list/1')
  })

  it('an object nested directly in an array is addressed by index, not doubled with its own segment', () => {
    const { store } = parseJson('[{"a":1}]')
    const array = store.firstChildOf(ROOT)
    const element = store.firstChildOf(array) // an unnamed Object — the array element itself
    const propA = store.firstChildOf(element)
    expect(toJsonPointer(pathSegmentsOf(store, element))).toBe('/0')
    expect(toJsonPointer(pathSegmentsOf(store, propA))).toBe('/0/a')
  })

  it('nested arrays index each level without an extra segment per Array node', () => {
    const { store } = parseJson('[[1,2],[3]]')
    const outer = store.firstChildOf(ROOT)
    const secondInner = store.nextSiblingOf(store.firstChildOf(outer))
    const three = store.firstChildOf(secondInner)
    expect(toJsonPointer(pathSegmentsOf(store, three))).toBe('/1/0')
  })

  it('a bare top-level JSON scalar has no segment of its own — the empty pointer addresses it', () => {
    const { store } = parseJson('42')
    const scalar = store.firstChildOf(ROOT)
    expect(toJsonPointer(pathSegmentsOf(store, scalar))).toBe('')
  })

  it('a top-level JSON array with no wrapping object needs no leading segment either', () => {
    const { store } = parseJson('[1,2]')
    const array = store.firstChildOf(ROOT)
    const second = store.nextSiblingOf(store.firstChildOf(array))
    expect(toJsonPointer(pathSegmentsOf(store, second))).toBe('/1')
  })

  it('escapes ~ and / in a JSON Pointer property name', () => {
    const { store } = parseJson('{"a/b~c":1}')
    const topObject = store.firstChildOf(ROOT)
    const prop = store.firstChildOf(topObject)
    expect(toJsonPointer(pathSegmentsOf(store, prop))).toBe('/a~1b~0c')
  })

  // R75 (`R72-path-query.md` §4): `copyPathFor` always emits the
  // Klados query grammar now, for every format — not a per-format choice
  // between XPath and JSON Pointer (D-081). `toXPath`/`toJsonPointer`
  // themselves are unchanged and still directly tested above/below; this
  // only covers what `copyPathFor` itself resolves to.
  it('copyPathFor emits the same Klados-grammar path regardless of format', () => {
    const { store } = parseXml('<a/>')
    const a = store.firstChildOf(ROOT)
    const segments = pathSegmentsOf(store, a)
    expect(copyPathFor(segments)).toBe('/a')
    expect(copyPathFor(segments)).toBe(toKladosPath(segments))
  })
})

describe('toKladosPath (R75, R72-path-query.md §4)', () => {
  it('matches toXPath for a named-only (XML-shaped) tree', () => {
    const { store } = parseXml('<zoo><cat/><cat/><cat/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const secondCat = store.nextSiblingOf(store.firstChildOf(zoo))
    const segments = pathSegmentsOf(store, secondCat)
    expect(toKladosPath(segments)).toBe('/zoo/cat[2]')
    expect(toKladosPath(segments)).toBe(toXPath(segments))
  })

  // The actual defect toXPath has for JSON: `pathSegmentsOf` only computes
  // `sameNamePosition` by comparing siblings' *names*, so an unnamed array
  // element (name === null) always gets `sameNameCount === 0` — toXPath
  // would print a bare `*` for every element in the array, indistinguishable
  // from one another. toKladosPath uses `siblingIndex` (1-based) instead,
  // which the grammar's positional predicate doesn't require a name for.
  it('addresses a JSON array element positionally, unlike toXPath', () => {
    const { store } = parseJson('{"list":[10,20,30]}')
    const topObject = store.firstChildOf(ROOT)
    const propList = store.firstChildOf(topObject)
    const array = store.firstChildOf(propList)
    const second = store.nextSiblingOf(store.firstChildOf(array))
    const segments = pathSegmentsOf(store, second)

    expect(toKladosPath(segments)).toBe('/list/*[2]')
    expect(toXPath(segments)).toBe('/list/*') // the defect: every element looks identical
  })

  it('the round trip: parsePath can actually parse what toKladosPath emits for a JSON array element', () => {
    const { store } = parseJson('[10,20,30]')
    const array = store.firstChildOf(ROOT)
    const third = store.nextSiblingOf(store.nextSiblingOf(store.firstChildOf(array)))
    const path = toKladosPath(pathSegmentsOf(store, third))
    expect(path).toBe('/*[3]')

    // Mirrors the palette's own mode-prefix strip (`parsePaletteInput`)
    // before handing the rest to `parsePath` — the R75 round trip this
    // exists to fix.
    const stripped = path.slice(1)
    const result = parsePath(stripped, () => null)
    expect(result.ok).toBe(true)
  })

  it('a bare top-level scalar (no addressable step) is just "/"', () => {
    const { store } = parseJson('42')
    const scalar = store.firstChildOf(ROOT)
    expect(toKladosPath(pathSegmentsOf(store, scalar))).toBe('/')
  })

  it('an object nested directly in an array addresses the object positionally, and its own property by name', () => {
    const { store } = parseJson('[{"a":1}]')
    const array = store.firstChildOf(ROOT)
    const element = store.firstChildOf(array)
    const propA = store.firstChildOf(element)
    expect(toKladosPath(pathSegmentsOf(store, element))).toBe('/*[1]')
    expect(toKladosPath(pathSegmentsOf(store, propA))).toBe('/*[1]/a')
  })
})

describe('sourceRangeLabel (D9)', () => {
  it('reports a line number for a pretty-printed document', () => {
    const text = '<zoo>\n  <cat/>\n  <dog/>\n</zoo>\n'
    const { store, source } = parseXml(text)
    const rowIndex = buildRowIndex(
      source,
      DEFAULT_MAX_ROW_BYTES,
      xmlFormatModule.capabilities.rowBreakBytes
    )
    const zoo = store.firstChildOf(ROOT)
    const dog = store.nextSiblingOf(store.firstChildOf(zoo))
    const lineIndex = buildLineIndex(source, rowIndex)
    const label = sourceRangeLabel(source, rowIndex, lineIndex, source.length, store.spanOf(dog))
    expect(label).toMatch(/^line 3$/)
  })

  it('reports byte offsets for a minified (single-line) document', () => {
    const long = '<a>'.repeat(50) + 'x' + '</a>'.repeat(50)
    const { store, source } = parseXml(long)
    const rowIndex = buildRowIndex(
      source,
      DEFAULT_MAX_ROW_BYTES,
      xmlFormatModule.capabilities.rowBreakBytes
    )
    const a = store.firstChildOf(ROOT)
    const lineIndex = buildLineIndex(source, rowIndex)
    const label = sourceRangeLabel(source, rowIndex, lineIndex, source.length, store.spanOf(a))
    expect(label).toMatch(/^bytes \d+–\d+$/)
  })
})

describe('adjacentCommentOf (D9)', () => {
  it('finds a preceding comment sibling', () => {
    const { store } = parseXml('<zoo><!--hi--><cat/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const cat = store.nextSiblingOf(store.firstChildOf(zoo))
    const comment = adjacentCommentOf(store, cat)
    expect(comment).not.toBeNull()
    expect(store.valueOf(comment!)).toEqual({ start: expect.any(Number), end: expect.any(Number) })
  })

  it('is null when nothing adjacent is a comment', () => {
    const { store } = parseXml('<zoo><cat/><dog/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const cat = store.firstChildOf(zoo)
    expect(adjacentCommentOf(store, cat)).toBeNull()
  })
})

describe('valueTextOf (D9)', () => {
  it('reads a folded scalar property value directly (D-030)', () => {
    const { store, source } = parseJson('{"a":42}')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const topObject = store.firstChildOf(ROOT)
    const prop = store.firstChildOf(topObject)
    expect(valueTextOf(store, buffer, prop)).toBe('42')
  })

  it('reads a bare array element value', () => {
    const { store, source } = parseJson('[1,2,3]')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const arr = store.firstChildOf(ROOT)
    const second = store.nextSiblingOf(store.firstChildOf(arr))
    expect(valueTextOf(store, buffer, second)).toBe('2')
  })

  it('is null for an XML element with mixed content (no single value)', () => {
    const { store, source } = parseXml('<p>Hello <b>world</b>!</p>')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const p = store.firstChildOf(ROOT)
    expect(valueTextOf(store, buffer, p)).toBeNull()
  })

  it('is null for a JSON object (no scalar value of its own)', () => {
    const { store, source } = parseJson('{"a":1,"b":2}')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const object = store.firstChildOf(ROOT)
    expect(valueTextOf(store, buffer, object)).toBeNull()
  })
})

describe('scalarFacetsOf (D9)', () => {
  it("lists an XML element's attributes", () => {
    const { store, source } = parseXml('<car id="c-1" make="VW"/>')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const car = store.firstChildOf(ROOT)
    const facets = scalarFacetsOf(store, buffer, car)
    expect(facets).toEqual([
      { name: 'id', value: 'c-1' },
      { name: 'make', value: 'VW' }
    ])
  })

  it('is empty for a node with no attributes', () => {
    const { store, source } = parseXml('<zoo><cat/></zoo>')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    const cat = store.firstChildOf(zoo)
    expect(scalarFacetsOf(store, buffer, cat)).toEqual([])
  })
})

describe('childrenColumnLayout (M5c-PLAN.md J5)', () => {
  it('hides Kind for XML children, which are uniformly Element', () => {
    const { store, source } = parseXml('<zoo><cat/><dog/><bird/></zoo>')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    const children = [...store.childrenOf(zoo)]
    const layout = childrenColumnLayout(store, buffer, children)
    expect(layout.showKind).toBe(false)
  })

  it('shows Kind for mixed XML content (element + comment)', () => {
    const { store, source } = parseXml('<zoo><!-- note --><cat/></zoo>')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    const children = [...store.childrenOf(zoo)]
    const layout = childrenColumnLayout(store, buffer, children)
    expect(layout.showKind).toBe(true)
  })

  it('hides Kind for JSON object members — every one is a Property, regardless of its value shape', () => {
    const { store, source } = parseJson('{"a":1,"b":{"c":2},"d":[1,2]}')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const object = store.firstChildOf(ROOT)
    const children = [...store.childrenOf(object)]
    const layout = childrenColumnLayout(store, buffer, children)
    expect(layout.showKind).toBe(false)
  })

  it('shows Kind for a JSON array whose elements are different shapes', () => {
    const { store, source } = parseJson('[1,{"a":2},[3]]')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const array = store.firstChildOf(ROOT)
    const children = [...store.childrenOf(array)]
    const layout = childrenColumnLayout(store, buffer, children)
    expect(layout.showKind).toBe(true)
  })

  it('widens the name column to fit the longest sampled label', () => {
    const { store, source } = parseXml('<zoo><cat/><a-very-long-element-name/></zoo>')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    const children = [...store.childrenOf(zoo)]
    const layout = childrenColumnLayout(store, buffer, children)
    expect(layout.nameCh).toBeGreaterThanOrEqual('a-very-long-element-name'.length)
  })

  it('clamps column width to a maximum rather than growing unbounded', () => {
    const { store, source } = parseXml(`<zoo><${'x'.repeat(500)}/></zoo>`)
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    const children = [...store.childrenOf(zoo)]
    const layout = childrenColumnLayout(store, buffer, children)
    expect(layout.nameCh).toBeLessThan(500)
  })

  it('is empty-safe', () => {
    const { store, source } = parseXml('<zoo></zoo>')
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    const children = [...store.childrenOf(zoo)]
    expect(children).toEqual([])
    const layout = childrenColumnLayout(store, buffer, children)
    expect(layout.showKind).toBe(false)
  })
})
