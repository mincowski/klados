import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { lastNodeStartingAtOrBefore, nodeContainingOffset } from '../src/renderer/nodeSpanLookup'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: Uint8Array } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return { store, source }
}

function parseJson(text: string): { store: NodeStore; source: Uint8Array } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  jsonFormatModule.parse(source, store, options)
  return { store, source }
}

const ROOT = 0

describe('nodeContainingOffset (D14)', () => {
  it('finds a leaf element containing the offset', () => {
    const { store } = parseXml('<zoo><cat/><dog/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const dog = store.nextSiblingOf(store.firstChildOf(zoo))
    const dogSpan = store.spanOf(dog)
    expect(nodeContainingOffset(store, dogSpan.start + 1)).toBe(dog)
  })

  it('finds the parent when the offset falls in a gap between children', () => {
    // Whitespace between </cat> and <dog> belongs to <zoo>, not either child.
    const { store } = parseXml('<zoo><cat/>   <dog/></zoo>')
    const zoo = store.firstChildOf(ROOT)
    const cat = store.firstChildOf(zoo)
    const catSpan = store.spanOf(cat)
    // Right after </cat>, before <dog> — a gap only <zoo> spans.
    expect(nodeContainingOffset(store, catSpan.end + 1)).toBe(zoo)
  })

  it('finds a deeply nested node exactly, not merely an ancestor', () => {
    const { store } = parseXml('<a><b><c>text</c></b></a>')
    const a = store.firstChildOf(ROOT)
    const b = store.firstChildOf(a)
    const c = store.firstChildOf(b)
    const cSpan = store.spanOf(c)
    expect(nodeContainingOffset(store, cSpan.start + 2)).toBe(c)
  })

  it('resolves a JSON property value to the property node', () => {
    const { store } = parseJson('{"a":42}')
    const topObject = store.firstChildOf(ROOT)
    const prop = store.firstChildOf(topObject)
    const value = store.ownValueOf(prop)!
    expect(nodeContainingOffset(store, value.start)).toBe(prop)
  })

  it('falls back to the Document root for an empty store', () => {
    const source = new Uint8Array(0)
    const store = new NodeStore(source, new Interner())
    expect(nodeContainingOffset(store, 0)).toBe(0)
  })

  it('resolves an offset at the very start of the document to the root', () => {
    const { store } = parseXml('<a/>')
    expect(nodeContainingOffset(store, 0)).toBe(store.firstChildOf(ROOT))
  })
})

describe('lastNodeStartingAtOrBefore (D14/D11 shared primitive)', () => {
  it('is monotonic non-decreasing as offset increases', () => {
    const { store, source } = parseXml('<zoo><cat/><dog/><fish/></zoo>')
    let previous = -1
    for (let offset = 0; offset < source.length; offset++) {
      const node = lastNodeStartingAtOrBefore(store, offset)
      expect(node).toBeGreaterThanOrEqual(previous)
      previous = node
    }
  })
})
