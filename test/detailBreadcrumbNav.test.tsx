/**
 * R62 (`R61-keyboard-workflow.md` §3) — the breadcrumb's segments are
 * one roving-tabindex group. Follows `test/detailGrid.test.tsx`'s own
 * harness (`DetailContent` mounted directly, a synthetic `OpenDocument`).
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

function deepDocument(): { document: OpenDocument; selectedNode: number } {
  const source = new TextEncoder().encode(
    '<garage><car><name>car0</name><year>2010</year></car></garage>'
  )
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  const garage = store.firstChildOf(0)
  const car = store.firstChildOf(garage)
  const name = store.firstChildOf(car) // a leaf, deep enough for several breadcrumb segments
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
  return { document, selectedNode: name }
}

function keydown(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('R62 §3 — the breadcrumb is one roving-tabindex group', () => {
  it('only one segment carries tabIndex 0, and the copy-path button stays its own ordinary stop', async () => {
    const { document, selectedNode } = deepDocument()
    await paint(<DetailContent document={document} selectedNode={selectedNode} />)

    const segments = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.detail-breadcrumb-segment')
    )
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.filter((s) => s.tabIndex === 0).length).toBe(1)
    expect(segments[0]!.tabIndex).toBe(0)

    const copyButton = container.querySelector<HTMLButtonElement>('.detail-breadcrumb-copy')!
    expect(copyButton.tabIndex).toBe(0) // an ordinary stop, not part of the roving group
  })

  it('ArrowRight moves the active segment; Home/End jump to the ends', async () => {
    const { document, selectedNode } = deepDocument()
    await paint(<DetailContent document={document} selectedNode={selectedNode} />)

    const segments = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.detail-breadcrumb-segment')
    )
    const last = segments.length - 1

    segments[0]!.focus()
    keydown(segments[0]!, 'ArrowRight')
    await paint(<DetailContent document={document} selectedNode={selectedNode} />)
    let refreshed = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.detail-breadcrumb-segment')
    )
    expect(refreshed[1]!.tabIndex).toBe(0)
    expect(refreshed[0]!.tabIndex).toBe(-1)

    keydown(refreshed[1]!, 'End')
    await paint(<DetailContent document={document} selectedNode={selectedNode} />)
    refreshed = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.detail-breadcrumb-segment')
    )
    expect(refreshed[last]!.tabIndex).toBe(0)
  })
})
