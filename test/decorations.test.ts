import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import {
  selectionDecoration,
  viewportDecorations
} from '../src/renderer/components/Raw/decorations'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: Uint8Array; buffer: SourceBuffer } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return { store, source, buffer: new SourceBuffer(source, 'utf-8', 0) }
}

function parseJson(text: string): { store: NodeStore; source: Uint8Array; buffer: SourceBuffer } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  jsonFormatModule.parse(source, store, options)
  return { store, source, buffer: new SourceBuffer(source, 'utf-8', 0) }
}

const ROOT = 0

describe('viewportDecorations — XML (D11)', () => {
  it('highlights an element tag name at spanStart + 1', () => {
    const { store, buffer } = parseXml('<car/>')
    const spans = viewportDecorations(store, buffer, 0, 6)
    const tagName = spans.find((s) => s.className === 'tagName')
    expect(tagName).toEqual({ start: 1, end: 4, className: 'tagName' })
  })

  it('highlights an attribute value, not the attribute name', () => {
    const { store, buffer, source } = parseXml('<car id="c-1"/>')
    const spans = viewportDecorations(store, buffer, 0, source.length)
    const stringSpans = spans.filter((s) => s.className === 'string')
    expect(stringSpans).toHaveLength(1)
    const text = buffer.slice(stringSpans[0]!.start, stringSpans[0]!.end)
    expect(text).toBe('c-1')
  })

  it('highlights a comment across its full span', () => {
    const text = '<a><!-- hi --></a>'
    const { store, buffer } = parseXml(text)
    const spans = viewportDecorations(store, buffer, 0, text.length)
    const comment = spans.find((s) => s.className === 'comment')
    expect(comment).toBeDefined()
    expect(buffer.slice(comment!.start, comment!.end)).toBe('<!-- hi -->')
  })

  it('highlights element text content as a string', () => {
    const { store, buffer, source } = parseXml('<a>hello</a>')
    const spans = viewportDecorations(store, buffer, 0, source.length)
    const strings = spans.filter((s) => s.className === 'string')
    expect(strings.some((s) => buffer.slice(s.start, s.end) === 'hello')).toBe(true)
  })

  it('is empty for an empty store', () => {
    const source = new Uint8Array(0)
    const store = new NodeStore(source, new Interner())
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    expect(viewportDecorations(store, buffer, 0, 0)).toEqual([])
  })
})

describe('viewportDecorations — JSON scalar classification (D11)', () => {
  it('classifies a string value', () => {
    const { store, buffer } = parseJson('{"a":"hi"}')
    const topObject = store.firstChildOf(ROOT)
    const prop = store.firstChildOf(topObject)
    const span = store.ownValueOf(prop)!
    const spans = viewportDecorations(store, buffer, span.start, span.end)
    expect(spans.some((s) => s.className === 'string')).toBe(true)
  })

  it('classifies a number value', () => {
    const { store, buffer, source } = parseJson('{"a":42}')
    const spans = viewportDecorations(store, buffer, 0, source.length)
    expect(spans.some((s) => s.className === 'number')).toBe(true)
  })

  it('classifies true/false/null as keyword', () => {
    const { store, buffer, source } = parseJson('{"a":true,"b":false,"c":null}')
    const spans = viewportDecorations(store, buffer, 0, source.length)
    const keywords = spans.filter((s) => s.className === 'keyword')
    expect(keywords).toHaveLength(3)
  })

  it('classifies a negative number', () => {
    const { store, buffer, source } = parseJson('{"a":-5}')
    const spans = viewportDecorations(store, buffer, 0, source.length)
    expect(spans.some((s) => s.className === 'number')).toBe(true)
  })
})

describe('viewportDecorations — viewport clipping and ancestor coverage (D11)', () => {
  it('clips a decoration that starts before "from"', () => {
    const { store, buffer, source } = parseXml('<a>0123456789</a>')
    const a = store.firstChildOf(ROOT)
    const fullValue = store.valueOf(a)!
    const cutPoint = fullValue.start + 5
    const spans = viewportDecorations(store, buffer, cutPoint, source.length)
    const text = spans.find((s) => s.className === 'string')
    expect(text).toBeDefined()
    expect(text!.start).toBe(cutPoint) // clipped, not the value's true start
  })

  it('clips a decoration that ends after "to"', () => {
    const { store, buffer } = parseXml('<a>0123456789</a>')
    const a = store.firstChildOf(ROOT)
    const fullValue = store.valueOf(a)!
    const cutPoint = fullValue.start + 5
    const spans = viewportDecorations(store, buffer, 0, cutPoint)
    const text = spans.find((s) => s.className === 'string')
    expect(text).toBeDefined()
    expect(text!.end).toBe(cutPoint) // clipped, not the value's true end
  })

  it('finds an ancestor element tag name when "from" starts mid-subtree', () => {
    // "from" lands inside <inner>'s text, well past <outer>'s own tag —
    // <outer>'s tagName decoration must still not appear (it's before
    // "from"), but requesting a range starting exactly at <outer>'s name
    // must still find it via the ancestor walk.
    const text = '<outer><inner>text</inner></outer>'
    const { store, buffer } = parseXml(text)
    const outerNameStart = text.indexOf('outer') // first occurrence, the open tag
    const spans = viewportDecorations(store, buffer, outerNameStart, outerNameStart + 5)
    expect(spans).toEqual([
      { start: outerNameStart, end: outerNameStart + 5, className: 'tagName' }
    ])
  })

  it('excludes a node entirely before "from" with no overlap', () => {
    const { store, buffer, source } = parseXml('<a>x</a><b>y</b>')
    const bStart = source.indexOf('b'.charCodeAt(0), 8)
    const spans = viewportDecorations(store, buffer, bStart, source.length)
    expect(spans.some((s) => buffer.slice(s.start, s.end) === 'x')).toBe(false)
  })

  it('excludes a node entirely after "to"', () => {
    const { store, buffer } = parseXml('<a>x</a><b>y</b>')
    const spans = viewportDecorations(store, buffer, 0, 8) // up to end of <a>x</a>
    expect(spans.some((s) => buffer.slice(s.start, s.end) === 'y')).toBe(false)
  })
})

describe('selectionDecoration (D11)', () => {
  it('is the full span when the node is entirely inside the window', () => {
    const { store, source } = parseXml('<zoo><cat/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const cat = store.firstChildOf(zoo)
    const span = store.spanOf(cat)
    expect(selectionDecoration(store, cat, 0, source.length)).toEqual(span)
  })

  it('is null when the node lies entirely outside the window', () => {
    const { store } = parseXml('<zoo><cat/><dog/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const dog = store.nextSiblingOf(store.firstChildOf(zoo))
    const dogSpan = store.spanOf(dog)
    expect(selectionDecoration(store, dog, 0, dogSpan.start)).toBeNull()
  })

  it('is clipped when the node straddles the window edge', () => {
    const { store } = parseXml('<zoo><cat/><dog/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const dog = store.nextSiblingOf(store.firstChildOf(zoo))
    const dogSpan = store.spanOf(dog)
    const windowEnd = dogSpan.start + 3
    const result = selectionDecoration(store, dog, 0, windowEnd)
    expect(result).toEqual({ start: dogSpan.start, end: windowEnd })
  })

  it('is null for an out-of-range node ref', () => {
    const { store, source } = parseXml('<a/>')
    expect(selectionDecoration(store, 999, 0, source.length)).toBeNull()
    expect(selectionDecoration(store, -1, 0, source.length)).toBeNull()
  })
})
