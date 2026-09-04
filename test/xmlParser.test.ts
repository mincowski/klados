import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeFlags, NodeStore } from '../src/core/nodeStore'
import { NodeKind, type ParseOptions, type ParseResult } from '../src/core/types'
import { xmlFormatModule, type XmlResumeContext } from '../src/formats/xml/index'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const defaultOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(
  text: string,
  options: ParseOptions = defaultOptions
): { store: NodeStore; source: Uint8Array; result: ParseResult } {
  const source = utf8(text)
  const store = new NodeStore(source, new Interner())
  const result = xmlFormatModule.parse(source, store, options)
  return { store, source, result }
}

describe('xmlFormatModule.detect', () => {
  it('matches a .xml filename strongly', () => {
    expect(xmlFormatModule.detect(utf8('<a/>'), 'data.xml')).toBeGreaterThan(0.5)
  })

  it('sniffs a leading <', () => {
    expect(xmlFormatModule.detect(utf8('  <a/>'), null)).toBeGreaterThan(0.5)
  })

  it('rejects content starting with neither', () => {
    expect(xmlFormatModule.detect(utf8('hello'), null)).toBe(0)
  })
})

describe('xmlFormatModule.detectEncoding', () => {
  it('extracts a declared encoding from the prolog', () => {
    const head = utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')
    expect(xmlFormatModule.detectEncoding(head)).toBe('ISO-8859-1')
  })

  it('returns null when there is no prolog', () => {
    expect(xmlFormatModule.detectEncoding(utf8('<a/>'))).toBeNull()
  })

  it('returns null when the prolog has no encoding attribute', () => {
    expect(xmlFormatModule.detectEncoding(utf8('<?xml version="1.0"?><a/>'))).toBeNull()
  })
})

describe('XML parser — text folding rules (CONCEPT.md §3.2 / B9)', () => {
  it('folds a single text run into a leaf element, no Text child', () => {
    const { store } = parseXml('<name>Golf</name>')
    const doc = 0
    const name = store.firstChildOf(doc)
    expect(store.kindOf(name)).toBe(NodeKind.Element)
    expect(store.nameOf(name)).toBe('name')
    expect(store.firstChildOf(name)).toBe(-1)
    const value = store.valueOf(name)!
    expect(value.start).toBeLessThan(value.end)
  })

  it('drops whitespace-only text between elements, setting droppedWhitespace', () => {
    const { store } = parseXml('<a>\n  <b/>\n  <c/>\n</a>')
    const doc = 0
    const a = store.firstChildOf(doc)
    expect(store.hasFlag(a, NodeFlags.DroppedWhitespace)).toBe(true)
    expect(store.valueOf(a)).toBeNull()
    const children = Array.from(store.childrenOf(a))
    expect(children.length).toBe(2)
    expect(store.kindOf(children[0]!)).toBe(NodeKind.Element)
    expect(store.kindOf(children[1]!)).toBe(NodeKind.Element)
  })

  it('preserves whitespace-only text inside xml:space="preserve"', () => {
    const { store } = parseXml('<a xml:space="preserve">\n  <b/>\n</a>')
    const doc = 0
    const a = store.firstChildOf(doc)
    expect(store.hasFlag(a, NodeFlags.DroppedWhitespace)).toBe(false)
    const children = Array.from(store.childrenOf(a))
    // whitespace before <b/>, <b/> itself, whitespace after <b/>
    expect(children.length).toBe(3)
    expect(store.kindOf(children[0]!)).toBe(NodeKind.Text)
    expect(store.kindOf(children[1]!)).toBe(NodeKind.Element)
    expect(store.kindOf(children[2]!)).toBe(NodeKind.Text)
  })

  it('keeps mixed content as ordered Text children and sets isMixed', () => {
    const { store, source } = parseXml('<desc>a <b>x</b> c</desc>')
    const doc = 0
    const desc = store.firstChildOf(doc)
    expect(store.hasFlag(desc, NodeFlags.IsMixed)).toBe(true)
    const children = Array.from(store.childrenOf(desc))
    expect(children.length).toBe(3)
    expect(store.kindOf(children[0]!)).toBe(NodeKind.Text)
    expect(store.kindOf(children[1]!)).toBe(NodeKind.Element)
    expect(store.kindOf(children[2]!)).toBe(NodeKind.Text)

    const firstText = store.ownValueOf(children[0]!)!
    expect(new TextDecoder().decode(source.subarray(firstText.start, firstText.end))).toBe('a ')
    const lastText = store.ownValueOf(children[2]!)!
    expect(new TextDecoder().decode(source.subarray(lastText.start, lastText.end))).toBe(' c')
  })

  it('an element with literally nothing between its tags has an absent value, not an empty one', () => {
    // No text run occurs at all here (unlike a single whitespace character),
    // so this is indistinguishable from a self-closing element.
    const { store } = parseXml('<a></a>')
    const doc = 0
    const a = store.firstChildOf(doc)
    expect(store.ownValueOf(a)).toBeNull()
    expect(store.hasFlag(a, NodeFlags.DroppedWhitespace)).toBe(false)
  })

  it("a single whitespace character as an element's sole content folds as a real value", () => {
    const { store } = parseXml('<a> </a>')
    const doc = 0
    const a = store.firstChildOf(doc)
    expect(store.ownValueOf(a)).toEqual({ start: 3, end: 4 })
    expect(store.hasFlag(a, NodeFlags.DroppedWhitespace)).toBe(false)
  })

  it('a scalar (all-nested) engine and a nested engine both parse (fixture variance)', () => {
    const scalar = parseXml('<car><engine>petrol</engine></car>')
    const nested = parseXml('<car><engine><type>petrol</type><kw>90</kw></engine></car>')

    const carScalar = scalar.store.firstChildOf(0)
    const engineScalar = scalar.store.firstChildOf(carScalar)
    expect(scalar.store.valueOf(engineScalar)).not.toBeNull()

    const carNested = nested.store.firstChildOf(0)
    const engineNested = nested.store.firstChildOf(carNested)
    expect(Array.from(nested.store.childrenOf(engineNested)).length).toBe(2)
  })
})

