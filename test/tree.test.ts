import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import {
  autoExpandChain,
  buildVisibleRows,
  childCountOf,
  collapseSubtree,
  EXPAND_ALL_LIMIT,
  expandAll,
  glyphOf,
  hasChildren,
  indexOfNode,
  kindLabelOf,
  labelOf,
  previewOf,
  typeAheadMatch
} from '../src/renderer/components/Tree/treeModel'

const defaultOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

/** <zoo><cat/><cat/><dog><puppy>Rex</puppy></dog></zoo>
 * Document(0) -> zoo(1) -> cat(2), cat(3), dog(4) -> puppy(5, value "Rex") */
function buildZoo(): { store: NodeStore; source: Uint8Array } {
  const text = '<zoo><cat/><cat/><dog><puppy>Rex</puppy></dog></zoo>'
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, defaultOptions)
  return { store, source }
}

const ROOT = 0

describe('hasChildren / childCountOf (D8)', () => {
  it('a node with children reports true and the right count', () => {
    const { store } = buildZoo()
    expect(hasChildren(store, ROOT)).toBe(true)
    expect(childCountOf(store, ROOT)).toBe(1) // zoo
    const zoo = store.firstChildOf(ROOT)
    expect(childCountOf(store, zoo)).toBe(3) // cat, cat, dog
  })

  it('a leaf reports false', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const cat = store.firstChildOf(zoo)
    expect(hasChildren(store, cat)).toBe(false)
    expect(childCountOf(store, cat)).toBe(0)
  })
})

describe('buildVisibleRows (D8)', () => {
  it('only the root is visible when nothing is expanded', () => {
    const { store } = buildZoo()
    const rows = buildVisibleRows(store, ROOT, new Set())
    expect(rows).toEqual([{ node: ROOT, depth: 0, posinset: 1, setsize: 1 }])
  })

  it('expanding a node reveals its children, in document order, at depth + 1', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const rows = buildVisibleRows(store, ROOT, new Set([ROOT, zoo]))
    expect(rows.map((r) => r.node)).toEqual([ROOT, zoo, zoo + 1, zoo + 2, zoo + 3])
    expect(rows[1]!.depth).toBe(1) // zoo, a child of the (expanded) root
    expect(rows.slice(2).every((r) => r.depth === 2)).toBe(true) // zoo's own children
  })

  it('reports true document-level setsize/posinset, not rendered-row counts', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const dog = zoo + 3
    // Expand zoo (revealing dog, setsize 3) but not dog itself — dog's own
    // children (puppy) stay hidden, and must not affect zoo's children's setsize.
    const rows = buildVisibleRows(store, ROOT, new Set([ROOT, zoo]))
    const dogRow = rows.find((r) => r.node === dog)!
    expect(dogRow.setsize).toBe(3)
    expect(dogRow.posinset).toBe(3)
  })

  it('collapsing a node hides its descendants regardless of their own expanded state', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const dog = zoo + 3
    // dog is "expanded" but its ancestor zoo is not, so nothing below root shows.
    const rows = buildVisibleRows(store, ROOT, new Set([dog]))
    expect(rows.map((r) => r.node)).toEqual([ROOT])
  })

  it('is iterative and handles a deep chain without overflowing the stack', () => {
    let text = ''
    for (let i = 0; i < 5000; i++) text += '<a>'
    text += 'x'
    for (let i = 0; i < 5000; i++) text += '</a>'
    const source = new TextEncoder().encode(text)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, { maxDepth: 10_000, encoding: 'utf-8' })

    const expanded = new Set<number>()
    for (let node = 0; node < store.nodeCount; node++) expanded.add(node)
    expect(() => buildVisibleRows(store, ROOT, expanded)).not.toThrow()
  })
})

describe('indexOfNode (D8)', () => {
  it('finds a node by ref, or -1 if absent from the visible rows', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const rows = buildVisibleRows(store, ROOT, new Set([ROOT]))
    expect(indexOfNode(rows, zoo)).toBe(1)
    expect(indexOfNode(rows, zoo + 1)).toBe(-1) // cat, not expanded into view
  })
})

describe('expandAll (D8)', () => {
  it('expands every node that has children', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const dog = zoo + 3
    const result = expandAll(store, ROOT)
    expect(result.truncated).toBe(false)
    expect(result.expanded).toEqual(new Set([ROOT, zoo, dog]))
  })

  it('truncates and reports it, rather than expanding past the limit', () => {
    let text = ''
    for (let i = 0; i < 200; i++) text += `<item${i}/>`
    text = `<root>${text}</root>`
    const source = new TextEncoder().encode(text)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, defaultOptions)

    const result = expandAll(store, ROOT, 5)
    expect(result.truncated).toBe(true)
    expect(result.expanded.size).toBeLessThan(store.nodeCount)
  })

  it('the default limit is a real bound, not effectively unlimited', () => {
    expect(EXPAND_ALL_LIMIT).toBeGreaterThan(0)
    expect(EXPAND_ALL_LIMIT).toBeLessThan(1_000_000)
  })
})

describe('collapseSubtree (M5c-PLAN.md J6 / D-052)', () => {
  it('collects every node with children in the subtree, root included', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const dog = zoo + 3
    const result = collapseSubtree(store, ROOT)
    expect(result.truncated).toBe(false)
    expect(result.toCollapse).toEqual(new Set([ROOT, zoo, dog]))
  })

  it('scoped to a subtree, leaves nodes outside it out — the whole point of D-052', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const dog = zoo + 3
    const result = collapseSubtree(store, dog)
    expect(result.toCollapse).toEqual(new Set([dog]))
    expect(result.toCollapse.has(zoo)).toBe(false)
    expect(result.toCollapse.has(ROOT)).toBe(false)
  })

  it('a leaf node collapses to an empty set', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const firstCat = store.firstChildOf(zoo)
    const result = collapseSubtree(store, firstCat)
    expect(result.toCollapse.size).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('truncates and reports it, rather than walking past the limit', () => {
    let text = ''
    for (let i = 0; i < 200; i++) text += `<item${i}/>`
    text = `<root>${text}</root>`
    const source = new TextEncoder().encode(text)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, defaultOptions)

    const result = collapseSubtree(store, ROOT, 5)
    expect(result.truncated).toBe(true)
  })
})

