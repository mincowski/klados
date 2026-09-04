/**
 * M4-PLAN.md G8's own acceptance criteria: every §6.3 form evaluates
 * correctly against both XML and JSON, with the same query string
 * producing the same node set on both (invariant 8) — and //name is
 * meaningfully faster than a full scan (measured separately, G10).
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { buildNameIndex } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { evaluatePath } from '../src/core/path/evaluate'
import { parsePath } from '../src/core/path/parse'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  const result = xmlFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

function parseJson(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  const result = jsonFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

/** Runs a query end to end: parse -> resolve names via the store's own
 * interner -> evaluate. Throws (failing the test loudly) on a parse
 * failure — every fixture here is deliberately well-formed. */
function run(store: NodeStore, source: SourceBuffer, query: string): number[] {
  const nameIndex = buildNameIndex(store, store.interner.size)
  const parsed = parsePath(query, (name) => store.interner.lookup(name))
  if (!parsed.ok) throw new Error(`query failed to parse: ${parsed.diagnostic.message}`)
  return [...evaluatePath(store, nameIndex, source, parsed.path)]
}

describe('evaluatePath — name and descendant steps (M4-PLAN.md G8)', () => {
  it('a name step finds direct children', () => {
    const { store, source } = parseXml('<zoo><cat/><dog/><cat/></zoo>')
    const result = run(store, source, 'zoo/cat')
    expect(result).toHaveLength(2)
    for (const node of result) expect(store.nameOf(node)).toBe('cat')
  })

  it('a descendant step finds nodes at any depth', () => {
    const { store, source } = parseXml(
      '<cars><car><price>100</price></car><group><car><price>200</price></car></group></cars>'
    )
    const result = run(store, source, 'cars//price')
    expect(result).toHaveLength(2)
    for (const node of result) expect(store.nameOf(node)).toBe('price')
  })

  it('a descendant step excludes the context node itself', () => {
    const { store, source } = parseXml('<price><price>nested</price></price>')
    // cars//price should find only the *inner* price, not the outer
    // context node that happens to share the same name.
    const result = run(store, source, 'price//price')
    expect(result).toHaveLength(1)
  })

  it('a descendant step over a nested-context match set does not double-count (regression)', () => {
    // <d><d><t/></d></d> — //d matches both the outer and inner <d>. //t
    // must find the single <t/> exactly once, not once per matching
    // ancestor context.
    const { store, source } = parseXml('<d><d><t/></d></d>')
    const result = run(store, source, '//d//t')
    expect(result).toHaveLength(1)
  })

  it('a wildcard descendant step over nested contexts does not double- or triple-count', () => {
    const { store, source } = parseXml('<a><a><a><t/></a></a></a>')
    // //a matches all three nested <a> elements (a context set with
    // ascending, nested spans); //a//* must find each genuine descendant
    // exactly once, not once per matching ancestor.
    const result = run(store, source, '//a//*')
    // Descendants across the whole document, deduplicated: the two inner
    // <a>s and the <t/> = 3 nodes, not the 6 a triple-count would produce.
    expect(result).toHaveLength(3)
  })

  it('a name absent from the document evaluates to empty, not an error', () => {
    const { store, source } = parseXml('<zoo><cat/></zoo>')
    expect(run(store, source, 'zoo/nonexistent')).toEqual([])
    expect(run(store, source, 'zoo//nonexistent')).toEqual([])
  })

  it('a wildcard child step matches every child', () => {
    const { store, source } = parseXml('<zoo><cat/><dog/><fish/></zoo>')
    expect(run(store, source, 'zoo/*')).toHaveLength(3)
  })

  it('a wildcard descendant step matches every descendant', () => {
    const { store, source } = parseXml('<zoo><cat><ear/></cat><dog/></zoo>')
    // zoo's descendants: cat, ear, dog = 3
    expect(run(store, source, 'zoo//*')).toHaveLength(3)
  })

  it('is measurably sublinear vs. a full scan, past the old scan-cap size', () => {
    // Not a timing assertion (that's G10's job) — a correctness check that
    // the index-based path finds a match placed well past where a naive
    // 200,000-node scan cap (the old findNodesByName's own limit) would
    // have missed it.
    const children = Array.from({ length: 300 }, (_, i) =>
      i === 250 ? '<needle/>' : '<hay/>'
    ).join('')
    const { store, source } = parseXml(`<zoo>${children}</zoo>`)
    expect(run(store, source, 'zoo//needle')).toHaveLength(1)
  })
})

