/**
 * M4-PLAN.md G1's own acceptance criteria: exact results in document order,
 * including past where the old `SCAN_LIMIT` scan would have missed them,
 * and — the "real difficulty" the plan calls out — correctness after a
 * subtree splice, asserted against a full rebuild rather than eyeballed.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { buildNameIndex, nameIndexMemoryBytes, nodesByNameId } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { spliceSubtree } from '../src/renderer/session/subtreeSplice'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function parseXml(text: string): NodeStore {
  const bytes = utf8(text)
  const store = new NodeStore(bytes, new Interner())
  const result = xmlFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return store
}

describe('buildNameIndex', () => {
  it('groups node refs by nameId in document order', () => {
    const store = parseXml('<zoo><cat id="1"/><dog/><cat id="2"/></zoo>')
    const index = buildNameIndex(store, store.interner.size)

    let catNameId = -1
    for (let id = 0; id < store.interner.size; id++) {
      if (store.textOf(id) === 'cat') catNameId = id
    }
    expect(catNameId).toBeGreaterThanOrEqual(0)

    const catNodes = [...nodesByNameId(index, catNameId)]
    const names = catNodes.map((ref) => store.nameOf(ref))
    expect(names).toEqual(['cat', 'cat'])
    // Ascending — document order.
    expect(catNodes).toEqual([...catNodes].sort((a, b) => a - b))
  })

  it('excludes unnamed nodes (text, document root)', () => {
    const store = parseXml('<zoo>hello</zoo>')
    const index = buildNameIndex(store, store.interner.size)
    const total = index.starts[index.starts.length - 1]!
    // Only <zoo> has a name; the folded text is not a separate named node
    // (D-030 node-density), and the Document root has none either.
    expect(total).toBe(1)
  })

  it('returns an empty range for an out-of-bounds nameId', () => {
    const store = parseXml('<zoo/>')
    const index = buildNameIndex(store, store.interner.size)
    expect([...nodesByNameId(index, 999)]).toEqual([])
    expect([...nodesByNameId(index, -1)]).toEqual([])
  })

  it('reports its own memory footprint', () => {
    const store = parseXml('<zoo><a/><b/></zoo>')
    const index = buildNameIndex(store, store.interner.size)
    expect(nameIndexMemoryBytes(index)).toBe(index.starts.byteLength + index.nodes.byteLength)
  })

  it('is exact on a document large enough to have exercised the old SCAN_LIMIT', () => {
    const children = Array.from({ length: 500 }, (_, i) =>
      i === 400 ? '<needle/>' : `<hay/>`
    ).join('')
    const store = parseXml(`<zoo>${children}</zoo>`)
    const index = buildNameIndex(store, store.interner.size)
    let needleId = -1
    for (let id = 0; id < store.interner.size; id++) {
      if (store.textOf(id) === 'needle') needleId = id
    }
    expect([...nodesByNameId(index, needleId)]).toHaveLength(1)
  })
})

describe('name index after a subtree splice (G1 invalidation)', () => {
  it('every ref a rebuilt index returns for a name still points at a node with that name', () => {
    const before = '<zoo><a/><cat id="1"/><b/><cat id="2"/></zoo>'
    const after = '<zoo><a/><cat id="1"/><b/><cat id="2"/><cat id="3"/></zoo>'

    const oldStore = parseXml(before)
    const interner = oldStore.interner
    const newBytes = utf8(after)
    const dirtyStart = before.indexOf('<b/>') + '<b/>'.length
    const dirtyEnd = dirtyStart // pure insertion right after <b/>
    const delta = newBytes.length - utf8(before).length

    const outcome = spliceSubtree({
      format: xmlFormatModule,
      oldStore,
      newBytes,
      interner,
      dirtyStart,
      dirtyEnd,
      delta,
      options: OPTIONS
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const splicedIndex = buildNameIndex(outcome.store, outcome.store.interner.size)
    const rebuiltFromScratch = buildNameIndex(parseXml(after), parseXml(after).interner.size)

    // Structural equivalence: same groups, same node names at every ref —
    // not byte-identical arrays, since a fresh parse's own nameIds can be
    // assigned in a different order than the splice's reused interner.
    const namesOf = (store: NodeStore, index: ReturnType<typeof buildNameIndex>): string[][] => {
      const groups: string[][] = []
      for (let id = 0; id < index.starts.length - 1; id++) {
        const refs = [...nodesByNameId(index, id)]
        if (refs.length === 0) continue
        groups.push(refs.map((ref) => store.nameOf(ref)!).sort())
      }
      return groups.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))
    }

    expect(namesOf(outcome.store, splicedIndex)).toEqual(
      namesOf(parseXml(after), rebuiltFromScratch)
    )

    // The acceptance criterion in exact terms: every ref the spliced
    // index's "cat" group returns names a node that is actually "cat".
    let catId = -1
    for (let id = 0; id < outcome.store.interner.size; id++) {
      if (outcome.store.textOf(id) === 'cat') catId = id
    }
    for (const ref of nodesByNameId(splicedIndex, catId)) {
      expect(outcome.store.nameOf(ref)).toBe('cat')
    }
    expect([...nodesByNameId(splicedIndex, catId)]).toHaveLength(3)
  })
})
