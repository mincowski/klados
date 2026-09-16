/**
 * R213–R214 — the result cache on its own: what it keeps, what it drops, and
 * R214 § 1's rule that it holds every table's order until the entries together
 * pass a byte budget, oldest-left out first.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import {
  cachedRowCountForTests,
  GRID_RESULT_CACHE_BUDGET_BYTES,
  gridResultCacheBytes,
  leaveCachedResult,
  resetGridResultCacheForTests,
  setGridResultCacheBudgetForTests,
  subscribeGridResultCache,
  takeCachedResult,
  type ResultIdentity
} from '../src/renderer/components/Detail/gridResultCache'
import { EMPTY_GRID_FILTERS } from '../src/renderer/components/Detail/gridFilter'

afterEach(() => resetGridResultCacheForTests())

const bytes = new TextEncoder().encode('<a/>')
const store = new NodeStore(bytes, new Interner())
const sourceBuffer = new SourceBuffer(bytes, 'utf-8', 0)

function grid(groupKey: string, overrides: Partial<ResultIdentity> = {}): ResultIdentity {
  return {
    // No tab: a test has none open, and the cache drops entries of closed tabs.
    viewKey: { tabId: null, filePath: 'C:/docs/a.xml' },
    store,
    sourceBuffer,
    node: 1,
    groupKey,
    sort: { nameId: 3, direction: 'asc' },
    extraColumns: new Set(),
    filters: EMPTY_GRID_FILTERS,
    ...overrides
  }
}

const rows = (n: number): number[] => Array.from({ length: n }, (_, i) => n - 1 - i)

describe('R213 — the result cache', () => {
  it('returns the order a grid left, as 4 bytes per row', () => {
    leaveCachedResult(grid('n:book'), rows(100), 0, [])
    const hit = takeCachedResult(grid('n:book'))
    expect(hit?.order).toBeInstanceOf(Int32Array)
    expect(hit?.order.byteLength).toBe(400)
    expect(Array.from(hit!.order)).toEqual(rows(100))
  })

  it('a grid with no sort and no filter leaves nothing, and evicts nothing', () => {
    leaveCachedResult(grid('n:book'), rows(100), 0, [])
    leaveCachedResult(grid('n:magazine', { sort: null }), rows(50), 0, [])
    expect(cachedRowCountForTests()).toBe(100)
  })

  it('misses on any difference in sort, columns, committed filters, store or node', () => {
    const other = new NodeStore(bytes, new Interner())
    leaveCachedResult(grid('n:book'), rows(10), 0, [])
    for (const difference of [
      { sort: { nameId: 3, direction: 'desc' } },
      { extraColumns: new Set([9]) },
      { filters: { quick: 'golf', perColumn: new Map() } },
      { store: other },
      { node: 2 }
    ] satisfies Partial<ResultIdentity>[]) {
      expect(takeCachedResult(grid('n:book', difference))).toBeNull()
    }
    expect(takeCachedResult(grid('n:book'))).not.toBeNull()
  })

  it('a grid leaving in a different state replaces its entry rather than adding one', () => {
    leaveCachedResult(grid('n:book'), rows(100), 0, [])
    leaveCachedResult(grid('n:book', { sort: { nameId: 4, direction: 'desc' } }), rows(30), 0, [])
    expect(cachedRowCountForTests()).toBe(30)
    expect(takeCachedResult(grid('n:book'))).toBeNull()
  })
})

describe('R214 — every table, within a byte budget', () => {
  it('the budget is 64 MB', () => {
    expect(GRID_RESULT_CACHE_BUDGET_BYTES).toBe(64 * 1024 * 1024)
  })

  it('keeps every table while they fit', () => {
    for (let g = 0; g < 50; g++) leaveCachedResult(grid(`n:g${g}`), rows(1000), 0, [])
    expect(cachedRowCountForTests()).toBe(50 * 1000)
    expect(gridResultCacheBytes()).toBe(50 * 4000)
    for (let g = 0; g < 50; g++) expect(takeCachedResult(grid(`n:g${g}`))).not.toBeNull()
  })

  it('evicts oldest-left first, and never exceeds the budget', () => {
    setGridResultCacheBudgetForTests(4 * 250) // room for 250 rows
    leaveCachedResult(grid('n:a'), rows(100), 0, [])
    leaveCachedResult(grid('n:b'), rows(100), 0, [])
    // Leaving `a` again moves it to the back of the queue…
    leaveCachedResult(grid('n:a'), rows(100), 0, [])
    // …so `c` evicts `b`, the table left longest ago.
    leaveCachedResult(grid('n:c'), rows(100), 0, [])
    expect(takeCachedResult(grid('n:b'))).toBeNull()
    expect(takeCachedResult(grid('n:a'))).not.toBeNull()
    expect(takeCachedResult(grid('n:c'))).not.toBeNull()
    expect(gridResultCacheBytes()).toBeLessThanOrEqual(4 * 250)
  })

  it('an order larger than the whole budget is not cached, and evicts nothing', () => {
    setGridResultCacheBudgetForTests(4 * 250)
    leaveCachedResult(grid('n:a'), rows(100), 0, [])
    leaveCachedResult(grid('n:huge'), rows(251), 0, [])
    expect(takeCachedResult(grid('n:huge'))).toBeNull()
    expect(takeCachedResult(grid('n:a'))).not.toBeNull()
    expect(gridResultCacheBytes()).toBe(400)
  })

  it('tells subscribers when its size changes, for the Statistics panel', () => {
    let calls = 0
    const unsubscribe = subscribeGridResultCache(() => calls++)
    leaveCachedResult(grid('n:a'), rows(10), 0, [])
    expect(calls).toBe(1)
    takeCachedResult(grid('n:a'))
    expect(calls).toBe(1)
    unsubscribe()
    leaveCachedResult(grid('n:b'), rows(10), 0, [])
    expect(calls).toBe(1)
  })

  it('drops the entries of a tab that is no longer open', () => {
    leaveCachedResult(
      grid('n:a', { viewKey: { tabId: 'tab-closed', filePath: 'C:/docs/a.xml' } }),
      rows(10),
      0,
      []
    )
    leaveCachedResult(grid('n:b'), rows(10), 0, [])
    expect(cachedRowCountForTests()).toBe(10)
  })
})
