import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { csvFormatModule } from '../src/formats/csv/index'
import { detectGrid, GRID_MIN_MEMBERS } from '../src/renderer/components/Detail/gridDetection'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const jsonOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, xmlOptions)
  return { store }
}

/** Namespace resolution enabled — R136's own tests need this; every test
 * above uses the plain `parseXml` above, matching `nameIdOf`'s raw
 * behaviour unchanged. */
function parseXmlNamespaced(text: string): { store: NodeStore } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, xmlOptions)
  return { store }
}

function parseJson(text: string): { store: NodeStore } {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  jsonFormatModule.parse(source, store, jsonOptions)
  return { store }
}

const ROOT = 0

/** Table names in render order — the assertion most of these tests want, and
 * short enough to read as one line. `-1` is the unnamed group JSON and CSV
 * rows form. */
function tableNames(store: NodeStore, node: number): string[] {
  return detectGrid(store, node).tables.map((t) =>
    t.nameId === -1 ? '(unnamed)' : store.textOf(t.nameId)
  )
}

describe('detectGrid (M2-PLAN.md E1)', () => {
  it('detects one car group under the Appendix A shape (garage > cars > elements > car*3)', () => {
    const { store } = parseXml(
      '<garage><cars><elements>' +
        '<car id="c-001"><name>Golf</name></car>' +
        '<car id="c-002"><name>Model 3</name></car>' +
        '<car id="c-003"><name>Panda</name></car>' +
        '</elements></cars></garage>'
    )
    const garage = store.firstChildOf(ROOT)
    const cars = store.firstChildOf(garage)
    const elements = store.firstChildOf(cars)

    const result = detectGrid(store, elements)

    expect(result.compositeChildCount).toBe(3)
    expect(result.tables).toHaveLength(1)
    expect(store.textOf(result.tables[0]!.nameId)).toBe('car')
    expect(result.tables[0]!.members).toHaveLength(3)
  })

  it('produces no table for a single occurrence (below GRID_MIN_MEMBERS)', () => {
    const { store } = parseXml('<garage><car id="c-001"><name>Golf</name></car></garage>')
    const garage = store.firstChildOf(ROOT)
    const result = detectGrid(store, garage)

    expect(result.compositeChildCount).toBe(1)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]!.members.length).toBeLessThan(GRID_MIN_MEMBERS)
    expect(result.tables).toHaveLength(0)
  })

  it('never groups scalar (non-composite) children', () => {
    // Leaf elements (folded scalar values, D-030) and an empty element have
    // no children of their own — non-composite, per CONCEPT.md §3.2 — and
    // must not enter a group even though several share a name.
    const { store } = parseXml(
      '<car>' +
        '<owner>Smith</owner>' +
        '<owner>Jones</owner>' +
        '<owner>Lee</owner>' +
        '<sunroof/>' +
        '<engine><type>diesel</type></engine>' +
        '</car>'
    )
    const car = store.firstChildOf(ROOT)
    const result = detectGrid(store, car)

    // Only <engine> has a child of its own; three <owner> and one <sunroof>
    // are leaves and never counted as composite.
    expect(result.compositeChildCount).toBe(1)
    expect(result.tables).toHaveLength(0)
  })

  it('groups repeating attribute-only leaf elements (D-088, from R149/CSV)', () => {
    // <car/> here has no child nodes at all, only attributes — the exact
    // shape a CSV row is, since R145 §2 emits fields as facets rather than
    // children. Excluded from grouping before D-088 (the plain "has
    // children" test), which meant a CSV file could never produce a grid.
    const { store } = parseXml(
      '<cars>' +
        '<car color="red" make="Toyota"/>' +
        '<car color="blue" make="Honda"/>' +
        '<car color="green" make="Ford"/>' +
        '</cars>'
    )
    const cars = store.firstChildOf(ROOT)
    const result = detectGrid(store, cars)
    expect(result.compositeChildCount).toBe(3)
    expect(result.tables).toHaveLength(1)
    expect(result.tables[0]!.members).toHaveLength(3)
  })

  it('still excludes an attribute-less, child-less leaf like <sunroof/> (D-088 does not widen this case)', () => {
    const { store } = parseXml('<car><sunroof/><sunroof/></car>')
    const car = store.firstChildOf(ROOT)
    const result = detectGrid(store, car)
    expect(result.compositeChildCount).toBe(0)
    expect(result.tables).toHaveLength(0)
  })

  it('groups unnamed composite JSON array elements together (all share NO_NAME)', () => {
    const { store } = parseJson(
      '{"items":[{"id":1,"name":"a"},{"id":2,"name":"b"},{"id":3,"name":"c"}]}'
    )
    const topObject = store.firstChildOf(ROOT)
    const itemsProperty = store.firstChildOf(topObject)
    const itemsArray = store.firstChildOf(itemsProperty)

    const result = detectGrid(store, itemsArray)

    expect(result.compositeChildCount).toBe(3)
    expect(result.tables).toHaveLength(1)
    expect(result.tables[0]!.nameId).toBe(-1)
    expect(result.tables[0]!.members).toHaveLength(3)
  })

  it('the same document shape produces the same result through JSON as XML (no formatId branch)', () => {
    const { store: xmlStore } = parseXml(
      '<root><car><name>Golf</name></car><car><name>Polo</name></car></root>'
    )
    const xmlRoot = xmlStore.firstChildOf(ROOT)
    const xmlResult = detectGrid(xmlStore, xmlRoot)

    const { store: jsonStore } = parseJson('{"cars":[{"name":"Golf"},{"name":"Polo"}]}')
    const jsonTopObject = jsonStore.firstChildOf(ROOT)
    const carsProperty = jsonStore.firstChildOf(jsonTopObject)
    const carsArray = jsonStore.firstChildOf(carsProperty)
    const jsonResult = detectGrid(jsonStore, carsArray)

    expect(xmlResult.compositeChildCount).toBe(jsonResult.compositeChildCount)
    expect(xmlResult.tables[0]!.members.length).toBe(jsonResult.tables[0]!.members.length)
  })

  it('returns no table and no groups for a node with no composite children', () => {
    const { store } = parseXml('<leaf>just text</leaf>')
    const leaf = store.firstChildOf(ROOT)
    const result = detectGrid(store, leaf)

    expect(result.compositeChildCount).toBe(0)
    expect(result.groups).toHaveLength(0)
    expect(result.tables).toHaveLength(0)
  })

  it('detection is a single pass: stays fast for a large, wide fan-out', () => {
    let xml = '<root>'
    const n = 100_000
    for (let i = 0; i < n; i++) xml += `<car><v>${i}</v></car>`
    xml += '</root>'
    const { store } = parseXml(xml)
    const root = store.firstChildOf(ROOT)

    const start = performance.now()
    const result = detectGrid(store, root)
    const elapsed = performance.now() - start

    expect(result.tables[0]!.members).toHaveLength(n)
    // Generous bound for CI variance — the point is "linear and cheap", not
    // a precise budget; §4.3's real number is measured in E10.
    expect(elapsed).toBeLessThan(500)
  })
})

