/**
 * R200 acceptance 4 (`docs/plans/R200-diagnostic-volume.md`) — the scrubber
 * renders at most bucket-count diagnostic markers.
 *
 * In the browser project rather than the node one because the claim is about
 * **DOM nodes**, which is the cost this round exists to remove: one `<div>`
 * per diagnostic, in a strip a few hundred pixels tall, on a document that
 * can produce millions. `scrubberModel.test.ts` asserts the marker *model*;
 * this asserts what actually gets committed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { SourceBuffer } from '../src/core/buffer'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import { Interner } from '../src/core/interner'
import { buildNameIndex } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import type { ParseOptions } from '../src/core/types'
import { csvFormatModule } from '../src/formats/csv/index'
import { ScrubberContent } from '../src/renderer/components/Scrubber/Scrubber'
import { DEFAULT_MATCH_BUCKET_COUNT } from '../src/renderer/components/Scrubber/scrubberModel'
import type { OpenDocument } from '../src/renderer/session/documentSession'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Scrubber/Scrubber.css'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  // The strip resolves position through the row index, never through
  // rendered geometry, but it still needs a box to lay markers out in.
  container.style.height = '400px'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/** A CSV whose every data row carries one field too many — one
 * `csv.long-row` Warning per row, which is the ordinary input R200 §2 names
 * as the case that reaches this in practice. */
function raggedCsvDocument(rows: number): OpenDocument {
  const text = 'a,b\n' + '1,2,3\n'.repeat(rows)
  const source = new TextEncoder().encode(text)
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  csvFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    csvFormatModule.capabilities.rowBreakBytes
  )
  return {
    filePath: 'C:/docs/export.csv',
    fileName: 'export.csv',
    store,
    sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
    rowIndex,
    lineIndex: buildLineIndex(source, rowIndex),
    nameIndex: buildNameIndex(store, interner.size),
    diagnostics: store.diagnostics,
    complete: true,
    formatId: 'csv',
    encoding: 'utf-8',
    readOnly: false,
    errorNode: null,
    errorOffset: null,
    pendingParseError: null,
    dirty: false,
    externalChangeDetected: false,
    reloadPending: false,
    pendingTransform: null,
    minifiedBannerDismissed: false,
    reparsePending: false,
    transformInProgress: false,
    lastTransformWasNoOp: false,
    undoBytes: 0,
    undoEntryCount: 0,
    pendingSpanDeltas: EMPTY_DELTA_LIST,
    externalRewrites: 0
  }
}

function markerNodes(): Element[] {
  return Array.from(container.querySelectorAll('.scrubber-marker-warning'))
}

describe('Scrubber diagnostic markers (R200 acceptance 4)', () => {
  it('renders at most bucket-count markers for 50,000 diagnostics', async () => {
    const doc = raggedCsvDocument(50_000)
    expect(doc.store.diagnosticIndex.total).toBe(50_001) // rows, plus R199's summary

    await paint(<ScrubberContent document={doc} selectedNode={-1} />)

    const markers = markerNodes()
    expect(markers.length).toBeGreaterThan(0)
    expect(markers.length).toBeLessThanOrEqual(DEFAULT_MATCH_BUCKET_COUNT)
  })

  it('marks the bottom of the strip, not only its top', async () => {
    // The failure a naive cap produces silently: parsers walk forward, so
    // the first N *records* are the first N by offset, and a strip drawn
    // from them reports a clean document below the cap.
    await paint(<ScrubberContent document={raggedCsvDocument(50_000)} selectedNode={-1} />)

    const tops = markerNodes().map((el) => Number.parseFloat((el as HTMLElement).style.top))
    expect(Math.max(...tops)).toBeGreaterThan(90)
  })
})