describe('R132 — existence predicates', () => {
  it('[@id] selects cars carrying an id attribute, including id=""', () => {
    const { store, source } = parseXml('<cars><car id="a"/><car id=""/><car/></cars>')
    expect(run(store, source, 'cars/car[@id]')).toHaveLength(2)
  })

  it('[price] selects cars with a price child, including an empty one and one with only element children', () => {
    const { store, source } = parseXml(
      '<cars><car><price>10</price></car><car><price></price></car>' +
        '<car><price><a/></price></car><car/></cars>'
    )
    expect(run(store, source, 'cars/car[price]')).toHaveLength(3)
  })

  it('[@*] / [*] select on any attribute / any child element', () => {
    const { store, source } = parseXml('<cars><car a="1"/><car/><car><x/></car></cars>')
    expect(run(store, source, 'cars/car[@*]')).toHaveLength(1)
    expect(run(store, source, 'cars/car[*]')).toHaveLength(1)
  })

  it('car[price<=100] excludes a car with no price element at all — the baseline not() is measured against', () => {
    const { store, source } = parseXml('<cars><car><price>50</price></car><car/></cars>')
    expect(run(store, source, 'cars/car[price<=100]')).toHaveLength(1)
  })
})

describe('R138–R139 — and/or/not evaluation', () => {
  it('[price>100 and year<2000] is exactly the intersection', () => {
    const { store, source } = parseXml(
      '<cars>' +
        '<car><price>200</price><year>1990</year></car>' + // both
        '<car><price>200</price><year>2010</year></car>' + // price only
        '<car><price>50</price><year>1990</year></car>' + // year only
        '<car><price>50</price><year>2010</year></car>' + // neither
        '</cars>'
    )
    expect(run(store, source, 'cars/car[price>100 and year<2000]')).toHaveLength(1)
  })

  it('[@id or @name] is exactly the union', () => {
    const { store, source } = parseXml(
      '<cars><car id="a"/><car name="b"/><car id="c" name="d"/><car/></cars>'
    )
    expect(run(store, source, 'cars/car[@id or @name]')).toHaveLength(3)
  })

  it('[and] is existence on a MathML <and/> element; [and and or] requires both', () => {
    const { store, source } = parseXml(
      '<cars>' + '<car><and/></car>' + '<car><and/><or/></car>' + '<car><or/></car>' + '</cars>'
    )
    expect(run(store, source, 'cars/car[and]')).toHaveLength(2)
    expect(run(store, source, 'cars/car[and and or]')).toHaveLength(1)
  })

  it('[a or b and c] groups as [a or (b and c)], distinct from [(a or b) and c]', () => {
    const { store, source } = parseXml(
      '<cars>' +
        '<car><a/></car>' + // a alone: matches "a or (b and c)"; fails "(a or b) and c" (no c)
        '<car><b/><c/></car>' + // b and c: matches both
        '<car><b/></car>' + // b alone: matches neither
        '</cars>'
    )
    expect(run(store, source, 'cars/car[a or b and c]')).toHaveLength(2)
    expect(run(store, source, 'cars/car[(a or b) and c]')).toHaveLength(1)
  })

  it('not(@id) negates, and not(not(@id)) is @id again', () => {
    const { store, source } = parseXml('<cars><car id="a"/><car/></cars>')
    expect(run(store, source, 'cars/car[not(@id)]')).toHaveLength(1)
    expect(run(store, source, 'cars/car[not(not(@id))]')).toHaveLength(1)
  })

  it('car[not(price>100)] includes a car with no price element at all (R132/R138 pairing)', () => {
    const { store, source } = parseXml(
      '<cars><car><price>200</price></car><car><price>50</price></car><car/></cars>'
    )
    const result = run(store, source, 'cars/car[not(price>100)]')
    // The 50-price car and the price-less car both satisfy not(price>100);
    // the 200-price car does not.
    expect(result).toHaveLength(2)
    expect(run(store, source, 'cars/car[price<=100]')).toHaveLength(1) // baseline: excludes the price-less car
  })

  it('and short-circuits: an unresolved second term never touches the store, matching every candidate through the first term alone', () => {
    // "nope" is absent from the whole document, so the second existence
    // leaf constant-folds to `false` — [price and nope] must select
    // nothing despite every car having a price, and must not throw.
    const { store, source } = parseXml('<cars><car><price>1</price></car></cars>')
    expect(run(store, source, 'cars/car[price and nope]')).toHaveLength(0)
    expect(run(store, source, 'cars/car[not(nope)]')).toHaveLength(1)
  })
})