describe('R210 — one table per group (`docs/plans/R210-grid-grouping.md`)', () => {
  it('renders every qualifying group as its own table, in document order', () => {
    // **The case that used to be "largest wins".** 40 books and 3 magazines
    // gave a book table with the magazines listed beneath it; now both are
    // tables, ordered by first appearance rather than by size.
    let xml = '<library>'
    for (let i = 0; i < 40; i++) xml += `<book><title>b${i}</title></book>`
    for (let i = 0; i < 3; i++) xml += `<magazine><title>m${i}</title></magazine>`
    xml += '</library>'

    const { store } = parseXml(xml)
    const library = store.firstChildOf(ROOT)
    const result = detectGrid(store, library)

    expect(result.compositeChildCount).toBe(43)
    expect(tableNames(store, library)).toEqual(['book', 'magazine'])
    expect(result.tables[0]!.members).toHaveLength(40)
    expect(result.tables[1]!.members).toHaveLength(3)
  })

  it('document order, not size order — a small group that appears first is the first table', () => {
    let xml = '<library>'
    for (let i = 0; i < 3; i++) xml += `<magazine><title>m${i}</title></magazine>`
    for (let i = 0; i < 40; i++) xml += `<book><title>b${i}</title></book>`
    xml += '</library>'
    const { store } = parseXml(xml)
    const library = store.firstChildOf(ROOT)
    expect(tableNames(store, library)).toEqual(['magazine', 'book'])
  })

  it('acceptance 1: adding members to a second group never changes which groups render', () => {
    // **The property § 1 exists for**, asserted directly rather than inferred
    // from an example. Under the old model this document flipped: at 2
    // `<b>` the table was `<a>`, at 4 it became `<b>`, and the `<a>` rows
    // dropped into the list beneath.
    function doc(bCount: number): string {
      let xml = '<root>'
      for (let i = 0; i < 3; i++) xml += `<a><v>${i}</v></a>`
      for (let i = 0; i < bCount; i++) xml += `<b><v>${i}</v></b>`
      return xml + '</root>'
    }

    const seen = new Set<string>()
    for (const bCount of [2, 3, 4, 10, 100]) {
      const { store } = parseXml(doc(bCount))
      const root = store.firstChildOf(ROOT)
      seen.add(tableNames(store, root).join(','))
    }
    expect([...seen]).toEqual(['a,b'])
  })

  it('acceptance 2: 21 evenly-sized groups render 21 tables, not nothing', () => {
    // **§ 2's cliff, as a regression test.** `GRID_MIN_COVERAGE = 0.05` meant
    // that at 21 equal groups each covered 4.76%, nothing qualified, and the
    // view fell to a plain list — a discontinuity between 20 groups and 21.
    let xml = '<root>'
    for (let g = 0; g < 21; g++) {
      for (let i = 0; i < 2; i++) xml += `<g${g}><v>${i}</v></g${g}>`
    }
    xml += '</root>'
    const { store } = parseXml(xml)
    const root = store.firstChildOf(ROOT)

    const result = detectGrid(store, root)
    expect(result.tables).toHaveLength(21)
    expect(tableNames(store, root)[0]).toBe('g0')
    expect(tableNames(store, root)[20]).toBe('g20')
  })

  it('acceptance 2 again, from the other side: 20 groups behaved and 21 did not', () => {
    for (const groupCount of [20, 21]) {
      let xml = '<root>'
      for (let g = 0; g < groupCount; g++) {
        for (let i = 0; i < 2; i++) xml += `<g${g}><v>${i}</v></g${g}>`
      }
      xml += '</root>'
      const { store } = parseXml(xml)
      const root = store.firstChildOf(ROOT)
      expect(detectGrid(store, root).tables).toHaveLength(groupCount)
    }
  })

  it('acceptance 3: 1000 <car> plus one <metadata> renders exactly as it did before', () => {
    // The common case, and the reason one-table-per-group is not a visible
    // change for most documents: `<metadata>` has a single member, so it
    // stays in the list beneath exactly as it always did.
    let xml = '<garage>'
    for (let i = 0; i < 1000; i++) xml += `<car><v>${i}</v></car>`
    xml += '<metadata><generated>today</generated></metadata></garage>'
    const { store } = parseXml(xml)
    const garage = store.firstChildOf(ROOT)
    const result = detectGrid(store, garage)

    expect(tableNames(store, garage)).toEqual(['car'])
    expect(result.tables[0]!.members).toHaveLength(1000)
    expect(result.groups).toHaveLength(2)
  })

  it('a group of two below any coverage floor is now a table — the floor is gone', () => {
    // This was "a coverage floor below 5% does not qualify even with enough
    // members": 100 singleton fillers plus a `<rare>` pair is 2/102 = 1.96%,
    // which used to disqualify it and leave the document with no table at
    // all. `GRID_MIN_MEMBERS` is the only rule now.
    let xml = '<root>'
    for (let i = 0; i < 100; i++) xml += `<filler${i}><v>${i}</v></filler${i}>`
    xml += '<rare><v>1</v></rare><rare><v>2</v></rare>'
    xml += '</root>'

    const { store } = parseXml(xml)
    const root = store.firstChildOf(ROOT)
    const result = detectGrid(store, root)

    expect(result.compositeChildCount).toBe(102)
    expect(tableNames(store, root)).toEqual(['rare'])
    expect(result.tables[0]!.members).toHaveLength(2)
  })

  it('collects members in the same pass — and with the same eligibility test that counts them', () => {
    // **The defect R210 closed by construction.** Detection counted with
    // `isGridEligible` and `collectGroupMembers` collected with
    // `hasChildren`, so an attribute-only row — every row of every CSV file —
    // was counted and then not collected: a table with no rows. Neither
    // function was wrong alone, which is why it survived R145–R149.
    const source = new TextEncoder().encode('name,age\nAlice,30\nBob,25\nCarol,40\n')
    const store = new NodeStore(source, new Interner())
    csvFormatModule.parse(source, store, { maxDepth: 1000, encoding: 'utf-8' })
    const document = 0
    const array = store.firstChildOf(document)

    const result = detectGrid(store, array)
    expect(result.compositeChildCount).toBe(3)
    expect(result.tables).toHaveLength(1)
    // The assertion that was missing: counted *and* collected.
    expect(result.tables[0]!.members).toHaveLength(result.compositeChildCount)
  })

  it('every member of every group is an eligible child, and no child is in two groups', () => {
    const { store } = parseXml(
      '<root><a><v>1</v></a><b><v>2</v></b><a><v>3</v></a><text>x</text><b><v>4</v></b></root>'
    )
    const root = store.firstChildOf(ROOT)
    const result = detectGrid(store, root)

    const all = result.groups.flatMap((g) => [...g.members])
    expect(all).toHaveLength(result.compositeChildCount)
    expect(new Set(all).size).toBe(all.length)
    // `<text>` folds to a scalar leaf and is not among them.
    expect(result.groups.map((g) => store.textOf(g.nameId)).sort()).toEqual(['a', 'b'])
  })
})

