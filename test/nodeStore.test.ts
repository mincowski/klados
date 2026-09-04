import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeFlags, NodeStore } from '../src/core/nodeStore'
import { NodeKind } from '../src/core/types'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/**
 * <car id="c-1"><name>Golf</name><owner>Smith</owner><owner>Jones</owner><sunroof/></car>
 *
 * A hand-built sequence of ~20 sink calls standing in for what B9's XML
 * parser will eventually emit for this shape: one element with an attribute,
 * three leaf children (two of them repeated names), and a self-closing leaf.
 * Offsets are computed from the literal fragments as the string is assembled,
 * rather than searched for after the fact, so they can't drift out of sync.
 */
function buildCarTree(): {
  store: NodeStore
  source: Uint8Array
  car: number
  name: number
  owner1: number
  owner2: number
  sunroof: number
} {
  let text = ''
  const mark = (fragment: string): number => {
    const at = text.length
    text += fragment
    return at
  }

  const carOpen = mark('<car id="')
  const idValueStart = mark('c-1')
  mark('">')
  const nameOpen = mark('<name>')
  const golfStart = mark('Golf')
  const nameClose = mark('</name>')
  const owner1Open = mark('<owner>')
  const smithStart = mark('Smith')
  const owner1Close = mark('</owner>')
  const owner2Open = mark('<owner>')
  const jonesStart = mark('Jones')
  const owner2Close = mark('</owner>')
  const sunroofOpen = mark('<sunroof')
  const sunroofClose = mark('/>')
  mark('</car>')

  const source = utf8(text)
  const store = new NodeStore(source, new Interner())

  const car = store.openNode(NodeKind.Element, carOpen, carOpen + 1, carOpen + 4)
  store.attribute(carOpen + 5, carOpen + 7, idValueStart, idValueStart + 3)

  const name = store.openNode(NodeKind.Element, nameOpen, nameOpen + 1, nameOpen + 5)
  store.value(golfStart, golfStart + 4)
  store.closeNode(name, nameClose + 7)

  const owner1 = store.openNode(NodeKind.Element, owner1Open, owner1Open + 1, owner1Open + 6)
  store.value(smithStart, smithStart + 5)
  store.closeNode(owner1, owner1Close + 8)

  const owner2 = store.openNode(NodeKind.Element, owner2Open, owner2Open + 1, owner2Open + 6)
  store.value(jonesStart, jonesStart + 5)
  store.closeNode(owner2, owner2Close + 8)

  const sunroof = store.openNode(NodeKind.Element, sunroofOpen, sunroofOpen + 1, sunroofOpen + 8)
  store.closeNode(sunroof, sunroofClose + 2)

  store.closeNode(car, source.length)

  return { store, source, car, name, owner1, owner2, sunroof }
}