describe('evaluatePath — predicates', () => {
  it('a positional predicate selects the Nth match, grouped by parent', () => {
    const { store, source } = parseXml('<zoo><cat/><cat/><cat/></zoo>')
    const result = run(store, source, 'zoo/cat[2]')
    expect(result).toHaveLength(1)
    // The second of the three <cat/> children.
    const catRefs = [...store.childrenOf(1)]
    expect(result[0]).toBe(catRefs[1])
  })

  it('a positional predicate out of range yields nothing', () => {
    const { store, source } = parseXml('<zoo><cat/></zoo>')
    expect(run(store, source, 'zoo/cat[5]')).toEqual([])
  })

  it('a facet predicate matches an exact attribute value', () => {
    const { store, source } = parseXml('<cars><car id="c-001"/><car id="c-002"/></cars>')
    const result = run(store, source, 'cars/car[@id="c-002"]')
    expect(result).toHaveLength(1)
    let value: string | null = null
    for (const attr of store.attributesOf(result[0]!)) {
      if (store.textOf(attr.nameId) === 'id') value = source.slice(attr.valueStart, attr.valueEnd)
    }
    expect(value).toBe('c-002')
  })

  it('a facet predicate with no matching value yields nothing', () => {
    const { store, source } = parseXml('<cars><car id="c-001"/></cars>')
    expect(run(store, source, 'cars/car[@id="does-not-exist"]')).toEqual([])
  })
})

/**
 * R129 acceptance 1 and 3 — the six operators against both a child-element
 * and an `@attribute` subject, on a hand-checked fixture. Every assertion
 * names the exact set, not its size: R17's span bug was invisible to every
 * shape-only assertion in the suite.
 */
