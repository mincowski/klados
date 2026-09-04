import { describe, expect, it } from 'vitest'
import { buildRowIndex } from '../src/core/rowIndex'
import { Severity, type Diagnostic } from '../src/core/types'
import {
  diagnosticMarkers,
  matchMarkers,
  offsetToRatio,
  ratioToOffset
} from '../src/renderer/components/Scrubber/scrubberModel'

function rows(text: string, maxRowBytes = 8): Int32Array {
  return buildRowIndex(new TextEncoder().encode(text), maxRowBytes, [0x20])
}

describe('offsetToRatio / ratioToOffset (D13)', () => {
  it('offset 0 maps to ratio 0', () => {
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    expect(offsetToRatio(rowIndex, 0)).toBe(0)
  })

  it('the last row maps to ratio 1', () => {
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    const lastRowStart = rowIndex[rowIndex.length - 1]!
    expect(offsetToRatio(rowIndex, lastRowStart)).toBe(1)
  })

  it('ratio 0 and 1 round-trip to the first and last row starts', () => {
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    expect(ratioToOffset(rowIndex, 0)).toBe(rowIndex[0])
    expect(ratioToOffset(rowIndex, 1)).toBe(rowIndex[rowIndex.length - 1])
  })

  it('is monotonic: a later offset never produces an earlier ratio', () => {
    const rowIndex = rows('abcdefgh\n'.repeat(200), 16)
    let previous = -1
    for (let i = 0; i < rowIndex.length; i++) {
      const ratio = offsetToRatio(rowIndex, rowIndex[i]!)
      expect(ratio).toBeGreaterThanOrEqual(previous)
      previous = ratio
    }
  })

  it('clamps an out-of-range ratio rather than reading past the row index', () => {
    const rowIndex = rows('a\nb\nc\n')
    expect(ratioToOffset(rowIndex, -1)).toBe(rowIndex[0])
    expect(ratioToOffset(rowIndex, 2)).toBe(rowIndex[rowIndex.length - 1])
  })

  it('is 0 for a degenerate (empty or single-row) document', () => {
    const empty = buildRowIndex(new Uint8Array(0), 8, [0x20])
    expect(offsetToRatio(empty, 0)).toBe(0)
    const single = rows('short')
    expect(offsetToRatio(single, 3)).toBe(0)
  })
})

describe('diagnosticMarkers (D13)', () => {
  it('produces one marker per diagnostic, positioned by offset', () => {
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    const diagnostics: Diagnostic[] = [
      { severity: Severity.Warning, code: 'w', offset: 0, length: 1, message: 'warn' },
      { severity: Severity.Error, code: 'e', offset: rowIndex[5]!, length: 1, message: 'err' },
      {
        severity: Severity.Fatal,
        code: 'f',
        offset: rowIndex[rowIndex.length - 1]!,
        length: 1,
        message: 'fatal'
      }
    ]
    const markers = diagnosticMarkers(rowIndex, diagnostics)
    expect(markers).toEqual([
      { ratio: 0, kind: 'warning' },
      { ratio: offsetToRatio(rowIndex, rowIndex[5]!), kind: 'error' },
      { ratio: 1, kind: 'fatal' }
    ])
  })

  it('is empty for no diagnostics', () => {
    const rowIndex = rows('a\nb\n')
    expect(diagnosticMarkers(rowIndex, [])).toEqual([])
  })
})

describe('matchMarkers (D13 / UI-FEEDBACK.md M5b)', () => {
  it('is empty for no matches', () => {
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    expect(matchMarkers(rowIndex, new Int32Array(0))).toEqual([])
  })

  it('one marker per non-empty bucket, never one per match', () => {
    const rowIndex = rows('abcdefgh\n'.repeat(200), 16)
    // Every match crammed into the very first bucket's range — should
    // collapse to exactly one marker regardless of match count.
    const starts = Int32Array.from({ length: 500 }, (_, i) => i % 4)
    const markers = matchMarkers(rowIndex, starts, 16)
    expect(markers.length).toBe(1)
    expect(markers[0]!.kind).toBe('match')
    expect(markers[0]!.ratio).toBe(0)
  })

  it('the densest bucket gets density 1, a sparser one gets a lower ratio', () => {
    const rowIndex = rows('abcdefgh\n'.repeat(200), 16)
    const totalBytes = rowIndex[rowIndex.length - 1]!
    // One match near the start (sparse bucket), many crammed near the end
    // (dense bucket).
    const starts = Int32Array.from(
      [5, ...Array.from({ length: 20 }, (_, i) => totalBytes - 1 - (i % 3))].sort((a, b) => a - b)
    )
    const markers = matchMarkers(rowIndex, starts, 8)
    const densest = markers.reduce((a, b) => (b.density! > a.density! ? b : a))
    const sparsest = markers.reduce((a, b) => (b.density! < a.density! ? b : a))
    expect(densest.density).toBe(1)
    expect(sparsest.density!).toBeLessThan(1)
  })

  it('a match at the very last byte still lands in the final bucket', () => {
    const rowIndex = rows('abcdefgh\n'.repeat(50), 16)
    const lastRowStart = rowIndex[rowIndex.length - 1]!
    const bucketCount = 8
    const markers = matchMarkers(rowIndex, Int32Array.from([lastRowStart]), bucketCount)
    expect(markers.length).toBe(1)
    // The final bucket's own ratio is (bucketCount - 1) / bucketCount, not
    // 1 — what matters here is that the match wasn't dropped entirely for
    // falling past every bucket's `[start, end)` range (the bug this test
    // guards against, before the last bucket's own unbounded-above fix).
    expect(markers[0]!.ratio).toBe((bucketCount - 1) / bucketCount)
  })

  it('is empty when bucketCount is 0', () => {
    const rowIndex = rows('a\nb\nc\n')
    expect(matchMarkers(rowIndex, Int32Array.from([1]), 0)).toEqual([])
  })
})