describe('NodeStore — hand-built tree', () => {
  it('produces the expected node count and kinds', () => {
    const { store, car, name } = buildCarTree()
    expect(store.nodeCount).toBe(5)
    expect(store.kindOf(car)).toBe(NodeKind.Element)
    expect(store.kindOf(name)).toBe(NodeKind.Element)
  })

  it('interns and exposes names', () => {
    const { store, car, name, owner1, owner2 } = buildCarTree()
    expect(store.nameOf(car)).toBe('car')
    expect(store.nameOf(name)).toBe('name')
    expect(store.nameOf(owner1)).toBe('owner')
    expect(store.nameOf(owner2)).toBe('owner')
    // repeated name interned once
    expect(store.nameIdOf(owner1)).toBe(store.nameIdOf(owner2))
  })

  it('links parent/child and sibling order', () => {
    const { store, car, name, owner1, owner2, sunroof } = buildCarTree()
    expect(store.parentOf(name)).toBe(car)
    expect(store.parentOf(owner1)).toBe(car)
    expect(store.firstChildOf(car)).toBe(name)

    const children = Array.from(store.childrenOf(car))
    expect(children).toEqual([name, owner1, owner2, sunroof])
  })

  // `noUncheckedIndexedAccess` types an out-of-range read as `undefined`,
  // the walk asserted that away with `!`, and `undefined !== -1` is `true`
  // — so this used to yield `undefined` forever. Materializing it, as any
  // tree view does, exhausted the heap instead of returning nothing.
  it('childrenOf terminates on a ref that is not a node', () => {
    const { store, car } = buildCarTree()
    expect(Array.from(store.childrenOf(store.nodeCount + 10))).toEqual([])
    expect(Array.from(store.childrenOf(-1))).toEqual([])
    // ...and still walks a real node correctly.
    expect(Array.from(store.childrenOf(car)).length).toBe(4)
  })

  it('childrenOf on an empty store yields nothing', () => {
    const empty = new NodeStore(new Uint8Array(0), new Interner())
    expect(empty.nodeCount).toBe(0)
    expect(Array.from(empty.childrenOf(0))).toEqual([])
  })

  it('prevSibling is the inverse of nextSibling', () => {
    const { store, name, owner1, sunroof } = buildCarTree()
    expect(store.nextSiblingOf(name)).toBe(owner1)
    expect(store.prevSiblingOf(owner1)).toBe(name)
    expect(store.prevSiblingOf(name)).toBe(-1)
    expect(store.nextSiblingOf(sunroof)).toBe(-1)
  })

  it('exposes the attribute on car and none on leaves', () => {
    const { store, car, name } = buildCarTree()
    expect(store.hasFlag(car, NodeFlags.HasAttributes)).toBe(true)
    const attrs = Array.from(store.attributesOf(car))
    expect(attrs.length).toBe(1)
    expect(attrs[0]!.valueStart).toBeLessThan(attrs[0]!.valueEnd)

    expect(Array.from(store.attributesOf(name))).toEqual([])
  })

  it('folds a single text run into the leaf element itself', () => {
    const { store, name } = buildCarTree()
    expect(store.ownValueOf(name)).not.toBeNull()
    expect(store.valueOf(name)).toEqual(store.ownValueOf(name))
  })

  it('has no value for a childless, textless leaf', () => {
    const { store, sunroof } = buildCarTree()
    expect(store.valueOf(sunroof)).toBeNull()
  })

  it('has no value for a composite node', () => {
    const { store, car } = buildCarTree()
    expect(store.valueOf(car)).toBeNull()
  })

  it('sets subtreeComplete on close', () => {
    const { store, car, sunroof } = buildCarTree()
    expect(store.hasFlag(car, NodeFlags.SubtreeComplete)).toBe(true)
    expect(store.hasFlag(sunroof, NodeFlags.SubtreeComplete)).toBe(true)
  })

  it('does not set isMixed on a non-mixed element', () => {
    const { store, car } = buildCarTree()
    expect(store.hasFlag(car, NodeFlags.IsMixed)).toBe(false)
  })
})

describe('NodeStore — mixed content', () => {
  it('sets isMixed when a node has both a Text child and an element child', () => {
    const xml = '<desc>a <b>x</b></desc>'
    const source = utf8(xml)
    const store = new NodeStore(source, new Interner())

    const desc = store.openNode(NodeKind.Element, 0, 1, 5)
    const text = store.openNode(NodeKind.Text, 6, 6, 6)
    store.value(6, 8)
    store.closeNode(text, 8)
    const b = store.openNode(NodeKind.Element, 8, 9, 10)
    store.value(11, 12)
    store.closeNode(b, 15)
    store.closeNode(desc, source.length)

    expect(store.hasFlag(desc, NodeFlags.IsMixed)).toBe(true)
    expect(store.kindOf(text)).toBe(NodeKind.Text)
  })
})

