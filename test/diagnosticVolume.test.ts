/**
 * R200 (`docs/plans/R200-diagnostic-volume.md`) — diagnostics are bounded in
 * what they retain and unbounded in what they record.
 *
 * The two halves are tested together on purpose. Capping the records alone is
 * the failure this round exists to avoid: parsers walk forward, so the first N
 * diagnostics are very nearly the first N *by offset*, and a scrubber drawn
 * from a capped list would mark the top of the document and report everything
 * below it as clean.
 */
import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_CAP_PER_CODE, DiagnosticIndex } from '../src/core/diagnosticIndex'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { DEFAULT_MAX_ROW_BYTES, buildRowIndex } from '../src/core/rowIndex'
import { Severity, type FormatModule, type ParseOptions } from '../src/core/types'
import { csvFormatModule } from '../src/formats/csv/index'
import { xmlFormatModule } from '../src/formats/xml/index'
import {
  DEFAULT_MATCH_BUCKET_COUNT,
  diagnosticMarkers,
  type ScrubberMarker
} from '../src/renderer/components/Scrubber/scrubberModel'
import { nextDiagnostic, sortedByOffset } from '../src/renderer/navigation/diagnosticNav'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parse(format: FormatModule, text: string): { store: NodeStore; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner(undefined, format.capabilities.hasNamespaces))
  format.parse(bytes, store, OPTIONS)
  return { store, bytes }
}

function markersFor(store: NodeStore, bytes: Uint8Array, format: FormatModule): ScrubberMarker[] {
  const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, format.capabilities.rowBreakBytes)
  return diagnosticMarkers(rowIndex, store.diagnosticIndex.positions())
}

/** A CSV whose header has two columns and whose every data row has three —
 * the "export with a stray trailing delimiter" R200 §2 names as the case
 * ordinary input reaches. */
function raggedCsv(rows: number): string {
  return 'a,b\n' + '1,2,3\n'.repeat(rows)
}

/** An XML document with a malformed attribute on every element — the same
 * shape in a format that needs genuinely broken input to get there. */
function malformedXml(elements: number): string {
  return '<r>' + '<e a/>'.repeat(elements) + '</r>'
}

describe('R200 — the retained list is bounded', () => {
  it('caps a CSV with 500,000 long rows, and records every one of them', () => {
    const { store } = parse(csvFormatModule, raggedCsv(500_000))

    expect(store.diagnosticIndex.total).toBe(500_000)
    expect(store.diagnosticCount).toBeLessThanOrEqual(DIAGNOSTIC_CAP_PER_CODE + 2)
    expect(store.diagnostics.filter((d) => d.code === 'csv.long-row')).toHaveLength(
      DIAGNOSTIC_CAP_PER_CODE
    )
  })

  it('caps a malformed XML document the same way, with no format-specific branch', () => {
    // R200 §2's finding: `CONCEPT.md` §11.1 says parsing stops at the first
    // failure and no parser implements that, so a defect repeating per node
    // yields a diagnostic per node in every format — not just in CSV.
    const { store } = parse(xmlFormatModule, malformedXml(100_000))

    expect(store.diagnosticIndex.total).toBe(100_000)
    expect(store.diagnosticCount).toBeLessThanOrEqual(DIAGNOSTIC_CAP_PER_CODE + 2)
  })

  it('caps per code, so a flood of one kind cannot push out a handful of another', () => {
    // Long rows outnumber short ones 200:1 here; the short-row warnings must
    // still be in the list.
    const rows: string[] = ['a,b,c']
    for (let i = 0; i < 1_000; i++) rows.push(i % 200 === 0 ? '1' : '1,2,3,4')
    const { store } = parse(csvFormatModule, rows.join('\n') + '\n')

    expect(store.diagnostics.some((d) => d.code === 'csv.short-row')).toBe(true)
    expect(store.diagnostics.filter((d) => d.code === 'csv.long-row')).toHaveLength(
      DIAGNOSTIC_CAP_PER_CODE
    )
  })

  it('names how many were not listed, once, in a single summary entry', () => {
    const { store } = parse(csvFormatModule, raggedCsv(5_000))
    const summary = store.diagnostics.filter((d) => d.code === 'klados.diagnostics-capped')

    expect(summary).toHaveLength(1)
    const suppressed = store.diagnosticIndex.total - (store.diagnosticCount - 1)
    expect(summary[0]!.message).toContain(suppressed.toLocaleString())
  })

  it('synthesizes no summary when nothing was suppressed', () => {
    const { store } = parse(csvFormatModule, raggedCsv(3))
    expect(store.diagnosticCount).toBe(3)
    expect(store.diagnostics.some((d) => d.code === 'klados.diagnostics-capped')).toBe(false)
  })

  it('returns the same array identity across reads, so consumers can memoize on it', () => {
    const { store } = parse(csvFormatModule, raggedCsv(5_000))
    expect(store.diagnostics).toBe(store.diagnostics)
    expect(store.diagnosticIndex.positions()).toBe(store.diagnosticIndex.positions())
  })
})

