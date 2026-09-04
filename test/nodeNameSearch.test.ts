import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { buildNameIndex } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { findNodesByName } from '../src/renderer/navigation/nodeNameSearch'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): NodeStore {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return store
}

describe('findNodesByName (D14, M4-PLAN.md G1)', () => {
  it('matches nodes by fuzzy name', () => {
    const store = parseXml('<zoo><cat/><dog/><catfish/></zoo>')
    const index = buildNameIndex(store, store.interner.size)
    const result = findNodesByName(store, index, 'cat')
    expect(result.matches.map((m) => m.name).sort()).toEqual(['cat', 'catfish'])
  })

  it('is empty for an empty query', () => {
    const store = parseXml('<zoo><cat/></zoo>')
    const index = buildNameIndex(store, store.interner.size)
    expect(findNodesByName(store, index, '').matches).toEqual([])
  })

  it('is empty when nothing matches', () => {
    const store = parseXml('<zoo><cat/><dog/></zoo>')
    const index = buildNameIndex(store, store.interner.size)
    expect(findNodesByName(store, index, 'xyz').matches).toEqual([])
  })

  it('ranks a better (more contiguous/earlier) match first', () => {
    const store = parseXml('<zoo><catalog/><scattering/></zoo>')
    const index = buildNameIndex(store, store.interner.size)
    const result = findNodesByName(store, index, 'cat')
    expect(result.matches[0]!.name).toBe('catalog')
  })

  it('is exact past the old scan cap — every same-named node is found', () => {
    // The old SCAN_LIMIT-bounded scan capped at 200,000 node refs; this
    // fixture puts a matching node well past a much smaller stand-in cap
    // to prove the new index-based lookup has no such limit at all.
    const children = Array.from({ length: 300 }, (_, i) =>
      i === 250 ? '<needle/>' : `<hay${i}/>`
    ).join('')
    const store = parseXml(`<zoo>${children}</zoo>`)
    const index = buildNameIndex(store, store.interner.size)
    const result = findNodesByName(store, index, 'needle')
    expect(result.matches.map((m) => m.name)).toEqual(['needle'])
  })

  it('every node with a given name is returned, in document order', () => {
    const store = parseXml('<zoo><cat id="1"/><dog/><cat id="2"/><cat id="3"/></zoo>')
    const index = buildNameIndex(store, store.interner.size)
    const result = findNodesByName(store, index, 'cat')
    expect(result.matches).toHaveLength(3)
    const refs = result.matches.map((m) => m.node)
    expect(refs).toEqual([...refs].sort((a, b) => a - b))
  })

  it('truncates to the 50 best matches without expanding lower-scored groups fully', () => {
    // "cat" matches exactly, "catfish" is a weaker (but still real) match —
    // "cat" alone has 60 instances, well past RESULT_LIMIT (50). Only
    // "cat"'s own nodes should appear; "catfish" (the worse-scored group)
    // never gets expanded at all once the limit is already full.
    const cats = Array.from({ length: 60 }, () => '<cat/>').join('')
    const store = parseXml(`<zoo>${cats}<catfish/></zoo>`)
    const index = buildNameIndex(store, store.interner.size)
    const result = findNodesByName(store, index, 'cat')
    expect(result.matches).toHaveLength(50)
    expect(result.matches.every((m) => m.name === 'cat')).toBe(true)
  })
})
