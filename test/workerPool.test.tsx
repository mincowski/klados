/**
 * R27 (`R24-tabs.md` §5, `CONCEPT.md` §11.4) — the shared worker pool,
 * exercised with a *real* `Worker` (real Chromium via the browser project;
 * `test/parseClient.test.ts`'s own header explains why the node project
 * can't construct one at all). Nothing prior to this round ever ran
 * `parseInWorker`/`transformInWorker` end to end through a real thread —
 * disclosed as untested in that file's own comment — so this is also the
 * first real coverage of the pooled path itself, not just its plumbing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { parseInWorker } from '../src/core/parseClient'
import { transformInWorker } from '../src/core/transformClient'
import { getWorkerPoolStats, resetWorkerPoolForTests } from '../src/core/workerPool'

afterEach(() => {
  resetWorkerPoolForTests()
})

function utf8(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

describe('the shared worker pool (R27)', () => {
  it('a single parse succeeds through a pooled worker, and the worker is released afterward', async () => {
    const result = await parseInWorker(utf8('{"a":1}'), { filename: 'a.json' })
    expect(result.store.nodeCount).toBeGreaterThan(0)
    expect(result.formatId).toBe('json')

    const stats = getWorkerPoolStats()
    expect(stats.size).toBe(3)
    expect(stats.free).toBe(3)
    expect(stats.queued).toBe(0)
  })

  it('more concurrent parses than the pool size queue rather than fail', async () => {
    const jobs = Array.from({ length: 7 }, (_, i) =>
      parseInWorker(utf8(`{"n":${i}}`), { filename: `${i}.json` })
    )
    const results = await Promise.all(jobs)
    expect(results).toHaveLength(7)
    for (const result of results) {
      expect(result.formatId).toBe('json')
      expect(result.complete).toBe(true)
    }

    // Every worker released back to the pool once its own job finished —
    // not leaked, not left "busy" forever.
    const stats = getWorkerPoolStats()
    expect(stats.size).toBe(3)
    expect(stats.free).toBe(3)
    expect(stats.queued).toBe(0)
  })

  it('cancelling mid-parse replaces the worker, and the pool keeps working afterward', async () => {
    const controller = new AbortController()
    const job = parseInWorker(utf8('{"a":1}'), {
      filename: 'a.json',
      signal: controller.signal
    })
    controller.abort()

    await expect(job).rejects.toMatchObject({ name: 'AbortError' })

    // The pool healed itself (a replacement worker took the terminated
    // one's slot) — a later, unrelated parse must still succeed.
    const next = await parseInWorker(utf8('{"b":2}'), { filename: 'b.json' })
    expect(next.formatId).toBe('json')
    expect(getWorkerPoolStats().size).toBe(3)
  })

  it('a transform runs through the same pool as parse', async () => {
    const result = await transformInWorker(utf8('{"a":1}'), {
      formatId: 'json',
      options: { indent: '  ', newline: '\n' }
    })
    // Minified input, default pretty-print options — not a no-op, so a
    // real (non-null) formatted result comes back.
    expect(result).not.toBeNull()
    expect(getWorkerPoolStats().free).toBe(3)
  })
})