describe('XML parser — attributes', () => {
  it('parses attributes and interns their names', () => {
    const { store } = parseXml('<car id="c-1" color="red"/>')
    const doc = 0
    const car = store.firstChildOf(doc)
    expect(store.hasFlag(car, NodeFlags.HasAttributes)).toBe(true)
    const attrs = Array.from(store.attributesOf(car))
    expect(attrs.length).toBe(2)
  })

  it('emits xmlns and xmlns:* as ordinary attributes', () => {
    const { store } = parseXml('<a xmlns="urn:x" xmlns:y="urn:y" y:b="1"/>')
    const doc = 0
    const a = store.firstChildOf(doc)
    const attrs = Array.from(store.attributesOf(a))
    expect(attrs.length).toBe(3)
  })
})

describe('XML parser — comments, PI, CData, DOCTYPE', () => {
  it('parses a comment as its own node', () => {
    const { store, source } = parseXml('<a><!-- hi --></a>')
    const doc = 0
    const a = store.firstChildOf(doc)
    const comment = store.firstChildOf(a)
    expect(store.kindOf(comment)).toBe(NodeKind.Comment)
    const value = store.ownValueOf(comment)!
    expect(new TextDecoder().decode(source.subarray(value.start, value.end))).toBe(' hi ')
  })

  it('parses a processing instruction with its target as name', () => {
    const { store } = parseXml('<?xml-stylesheet href="x.xsl"?><a/>')
    const doc = 0
    const pi = store.firstChildOf(doc)
    expect(store.kindOf(pi)).toBe(NodeKind.ProcessingInstruction)
    expect(store.nameOf(pi)).toBe('xml-stylesheet')
  })

  it('does not emit a node for the <?xml ...?> declaration itself', () => {
    const { store } = parseXml('<?xml version="1.0"?><a/>')
    const doc = 0
    const onlyChild = store.firstChildOf(doc)
    expect(store.kindOf(onlyChild)).toBe(NodeKind.Element)
    expect(store.nextSiblingOf(onlyChild)).toBe(-1)
  })

  it('parses CDATA as its own node, auto-flagged isCData, even as sole content', () => {
    const { store, source } = parseXml('<a><![CDATA[<not a tag>]]></a>')
    const doc = 0
    const a = store.firstChildOf(doc)
    const cdata = store.firstChildOf(a)
    expect(store.kindOf(cdata)).toBe(NodeKind.CData)
    expect(store.hasFlag(cdata, NodeFlags.IsCData)).toBe(true)
    const value = store.ownValueOf(cdata)!
    expect(new TextDecoder().decode(source.subarray(value.start, value.end))).toBe('<not a tag>')
  })

  it('parses a DOCTYPE with an internal subset without attempting to parse it', () => {
    const { store } = parseXml('<!DOCTYPE html [ <!ENTITY x "y"> ]><a/>')
    const doc = 0
    const doctype = store.firstChildOf(doc)
    expect(store.kindOf(doctype)).toBe(NodeKind.DocType)
    const a = store.nextSiblingOf(doctype)
    expect(store.kindOf(a)).toBe(NodeKind.Element)
  })
})

describe('XML parser — self-closing tags', () => {
  it('opens and closes a self-closing element immediately', () => {
    const { store } = parseXml('<a><b/></a>')
    const doc = 0
    const a = store.firstChildOf(doc)
    const b = store.firstChildOf(a)
    expect(store.kindOf(b)).toBe(NodeKind.Element)
    expect(store.nextSiblingOf(b)).toBe(-1)
  })
})

