/**
 * R213 (`docs/plans/R213-grid-view-state.md` § 5) — the result cache's memory
 * rule, on its own: what it keeps, what it drops, and that it never holds more
 * than one grid that is not on screen once a grid mounts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import {
  cachedRowCountForTests,
  GRID_RESULT_CACHE_ENTRIES,
  leaveCachedResult,
  resetGridResultCacheForTests,
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
    viewKey: { tabId: 'tab-0', filePath: 'C:/docs/a.xml' },
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
    const differences: Partial<ResultIdentity>[] = [
      { sort: { nameId: 3, direction: 'desc' } },
      { extraColumns: new Set([9]) },
      { filters: { quick: 'golf', perColumn: new Map() } },
      { store: other },
      { node: 2 }
    ]
    for (const difference of differences) {
      leaveCachedResult(grid('n:book'), rows(10), 0, [])
      expect(takeCachedResult(grid('n:book', difference))).toBeNull()
    }
    leaveCachedResult(grid('n:book'), rows(10), 0, [])
    expect(takeCachedResult(grid('n:book'))).not.toBeNull()
  })

  it('the same grid mounting in a different state drops its stale entry', () => {
    leaveCachedResult(grid('n:book'), rows(100), 0, [])
    expect(takeCachedResult(grid('n:book', { sort: null }))).toBeNull()
    expect(cachedRowCountForTests()).toBe(0)
  })

  it('once a grid mounts, at most one grid not on screen is held', () => {
    leaveCachedResult(grid('n:a'), rows(100), 0, [])
    leaveCachedResult(grid('n:b'), rows(100), 0, [])
    expect(cachedRowCountForTests()).toBe(2 * 100)
    // `c` mounts and has nothing cached: only the most recent other grid stays.
    expect(takeCachedResult(grid('n:c'))).toBeNull()
    expect(cachedRowCountForTests()).toBe(100)
    expect(takeCachedResult(grid('n:b'))).not.toBeNull()
  })

  it('flipping between two grids keeps both: the one on screen and the one just left', () => {
    leaveCachedResult(grid('n:a'), rows(100), 0, [])
    expect(takeCachedResult(grid('n:b'))).toBeNull()
    leaveCachedResult(grid('n:b'), rows(100), 0, [])
    expect(takeCachedResult(grid('n:a'))).not.toBeNull()
    expect(cachedRowCountForTests()).toBe(200)
    leaveCachedResult(grid('n:a'), rows(100), 0, [])
    expect(takeCachedResult(grid('n:b'))).not.toBeNull()
    expect(cachedRowCountForTests()).toBeLessThanOrEqual(GRID_RESULT_CACHE_ENTRIES * 100)
  })
})
