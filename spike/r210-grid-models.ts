#!/usr/bin/env -S npx tsx
/**
 * R210's own measurement: what the three grid rendering models cost as the
 * number of distinct child-name groups under one parent grows.
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
 *  1. Today's model has a **discontinuity**: `GRID_MIN_COVERAGE = 0.05` means
 *     that once children spread evenly across more than 20 groups, no group
 *     clears the floor and **no table renders at all**.
 *  2. Model C implemented naively — one `collectGroupMembers` pass per group —
 *     is O(children x groups) and unusable past a few dozen groups.
 *  3. One bucketing pass producing counts *and* members is flat in group
 *     count and replaces `detectGrid` + `collectGroupMembers` together.
 *
 * Not wired into `npm test` — a measurement script, same convention as
 * `spike/m2-e10-measure.ts`, whose scope this extends (E10 measured one
 * group; this measures many).
 */
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, type NodeRef, type ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { detectGrid } from '../src/renderer/components/Detail/gridDetection'
import { collectColumns, collectGroupMembers } from '../src/renderer/components/Detail/gridColumns'
import { isGridEligible } from '../src/renderer/nodeDisplay'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const TABLE_CAP = 5

function buildDoc(total: number, groups: number): { store: NodeStore; root: NodeRef } {
  const parts: string[] = ['<root>']
  for (let i = 0; i < total; i++) {
    const g = i % groups
    parts.push(`<g${g}><a>1</a><b>2</b><c>3</c></g${g}>`)
  }
  parts.push('</root>')
  const bytes = new TextEncoder().encode(parts.join(''))
  const store = new NodeStore(bytes, new Interner(undefined, false))
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

/**
 * One pass producing both the per-name counts and the members, applying the
 * same `isGridEligible` filter `detectGrid` does — a like-for-like replacement
 * for `detectGrid` + `collectGroupMembers`, not a cheaper scan that skips work.
 */
function onePassBuckets(store: NodeStore, root: NodeRef): Map<number, NodeRef[]> {
  const byName = new Map<number, NodeRef[]>()
  for (const child of store.childrenOf(root)) {
    if (!isGridEligible(store, child)) continue
    const id = store.nameIdOf(child)
    if (id === -1) continue
    const bucket = byName.get(id)
    if (bucket === undefined) byName.set(id, [child])
    else bucket.push(child)
  }
  return byName
}

function ms(fn: () => unknown): number {
  const t = performance.now()
  fn()
  return performance.now() - t
}

const total = Number(process.argv[2] ?? 200_000)
console.log(`\n${total.toLocaleString()} composite children, split evenly across N groups`)
console.log('        | TODAY (winner only)        | MODEL C (every group)')
console.log(`N       | detect + members + columns | naive members  1-pass  columns(all)  cap ${TABLE_CAP}`)

for (const groups of [1, 2, 10, 20, 21, 100]) {
  const { store, root } = buildDoc(total, groups)
  const det = detectGrid(store, root)
  const ids = det.groups.map((g) => g.nameId)
  const winner = det.grid === null ? null : det.grid.nameId

  // Warm every path before timing any of it — the first measured row is
  // otherwise pure JIT compilation and reads as a false regression.
  for (let w = 0; w < 3; w++) {
    detectGrid(store, root)
    onePassBuckets(store, root)
    if (winner !== null) collectColumns(store, collectGroupMembers(store, root, winner))
  }

  const tToday =
    winner === null
      ? NaN
      : ms(() => detectGrid(store, root)) +
        ms(() => collectGroupMembers(store, root, winner)) +
        ms(() => collectColumns(store, collectGroupMembers(store, root, winner)))

  const tNaive = ms(() => {
    for (const id of ids) collectGroupMembers(store, root, id)
  })
  const tOnePass = ms(() => onePassBuckets(store, root))
  const all = [...onePassBuckets(store, root).values()]
  const tColsAll = ms(() => {
    for (const m of all) collectColumns(store, m)
  })
  const capped = all.slice(0, TABLE_CAP)
  const tColsCap = ms(() => {
    for (const m of capped) collectColumns(store, m)
  })

  console.log(
    String(groups).padEnd(8) +
      '| ' +
      (Number.isNaN(tToday) ? 'NO TABLE AT ALL' : `${tToday.toFixed(1)} ms`).padEnd(27) +
      '| ' +
      `${tNaive.toFixed(1)} ms`.padEnd(15) +
      `${tOnePass.toFixed(1)} ms`.padEnd(8) +
      `${tColsAll.toFixed(1)} ms`.padEnd(14) +
      `${tColsCap.toFixed(1)} ms`
  )
}
