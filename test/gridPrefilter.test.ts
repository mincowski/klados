/**
 * R214 (`docs/plans/R214-filter-pass.md` § 4) — the byte prefilter may only ever
 * remove rows that could not have matched. This is the differential test the
 * plan made a condition of building it: generated documents in all four formats,
 * needles drawn from what their cells actually display, and a prefiltered pass
 * compared with a plain one on every field of the outcome.
 *
 * The generators aim at the cases where displayed text is not the bytes:
 * separators (` · `, `, `, mixed-content spaces), generated counts (`3 items`,
 * `1 field`, `0 items`), stripped JSON quotes, and the two code points that
 * lower-case to ASCII (U+0130, U+212A). Narrowing (§ 3) and slicing (§ 2) are
 * checked against the same plain pass.
 */
import { describe, expect, it } from 'vitest'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { FormatModule, NodeRef, ParseOptions } from '../src/core/types'
import { csvFormatModule } from '../src/formats/csv/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { tomlFormatModule } from '../src/formats/toml/index'
import { xmlFormatModule } from '../src/formats/xml/index'
import { rowFields } from '../src/renderer/components/Detail/gridCell'
import { collectColumns } from '../src/renderer/components/Detail/gridColumns'
import { detectGrid, type GridGroup } from '../src/renderer/components/Detail/gridDetection'
import {
  createFilterPass,
  filterIndices,
  narrowedRows,
  type FilterOutcome,
  type GridFilters
} from '../src/renderer/components/Detail/gridFilter'
import { prefilterTokenFor, rowMayMatch } from '../src/renderer/components/Detail/gridPrefilter'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

