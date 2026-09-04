/**
 * M4-PLAN.md G8's "runs through G3's scheduler" requirement, verified: a
 * path evaluation chunked at step granularity yields the identical result
 * `evaluatePath`'s synchronous version does, without blocking synchronously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Interner } from '../src/core/interner'
import { buildNameIndex } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { evaluatePath } from '../src/core/path/evaluate'
import { parsePath } from '../src/core/path/parse'
import { evaluatePathChunked } from '../src/renderer/navigation/pathQueryJob'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  const result = xmlFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

/** R53 (`R53-interner-encoding.md`) — `bytes` must already be in
 * `encoding`'s own byte sequence (the caller's job, not the parser's:
 * invariant 7 is that a document's bytes are never transcoded), so this
 * takes raw bytes directly rather than a JS string to encode. */
function parseXmlEncoded(
  bytes: Uint8Array,
  encoding: string
): { store: NodeStore; source: SourceBuffer } {
  const store = new NodeStore(bytes, new Interner())
  const result = xmlFormatModule.parse(bytes, store, { maxDepth: 1000, encoding })
  if (!result.complete) throw new Error('test fixture must parse completely')
  return { store, source: new SourceBuffer(bytes, encoding, 0) }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('evaluatePathChunked', () => {
  it('produces the same result as the synchronous evaluatePath', async () => {
    const { store, source } = parseXml(
      '<cars><car id="c-1"><price>100</price></car><car id="c-2"><price>200</price></car></cars>'
    )
    const nameIndex = buildNameIndex(store, store.interner.size)
    const parsed = parsePath('cars//price', (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error('parse failed')

    const expected = evaluatePath(store, nameIndex, source, parsed.path)

    const job = evaluatePathChunked(store, nameIndex, source, parsed.path)
    await vi.runAllTimersAsync()
    const result = await job.result
    expect([...result]).toEqual([...expected])
  })

  it('yields between steps rather than resolving synchronously', async () => {
    const { store, source } = parseXml('<zoo><cat/><dog/></zoo>')
    const nameIndex = buildNameIndex(store, store.interner.size)
    const parsed = parsePath('zoo/cat', (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error('parse failed')

    let settled = false
    const job = evaluatePathChunked(store, nameIndex, source, parsed.path)
    void job.result.then(() => {
      settled = true
    })
    expect(settled).toBe(false) // nothing has run yet — scheduled via setTimeout(0)
    await vi.runAllTimersAsync()
    expect(settled).toBe(true)
  })

  it('cancelling mid-evaluation rejects and leaves no stale state', async () => {
    const { store, source } = parseXml('<zoo><cat/></zoo>')
    const nameIndex = buildNameIndex(store, store.interner.size)
    const parsed = parsePath('zoo/cat', (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error('parse failed')

    const job = evaluatePathChunked(store, nameIndex, source, parsed.path)
    job.cancel()
    await expect(job.result).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('an empty context after a step short-circuits the remaining steps', async () => {
    const { store, source } = parseXml('<zoo><cat/></zoo>')
    const nameIndex = buildNameIndex(store, store.interner.size)
    const parsed = parsePath('zoo/nonexistent/whatever', (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error('parse failed')

    const job = evaluatePathChunked(store, nameIndex, source, parsed.path)
    await vi.runAllTimersAsync()
    const result = await job.result
    expect(result.length).toBe(0)
  })

  it('resolves and evaluates a non-ASCII element name in a windows-1252 document, end to end through the fixed lookup (R53)', async () => {
    // "<café>1</café>" as windows-1252's own bytes (0xE9 is 'é' in that
    // page) — hand-built, not via `encodeText`, so this fixture doesn't
    // depend on the same code the fix under test uses.
    //
    // Built via `Interner.lookup` directly rather than `parsePath`, because
    // the query grammar's `NAME_CHAR` (`core/path/parse.ts`) is ASCII-only
    // and cannot parse a literal `café` step today — a separate, adjacent
    // gap `R53-interner-encoding.md`'s Results section reports rather
    // than silently also fixing. This test covers what R53 actually
    // changed: once a caller has a non-ASCII name and the document's own
    // encoding, `lookup` resolves it to the right `nameId` and evaluation
    // finds the node — the fix is real even though the Palette can't reach
    // it through typed query text yet.
    const bytes = new Uint8Array([
      0x3c,
      0x63,
      0x61,
      0x66,
      0xe9,
      0x3e, // "<café>"
      0x31, // "1"
      0x3c,
      0x2f,
      0x63,
      0x61,
      0x66,
      0xe9,
      0x3e // "</café>"
    ])
    const { store, source } = parseXmlEncoded(bytes, 'windows-1252')
    const nameIndex = buildNameIndex(store, store.interner.size)

    const resolved = store.interner.lookup('café', 'windows-1252')
    if (typeof resolved !== 'number') throw new Error('expected a resolved nameId')

    const path = {
      steps: [{ axis: 'child' as const, isWildcard: false, nameId: resolved, predicate: null }]
    }
    const job = evaluatePathChunked(store, nameIndex, source, path)
    await vi.runAllTimersAsync()
    const result = await job.result
    expect(result.length).toBe(1)
  })
})

/**
 * R130 acceptance 5 and 6 — a predicate is preemptible *within* a step, not
 * only between steps, which is the disclosed G10 finding this retires.
 *
 * The assertion is on `runChunkedJob`'s own resumption — the job is still
 * unsettled after one scheduled turn and needs more — never on elapsed
 * time. `performance.now` is stubbed to advance a fixed amount per read so
 * the slice boundary is deterministic rather than a race with the machine
 * the suite happens to run on; the mechanism being asserted (the scheduler
 * ran out of slice, yielded, and came back) is the real one either way.
 */
describe('evaluatePathChunked — a predicate suspends mid-step (R130)', () => {
  const CANDIDATES = 400_000

  /** 400,000 `<c v="…"/>` siblings — the §2 corpus's candidate count in the
   * smallest document that produces it. Exactly one carries `v="target"`,
   * so the expected result is a set of one, named, not a count. */
  function bigFixture(): { store: NodeStore; source: SourceBuffer } {
    const parts: string[] = ['<r>']
    for (let i = 0; i < CANDIDATES; i++) {
      parts.push(i === CANDIDATES - 1 ? '<c v="target"/>' : '<c v="x"/>')
    }
    parts.push('</r>')
    return parseXml(parts.join(''))
  }

  function stubClock(msPerRead: number): void {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (now += msPerRead))
  }

  it('yields to the scheduler many times within one step over 400,000 candidates, and returns the same set as the synchronous evaluator', async () => {
    const { store, source } = bigFixture()
    const nameIndex = buildNameIndex(store, store.interner.size)
    // **One** step, deliberately: `//c` is a single descendant step, so
    // every resumption this counts is a resumption *within* a step. A
    // two-step query would yield once between its steps even under the
    // pre-R130 shape, and the test would not be discriminating.
    const parsed = parsePath('//c[@v="target"]', (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.diagnostic.message}`)
    expect(parsed.path.steps).toHaveLength(1)

    const expected = [...evaluatePath(store, nameIndex, source, parsed.path)]
    expect(expected).toHaveLength(1)

    // Each `performance.now()` read advances 5 ms against an 8 ms slice, so
    // a slice ends after a small, fixed number of batches whatever the
    // machine is doing — the resumption is what is asserted, not a duration.
    stubClock(5)

    let settled = false
    const job = evaluatePathChunked(store, nameIndex, source, parsed.path)
    void job.result.then(() => {
      settled = true
    })

    // One scheduled turn is not enough: the step is still mid-predicate and
    // the scheduler has re-armed itself rather than resolved.
    await vi.advanceTimersToNextTimerAsync()
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    let turns = 1
    while (!settled && vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync()
      turns++
    }
    expect(settled).toBe(true)
    // 400,000 candidates at PREDICATE_BATCH (512) each is ~782 batches, a
    // couple of batches per slice — so hundreds of turns. Anything that
    // filtered the candidate array in one unit would settle in one or two.
    expect(turns).toBeGreaterThan(50)
    expect([...(await job.result)]).toEqual(expected)
  })

  it('an existence predicate (R132) also yields many times over 400,000 candidates — it shares the same resumable loop, not a second one', async () => {
    const { store, source } = bigFixture()
    const nameIndex = buildNameIndex(store, store.interner.size)
    const parsed = parsePath('//c[@v]', (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.diagnostic.message}`)

    const expected = [...evaluatePath(store, nameIndex, source, parsed.path)]
    expect(expected).toHaveLength(CANDIDATES) // every <c> here carries @v

    stubClock(5)

    let settled = false
    const job = evaluatePathChunked(store, nameIndex, source, parsed.path)
    void job.result.then(() => {
      settled = true
    })

    await vi.advanceTimersToNextTimerAsync()
    expect(settled).toBe(false)

    let turns = 1
    while (!settled && vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync()
      turns++
    }
    expect(settled).toBe(true)
    expect(turns).toBeGreaterThan(50)
    expect([...(await job.result)]).toEqual(expected)
  })

  it('cancelling mid-predicate leaves no partial result — the promise rejects and never resolves', async () => {
    const { store, source } = bigFixture()
    const nameIndex = buildNameIndex(store, store.interner.size)
    const parsed = parsePath('//c[@v="x"]', (name) => store.interner.lookup(name))
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.diagnostic.message}`)

    stubClock(5)

    let resolvedWith: Int32Array | null = null
    const job = evaluatePathChunked(store, nameIndex, source, parsed.path)
    void job.result.then(
      (value) => {
        resolvedWith = value
      },
      () => {}
    )

    // Let one slice run so the predicate is genuinely part-way through its
    // candidate array, then cancel.
    await vi.advanceTimersToNextTimerAsync()
    job.cancel()
    await expect(job.result).rejects.toMatchObject({ name: 'AbortError' })

    // No partial `Int32Array` was ever handed out, and nothing is left
    // scheduled to hand one out later.
    await vi.runAllTimersAsync()
    expect(resolvedWith).toBeNull()
  })
})