describe('R209 — grid grouping on the raw name, namespace resolution removed', () => {
  /**
   * **R136's inverse, kept in place rather than deleted.** This block used to
   * assert that two prefixes bound to one URI produced ONE grid group. R209
   * removed namespace resolution (D-101), so they produce two — and this file
   * is where a future reader will look to find out whether the merged-group
   * behaviour ever existed and why it went.
   */
  it('two prefixes for one URI produce TWO groups, one per name as written', () => {
    const { store } = parseXmlNamespaced(
      '<root>' +
        '<a:car xmlns:a="urn:cars"><v>1</v></a:car>' +
        '<b:car xmlns:b="urn:cars"><v>2</v></b:car>' +
        '<b:car xmlns:b="urn:cars"><v>3</v></b:car>' +
        '</root>'
    )
    const root = store.firstChildOf(ROOT)
    const result = detectGrid(store, root)

    // Under R136 this was one group of 3. The single `a:car` is a group of
    // one, which never qualified as a table (§4.3 rule: at least 2 members)
    // and renders in the list beneath, per D-014 — that part is unchanged by
    // R210, which only removed the *competition* between qualifying groups.
    expect(result.groups).toHaveLength(2)
    expect(result.tables).toHaveLength(1)
    expect(result.tables[0]!.members).toHaveLength(2)
    expect(store.textOf(result.tables[0]!.nameId)).toBe('b:car')
  })

  it('the same prefix bound to different URIs still produces two groups — for the simpler reason', () => {
    const { store } = parseXmlNamespaced(
      '<root>' +
        '<x xmlns:p="urn:one"><p:car><v>1</v></p:car><p:car><v>2</v></p:car></x>' +
        '<y xmlns:p="urn:two"><p:car><v>3</v></p:car><p:car><v>4</v></p:car></y>' +
        '</root>'
    )
    const root = store.firstChildOf(ROOT)
    const x = store.firstChildOf(root)
    const y = store.nextSiblingOf(x)
    const carsUnderX = detectGrid(store, x)
    const carsUnderY = detectGrid(store, y)
    expect(carsUnderX.tables[0]!.members).toHaveLength(2)
    expect(carsUnderY.tables[0]!.members).toHaveLength(2)

    // **The outcome is unchanged and the reason is inverted.** Under R135
    // these ids differed because `p:car` resolved to two different URIs in
    // two subtrees. Now they are the *same* id — one raw interned name —
    // and the two groups are separate only because `detectGrid` groups one
    // parent's own children. Asserted explicitly, because a test still
    // passing for a different reason is worth saying out loud.
    expect(carsUnderX.tables[0]!.nameId).toBe(carsUnderY.tables[0]!.nameId)
    expect(store.textOf(carsUnderX.tables[0]!.nameId)).toBe('p:car')
  })

  it('the column header shows the prefix as written, and there is no URI to append', () => {
    const { store } = parseXmlNamespaced('<root><a:car xmlns:a="urn:cars">1</a:car></root>')
    const root = store.firstChildOf(ROOT)
    const car = store.firstChildOf(root)
    expect(store.nameOf(car)).toBe('a:car')

    // R209 removed `namespaceUriOfName` along with the tooltip suffix it fed.
    // The header text is unchanged — it always showed the prefix as written.
    expect('namespaceUriOfName' in store).toBe(false)
  })

  it('a single-prefix document groups exactly as it always did', () => {
    // **The case that must not regress** (R209 acceptance 2), and it is
    // almost every namespaced document: one prefix throughout resolved to
    // its own raw name under R136 too, so nothing here ever depended on
    // resolution.
    const { store } = parseXmlNamespaced(
      '<root xmlns:a="urn:cars">' +
        '<a:car><v>1</v></a:car>' +
        '<a:car><v>2</v></a:car>' +
        '<a:car><v>3</v></a:car>' +
        '</root>'
    )
    const root = store.firstChildOf(ROOT)
    const result = detectGrid(store, root)
    expect(result.groups).toHaveLength(1)
    expect(result.tables[0]!.members).toHaveLength(3)
    expect(store.textOf(result.tables[0]!.nameId)).toBe('a:car')
  })

  it('R209 made the two-prefix case two TABLES rather than a table and a list', () => {
    // R209's own Results called this out as not-closed: "a node whose
    // composite children fall into two groups shows one as a table and the
    // rest as a list, with or without namespaces". This is that closing.
    const { store } = parseXmlNamespaced(
      '<root>' +
        '<a:car xmlns:a="urn:cars"><v>1</v></a:car>' +
        '<a:car xmlns:a="urn:cars"><v>2</v></a:car>' +
        '<b:car xmlns:b="urn:cars"><v>3</v></b:car>' +
        '<b:car xmlns:b="urn:cars"><v>4</v></b:car>' +
        '</root>'
    )
    const root = store.firstChildOf(ROOT)
    expect(tableNames(store, root)).toEqual(['a:car', 'b:car'])
  })
})
