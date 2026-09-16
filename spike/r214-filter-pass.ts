#!/usr/bin/env -S npx tsx
/**
 * R214's measurement: where the grid's quick-filter pass spends its time, and
 * what two cheaper routes to the **identical** result cost.
 *
 * Usage: npx tsx spike/r214-filter-pass.ts [fixture] [runs]
 *   fixture defaults to spike/fixtures/cars-200mb.xml; runs to 3 (median).
 *
 * Questions, each answered with a number:
 *
 *  1. **Breakdown.** Of `filterIndices`' time, how much is the structural walk
 *     (`rowFields` minus decoding), decoding cells to strings, folding case,
 *     and the `includes` itself.
 *  2. **Byte prefilter.** One Boyer–Moore–Horspool scan over the group's bytes,
 *     ASCII case-folded, marks the rows whose own byte span contains the needle.
 *     Only those rows go through the unchanged exact check. A row whose bytes do
 *     not contain the needle cannot match *literal* text, but the displayed text
 *     also has separators (` · `, `, `, ` `) and generated labels (`3 items`,
 *     `4 fields`) — so a needle that could match those is not prefiltered, and
 *     the bench reports which needles fall back. Every result is compared to the
 *     unfiltered-by-bytes pass for exact equality (indices, hidden-match count,
 *     hidden-match columns); a mismatch aborts.
 *  3. **Narrowing.** Typing `Gol` then `Golf`: the second pass over only the
 *     first pass's matches (visible and hidden), against a full pass.
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

// --- load --------------------------------------------------------------------
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

// --- 1. breakdown ---------------------------------------------------------------
console.log('1. Where a full pass goes (no needle matched: `zzzz`)')
const full = time(() => filterIndices(store, source, members, columns, quickFilter('zzzz'))).ms
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
console.log(`   filterIndices, full pass           ${fmt(full)}`)
console.log(`   structural walk only               ${fmt(structural)}`)
console.log(`   rowFields (walk + build + decode)  ${fmt(decoded)}`)
console.log(`   + toLowerCase                      ${fmt(folded)}`)
console.log(`   => includes + loop overhead        ${fmt(full - folded)}`)
console.log(`   per row, full pass                 ${((full / members.length) * 1000).toFixed(2)} µs\n`)

// --- 2. byte prefilter -----------------------------------------------------------
function asciiFold(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 32 : b
}

/** Needles whose match could come from text the bytes do not contain. */
function prefilterSafe(needle: string): boolean {
  if (needle.length === 0) return false
  for (let i = 0; i < needle.length; i++) if (needle.charCodeAt(i) > 0x7f) return false
  if (/[ ,]/.test(needle)) return false // join separators
  if (/^\d+$/.test(needle)) return false // `3 items`, `4 fields`
  if ('items'.includes(needle) || 'fields'.includes(needle)) return false
  // `toLowerCase` maps U+212A KELVIN SIGN to `k` and U+0130 to `i̇`: a folded cell
  // can contain an ASCII `k`/`i` its bytes do not.
  if (/[ki]/.test(needle)) return false
  return true
}

/** Member indices whose own byte span contains `needle`, ASCII case-folded.
 * One Horspool scan over the whole group range; after a hit the scan jumps to
 * the end of that row, since one hit is all a row needs. */
function candidateRows(needle: string): number[] {
  const nb = new TextEncoder().encode(needle.toLowerCase())
  const m = nb.length
  const last = m - 1
  const shift = new Int32Array(256).fill(m)
  for (let i = 0; i < last; i++) {
    shift[nb[i]!] = last - i
    const upper = nb[i]! >= 0x61 && nb[i]! <= 0x7a ? nb[i]! - 32 : -1
    if (upper >= 0) shift[upper] = last - i
  }
  const out: number[] = []
  let k = 0
  let rowStart = store.spanOf(members[0]!).start
  let rowEnd = store.spanOf(members[0]!).end
  let i = rowStart
  const end = store.spanOf(members[members.length - 1]!).end
  while (i + m <= end) {
    // advance to the row containing i
    while (i >= rowEnd) {
      k++
      if (k >= members.length) return out
      const span = store.spanOf(members[k]!)
      rowStart = span.start
      rowEnd = span.end
      if (i < rowStart) i = rowStart
    }
    if (i + m > rowEnd) {
      i = rowEnd
      continue
    }
    let j = last
    while (j >= 0 && asciiFold(bytes[i + j]!) === nb[j]) j--
    if (j < 0) {
      out.push(k)
      i = rowEnd
      continue
    }
    i += shift[bytes[i + last]!]!
  }
  return out
}

function viaPrefilter(needle: string): FilterResult {
  const quick = needle.trim().toLowerCase()
  if (!prefilterSafe(quick)) return filterIndices(store, source, members, columns, quickFilter(needle))
  const rows = candidateRows(quick)
  const subset = rows.map((r) => members[r]!)
  const result = filterIndices(store, source, subset, columns, quickFilter(needle))
  return {
    indices: result.indices.map((i) => rows[i]!),
    hiddenMatchCount: result.hiddenMatchCount,
    hiddenMatchColumns: result.hiddenMatchColumns
  }
}

