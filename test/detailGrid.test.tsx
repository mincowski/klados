/**
 * R43 (`R43-grid-sizing-and-scroll.md`, D-071): `.detail-grid-container`
 * used to be a fixed `height: 480px` — real layout, so this needs the
 * browser project the same way every other height/geometry assertion here
 * does (`test/grid.test.tsx`'s own R40 describe block).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTLE_MS } from './support/wait'
import { createRoot, type Root } from 'react-dom/client'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { DetailContent } from '../src/renderer/components/Detail/Detail'
import type { OpenDocument } from '../src/renderer/session/documentSession'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Detail/Grid.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.width = '900px'
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
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function gridDocument(rows: number): { document: OpenDocument; selectedNode: number } {
  const parts: string[] = ['<garage>']
  for (let r = 0; r < rows; r++)
    parts.push(`<car><name>car${r}</name><year>20${10 + r}</year></car>`)
  parts.push('</garage>')
  const source = new TextEncoder().encode(parts.join(''))
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    xmlFormatModule.capabilities.rowBreakBytes
  )
  const lineIndex = buildLineIndex(source, rowIndex)
  const nameIndex = buildNameIndex(store, store.interner.size)
  const document: OpenDocument = {
    filePath: 'C:/docs/garage.xml',
    fileName: 'garage.xml',
    store,
    sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
    rowIndex,
    lineIndex,
    nameIndex,
    diagnostics: store.diagnostics,
    complete: true,
    formatId: 'xml',
    encoding: 'utf-8',
    readOnly: false,
    errorNode: null,
    errorOffset: null,
    pendingParseError: null,
    dirty: false,
    externalChangeDetected: false,
    pendingTransform: null,
    minifiedBannerDismissed: false,
    reparsePending: false,
    transformInProgress: false,
    lastTransformWasNoOp: false,
    undoBytes: 0,
    undoEntryCount: 0,
    pendingSpanDeltas: EMPTY_DELTA_LIST,
    // R100: this fixture predates the field; a freshly opened document
    // has had no external rewrite yet.
    externalRewrites: 0
  }
  return { document, selectedNode: 0 } // the Document root — its one child (garage) is the grid-eligible node
}

describe('.detail-grid-container height (R43)', () => {
  it('grows past 480px in a tall pane instead of leaving a gap below it', async () => {
    container.style.height = '1000px'
    const { document, selectedNode } = gridDocument(30)
    await paint(<DetailContent document={document} selectedNode={selectedNode} />)

    const gridContainer = container.querySelector<HTMLElement>('.detail-grid-container')
    expect(gridContainer).not.toBeNull()
    expect(gridContainer!.getBoundingClientRect().height).toBeGreaterThan(480)
  })

  it('shrinks in a short pane but never below its floor, and only one ancestor scrolls', async () => {
    container.style.height = '260px'
    const { document, selectedNode } = gridDocument(30)
    await paint(<DetailContent document={document} selectedNode={selectedNode} />)

    const detailEl = container.querySelector<HTMLElement>('.detail')
    const gridContainer = container.querySelector<HTMLElement>('.detail-grid-container')
    expect(detailEl).not.toBeNull()
    expect(gridContainer).not.toBeNull()

    // The floor holds: the grid container never shrinks to an unreadable
    // two-row table just because the pane is short.
    expect(gridContainer!.getBoundingClientRect().height).toBeGreaterThanOrEqual(230)

    // R33 §1a's nested-scroll case: with the floor holding, `.detail`
    // itself is what scrolls once the pane is too short — the common case
    // (an ordinary window) has exactly one scrollbar, not two.
    expect(detailEl!.scrollHeight).toBeGreaterThan(detailEl!.clientHeight)
  })
})
