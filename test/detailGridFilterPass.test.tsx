/**
 * R214 (`docs/plans/R214-filter-pass.md` § 2–3) — the grid filter pass in the
 * browser: sliced, cancelled by a newer filter, waited for by export, never
 * cached mid-way, and narrowed when typing forward. `setFilterPassForTests`
 * holds passes open so each state can be observed rather than raced.
 *
 * The fixture helpers are `test/detailGridViewState.test.tsx`'s, kept as a local
 * copy the way the neighbouring Detail tests each carry their own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { SETTLE_MS } from './support/wait'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { DetailContent } from '../src/renderer/components/Detail/Detail'
import { copyGridAs } from '../src/renderer/components/Detail/gridController'
import { resetGridViewStateForTests } from '../src/renderer/components/Detail/gridViewState'
import {
  cacheHitCountForTests,
  cachedRowCountForTests,
  resetGridResultCacheForTests
} from '../src/renderer/components/Detail/gridResultCache'
import {
  filterPassStatsForTests,
  resetFilterPassForTests,
  setFilterPassForTests
} from '../src/renderer/components/Detail/useFilterPass'
import { resetNotificationsForTests } from '../src/renderer/notifications/notificationStore'
import type { OpenDocument } from '../src/renderer/session/documentSession'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/styles/base.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Detail/Grid.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.width = '900px'
  container.style.height = '800px'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetGridViewStateForTests()
  resetGridResultCacheForTests()
  resetNotificationsForTests()
})

async function settle(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function openDocumentOf(xml: string, interner = new Interner()): OpenDocument {
  const source = new TextEncoder().encode(xml)
  const store = new NodeStore(source, interner)
  xmlFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    xmlFormatModule.capabilities.rowBreakBytes
  )
  return {
    filePath: 'C:/docs/library.xml',
    fileName: 'library.xml',
    store,
    sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
    rowIndex,
    lineIndex: buildLineIndex(source, rowIndex),
    nameIndex: buildNameIndex(store, store.interner.size),
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

/** Two shelves. Shelf one's books carry an `isbn` that shelf two's do not, so
 * a sort or pin on it is a column that exists on one node and not the other. */
const books = (count: number, isbn: boolean): string =>
  Array.from(
    { length: count },
    (_, i) =>
      `<book><title>t${i}</title><year>${2000 + ((i * 7) % count)}</year>` +
      `${isbn ? `<isbn>${9000 - i}</isbn>` : ''}</book>`
  ).join('')
const magazines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `<magazine><issue>${i}</issue></magazine>`).join('')

function shelves(document: OpenDocument): [number, number] {
  const store = document.store
  const library = store.firstChildOf(0)
  const first = store.firstChildOf(library)
  return [first, store.nextSiblingOf(first)]
}

async function show(document: OpenDocument, node: number): Promise<void> {
  root.render(<DetailContent document={document} selectedNode={node} />)
  await settle()
}

const tab = (name: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('.grid-group-tablist [role=tab]')].find(
    (t) => t.querySelector('.grid-group-tab-name')?.textContent === name
  )!
async function switchTo(name: string): Promise<void> {
  tab(name).click()
  await settle()
}
/** The first column of every rendered body row, top to bottom. */
const firstColumn = (column: number): string[] =>
  [...container.querySelectorAll<HTMLElement>('.grid-row')]
    .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
    .map((r) => r.querySelectorAll('[role=gridcell]')[column]?.textContent ?? '')
const quickFilter = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('.grid-quick-filter')!

function typeInto(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
    input,
    text
  )
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const SHELF = `<library><shelf>${books(1000, true)}${magazines(3)}</shelf></library>`

/** Waits for a committed filter's pass to be visibly running. */
async function waitForPending(): Promise<void> {
  await vi.waitFor(() => expect(container.querySelector('.grid-filter-progress')).not.toBeNull())
}