describe('NodeStore — dropped whitespace', () => {
  it('marks droppedWhitespace instead of storing an empty value on a composite node', () => {
    const source = utf8('<a>\n  <b/>\n</a>')
    const store = new NodeStore(source, new Interner())

    const a = store.openNode(NodeKind.Element, 0, 1, 2)
    // whitespace-only run between <a> and <b/> — parser signals via an
    // empty, non-sentinel value() call rather than a node.
    store.value(3, 3)
    const b = store.openNode(NodeKind.Element, 6, 7, 8)
    store.closeNode(b, 10)
    store.closeNode(a, source.length)

    expect(store.hasFlag(a, NodeFlags.DroppedWhitespace)).toBe(true)
    expect(store.ownValueOf(a)).toBeNull()
  })

  it('also catches whitespace trailing the last child, not just leading the first', () => {
    const source = utf8('<a><b/>\n</a>')
    const store = new NodeStore(source, new Interner())

    const a = store.openNode(NodeKind.Element, 0, 1, 2)
    const b = store.openNode(NodeKind.Element, 3, 4, 5)
    store.closeNode(b, 7)
    store.value(8, 8)
    store.closeNode(a, source.length)

    expect(store.hasFlag(a, NodeFlags.DroppedWhitespace)).toBe(true)
    expect(store.ownValueOf(a)).toBeNull()
  })

  it('a genuinely empty leaf still gets a real (zero-length) value', () => {
    const source = utf8('<a></a>')
    const store = new NodeStore(source, new Interner())
    const a = store.openNode(NodeKind.Element, 0, 1, 2)
    store.value(3, 3)
    store.closeNode(a, source.length)

    expect(store.ownValueOf(a)).toEqual({ start: 3, end: 3 })
    expect(store.hasFlag(a, NodeFlags.DroppedWhitespace)).toBe(false)
  })
})

describe('NodeStore — CData', () => {
  it('auto-flags isCData from kind', () => {
    const source = utf8('<a><![CDATA[x]]></a>')
    const store = new NodeStore(source, new Interner())
    const a = store.openNode(NodeKind.Element, 0, 1, 2)
    const cdata = store.openNode(NodeKind.CData, 3, 3, 3)
    store.value(12, 13)
    store.closeNode(cdata, 16)
    store.closeNode(a, source.length)

    expect(store.hasFlag(cdata, NodeFlags.IsCData)).toBe(true)
  })
})

describe('NodeStore — dev assertions', () => {
  it('throws when closeNode does not match the innermost open node', () => {
    const source = utf8('<a><b/></a>')
    const store = new NodeStore(source, new Interner())
    const a = store.openNode(NodeKind.Element, 0, 1, 2)
    const b = store.openNode(NodeKind.Element, 3, 4, 5)
    expect(() => store.closeNode(a, source.length)).toThrow()
    store.closeNode(b, 7)
    store.closeNode(a, source.length)
  })

  it('throws when attribute() is called on a node after one of its children has already opened and closed', () => {
    const source = utf8('<a><b/></a>')
    const store = new NodeStore(source, new Interner())
    store.openNode(NodeKind.Element, 0, 1, 2)
    const b = store.openNode(NodeKind.Element, 3, 4, 5)
    store.closeNode(b, 7)
    // stack top is `a` again; `a.childOpened` is still true from `b`.
    expect(() => store.attribute(0, 1, 0, 1)).toThrow()
  })
})

describe('NodeStore — growth', () => {
  it('grows past its initial capacity of 1024 when inserting 5000 nodes', () => {
    const source = utf8('x'.repeat(20000))
    const store = new NodeStore(source, new Interner(), 16)
    const root = store.openNode(NodeKind.Array, 0, 0, 0)
    for (let i = 0; i < 5000; i++) {
      const n = store.openNode(NodeKind.Scalar, i, i, i)
      store.closeNode(n, i + 1)
    }
    store.closeNode(root, source.length)

    expect(store.nodeCount).toBe(5001)
    expect(Array.from(store.childrenOf(root)).length).toBe(5000)
  })
})
