#!/usr/bin/env -S npx tsx
/**
 * R214's measurement: where the grid's quick-filter pass spends its time, and what
 * the shipped prefilter and narrowing save — always against the plain pass, and
 * always checked for an **identical** result.
 *
 * Usage: npx tsx spike/r214-filter-pass.ts [fixture] [runs]
 *   fixture defaults to spike/fixtures/cars-200mb.xml; runs to 3 (median).
 *
 *  1. **Breakdown.** Of a plain pass's time, how much is the structural walk,
 *     building and decoding cells, folding case, and the `includes` itself.
 *  2. **The shipped pass** (`gridFilter.ts` with `gridPrefilter.ts`) against the
 *     plain one, per needle. A mismatch in indices, hidden-match count or
 *     hidden-match columns aborts.
 *  3. **Narrowing.** `Golf` over only the rows `Gol` matched anywhere, against a
 *     full pass.
 *
 * Earlier versions carried two prototypes of the prefilter's rules; they were
 * removed once section 2 measured the shipped code, since a copy of the rules
 * here is one more thing to drift (R214 § 9). Measure in the application too:
 * this runs in Node, where `TextDecoder` is far cheaper per call than in the
 * renderer (`FINDINGS.md`).
 *
 * Not wired into `npm test`. Needs `npm run fixtures:generate` first.
 */
import { readFileSync } from 'node:fs'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { NodeRef, ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { rowFields } from '../src/renderer/components/Detail/gridCell'
import { collectColumns } from '../src/renderer/components/Detail/gridColumns'
import { detectGrid } from '../src/renderer/components/Detail/gridDetection'
import {
  filterIndices,
  type FilterResult,
  type GridFilters
} from '../src/renderer/components/Detail/gridFilter'

const fixture = process.argv[2] ?? 'spike/fixtures/cars-200mb.xml'
const RUNS = Number(process.argv[3] ?? 3)
const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
/** The pass without the prefilter — every comparison below is against it. */
const PLAIN = { prefilter: false } as const

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}
function time<T>(fn: () => T): { ms: number; value: T } {
  const times: number[] = []
  let value!: T
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    value = fn()
    times.push(performance.now() - t0)
  }
  return { ms: median(times), value }
}
const fmt = (ms: number): string => `${ms.toFixed(0).padStart(6)} ms`

function sameResult(a: FilterResult, b: FilterResult): boolean {
  if (a.indices.length !== b.indices.length || a.hiddenMatchCount !== b.hiddenMatchCount) return false
  for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) return false
  const ha = [...a.hiddenMatchColumns].sort((x, y) => x - y)
  const hb = [...b.hiddenMatchColumns].sort((x, y) => x - y)
  return ha.length === hb.length && ha.every((x, i) => x === hb[i])
}

// --- load --------------------------------------------------------------------------
const t0 = performance.now()
const bytes = new Uint8Array(readFileSync(fixture))
const store = new NodeStore(bytes, new Interner())
xmlFormatModule.parse(bytes, store, OPTIONS)
const source = new SourceBuffer(bytes, 'utf-8', 0)
console.log(`${fixture}: ${(bytes.length / 1048576).toFixed(0)} MB, ${store.nodeCount.toLocaleString()} nodes, parsed in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

// garage > cars > elements — breadth-first, because the document's first child
// is the `<?xml?>` declaration, which has no children to descend into.
function findTableParent(): NodeRef {
  const queue: NodeRef[] = [0]
  while (queue.length > 0) {
    const node = queue.shift()!
    if (detectGrid(store, node).tables.length > 0) return node
    for (const child of store.childrenOf(node)) queue.push(child)
    if (queue.length > 64) throw new Error('no table near the root')
  }
  throw new Error('no table')
}
const table = detectGrid(store, findTableParent()).tables[0]!
const members = table.members
const { columns } = collectColumns(store, members)
console.log(`group <${store.textOf(table.nameId)}>: ${members.length.toLocaleString()} rows, ${columns.length} visible columns\n`)

const quickFilter = (quick: string): GridFilters => ({ quick, perColumn: new Map() })

// --- 1. breakdown -------------------------------------------------------------------
console.log('1. Where a plain pass goes (no needle matched: `zzzz`)')
const full = time(() => filterIndices(store, source, members, columns, quickFilter('zzzz'), PLAIN)).ms
const structural = time(() => {
  let n = 0
  for (const row of members) {
    for (const _ of store.attributesOf(row)) n++
    for (const child of store.childrenOf(row)) n += store.nameIdOf(child)
  }
  return n
}).ms
const decoded = time(() => {
  let n = 0
  for (const row of members) for (const [, cell] of rowFields(store, source, row)) n += cell.text?.length ?? 0
  return n
}).ms
const folded = time(() => {
  let n = 0
  for (const row of members)
    for (const [, cell] of rowFields(store, source, row)) n += (cell.text ?? '').toLowerCase().length
  return n
}).ms
console.log(`   plain pass                         ${fmt(full)}`)
console.log(`   structural walk only               ${fmt(structural)}`)
console.log(`   rowFields (walk + build + decode)  ${fmt(decoded)}`)
console.log(`   + toLowerCase                      ${fmt(folded)}`)
console.log(`   => includes + loop overhead        ${fmt(full - folded)}`)
console.log(`   per row                            ${((full / members.length) * 1000).toFixed(2)} µs\n`)

// --- 2. the shipped pass --------------------------------------------------------------
console.log('2. The shipped pass against the plain pass')
console.log('   needle        plain       shipped     speed-up')
for (const needle of ['Golf', 'Weber', 'WVW99', 'zzzz', 'car', 'e', 'electric', 'kilo', '2016', 'hybrid 1']) {
  const plain = time(() => filterIndices(store, source, members, columns, quickFilter(needle), PLAIN))
  const shipped = time(() => filterIndices(store, source, members, columns, quickFilter(needle)))
  if (!sameResult(plain.value, shipped.value)) throw new Error(`MISMATCH for ${JSON.stringify(needle)}`)
  console.log(
    `   ${JSON.stringify(needle).padEnd(12)} ${fmt(plain.ms)}   ${fmt(shipped.ms)}   ${(plain.ms / shipped.ms).toFixed(1).padStart(6)}×`
  )
}
console.log('   (every row above: identical indices, hidden-match count and columns)\n')

// --- 3. narrowing -----------------------------------------------------------------
console.log('3. Narrowing: `Golf` over the rows `Gol` matched anywhere')
const gol = filterIndices(store, source, members, columns, quickFilter('Gol'))
const fullGolf = time(() => filterIndices(store, source, members, columns, quickFilter('Golf')))
const narrowed = time(() =>
  filterIndices(store, source, members, columns, quickFilter('Golf'), { within: gol.anywhere })
)
if (!sameResult(fullGolf.value, narrowed.value)) throw new Error('MISMATCH narrowing')
console.log(`   \`Gol\` matched ${gol.anywhere!.length.toLocaleString()} rows anywhere`)
console.log(`   \`Golf\`, full pass      ${fmt(fullGolf.ms)}`)
console.log(`   \`Golf\`, narrowed       ${fmt(narrowed.ms)}   identical result`)