describe('R214 — the filter pass runs in slices', () => {
  afterEach(() => resetFilterPassForTests())

  it('while a pass runs, the previous rows stay and progress is shown; then the result replaces them', async () => {
    setFilterPassForTests({ syncBudgetMs: 0, paused: true })
    const document = openDocumentOf(SHELF)
    await show(document, shelves(document)[0])
    const before = firstColumn(0)
    expect(before[0]).toBe('t0')

    typeInto(quickFilter(), 't99')
    await waitForPending()
    expect(firstColumn(0)).toEqual(before)
    expect(container.querySelector('.grid-filter-progress')!.textContent).toBe('Filtering…')
    expect(container.querySelector('.grid-filter-progress')!.getAttribute('role')).toBe('status')
    expect(container.querySelector('[role=grid]')!.getAttribute('aria-busy')).toBe('true')

    setFilterPassForTests({ paused: false })
    await vi.waitFor(() => expect(container.querySelector('.grid-filter-progress')).toBeNull())
    expect(container.querySelector('[role=grid]')!.getAttribute('aria-busy')).toBe('false')
    expect(firstColumn(0)).toEqual([
      't99',
      't990',
      't991',
      't992',
      't993',
      't994',
      't995',
      't996',
      't997',
      't998',
      't999'
    ])
  })

  it('a pass that finishes within its budget never shows progress', async () => {
    const document = openDocumentOf(SHELF)
    await show(document, shelves(document)[0])
    typeInto(quickFilter(), 't99')
    await vi.waitFor(() => expect(firstColumn(0)[0]).toBe('t99'))
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    expect(container.querySelector('.grid-filter-progress')).toBeNull()
  })

  it('a newer filter abandons the running pass', async () => {
    setFilterPassForTests({ syncBudgetMs: 0, paused: true })
    const document = openDocumentOf(SHELF)
    await show(document, shelves(document)[0])
    typeInto(quickFilter(), 't12')
    await waitForPending()
    typeInto(quickFilter(), 't5')
    // The second commit starts a second pass; the first is still held mid-way.
    await vi.waitFor(() => expect(filterPassStatsForTests().sliced).toBe(2))
    setFilterPassForTests({ paused: false })
    await vi.waitFor(() => expect(firstColumn(0).slice(0, 2)).toEqual(['t5', 't50']))
    await vi.waitFor(() => expect(container.querySelector('.grid-filter-progress')).toBeNull())
    // Only the newer pass ran to its end; the abandoned one was never stepped again.
    expect(filterPassStatsForTests().completedSliced).toBe(1)
    expect(quickFilter().value).toBe('t5')
  })

  it('an export asked for mid-pass waits for the pass, and copies the new rows', async () => {
    let copied: string | null = null
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => ((copied = text), Promise.resolve()) }
    })
    try {
      setFilterPassForTests({ syncBudgetMs: 0, paused: true })
      const document = openDocumentOf(SHELF)
      await show(document, shelves(document)[0])
      typeInto(quickFilter(), 't99')
      await waitForPending()
      copyGridAs('csv')
      await settle()
      expect(copied).toBeNull()

      setFilterPassForTests({ paused: false })
      await vi.waitFor(() => expect(copied).not.toBeNull())
      const lines = copied!.trim().split(/\r?\n/)
      expect(lines).toHaveLength(1 + 11)
      expect(lines[1]!.split(',')[0]).toBe('t99')
    } finally {
      if (original === undefined) delete (navigator as { clipboard?: unknown }).clipboard
      else Object.defineProperty(navigator, 'clipboard', original)
    }
  })

  it('a table left mid-pass caches nothing, and restores its filter by recomputing it', async () => {
    setFilterPassForTests({ syncBudgetMs: 0, paused: true })
    const document = openDocumentOf(SHELF)
    await show(document, shelves(document)[0])
    typeInto(quickFilter(), 't99')
    await waitForPending()
    await switchTo('magazine')
    expect(cachedRowCountForTests()).toBe(0)

    setFilterPassForTests({ paused: false })
    await switchTo('book')
    await vi.waitFor(() => expect(firstColumn(0)[0]).toBe('t99'))
    expect(cacheHitCountForTests()).toBe(0)
  })

  it('typing a filter forward narrows: the next pass visits only the previous matches', async () => {
    const document = openDocumentOf(SHELF)
    await show(document, shelves(document)[0])
    typeInto(quickFilter(), 't9')
    await vi.waitFor(() => expect(firstColumn(0)[0]).toBe('t9'))
    expect(filterPassStatsForTests().lastRows).toBe(1000)

    typeInto(quickFilter(), 't99')
    await vi.waitFor(() => expect(firstColumn(0)[1]).toBe('t990'))
    // `t9` matched t9, t90–t99 and t900–t999 (111 rows) and nothing else.
    expect(filterPassStatsForTests().lastRows).toBe(111)
    expect(firstColumn(0)).toHaveLength(11)

    // Deleting a character is not an extension: a full pass again.
    typeInto(quickFilter(), 't9')
    await vi.waitFor(() => expect(firstColumn(0)[1]).toBe('t90'))
    expect(filterPassStatsForTests().lastRows).toBe(1000)
  })
})