describe('R200 — the position index is not', () => {
  it('spreads the scrubber across the whole strip, not just its first N', () => {
    // The claim § 5 exists to make, and the one a naive cap breaks silently.
    const { store, bytes } = parse(csvFormatModule, raggedCsv(500_000))
    const markers = markersFor(store, bytes, csvFormatModule)

    expect(markers.length).toBeLessThanOrEqual(DEFAULT_MATCH_BUCKET_COUNT)
    expect(markers.length).toBeGreaterThan(DEFAULT_MATCH_BUCKET_COUNT / 2)
    expect(markers[markers.length - 1]!.ratio).toBeGreaterThan(0.9)
    // Every bucket the document actually spans is marked: a strip drawn from
    // the capped records would stop within the first fraction of a percent.
    expect(markers.filter((m) => m.ratio > 0.5).length).toBeGreaterThan(
      DEFAULT_MATCH_BUCKET_COUNT / 4
    )
  })

  it('does the same for XML', () => {
    const { store, bytes } = parse(xmlFormatModule, malformedXml(100_000))
    const markers = markersFor(store, bytes, xmlFormatModule)

    expect(markers.length).toBeLessThanOrEqual(DEFAULT_MATCH_BUCKET_COUNT)
    expect(markers[markers.length - 1]!.ratio).toBeGreaterThan(0.9)
  })

  it('keeps the per-severity totals truthful against a capped list', () => {
    // What `StatusBar` and `StatisticsPanel` read. Filtering the record list
    // instead would report 100 warnings for a file with half a million.
    const { store } = parse(csvFormatModule, raggedCsv(500_000))

    expect(store.diagnosticIndex.countOf(Severity.Warning)).toBe(500_000)
    expect(store.diagnosticIndex.countOf(Severity.Error)).toBe(0)
    expect(store.diagnosticIndex.countOf(Severity.Fatal)).toBe(0)
  })

  it('survives a worker transfer, both halves together', () => {
    const { store, bytes } = parse(csvFormatModule, raggedCsv(5_000))

    const far = new NodeStore(bytes, new Interner())
    far.adoptDiagnostics(
      store.diagnostics,
      DiagnosticIndex.fromBuffers(store.diagnosticIndex.exportBuffers())
    )

    expect(far.diagnosticIndex.total).toBe(store.diagnosticIndex.total)
    expect(far.diagnosticCount).toBe(store.diagnosticCount)
    expect(far.diagnostics.filter((d) => d.code === 'klados.diagnostics-capped')).toHaveLength(1)
  })
})

describe('R200 — navigation', () => {
  it('reaches every retained diagnostic', () => {
    const { store } = parse(csvFormatModule, raggedCsv(5_000))
    const retained = store.diagnostics.filter((d) => d.code === 'csv.long-row')

    let seen = 0
    for (let offset = -1; ; seen++) {
      const next = nextDiagnostic(retained, offset)
      if (next === null) break
      offset = next.offset
    }
    expect(seen).toBe(retained.length)
  })

  it('sorts a given list once, not once per call', () => {
    // Acceptance 8. The cap bounds the array; it is not a licence to keep
    // doing O(n log n) per keystroke on what is left.
    const { store } = parse(csvFormatModule, raggedCsv(5_000))
    const list = store.diagnostics
    expect(sortedByOffset(list)).toBe(sortedByOffset(list))
    expect(sortedByOffset(list)).not.toBe(list)
  })
})
