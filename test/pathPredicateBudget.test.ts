/**
 * R129–R131 acceptance 7, 8 and 9 — the two wall-clock budgets, in the
 * shape of R110's Replace All regression test (`test/documentEdits.test.ts`):
 * measure the real operation on a real corpus and fail if it exceeds the
 * budget.
 *
 * **The corpus is generated, not committed** (`npm run fixtures:generate`,
 * or `node spike/generate-fixtures.ts cars-attrs-400k.xml` for this one
 * alone) — 86 MB, 400,000 `<car>` records with five attributes each and a
 * numeric `<price>` child, which is R129 §2's corpus B. Absent, this file
 * skips, the same way `test/invariants.test.ts` handles the spike fixtures.
 *
 * **Both budgets were checked to fail before the fix**, which is acceptance
 * 9: `//car[@vin="…"]` failed at ~239 ms through the decoding facet
 * evaluator, and `//car[price>50000]` failed because the grammar rejected
 * the query outright — the honest form of "fails."
 *
 * **The expected answers are recomputed from the generator's own formulas**,
 * never taken from what the query returned. A predicate that is fast and
 * wrong would otherwise pass a budget test, and this project has shipped
 * exactly that class of defect before (R17's span bug, invisible to every
 * shape-only assertion).
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { buildNameIndex, type NameIndex } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import { evaluatePath } from '../src/core/path/evaluate'
import { parsePath } from '../src/core/path/parse'
import { xmlFormatModule } from '../src/formats/xml/index'

const FIXTURE = resolve(__dirname, '../spike/fixtures/cars-attrs-400k.xml')
const RECORDS = 400_000
/** §10's budget for both queries — 239.2 ms and "does not parse" before. */
const BUDGET_MS = 40

function fixtureExists(): boolean {
  try {
    return statSync(FIXTURE).isFile()
  } catch {
    return false
  }
}

/** The generator's own formulas (`spike/generate-fixtures.ts`), repeated so
 * the expected answer is computed rather than observed. */
function priceOf(i: number): number {
  return 1000 + ((i * 37) % 89000)
}
function vinOf(i: number): string {
  return 'WVW' + String(100000000 + i)
}

const present = fixtureExists()

describe.skipIf(!present)('R129–R131 — predicate wall-clock budgets', () => {
  let store: NodeStore
  let source: SourceBuffer
  let nameIndex: NameIndex

  beforeAll(() => {
    const bytes = new Uint8Array(readFileSync(FIXTURE))
    store = new NodeStore(bytes, new Interner())
    const result = xmlFormatModule.parse(bytes, store, { maxDepth: 1000, encoding: 'utf-8' })
    if (!result.complete) throw new Error('fixture did not parse completely')
    source = new SourceBuffer(bytes, 'utf-8', 0)
    nameIndex = buildNameIndex(store, store.interner.size)
  }, 300_000)

  /** Median of five, so one GC pause or one scheduler hiccup cannot decide
   * the verdict — the difference being measured is 239 ms against 40, not
   * something noise could plausibly cover either way. */
  function measure(query: string): { elapsedMs: number; matches: number } {
    const parsed = parsePath(query, (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error(`query failed to parse: ${parsed.diagnostic.message}`)

    const samples: number[] = []
    let matches = -1
    for (let run = 0; run < 5; run++) {
      const start = performance.now()
      const result = evaluatePath(store, nameIndex, source, parsed.path)
      samples.push(performance.now() - start)
      if (matches !== -1 && result.length !== matches) {
        throw new Error('the same query returned different results across runs')
      }
      matches = result.length
    }
    samples.sort((a, b) => a - b)
    return { elapsedMs: samples[2]!, matches }
  }

  it(`the fixture is corpus B's shape: ${RECORDS} cars, five attributes each`, () => {
    const cars = evaluatePath(store, nameIndex, source, {
      steps: [
        {
          axis: 'descendant',
          isWildcard: false,
          nameId: store.interner.lookup('car') as number,
          predicate: null
        }
      ]
    })
    expect(cars.length).toBe(RECORDS)
    expect(store.attrEndOf(cars[0]!) - store.attrStartOf(cars[0]!)).toBe(5)
  })

  // R131 — the facet retrofit. 239.2 ms before, through `attributesOf`'s
  // per-visit allocations plus a decode per candidate.
  it(`//car[@vin="…"] completes in under ${BUDGET_MS} ms`, () => {
    // The last record, so this is the attribute-5-of-5, match-at-the-end
    // case rather than an early-out.
    const { elapsedMs, matches } = measure(`//car[@vin="${vinOf(RECORDS - 1)}"]`)
    expect(matches).toBe(1)

    console.log(`//car[@vin="…"]: ${elapsedMs.toFixed(1)} ms`)
    expect(elapsedMs).toBeLessThan(BUDGET_MS)
  })

  // R129 — the predicate the milestone is named after. Did not parse before.
  it(`//car[price>50000] completes in under ${BUDGET_MS} ms`, () => {
    let expected = 0
    for (let i = 0; i < RECORDS; i++) if (priceOf(i) > 50000) expected++
    expect(expected).toBeGreaterThan(0)

    const { elapsedMs, matches } = measure('//car[price>50000]')
    expect(matches).toBe(expected)

    console.log(`//car[price>50000]: ${elapsedMs.toFixed(1)} ms`)
    expect(elapsedMs).toBeLessThan(BUDGET_MS)
  })

  it('the string form of the same predicate is also under budget', () => {
    // `car[make="BMW"]`'s shape — a byte comparison over 400,000 child
    // element values, §2's 11.6 ms case.
    const { elapsedMs, matches } = measure('//car[engine="electric"]')
    expect(matches).toBe(RECORDS / 4) // ENGINE_TYPES has four entries, cycled by index

    console.log(`//car[engine="electric"]: ${elapsedMs.toFixed(1)} ms`)
    expect(elapsedMs).toBeLessThan(BUDGET_MS)
  })
})

describe.skipIf(present)('R129–R131 — predicate wall-clock budgets', () => {
  it.skip('fixture absent — run `node spike/generate-fixtures.ts cars-attrs-400k.xml`', () => {})
})