// --- v2: value bytes only, token-based, conservative about generated text ---------

/** U+212A (E2 84 AA) and U+0130 (C4 B0) lowercase to ASCII `k` / `i̇`. Checked
 * once over the group's bytes, not per needle. */
function groupHasAsciiLoweringChars(): boolean {
  const start = store.spanOf(members[0]!).start
  const end = store.spanOf(members[members.length - 1]!).end
  for (let i = start; i < end - 1; i++) {
    const b = bytes[i]!
    if (b === 0xe2 && bytes[i + 1] === 0x84 && bytes[i + 2] === 0xaa) return true
    if (b === 0xc4 && bytes[i + 1] === 0xb0) return true
  }
  return false
}
const loweringChars = time(() => groupHasAsciiLoweringChars())

/** The token a row's value bytes must contain for the displayed text to contain
 * the needle: the longest run between join separators. `null` when no such
 * necessary condition exists (every run could come from generated text). */
function prefilterToken(needle: string): { token: string; digits: boolean } | null {
  const runs = needle.split(/[ ,·]+/).filter((r) => r.length > 0)
  runs.sort((a, b) => b.length - a.length)
  for (const run of runs) {
    let ascii = true
    for (let i = 0; i < run.length; i++) if (run.charCodeAt(i) > 0x7f) ascii = false
    if (!ascii) continue
    if (/[ki]/.test(run) && loweringChars.value) continue
    // Digits and substrings of `items`/`fields` can come from a generated count,
    // so rows that could show one stay candidates whatever their bytes say.
    return {
      token: run,
      digits: /^\d+$/.test(run) || 'items'.includes(run) || 'fields'.includes(run)
    }
  }
  return null
}

function subtreeEnd(node: NodeRef): NodeRef {
  for (let n = node; n !== -1; n = store.parentOf(n)) {
    const next = store.nextSiblingOf(n)
    if (next !== -1) return next
  }
  return store.nodeCount
}

/** Whether any cell of `row` could show a generated count (`3 items`, `4 fields`,
 * `0 items`): a composite field that repeats, or whose children carry no value
 * of their own. A superset — a row it names may still show no count. */
function mayGenerateCount(row: NodeRef): boolean {
  const seen = new Map<number, number>()
  for (const child of store.childrenOf(row)) {
    const id = store.nameIdOf(child)
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  for (const child of store.childrenOf(row)) {
    if (store.firstChildOf(child) === -1) continue
    if ((seen.get(store.nameIdOf(child)) ?? 0) > 1) return true
    let anyValue = false
    for (const g of store.childrenOf(child)) if (store.ownValueOf(g) !== null) anyValue = true
    if (!anyValue) return true
  }
  return false
}

function spanContains(start: number, end: number, nb: Uint8Array): boolean {
  const m = nb.length
  const first = nb[0]!
  for (let i = start; i + m <= end; i++) {
    if (asciiFold(bytes[i]!) !== first) continue
    let j = 1
    while (j < m && asciiFold(bytes[i + j]!) === nb[j]) j++
    if (j === m) return true
  }
  return false
}

/** Rows whose attribute values or subtree own-value bytes contain `token`. */
function candidateRowsV2(token: string, digits: boolean): number[] {
  const nb = new TextEncoder().encode(token)
  const out: number[] = []
  for (let k = 0; k < members.length; k++) {
    const row = members[k]!
    let hit = false
    for (const attr of store.attributesOf(row)) {
      if (spanContains(attr.valueStart, attr.valueEnd, nb)) {
        hit = true
        break
      }
    }
    if (!hit) {
      const end = subtreeEnd(row)
      for (let n = row + 1; n < end; n++) {
        const v = store.ownValueOf(n)
        if (v !== null && spanContains(v.start, v.end, nb)) {
          hit = true
          break
        }
      }
    }
    if (!hit && digits && mayGenerateCount(row)) hit = true
    if (hit) out.push(k)
  }
  return out
}

function viaPrefilterV2(needle: string): { result: FilterResult; candidates: number | null } {
  const quick = needle.trim().toLowerCase()
  const plan = prefilterToken(quick)
  if (plan === null)
    return { result: filterIndices(store, source, members, columns, quickFilter(needle)), candidates: null }
  const rows = candidateRowsV2(plan.token, plan.digits)
  const subset = rows.map((r) => members[r]!)
  const result = filterIndices(store, source, subset, columns, quickFilter(needle))
  return {
    result: {
      indices: result.indices.map((i) => rows[i]!),
      hiddenMatchCount: result.hiddenMatchCount,
      hiddenMatchColumns: result.hiddenMatchColumns
    },
    candidates: rows.length
  }
}

function sameResult(a: FilterResult, b: FilterResult): boolean {
  if (a.indices.length !== b.indices.length || a.hiddenMatchCount !== b.hiddenMatchCount) return false
  for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) return false
  const ha = [...a.hiddenMatchColumns].sort((x, y) => x - y)
  const hb = [...b.hiddenMatchColumns].sort((x, y) => x - y)
  return ha.length === hb.length && ha.every((x, i) => x === hb[i])
}