describe('kindLabelOf / glyphOf / labelOf (D8)', () => {
  it('a named node uses its own name', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    expect(labelOf(store, zoo)).toBe('zoo')
  })

  it('an unnamed node (the Document root) falls back to its kind label', () => {
    const { store } = buildZoo()
    expect(labelOf(store, ROOT)).toBe('Document')
  })

  it('every kind has a non-empty glyph', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    expect(glyphOf(store.kindOf(zoo)).length).toBeGreaterThan(0)
    expect(kindLabelOf(store.kindOf(zoo))).toBe('Element')
  })
})

describe('previewOf (D8)', () => {
  it('decodes a leaf value', () => {
    const { store, source } = buildZoo()
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    const dog = zoo + 3
    const puppy = store.firstChildOf(dog)
    expect(previewOf(store, buffer, puppy)).toBe('Rex')
  })

  it('returns null for a node with no value', () => {
    const { store, source } = buildZoo()
    const buffer = new SourceBuffer(source, 'utf-8', 0)
    const zoo = store.firstChildOf(ROOT)
    expect(previewOf(store, buffer, zoo)).toBeNull()
  })

  it('bounds the decoded slice regardless of the value length', () => {
    const long = 'x'.repeat(10_000)
    const text = `<a>${long}</a>`
    const source = new TextEncoder().encode(text)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, defaultOptions)
    const buffer = new SourceBuffer(source, 'utf-8', 0)

    const preview = previewOf(store, buffer, store.firstChildOf(ROOT))
    expect(preview).not.toBeNull()
    expect(preview!.length).toBeLessThan(long.length)
  })
})

describe('typeAheadMatch (D8)', () => {
  it('matches a row label by prefix, case-insensitively', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const rows = buildVisibleRows(store, ROOT, new Set([ROOT, zoo]))
    const dogIndex = rows.findIndex((r) => labelOf(store, r.node) === 'dog')
    expect(typeAheadMatch(rows, store, 0, 'DOG')).toBe(dogIndex)
  })

  it('cycles to the next match, not back to the same one, on repeated input', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    const rows = buildVisibleRows(store, ROOT, new Set([ROOT, zoo]))
    const firstCat = rows.findIndex((r) => labelOf(store, r.node) === 'cat')
    const secondCat = rows.findIndex((r, i) => i > firstCat && labelOf(store, r.node) === 'cat')
    expect(typeAheadMatch(rows, store, firstCat, 'c')).toBe(secondCat)
  })

  it('returns null when nothing matches', () => {
    const { store } = buildZoo()
    const rows = buildVisibleRows(store, ROOT, new Set([ROOT]))
    expect(typeAheadMatch(rows, store, 0, 'zzz')).toBeNull()
  })
})

/** garage > cars > elements > car×3 — the shape CONCEPT.md's Appendix A and
 * the real `cars-*.xml` fixtures both use. `cars` and `elements` are each
 * transparent wrappers (M2-PLAN.md E2, D-015). */
function buildGarage(): { store: NodeStore } {
  const text =
    '<garage><cars><elements>' +
    '<car><name>Golf</name></car>' +
    '<car><name>Model 3</name></car>' +
    '<car><name>Panda</name></car>' +
    '</elements></cars></garage>'
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, defaultOptions)
  return { store }
}

describe('autoExpandChain (M2b, UI-FEEDBACK.md)', () => {
  it('walks a single-child chain down to the first node with more than one child', () => {
    const { store } = buildGarage()
    const garage = store.firstChildOf(ROOT)
    const cars = store.firstChildOf(garage)
    const elements = store.firstChildOf(cars)

    // ROOT -> garage -> cars -> elements is an unbroken single-child chain;
    // elements has three <car> children, so the chain stops there.
    expect(autoExpandChain(store, ROOT)).toEqual([ROOT, garage, cars, elements])
  })

  it('stops immediately at a node with more than one child', () => {
    const { store } = buildZoo()
    const zoo = store.firstChildOf(ROOT)
    // zoo has three children (cat, cat, dog) so the chain from zoo is just itself.
    expect(autoExpandChain(store, zoo)).toEqual([zoo])
  })

  it('stops at a leaf: a childless only child does not extend the chain', () => {
    const { store } = buildGarage()
    const garage = store.firstChildOf(ROOT)
    const cars = store.firstChildOf(garage)
    const elements = store.firstChildOf(cars)
    const car = store.firstChildOf(elements)

    // car's only child is `name`, which itself has no children (its text is
    // its own value, per D-030) — nothing about expanding `name` would show
    // anything new, so the chain stops at `car`.
    expect(autoExpandChain(store, car)).toEqual([car])
  })

  it('is bounded by maxDepth, matching the precedent transparentWrapper.ts sets', () => {
    let text = ''
    for (let i = 0; i < 50; i++) text += '<a>'
    text += '<x/>'
    for (let i = 0; i < 50; i++) text += '</a>'
    const source = new TextEncoder().encode(text)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, { maxDepth: 200, encoding: 'utf-8' })

    // maxDepth counts additional hops past the starting node, so the chain
    // (which always includes that node) is one longer.
    const chain = autoExpandChain(store, ROOT, 5)
    expect(chain.length).toBe(6)
  })
})
