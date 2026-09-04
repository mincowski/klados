import { describe, expect, it } from 'vitest'
import { buildRowIndex } from '../src/core/rowIndex'
import {
  computeWindowBounds,
  planReslice,
  shouldRecenter,
  WINDOW_BYTES
} from '../src/renderer/components/Raw/rawWindow'

describe('computeWindowBounds (D10)', () => {
  it('is empty for an empty document', () => {
    const rowIndex = buildRowIndex(new Uint8Array(0), 512, [0x20])
    expect(computeWindowBounds(rowIndex, 0, 0, 1024)).toEqual({ start: 0, end: 0 })
  })

  it('clamps to the start of the document', () => {
    const bytes = new TextEncoder().encode('a\nb\nc\nd\ne\n'.repeat(50))
    const rowIndex = buildRowIndex(bytes, 8, [0x20])
    const { start, end } = computeWindowBounds(rowIndex, bytes.length, 0, 100)
    expect(start).toBe(0)
    expect(end).toBeGreaterThan(0)
    expect(end).toBeLessThanOrEqual(bytes.length)
  })

  it('clamps to the end of the document', () => {
    const bytes = new TextEncoder().encode('a\nb\nc\nd\ne\n'.repeat(50))
    const rowIndex = buildRowIndex(bytes, 8, [0x20])
    const { start, end } = computeWindowBounds(rowIndex, bytes.length, bytes.length, 100)
    expect(end).toBe(bytes.length)
    expect(start).toBeLessThan(end)
  })

  it('both ends land exactly on a row start (or document end)', () => {
    const bytes = new TextEncoder().encode('abcdefgh\n'.repeat(200))
    const rowIndex = buildRowIndex(bytes, 16, [0x20])
    const { start, end } = computeWindowBounds(rowIndex, bytes.length, 500, 200)
    expect(Array.from(rowIndex)).toContain(start)
    expect(end === bytes.length || Array.from(rowIndex).includes(end)).toBe(true)
  })

  it('centers the window on the requested offset, not always at the document start', () => {
    const bytes = new TextEncoder().encode('x'.repeat(10) + '\n' + 'y'.repeat(2000))
    const rowIndex = buildRowIndex(bytes, 512, [0x20])
    const { start } = computeWindowBounds(rowIndex, bytes.length, 1000, 400)
    expect(start).toBeGreaterThan(0)
  })

  it('the default window size is the A6/A6b winning configuration (1 MB)', () => {
    expect(WINDOW_BYTES).toBe(1024 * 1024)
  })
})

describe('planReslice (D10)', () => {
  it('produces two edge changes for a pure forward pan (the boundary-crossing case)', () => {
    const plan = planReslice(0, 1000, 400, 1400)
    expect(plan.kind).toBe('incremental')
    if (plan.kind !== 'incremental') throw new Error('unreachable')
    expect(plan.sharedStart).toBe(400)
    expect(plan.sharedEnd).toBe(1000)
    expect(plan.leading).toEqual({ start: 400, end: 400 }) // empty — pure drop, no insert
    expect(plan.trailing).toEqual({ start: 1000, end: 1400 }) // pure append
  })

  it('produces two edge changes for a pure backward pan, symmetrically', () => {
    const plan = planReslice(400, 1400, 0, 1000)
    expect(plan.kind).toBe('incremental')
    if (plan.kind !== 'incremental') throw new Error('unreachable')
    expect(plan.leading).toEqual({ start: 0, end: 400 }) // pure prepend
    expect(plan.trailing).toEqual({ start: 1000, end: 1000 }) // empty — pure drop
  })

  it('an identical window is a no-op incremental plan (both edges empty)', () => {
    const plan = planReslice(0, 1000, 0, 1000)
    expect(plan.kind).toBe('incremental')
    if (plan.kind !== 'incremental') throw new Error('unreachable')
    expect(plan.leading.start).toBe(plan.leading.end)
    expect(plan.trailing.start).toBe(plan.trailing.end)
  })

  it('falls back to a full replace when the windows share nothing', () => {
    const plan = planReslice(0, 1000, 2000, 3000)
    expect(plan).toEqual({ kind: 'replace', newStart: 2000, newEnd: 3000 })
  })

  it('falls back to a full replace when the windows merely touch (no shared byte)', () => {
    const plan = planReslice(0, 1000, 1000, 2000)
    expect(plan.kind).toBe('replace')
  })
})

describe('shouldRecenter (D10)', () => {
  it('is false in the middle of the window', () => {
    expect(shouldRecenter(500, 0, 1000, 1000)).toBe(false)
  })

  it('is true near the start of the window (scrolling backward), when the window is not at doc start', () => {
    expect(shouldRecenter(100, 1000, 2000, 10_000)).toBe(true)
  })

  it('is true near the end of the window (scrolling forward), when the window is not at doc end', () => {
    expect(shouldRecenter(900, 0, 1000, 10_000)).toBe(true)
  })

  it('respects a custom margin', () => {
    expect(shouldRecenter(1300, 1000, 2000, 10_000, 0.1)).toBe(false)
    expect(shouldRecenter(1050, 1000, 2000, 10_000, 0.1)).toBe(true)
  })

  it('is false for a degenerate (zero-width) window', () => {
    expect(shouldRecenter(0, 0, 0, 0)).toBe(false)
  })

  // M5g-PLAN.md §1.6: a window already clamped against a document edge
  // cannot recentre further in that direction, regardless of margin —
  // without this, every scroll event in the first/last 20% of a
  // boundary-pinned window re-slices onto the window already in place.
  describe('window clamped against a document edge', () => {
    it('is false near the start of a window already at document start', () => {
      expect(shouldRecenter(0, 0, 1_048_576, 10_485_760)).toBe(false)
    })

    it('is false slightly into a window already at document start', () => {
      expect(shouldRecenter(100, 0, 1_048_576, 10_485_760)).toBe(false)
    })

    it('is false mid-document, where the window is not clamped at either edge', () => {
      expect(shouldRecenter(5_242_880, 4_718_592, 5_767_168, 10_485_760)).toBe(false)
    })

    it('is false near the end of a window already at document end', () => {
      const byteLength = 10_485_760
      expect(shouldRecenter(byteLength, byteLength - 1_048_576, byteLength, byteLength)).toBe(false)
    })
  })
})
