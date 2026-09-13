import { describe, expect, it } from 'vitest'
import { buildRowIndex } from '../src/core/rowIndex'
import { DiagnosticIndex } from '../src/core/diagnosticIndex'
import { Severity } from '../src/core/types'
import {
  DEFAULT_MATCH_BUCKET_COUNT,
  diagnosticMarkers,
  matchMarkers,
  offsetToRatio,
  ratioToOffset,
  type ScrubberMarker
} from '../src/renderer/components/Scrubber/scrubberModel'

/** The index the strip actually reads (R200) — built here the way
 * `NodeStore.diagnostic` builds it, so these tests exercise the sort and the
 * trim rather than a hand-made pair of arrays that is already ascending. */
function index(entries: readonly (readonly [Severity, number])[]): DiagnosticIndex {
  const built = new DiagnosticIndex()
  for (const [severity, offset] of entries) built.add(severity, offset)
  return built
}

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

describe('diagnosticMarkers (D13, bucketed by R200)', () => {
  it('places a marker in the bucket each diagnostic falls into', () => {
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    const midOffset = rowIndex[5]!
    const lastOffset = rowIndex[rowIndex.length - 1]!
    const markers = diagnosticMarkers(
      rowIndex,
      index([
        [Severity.Warning, 0],
        [Severity.Error, midOffset],
        [Severity.Fatal, lastOffset]
      ]).positions()
    )

    expect(markers.map((m) => m.kind)).toEqual(['warning', 'error', 'fatal'])
    // Bucketed, so a marker's ratio is its bucket's, not the diagnostic's.
    // The gap is bounded by two bucket widths: one for the bucket itself, one
    // because the bucket's own edges are row-quantized through `rowIndex`. A
    // document with fewer rows than buckets — this one — leaves some bucket
    // ranges empty, which is why even offset 0 does not land at ratio 0.
    const within = (marker: ScrubberMarker, offset: number): boolean =>
      Math.abs(marker.ratio - offsetToRatio(rowIndex, offset)) <= 2 / DEFAULT_MATCH_BUCKET_COUNT
    expect(within(markers[0]!, 0)).toBe(true)
    expect(within(markers[1]!, midOffset)).toBe(true)
    expect(within(markers[2]!, lastOffset)).toBe(true)
  })

  it('is empty for no diagnostics', () => {
    const rowIndex = rows('a\nb\n')
    expect(diagnosticMarkers(rowIndex, new DiagnosticIndex().positions())).toEqual([])
  })

  it('draws a bucket at its most severe, so a fatal is never hidden by a warning', () => {
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    // Both in bucket 0 — a single marker, and it is the fatal.
    const markers = diagnosticMarkers(
      rowIndex,
      index([
        [Severity.Warning, 0],
        [Severity.Fatal, 1]
      ]).positions(),
      4
    )
    expect(markers).toEqual([{ ratio: 0, kind: 'fatal' }])
  })

  it('bounds the marker count and still spreads them over the whole strip', () => {
    // R200 §5's claim, and the one a naive cap breaks silently: capping the
    // *records* and drawing from those would cluster every mark at the top,
    // because parsers walk forward.
    const text = 'row\n'.repeat(50_000)
    const rowIndex = rows(text, 64)
    const entries: [Severity, number][] = []
    for (let i = 0; i < 50_000; i++) entries.push([Severity.Warning, i * 4])
    const markers = diagnosticMarkers(rowIndex, index(entries).positions())

    expect(markers.length).toBeLessThanOrEqual(DEFAULT_MATCH_BUCKET_COUNT)
    expect(markers[0]!.ratio).toBeLessThanOrEqual(1 / DEFAULT_MATCH_BUCKET_COUNT)
    expect(markers[markers.length - 1]!.ratio).toBeGreaterThan(0.9)
  })

  it('sorts positions the parser emitted out of order', () => {
    // XML's unwind loop emits `xml.unclosed-element` backwards from EOF, so
    // the index cannot assume ascending input — `countMatchesInRange` binary
    // searches and would miscount if it did.
    const rowIndex = rows('a\nb\nc\nd\ne\n'.repeat(20))
    const last = rowIndex[rowIndex.length - 1]!
    const descending = diagnosticMarkers(
      rowIndex,
      index([
        [Severity.Error, last],
        [Severity.Error, 0]
      ]).positions()
    )
    expect(descending).toHaveLength(2)
    expect(descending[0]!.ratio).toBeLessThanOrEqual(1 / DEFAULT_MATCH_BUCKET_COUNT)
    expect(descending[1]!.ratio).toBeGreaterThan(0.9)
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
