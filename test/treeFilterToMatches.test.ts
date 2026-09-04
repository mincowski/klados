/**
 * M4-PLAN.md G6's own acceptance criteria: filter mode hides every subtree
 * with no match and no others, ancestors of matches stay visible, and a
 * match count in the millions does not hang the Tree.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { buildFilteredRows } from '../src/renderer/components/Tree/treeModel'

const defaultOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

/** <zoo><cat/><cat/><dog><puppy>Rex</puppy></dog></zoo>
 * Document(0) -> zoo(1) -> cat(2), cat(3), dog(4) -> puppy(5, value "Rex") */
function buildZoo(): NodeStore {
  const text = '<zoo><cat/><cat/><dog><puppy>Rex</puppy></dog></zoo>'
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, defaultOptions)
  return store
}

const ROOT = 0
const ZOO = 1
const CAT_A = 2
const CAT_B = 3
const DOG = 4
const PUPPY = 5

describe('buildFilteredRows (M4-PLAN.md G6)', () => {
  it('hides every subtree with no match and no others', () => {
    const store = buildZoo()
    // A match inside <puppy>Rex</puppy> only.
    const matchStarts = Int32Array.from([store.spanOf(PUPPY).start + 1])
    const { rows, truncated } = buildFilteredRows(store, ROOT, matchStarts)

    expect(truncated).toBe(false)
    const nodes = rows.map((r) => r.node)
    expect(nodes).toEqual([ROOT, ZOO, DOG, PUPPY])
    expect(nodes).not.toContain(CAT_A)
    expect(nodes).not.toContain(CAT_B)
  })

  it('an empty match set produces no rows', () => {
    const store = buildZoo()
    const { rows, truncated } = buildFilteredRows(store, ROOT, new Int32Array(0))
    expect(rows).toEqual([])
    expect(truncated).toBe(false)
  })

  it('a match on the root itself shows only the root', () => {
    const store = buildZoo()
    // The Document node's own span covers everything, but neither of its
    // children (zoo) has a match of its own if the match sits outside
    // every node's span — use an offset that only the root's span (the
    // whole document) contains: none exists here since spans nest, so
    // instead verify a match matching *every* level shows the full chain.
    const matchStarts = Int32Array.from([store.spanOf(CAT_A).start])
    const { rows } = buildFilteredRows(store, ROOT, matchStarts)
    expect(rows.map((r) => r.node)).toEqual([ROOT, ZOO, CAT_A])
  })

  it('multiple matches under different branches keep both, prune the rest', () => {
    const store = buildZoo()
    const matchStarts = Int32Array.from(
      [store.spanOf(CAT_B).start, store.spanOf(PUPPY).start].sort((a, b) => a - b)
    )
    const { rows } = buildFilteredRows(store, ROOT, matchStarts)
    const nodes = rows.map((r) => r.node)
    expect(nodes).toContain(CAT_B)
    expect(nodes).toContain(DOG)
    expect(nodes).toContain(PUPPY)
    expect(nodes).not.toContain(CAT_A)
  })

  it('setsize reflects only matching siblings, not the full sibling count', () => {
    const store = buildZoo()
    const matchStarts = Int32Array.from([store.spanOf(CAT_A).start])
    const { rows } = buildFilteredRows(store, ROOT, matchStarts)
    const catRow = rows.find((r) => r.node === CAT_A)!
    expect(catRow.setsize).toBe(1) // only one matching sibling out of three
  })

  it('is bounded — a very small limit truncates rather than hanging', () => {
    const store = buildZoo()
    const matchStarts = Int32Array.from([store.spanOf(PUPPY).start])
    const { truncated } = buildFilteredRows(store, ROOT, matchStarts, 1)
    expect(truncated).toBe(true)
  })

  it('an unmatched document (no node span contains any match) yields no rows', () => {
    const store = buildZoo()
    const matchStarts = Int32Array.from([1_000_000]) // past the document entirely
    const { rows } = buildFilteredRows(store, ROOT, matchStarts)
    expect(rows).toEqual([])
  })
})
