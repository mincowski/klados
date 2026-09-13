#!/usr/bin/env -S npx tsx
/**
 * R210's own measurement: what the grid rendering models cost as the number
 * of distinct child-name groups under one parent grows.
 *
 * Usage: npx tsx spike/r210-grid-models.ts [totalChildren]
 *
 * Generates its own documents rather than reading fixtures, because the
 * variable under test is *group count*, which no existing fixture varies —
 * `spike/fixtures/` is all single-group (2 M `<car>`), which is exactly the
 * shape that hides the behaviour this round is about.
 *
 * Three things it answers, all of which the plan states as findings:
 *
 *  1. The **old** model had a discontinuity: `GRID_MIN_COVERAGE = 0.05` meant
 *     that once children spread evenly across more than 20 groups, no group
 *     cleared the floor and **no table rendered at all**.
 *  2. One table per group implemented naively — one `collectGroupMembers`
 *     pass per group — is O(children × groups) and unusable past a few dozen.
 *  3. One bucketing pass producing counts *and* members is flat in group
 *     count, and is what shipped.
 *
 * **Re-run after R210 landed**, which changed what it measures: `detectGrid`
 * is now the one-pass implementation, so the "1-pass" column is the shipped
 * code rather than a proposal, and the old model survives here as
 * `legacyDetect` — the only place left that can still reproduce § 2's cliff.
 *
 * Not wired into `npm test` — a measurement script, same convention as
 * `spike/m2-e10-measure.ts`, whose scope this extends (E10 measured one
 * group; this measures many).
 */
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, type NodeRef, type ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { detectGrid, GRID_MIN_MEMBERS } from '../src/renderer/components/Detail/gridDetection'
import { collectColumns } from '../src/renderer/components/Detail/gridColumns'
import { hasChildren, isGridEligible } from '../src/renderer/nodeDisplay'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const TABLE_CAP = 5

/** The pre-R210 model, kept runnable here because the code no longer
 * contains it and § 2's cliff is only reproducible against it: count every
 * group, promote the largest one that clears a 5% coverage floor, then walk
 * the children a second time to collect that one group's members. */
const LEGACY_MIN_COVERAGE = 0.05

function legacyDetect(store: NodeStore, node: NodeRef): { winner: number; members: NodeRef[] } {
  const counts = new Map<number, number>()
  let composite = 0
  for (const child of store.childrenOf(node)) {
    if (!isGridEligible(store, child)) continue
    composite++
    const id = store.nameIdOf(child)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  let winner = -2
  let best = 0
  for (const [id, count] of counts) {
    if (count >= GRID_MIN_MEMBERS && count / composite >= LEGACY_MIN_COVERAGE && count > best) {
      winner = id
      best = count
    }
  }
  if (winner === -2) return { winner, members: [] }
  // The second pass, and note the predicate: `hasChildren`, where the
  // counting pass above used `isGridEligible`. That disagreement is the CSV
  // defect R210 closed — kept here because it is what the measurement was
  // actually measuring.
  const members: NodeRef[] = []
  for (const child of store.childrenOf(node)) {
    if (store.nameIdOf(child) === winner && hasChildren(store, child)) members.push(child)
  }
  return { winner, members }
}

/** One table per group, implemented the obvious way: count first, then one
 * collection pass per group. This is the column that must stay out of the
 * implementation (§ 8). */
function naivePerGroupMembers(store: NodeStore, node: NodeRef): Map<number, NodeRef[]> {
  const counts = new Map<number, number>()
  for (const child of store.childrenOf(node)) {
    if (!isGridEligible(store, child)) continue
    counts.set(store.nameIdOf(child), (counts.get(store.nameIdOf(child)) ?? 0) + 1)
  }
  const out = new Map<number, NodeRef[]>()
  for (const [id, count] of counts) {
    if (count < GRID_MIN_MEMBERS) continue
    const members: NodeRef[] = []
    for (const child of store.childrenOf(node)) {
      if (isGridEligible(store, child) && store.nameIdOf(child) === id) members.push(child)
    }
    out.set(id, members)
  }
  return out
}

function buildDoc(total: number, groups: number): { store: NodeStore; root: NodeRef } {
  const parts: string[] = ['<root>']
  for (let i = 0; i < total; i++) {
    const g = i % groups
    parts.push(`<g${g}><a>1</a><b>2</b><c>3</c></g${g}>`)
  }
  parts.push('</root>')
  const bytes = new TextEncoder().encode(parts.join(''))
  const store = new NodeStore(bytes, new Interner())
  xmlFormatModule.parse(bytes, store, OPTIONS)
  let root: NodeRef = 0
  for (let n = 0; n < store.nodeCount; n++) {
    if (store.kindOf(n) === NodeKind.Element) {
      root = n
      break
    }
  }
  return { store, root }
}

function ms(fn: () => unknown): number {
  const t = performance.now()
  fn()
  return performance.now() - t
}

const total = Number(process.argv[2] ?? 200_000)
console.log(`\n${total.toLocaleString()} composite children, split evenly across N groups`)
console.log('        | PRE-R210 (winner only)     | R210 (every group)')
console.log(`N       | count + collect + columns  | naive members  1-pass  columns(all)  cap ${TABLE_CAP}`)

for (const groups of [1, 2, 10, 20, 21, 100]) {
  const { store, root } = buildDoc(total, groups)

  // Warm every path before timing any of it — the first measured row is
  // otherwise pure JIT compilation and reads as a false regression.
  for (let w = 0; w < 3; w++) {
    legacyDetect(store, root)
    detectGrid(store, root)
    const warm = detectGrid(store, root).tables[0]
    if (warm !== undefined) collectColumns(store, warm.members)
  }

  const legacy = legacyDetect(store, root)
  const tLegacy =
    legacy.winner === -2
      ? NaN
      : ms(() => legacyDetect(store, root)) +
        ms(() => collectColumns(store, legacyDetect(store, root).members))

  const tNaive = ms(() => naivePerGroupMembers(store, root))
  const tOnePass = ms(() => detectGrid(store, root))
  const tables = detectGrid(store, root).tables
  const tColsAll = ms(() => {
    for (const t of tables) collectColumns(store, t.members)
  })
  const capped = tables.slice(0, TABLE_CAP)
  const tColsCap = ms(() => {
    for (const t of capped) collectColumns(store, t.members)
  })

  console.log(
    String(groups).padEnd(8) +
      '| ' +
      (Number.isNaN(tLegacy) ? 'NO TABLE AT ALL' : `${tLegacy.toFixed(1)} ms`).padEnd(27) +
      '| ' +
      `${tNaive.toFixed(1)} ms`.padEnd(15) +
      `${tOnePass.toFixed(1)} ms`.padEnd(8) +
      `${tColsAll.toFixed(1)} ms`.padEnd(14) +
      `${tColsCap.toFixed(1)} ms`
  )
}