console.log('2. Byte prefilter, then the unchanged exact check on candidate rows')
console.log('   needle        matches   candidates   today       prefiltered   speed-up')
for (const needle of ['Golf', 'Weber', 'Zaragoza', 'WVW99', 'zzzz', 'car', 'e', 'electric', '2016', 'hybrid 1']) {
  const today = time(() => filterIndices(store, source, members, columns, quickFilter(needle)))
  const safe = prefilterSafe(needle.trim().toLowerCase())
  const candidates = safe ? candidateRows(needle.trim().toLowerCase()).length : members.length
  const fast = time(() => viaPrefilter(needle))
  if (!sameResult(today.value, fast.value)) throw new Error(`MISMATCH for ${JSON.stringify(needle)}`)
  console.log(
    `   ${JSON.stringify(needle).padEnd(12)} ${today.value.indices.length.toLocaleString().padStart(9)} ${(safe ? candidates.toLocaleString() : 'fallback').padStart(12)} ${fmt(today.ms)}   ${fmt(fast.ms)}   ${(today.ms / fast.ms).toFixed(1).padStart(6)}×`
  )
}
console.log('   (every row above: identical indices, hidden-match count and columns)\n')

console.log('2b. Value bytes only, by token, with the generated-text rules')
console.log(`   group scan for case-lowering characters: ${fmt(loweringChars.ms)} (found: ${loweringChars.value})`)
console.log('   needle        matches   candidates   today       prefiltered   speed-up')
for (const needle of ['Golf', 'Weber', 'Zaragoza', 'WVW99', 'zzzz', 'car', 'e', 'electric', '2016', '223', 'hybrid 1', 'Golf, Po']) {
  const today = time(() => filterIndices(store, source, members, columns, quickFilter(needle)))
  const fast = time(() => viaPrefilterV2(needle))
  if (!sameResult(today.value, fast.value.result)) throw new Error(`MISMATCH v2 for ${JSON.stringify(needle)}`)
  const c = fast.value.candidates
  console.log(
    `   ${JSON.stringify(needle).padEnd(12)} ${today.value.indices.length.toLocaleString().padStart(9)} ${(c === null ? 'fallback' : c.toLocaleString()).padStart(12)} ${fmt(today.ms)}   ${fmt(fast.ms)}   ${(today.ms / fast.ms).toFixed(1).padStart(6)}×`
  )
}
const scanOnly = time(() => candidateRowsV2('zzzz', false)).ms
console.log(`   candidate scan alone, no hits: ${fmt(scanOnly)}`)
console.log('   (every row above: identical indices, hidden-match count and columns)\n')

// --- 3. narrowing ----------------------------------------------------------------
console.log('3. Narrowing: `Gol` → `Golf` over the previous matches')
const gol = filterIndices(store, source, members, columns, quickFilter('Gol'))
// Hidden matches must be rescanned too: a row that matched `Gol` only in a
// hidden column can match `Golf` only there, but it still has to be counted.
// So narrowing keeps every row that matched anywhere.
const golAnywhere = time(() => {
  const rows: number[] = []
  for (let i = 0; i < members.length; i++) {
    for (const [, cell] of rowFields(store, source, members[i]!)) {
      if ((cell.text ?? '').toLowerCase().includes('gol')) {
        rows.push(i)
        break
      }
    }
  }
  return rows
}).value
const fullGolf = time(() => filterIndices(store, source, members, columns, quickFilter('Golf')))
const narrowed = time(() => {
  const subset = golAnywhere.map((r) => members[r]!)
  const r = filterIndices(store, source, subset, columns, quickFilter('Golf'))
  return { indices: r.indices.map((i) => golAnywhere[i]!), hiddenMatchCount: r.hiddenMatchCount, hiddenMatchColumns: r.hiddenMatchColumns }
})
if (!sameResult(fullGolf.value, narrowed.value)) throw new Error('MISMATCH narrowing')
console.log(`   \`Gol\` matched ${gol.indices.length.toLocaleString()} rows (${golAnywhere.length.toLocaleString()} anywhere)`)
console.log(`   \`Golf\`, full pass      ${fmt(fullGolf.ms)}`)
console.log(`   \`Golf\`, narrowed       ${fmt(narrowed.ms)}   identical result`)

// --- slice sizing ----------------------------------------------------------------
console.log(`\n4. Rows per 8 ms slice at today's per-row cost: ${Math.floor(8 / (full / members.length)).toLocaleString()}`)