describe('XML parser — malformed input', () => {
  it('emits a diagnostic and recovers on a mismatched end tag', () => {
    const { store, result } = parseXml('<a><b></a></b>')
    expect(result.diagnosticCount).toBeGreaterThan(0)
    const doc = 0
    const a = store.firstChildOf(doc)
    expect(store.nameOf(a)).toBe('a')
  })

  it('does not throw and emits a diagnostic on an unclosed tag', () => {
    expect(() => parseXml('<a><b>')).not.toThrow()
    const { result } = parseXml('<a><b>')
    expect(result.diagnosticCount).toBeGreaterThan(0)
    expect(result.complete).toBe(false)
  })

  it('emits a diagnostic and does not crash on a stray end tag', () => {
    const { result } = parseXml('<a></a></c>')
    expect(result.diagnosticCount).toBeGreaterThan(0)
  })

  it('emits a Fatal diagnostic and does not crash past maxDepth', () => {
    const depth = 5000
    const text = '<a>'.repeat(depth) + '</a>'.repeat(depth)
    const { store, result } = parseXml(text, { maxDepth: 1000, encoding: 'utf-8' })
    expect(result.complete).toBe(false)
    const fatal = store.diagnostics.find((d) => d.severity === 2)
    expect(fatal).toBeDefined()
  })
})

describe('XML parser — parseRange (subtree reparse)', () => {
  it('reparses an element subtree to an identical shape', () => {
    const text = '<garage><car id="1"><name>Golf</name><owner>Smith</owner></car></garage>'
    const { store, source } = parseXml(text)
    const doc = 0
    const garage = store.firstChildOf(doc)
    const car = store.firstChildOf(garage)
    const span = store.spanOf(car)

    const context = xmlFormatModule.resumeContextFor({
      length: 1,
      kindAt: () => NodeKind.Element,
      spanStartAt: () => store.spanOf(garage).start,
      spanEndAt: () => store.spanOf(garage).end,
      attributesAt: () => []
    })

    const freshStore = new NodeStore(source, new Interner())
    const result = xmlFormatModule.parseRange!(
      source,
      span.start,
      span.end,
      freshStore,
      context,
      defaultOptions
    )
    expect(result.complete).toBe(true)

    function shape(s: NodeStore, node: number): unknown {
      return {
        kind: s.kindOf(node),
        name: s.nameOf(node),
        children: Array.from(s.childrenOf(node)).map((c) => shape(s, c))
      }
    }
    expect(shape(freshStore, 0)).toEqual(shape(store, car))
  })

  it('reparses a bare Text node span directly', () => {
    const text = '<desc>a <b>x</b> c</desc>'
    const { store, source } = parseXml(text)
    const doc = 0
    const desc = store.firstChildOf(doc)
    const firstText = store.firstChildOf(desc)
    expect(store.kindOf(firstText)).toBe(NodeKind.Text)
    const span = store.spanOf(firstText)

    const context = xmlFormatModule.resumeContextFor({
      length: 0,
      kindAt: () => NodeKind.Document,
      spanStartAt: () => 0,
      spanEndAt: () => 0,
      attributesAt: () => []
    })
    const freshStore = new NodeStore(source, new Interner())
    const result = xmlFormatModule.parseRange!(
      source,
      span.start,
      span.end,
      freshStore,
      context,
      defaultOptions
    )
    expect(result.complete).toBe(true)
    expect(freshStore.kindOf(0)).toBe(NodeKind.Text)
    expect(freshStore.ownValueOf(0)).toEqual(store.ownValueOf(firstText))
  })
})

describe('XML parser — resumeContextFor', () => {
  it('rebuilds the xml:space scope by walking ancestors', () => {
    const ctx = xmlFormatModule.resumeContextFor({
      length: 2,
      kindAt: () => NodeKind.Element,
      spanStartAt: () => 0,
      spanEndAt: () => 0,
      attributesAt: (i) => (i === 0 ? [{ name: 'xml:space', value: 'preserve' }] : [])
    }) as XmlResumeContext
    expect(ctx.preserveWhitespace).toBe(true)
  })

  it('a later ancestor can reset xml:space back to default', () => {
    const ctx = xmlFormatModule.resumeContextFor({
      length: 2,
      kindAt: () => NodeKind.Element,
      spanStartAt: () => 0,
      spanEndAt: () => 0,
      attributesAt: (i) =>
        i === 0
          ? [{ name: 'xml:space', value: 'preserve' }]
          : [{ name: 'xml:space', value: 'default' }]
    }) as XmlResumeContext
    expect(ctx.preserveWhitespace).toBe(false)
  })
})