describe('evaluatePath — comparison predicates (R129)', () => {
  // Five cars, `id` doubling as the row label so a failure says which rows
  // came back. `price` is both a child element and an attribute so the two
  // subject axes can be asserted against identical data.
  const FIXTURE =
    '<cars>' +
    '<car id="a" price="10"><price>10</price><make>BMW</make></car>' +
    '<car id="b" price="100"><price>100</price><make>Audi</make></car>' +
    '<car id="c" price="1000"><price>1000</price><make>BMW</make></car>' +
    '<car id="d" price="x"><price>x</price><make>Fiat</make></car>' +
    '<car id="e"><make>Opel</make></car>' +
    '</cars>'

  function ids(query: string): string[] {
    const { store, source } = parseXml(FIXTURE)
    const out: string[] = []
    for (const node of run(store, source, query)) {
      for (const attr of store.attributesOf(node)) {
        if (store.textOf(attr.nameId) === 'id')
          out.push(source.slice(attr.valueStart, attr.valueEnd))
      }
    }
    return out
  }

  const numericCases: readonly [string, string[]][] = [
    ['cars/car[price>100]', ['c']],
    ['cars/car[price>=100]', ['b', 'c']],
    ['cars/car[price<100]', ['a']],
    ['cars/car[price<=100]', ['a', 'b']],
    ['cars/car[price=100]', ['b']],
    // `!=` is true for every car with a numeric price other than 100 — and
    // false for `d` (non-numeric, so NaN !== 100 is true... but the value
    // *exists*, so this one really is a match) and for `e` (no <price> at
    // all, so no value and therefore false, §5's rule).
    ['cars/car[price!=100]', ['a', 'c', 'd']]
  ]

  for (const [query, expected] of numericCases) {
    it(`${query} selects exactly ${JSON.stringify(expected)} against a child element`, () => {
      expect(ids(query)).toEqual(expected)
    })

    it(`${query.replace('[price', '[@price')} selects the same set against an attribute`, () => {
      expect(ids(query.replace('[price', '[@price'))).toEqual(expected)
    })
  }

  it('a string literal compares as text, so make="BMW" is exact', () => {
    expect(ids('cars/car[make="BMW"]')).toEqual(['a', 'c'])
    expect(ids('cars/car[make!="BMW"]')).toEqual(['b', 'd', 'e'])
    expect(ids('cars/car[make="bmw"]')).toEqual([])
  })

  it('a relational operator against a non-numeric value is false, not an error', () => {
    // `d`'s price is "x": NaN, and every comparison against NaN is false.
    expect(ids('cars/car[price>-99999]')).toEqual(['a', 'b', 'c'])
  })

  it('a relational operator against a non-numeric *literal* is false too', () => {
    expect(ids('cars/car[price>"abc"]')).toEqual([])
  })

  it("a quoted numeric literal still converts for a relational operator (XPath's rule)", () => {
    expect(ids('cars/car[price>"100"]')).toEqual(['c'])
  })

  // R129 acceptance 3 — the rule that surprises people, in its own test.
  it('a missing subject makes every operator false, != included', () => {
    for (const op of ['=', '!=', '<', '<=', '>', '>=']) {
      expect(ids(`cars/car[missing${op}100]`), `child subject, ${op}`).toEqual([])
      expect(ids(`cars/car[@missing${op}100]`), `attribute subject, ${op}`).toEqual([])
    }
    for (const op of ['=', '!=']) {
      expect(ids(`cars/car[missing${op}"x"]`), `child subject, ${op} with a string`).toEqual([])
    }
    // And `e`, which exists but has no <price> child, is absent from every
    // one of the numeric cases above — including `price!=100`.
    expect(ids('cars/car[price!=100]')).not.toContain('e')
  })

  it('the subject is existential: any matching child satisfies the predicate', () => {
    const { store, source } = parseXml(
      '<cars><car id="a"><p>1</p><p>500</p></car><car id="b"><p>1</p><p>2</p></car></cars>'
    )
    const result = run(store, source, 'cars/car[p>100]')
    expect(result).toHaveLength(1)
    expect(store.nameOf(result[0]!)).toBe('car')
  })

  it('a comparison predicate works on a descendant step and on a wildcard step', () => {
    expect(ids('//car[price>100]')).toEqual(['c'])
    expect(ids('cars/*[price>100]')).toEqual(['c'])
  })

  it('evaluates against JSON identically (invariant 8)', () => {
    // JSON's array items are unnamed, so the predicate rides a wildcard
    // step — the same query shape, against the other format's tree.
    const json = parseJson(
      '{"cars":[{"id":"a","price":10},{"id":"b","price":100},{"id":"c","price":1000}]}'
    )
    const result = run(json.store, json.source, '//*[price>100]')
    expect(result).toHaveLength(1)
    const priceChild = [...json.store.childrenOf(result[0]!)].find(
      (n) => json.store.nameOf(n) === 'price'
    )!
    const span = json.store.valueOf(priceChild)!
    expect(json.source.slice(span.start, span.end)).toBe('1000')
  })

  it('a value held by a CData child rather than folded onto the node is still read', () => {
    // `NodeStore.valueOf` has two representations and `readValueSpan` (the
    // allocation-free mirror of it) must handle both: CDATA is the one
    // that reaches the lone-child branch.
    const { store, source } = parseXml('<cars><car><price><![CDATA[1000]]></price></car></cars>')
    const priceRef = run(store, source, '//price')[0]!
    expect(store.valueStartOf(priceRef)).toBe(-1) // not folded — the branch under test
    expect(run(store, source, 'cars/car[price>100]')).toHaveLength(1)
    expect(run(store, source, 'cars/car[price>10000]')).toHaveLength(0)
  })

  it('compares bytes in a non-UTF-8 document without decoding (R53 encodings)', () => {
    // "<c v="café"/>" in windows-1252 — 0xE9 is 'é' in that page. The
    // needle is encoded into the document's encoding once per query, so a
    // JS-string literal matches bytes that are not UTF-8.
    const bytes = Uint8Array.from([
      0x3c, 0x63, 0x20, 0x76, 0x3d, 0x22, 0x63, 0x61, 0x66, 0xe9, 0x22, 0x2f, 0x3e
    ])
    const store = new NodeStore(bytes, new Interner())
    const parsed = xmlFormatModule.parse(bytes, store, { maxDepth: 1000, encoding: 'windows-1252' })
    expect(parsed.complete).toBe(true)
    const source = new SourceBuffer(bytes, 'windows-1252', 0)
    expect(run(store, source, 'c[@v="café"]')).toHaveLength(1)
    expect(run(store, source, 'c[@v="cafe"]')).toHaveLength(0)
  })
})