// mulberry32 — deterministic, the generator shape the invariant tests use.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rand = () => number
const pick = <T>(rand: Rand, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

/** Values chosen to collide with what the grid generates or joins. */
const WORDS = [
  'Golf',
  'GOLF',
  'items',
  'Item',
  'fields',
  'field',
  '3',
  '12',
  'Kilo',
  'KELVIN',
  '\u212Aelvin', // KELVIN SIGN, lower-cases to `k`
  '\u0130stanbul', // I WITH DOT ABOVE, lower-cases to `i̇`
  'caf\u00e9',
  'cafe\u0301',
  'a, b',
  'x · y',
  'diesel',
  '110',
  'Smith',
  'Jones',
  'car',
  'name',
  'v1'
]

const text = (rand: Rand): string =>
  Array.from({ length: 1 + Math.floor(rand() * 2) }, () => pick(rand, WORDS)).join(
    pick(rand, [' ', '', '-', ', '])
  )

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

function genXml(rand: Rand): string {
  const rows: string[] = []
  const n = 3 + Math.floor(rand() * 6)
  for (let r = 0; r < n; r++) {
    let body = ''
    const attrs = rand() < 0.6 ? ` id="${escapeXml(text(rand))}"` : ''
    if (rand() < 0.8) body += `<name>${escapeXml(text(rand))}</name>`
    if (rand() < 0.5)
      body += `<owner>${escapeXml(text(rand))}</owner><owner>${escapeXml(text(rand))}</owner>`
    if (rand() < 0.5)
      body += `<engine><type>${escapeXml(text(rand))}</type><kw>${Math.floor(rand() * 300)}</kw></engine>`
    if (rand() < 0.3) body += '<extras><a><b>1</b></a><c><d>2</d></c></extras>' // composite, no valued children
    if (rand() < 0.3) body += '<part><x>1</x></part><part><x>2</x></part><part><x>3</x></part>' // repeated composite
    if (rand() < 0.3)
      body += `<desc>${escapeXml(text(rand))} <b>${escapeXml(text(rand))}</b> ${escapeXml(text(rand))}</desc>`
    if (rand() < 0.2) body += '<sunroof/>'
    rows.push(`<car${attrs}>${body}</car>`)
  }
  return `<garage>${rows.join('')}<meta><n>1</n></meta><meta><n>2</n></meta></garage>`
}

const jsonString = (s: string): string => JSON.stringify(s)

function genJson(rand: Rand): string {
  const rows: string[] = []
  const n = 3 + Math.floor(rand() * 6)
  for (let r = 0; r < n; r++) {
    const fields: string[] = []
    if (rand() < 0.8) fields.push(`"name": ${jsonString(text(rand))}`)
    if (rand() < 0.4) fields.push(`"year": ${Math.floor(rand() * 3000)}`)
    if (rand() < 0.4) fields.push(`"owner": [${jsonString(text(rand))}, ${jsonString(text(rand))}]`)
    if (rand() < 0.3) fields.push(`"one": [${jsonString(text(rand))}]`)
    if (rand() < 0.3) fields.push('"none": []')
    if (rand() < 0.4)
      fields.push(
        `"engine": {"type": ${jsonString(text(rand))}, "kw": ${Math.floor(rand() * 300)}}`
      )
    if (rand() < 0.3) fields.push('"parts": [{"x": 1}, {"x": 2}]')
    if (rand() < 0.3) fields.push('"nested": {"a": {"b": 1}}')
    if (rand() < 0.2) fields.push('"flag": null')
    rows.push(`{${fields.join(', ')}}`)
  }
  return `{"cars": [${rows.join(', ')}]}`
}

function genToml(rand: Rand): string {
  const tables: string[] = []
  const n = 3 + Math.floor(rand() * 6)
  for (let r = 0; r < n; r++) {
    const lines = ['[[car]]']
    if (rand() < 0.8) lines.push(`name = ${jsonString(text(rand))}`)
    if (rand() < 0.4) lines.push(`kw = ${Math.floor(rand() * 300)}`)
    if (rand() < 0.4) lines.push(`owner = [${jsonString(text(rand))}, ${jsonString(text(rand))}]`)
    if (rand() < 0.3) lines.push('none = []')
    if (rand() < 0.4) lines.push(`engine = { type = ${jsonString(text(rand))}, kw = 7 }`)
    tables.push(lines.join('\n'))
  }
  return tables.join('\n\n') + '\n'
}

function genCsv(rand: Rand): string {
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`
  const lines = ['name,owner,kw,note']
  const n = 3 + Math.floor(rand() * 8)
  for (let r = 0; r < n; r++) {
    lines.push(
      [
        quote(text(rand)),
        quote(text(rand)),
        String(Math.floor(rand() * 300)),
        rand() < 0.3 ? '' : quote(text(rand))
      ].join(',')
    )
  }
  return lines.join('\n') + '\n'
}

const FORMATS: readonly (readonly [string, FormatModule, (rand: Rand) => string])[] = [
  ['xml', xmlFormatModule, genXml],
  ['json', jsonFormatModule, genJson],
  ['toml', tomlFormatModule, genToml],
  ['csv', csvFormatModule, genCsv]
]

function parse(format: FormatModule, doc: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(doc)
  const store = new NodeStore(bytes, new Interner())
  format.parse(bytes, store, OPTIONS)
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

function tablesOf(store: NodeStore): GridGroup[] {
  const tables: GridGroup[] = []
  const stack: NodeRef[] = [0]
  while (stack.length > 0) {
    const node = stack.pop()!
    tables.push(...detectGrid(store, node).tables)
    for (const child of store.childrenOf(node)) stack.push(child)
  }
  return tables
}

/** Needles the display could contain: substrings of real cell text, across
 * separators and generated counts, plus fixed probes for each hazard. */
function needlesFor(
  rand: Rand,
  store: NodeStore,
  source: SourceBuffer,
  members: readonly NodeRef[]
): string[] {
  const texts: string[] = []
  for (const row of members)
    for (const [, cell] of rowFields(store, source, row)) if (cell.text) texts.push(cell.text)
  const needles = [
    'k',
    'i',
    'K',
    'I',
    'item',
    'items',
    'field',
    '1 field',
    '0',
    '3',
    '2 items',
    ', ',
    ' · ',
    'olf',
    'car',
    'zz',
    'kelvin',
    'istanbul',
    '"'
  ]
  for (let i = 0; i < 12 && texts.length > 0; i++) {
    const t = pick(rand, texts)
    const a = Math.floor(rand() * t.length)
    const b = Math.min(t.length, a + 1 + Math.floor(rand() * 8))
    needles.push(rand() < 0.5 ? t.slice(a, b) : t.slice(a, b).toUpperCase())
  }
  return needles
}

function expectSame(actual: FilterOutcome, expected: FilterOutcome, label: string): void {
  expect(actual.indices, label).toEqual(expected.indices)
  expect(actual.hiddenMatchCount, label).toBe(expected.hiddenMatchCount)
  expect([...actual.hiddenMatchColumns].sort(), label).toEqual(
    [...expected.hiddenMatchColumns].sort()
  )
  expect(actual.anywhere, label).toEqual(expected.anywhere)
}

const quick = (text: string, perColumn: ReadonlyMap<number, string> = new Map()): GridFilters => ({
  quick: text,
  perColumn
})

describe('R214 — the byte prefilter never removes a matching row', () => {
  for (const [name, format, generate] of FORMATS) {
    it(`${name}: prefiltered, narrowed and sliced passes equal the plain pass`, () => {
      const rand = mulberry32(214 + name.length)
      let compared = 0
      let prefiltered = 0
      for (let d = 0; d < 60; d++) {
        const { store, source } = parse(format, generate(rand))
        for (const table of tablesOf(store)) {
          const { columns, overflow } = collectColumns(store, table.members)
          // Hide a random column sometimes, so hidden-column matches are exercised.
          const all = [...columns, ...overflow]
          const visible = rand() < 0.5 || all.length < 2 ? all : all.filter(() => rand() < 0.6)
          for (const needle of needlesFor(rand, store, source, table.members)) {
            const filters = quick(needle)
            const plain = filterIndices(store, source, table.members, visible, filters, {
              prefilter: false
            })
            const fast = filterIndices(store, source, table.members, visible, filters)
            expectSame(fast, plain, `${name} doc ${d} needle ${JSON.stringify(needle)}`)
            compared++
            if (prefilterTokenFor(needle.trim().toLowerCase(), source) !== null) prefiltered++

            // Narrowing: the needle's prefix first, then the needle.
            if (needle.trim().length > 1) {
              const prefix = quick(needle.trim().slice(0, -1))
              const base = {
                store,
                source,
                members: table.members,
                filters: prefix,
                outcome: filterIndices(store, source, table.members, visible, prefix)
              }
              const within = narrowedRows(base, store, source, table.members, filters)
              if (within !== null) {
                const narrowed = filterIndices(store, source, table.members, visible, filters, {
                  within
                })
                expectSame(narrowed, plain, `${name} narrowed ${JSON.stringify(needle)}`)
              }
            }

            // With a column filter too, so the two combine.
            if (visible.length > 0 && rand() < 0.3) {
              const column = pick(rand, visible)
              const both = quick(
                needle,
                new Map([[column.nameId, pick(rand, ['a', 'o', '1', ''])]])
              )
              expectSame(
                filterIndices(store, source, table.members, visible, both),
                filterIndices(store, source, table.members, visible, both, { prefilter: false }),
                `${name} with column filter ${JSON.stringify(needle)}`
              )
            }
          }
        }
      }
      // The test is only worth something if both paths were really exercised.
      expect(compared).toBeGreaterThan(500)
      expect(prefiltered).toBeGreaterThan(compared / 4)
    })
  }

  it('a pass stepped with a deadline already passed still reaches the same outcome', () => {
    const rand = mulberry32(99)
    const rows = Array.from(
      { length: 2000 },
      (_, i) => `<car><name>${text(rand)} ${i}</name><kw>${i}</kw></car>`
    ).join('')
    const { store, source } = parse(xmlFormatModule, `<garage>${rows}</garage>`)
    const table = tablesOf(store).find((t) => t.members.length > 2)!
    const { columns } = collectColumns(store, table.members)
    const pass = createFilterPass(store, source, table.members, columns, quick('o'))
    let outcome: FilterOutcome | null = null
    let slices = 0
    while (outcome === null) {
      outcome = pass.step(0)
      slices++
    }
    // More rows than one slice checks the clock after, so the pass really was
    // resumed rather than finishing in its first step.
    expect(table.members.length).toBeGreaterThan(1000)
    expect(slices).toBeGreaterThan(1)
    expectSame(
      outcome,
      filterIndices(store, source, table.members, columns, quick('o'), { prefilter: false }),
      'sliced'
    )
  })

  it('the documented hazards are not prefiltered, and ordinary needles are', () => {
    const plain = parse(xmlFormatModule, '<a><b><c>x</c></b><b><c>y</c></b></a>').source
    expect(prefilterTokenFor('golf', plain)).not.toBeNull()
    expect(prefilterTokenFor('kilo', plain)).not.toBeNull()
    expect(prefilterTokenFor(`caf${String.fromCodePoint(0xe9)}`, plain)).toBeNull()
    // A run that could come from a generated count is not prefiltered at all.
    expect(prefilterTokenFor('item', plain)).toBeNull()
    expect(prefilterTokenFor('fields', plain)).toBeNull()
    expect(prefilterTokenFor('2016', plain)).toBeNull()
    expect(prefilterTokenFor('2016x', plain)).not.toBeNull()
    // The longest run between separators is what gets searched for.
    expect(new TextDecoder().decode(prefilterTokenFor('ab, golfer', plain)!.bytes)).toBe('golfer')
    expect(prefilterTokenFor(', ', plain)).toBeNull()
  })

  it('a row whose values hold a character that lower-cases to i or k stays a candidate', () => {
    const kelvin = String.fromCodePoint(0x212a)
    const dotted = String.fromCodePoint(0x130)
    const { store, source } = parse(
      xmlFormatModule,
      `<a><b><c>${kelvin}ilo</c></b><b><c>${dotted}stanbul</c></b><b><c>plain</c></b></a>`
    )
    const [kilo, istanbul, other] = [...store.childrenOf(store.firstChildOf(0))]
    const kiloToken = prefilterTokenFor('kilo', source)!
    const istanbulToken = prefilterTokenFor('istanbul', source)!
    expect(rowMayMatch(store, source, kilo!, kiloToken)).toBe(true)
    expect(rowMayMatch(store, source, other!, kiloToken)).toBe(false)
    expect(rowMayMatch(store, source, istanbul!, istanbulToken)).toBe(true)
    expect(rowMayMatch(store, source, other!, istanbulToken)).toBe(false)
    // Only the character the run needs: `kelp` has no `i`, so U+0130 does not keep a row.
    const kelpToken = prefilterTokenFor('kelp', source)!
    expect(rowMayMatch(store, source, istanbul!, kelpToken)).toBe(false)
    expect(rowMayMatch(store, source, kilo!, kelpToken)).toBe(true)
  })
})