describe('evaluatePath — identical results across XML and JSON (invariant 8)', () => {
  it('//price finds the same count of named nodes in both formats', () => {
    const xml = parseXml('<cars><car><price>100</price></car><car><price>200</price></car></cars>')
    const json = parseJson('{"cars":[{"price":100},{"price":200}]}')

    const xmlResult = run(xml.store, xml.source, '//price')
    const jsonResult = run(json.store, json.source, '//price')

    expect(xmlResult).toHaveLength(2)
    expect(jsonResult).toHaveLength(2)
    for (const node of xmlResult) expect(xml.store.nameOf(node)).toBe('price')
    for (const node of jsonResult) expect(json.store.nameOf(node)).toBe('price')
  })

  it('a wildcard step reaches the same named leaves in both formats', () => {
    // The query differs by one wildcard step, and the raw descendant
    // *count* differs too — not because the evaluator special-cases either
    // format, but because the two trees genuinely differ in shape here.
    // JSON's D-030 node density means a property whose value is itself an
    // object/array gets one extra node (the value's own Object/Array node,
    // distinct from the Property that names it) that XML's element model
    // has no equivalent of — an XML document's root element is Document's
    // own child, while a JSON document's top-level value is wrapped in an
    // unnamed Object/Array that Document's child actually is. What *is*
    // identical across both is which leaf names are reachable underneath —
    // the actual "same query language, same answer" claim §6.3 makes.
    const xml = parseXml('<root><a><b/><c/></a></root>')
    const json = parseJson('{"a":{"b":1,"c":2}}')

    const xmlNames = run(xml.store, xml.source, 'root/a//*')
      .map((n) => xml.store.nameOf(n))
      .sort()
    const jsonNames = run(json.store, json.source, '*/a//*')
      .map((n) => json.store.nameOf(n))
      .filter((name): name is string => name !== null)
      .sort()

    expect(xmlNames).toEqual(['b', 'c'])
    expect(jsonNames).toEqual(['b', 'c'])
  })
})
