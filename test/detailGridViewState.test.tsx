/**
 * R213 (`docs/plans/R213-grid-view-state.md`) — a table keeps its sort, columns,
 * pins, widths and filters when the user switches group tabs and comes back.
 * Rendered through `DetailContent`, because the grid is unmounted by a tab switch
 * and the question is what the *next* grid starts from.
 *
 * The document fixture is `test/detailGridGroupTabs.test.tsx`'s, kept as a local
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
  resetGridResultCacheForTests
} from '../src/renderer/components/Detail/gridResultCache'
import {
  getPushedNotifications,
  resetNotificationsForTests
} from '../src/renderer/notifications/notificationStore'
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

const LIBRARY = `<library><shelf>${books(6, true)}${magazines(3)}</shelf><shelf>${books(5, false)}${magazines(2)}</shelf></library>`

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
const header = (name: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('.grid-header-cell')].find(
    (h) => h.querySelector('.grid-header-label')?.textContent?.replace(/ [▲▼]$/, '') === name
  )!
const sortLabel = (): string | null =>
  [...container.querySelectorAll<HTMLElement>('.grid-header-label')]
    .map((l) => l.textContent ?? '')
    .find((t) => / [▲▼]$/.test(t)) ?? null
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

/** Types a quick filter and waits for it to commit through the keystroke
 * debounce, which is when the table narrows to `rows`. */
async function typeFilter(text: string, rows: number): Promise<void> {
  typeInto(quickFilter(), text)
  await vi.waitFor(() => expect(container.querySelectorAll('.grid-row')).toHaveLength(rows))
  await settle()
}

describe('R213 — a table keeps its view state across tab switches', () => {
  it('acceptance 1: sort a group, switch away and back — same column, same direction', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    header('year').querySelector<HTMLButtonElement>('.grid-header-label')!.click()
    header('year').querySelector<HTMLButtonElement>('.grid-header-label')!.click()
    await settle()
    expect(sortLabel()).toBe('year ▼')
    const sorted = firstColumn(1)

    await switchTo('magazine')
    expect(sortLabel()).toBeNull()
    await switchTo('book')
    expect(sortLabel()).toBe('year ▼')
    expect(firstColumn(1)).toEqual(sorted)
  })

  it('acceptance 3: groups do not share state — sorting book leaves magazine unsorted', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    header('year').querySelector<HTMLButtonElement>('.grid-header-label')!.click()
    await settle()
    await switchTo('magazine')
    expect(sortLabel()).toBeNull()
    expect(firstColumn(0)).toEqual(['0', '1', '2'])
  })

  it('acceptance 2: pins and resized widths survive the round trip', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    header('year').querySelector<HTMLButtonElement>('.grid-header-pin')!.click()
    await settle()
    const title = header('title')
    const handle = title.querySelector<HTMLElement>('.grid-header-resize-handle')!
    const before = title.getBoundingClientRect().width
    const startX = title.getBoundingClientRect().right
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + 90 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await settle()
    const resized = header('title').getBoundingClientRect().width
    expect(resized).toBeGreaterThan(before + 60)

    await switchTo('magazine')
    await switchTo('book')
    expect(header('year').querySelector('.grid-header-pin')!.getAttribute('aria-pressed')).toBe(
      'true'
    )
    // Pinned columns lead.
    expect(
      container.querySelector('.grid-header-cell:not(.grid-row-header-cell) .grid-header-label')!
        .textContent
    ).toBe('year')
    expect(header('title').getBoundingClientRect().width).toBeCloseTo(resized, 0)
  })

  it('acceptance 2: the column picker’s extra columns survive the round trip', async () => {
    // 62 fields: two past GRID_COLUMN_CAP (60), so `f61` is an overflow column.
    const fields = (i: number): string =>
      Array.from({ length: 62 }, (_, f) => `<f${f}>v${i}_${f}</f${f}>`).join('')
    const wide = Array.from({ length: 3 }, (_, i) => `<row>${fields(i)}</row>`).join('')
    const document = openDocumentOf(`<t><s>${wide}${magazines(2)}</s></t>`)
    const shelf = document.store.firstChildOf(document.store.firstChildOf(0))
    await show(document, shelf)
    const columnLabels = (): string[] =>
      [...container.querySelectorAll('.grid-column-picker-list label')].map(
        (l) => l.textContent ?? ''
      )
    container.querySelector<HTMLButtonElement>('.grid-column-picker > button')!.click()
    await settle()
    expect(columnLabels()).toContain('f61')
    const f61 = [...container.querySelectorAll<HTMLLabelElement>('.grid-column-picker-list label')]
      .find((l) => l.textContent === 'f61')!
      .querySelector('input')!
    f61.click()
    await settle()

    await switchTo('magazine')
    await switchTo('row')
    const picker = container.querySelector<HTMLButtonElement>('.grid-column-picker > button')!
    expect(picker.getAttribute('aria-label')).toBe('Show 1 more columns')
    // Acceptance 6: the picker it was opened from comes back closed.
    expect(container.querySelector('.grid-column-picker-list')).toBeNull()
  })

  it('acceptance 4: filters are kept on the node they were set on, and not carried to a sibling', async () => {
    const document = openDocumentOf(LIBRARY)
    const [first, second] = shelves(document)
    await show(document, first)
    header('year').querySelector<HTMLButtonElement>('.grid-header-label')!.click()
    await typeFilter('t3', 1)
    expect(firstColumn(0)).toEqual(['t3'])

    await switchTo('magazine')
    await switchTo('book')
    expect(quickFilter().value).toBe('t3')
    expect(firstColumn(0)).toEqual(['t3'])

    // The sibling shelf: the shape is shared by group name, the filter is not.
    await show(document, second)
    expect(quickFilter().value).toBe('')
    expect(container.querySelectorAll('.grid-row')).toHaveLength(5)
    expect(sortLabel()).toBe('year ▲')

    // And back on the first shelf, its filter is still there.
    await show(document, first)
    expect(quickFilter().value).toBe('t3')
    expect(firstColumn(0)).toEqual(['t3'])
  })

  it('a filter typed just before switching away is kept, even inside the debounce', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    typeInto(quickFilter(), 't4')
    await switchTo('magazine')
    await switchTo('book')
    expect(quickFilter().value).toBe('t4')
    expect(firstColumn(0)).toEqual(['t4'])
  })

  it('acceptance 5: a sort and pin on a column the sibling does not have are dropped there, and kept for the node that has it', async () => {
    const document = openDocumentOf(LIBRARY)
    const [first, second] = shelves(document)
    await show(document, first)
    header('isbn').querySelector<HTMLButtonElement>('.grid-header-label')!.click()
    header('isbn').querySelector<HTMLButtonElement>('.grid-header-pin')!.click()
    await settle()
    expect(sortLabel()).toBe('isbn ▲')

    await show(document, second)
    expect(container.querySelector('[role=grid]')).not.toBeNull()
    expect(sortLabel()).toBeNull()
    expect(header('isbn')).toBeUndefined()
    // Changing the shape here must not forget what the first shelf had.
    header('title').querySelector<HTMLButtonElement>('.grid-header-pin')!.click()
    await settle()

    await show(document, first)
    expect(sortLabel()).toBe('isbn ▲')
    expect(header('isbn').querySelector('.grid-header-pin')!.getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(header('title').querySelector('.grid-header-pin')!.getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('the scroll offset is restored, and not undone by bringing the active row into view', async () => {
    const document = openDocumentOf(
      `<library><shelf>${books(400, true)}${magazines(3)}</shelf></library>`
    )
    await show(document, shelves(document)[0])
    const scroller = (): HTMLElement => container.querySelector<HTMLElement>('.grid-scroll')!
    scroller().scrollTop = 3000
    scroller().dispatchEvent(new Event('scroll'))
    await settle()
    const offset = scroller().scrollTop
    expect(offset).toBeGreaterThan(1000)

    await switchTo('magazine')
    await switchTo('book')
    expect(scroller().scrollTop).toBe(offset)
    expect(firstColumn(0)).not.toContain('t0')
  })

  it('the selected tab and the table survive an edit that replaces the store, and a reparse that renumbers names', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    header('year').querySelector<HTMLButtonElement>('.grid-header-label')!.click()
    await settle()
    await switchTo('magazine')
    await switchTo('book')

    // A new store for the same file, as every edit produces — and a fresh
    // interner that has seen other names first, as a full reparse can, so the
    // same column names carry different ids.
    const renumbering = new Interner()
    const primer = new TextEncoder().encode('<zz><year/><magazine/><title/></zz>')
    xmlFormatModule.parse(primer, new NodeStore(primer, renumbering), options)
    const reparsed = openDocumentOf(LIBRARY, renumbering)
    expect(reparsed.store.nameIdOf(reparsed.store.firstChildOf(0))).not.toBe(
      document.store.nameIdOf(document.store.firstChildOf(0))
    )
    await show(reparsed, shelves(reparsed)[0])
    expect(sortLabel()).toBe('year ▲')

    await switchTo('magazine')
    await show(openDocumentOf(LIBRARY), shelves(document)[0])
    expect(
      container.querySelector('.grid-group-tablist [aria-selected=true] .grid-group-tab-name')!
        .textContent
    ).toBe('magazine')
  })

  it('acceptance 8: Copy Grid exports the restored order and filter', async () => {
    let copied = ''
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => ((copied = text), Promise.resolve()) }
    })
    try {
      const document = openDocumentOf(LIBRARY)
      await show(document, shelves(document)[0])
      header('isbn').querySelector<HTMLButtonElement>('.grid-header-label')!.click()
      await settle()
      // `899` matches isbn 8999–8995 (t1–t5) and not 9000 (t0).
      await typeFilter('899', 5)
      await switchTo('magazine')
      await switchTo('book')
      copyGridAs('csv')
      await settle()
      const lines = copied.trim().split(/\r?\n/)
      expect(lines[0]).toBe('title,year,isbn')
      expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['t5', 't4', 't3', 't2', 't1'])
    } finally {
      if (original === undefined) delete (navigator as { clipboard?: unknown }).clipboard
      else Object.defineProperty(navigator, 'clipboard', original)
    }
  })

  it('a restored horizontal offset survives the pinned columns settling after mount', async () => {
    const fields = (i: number): string =>
      Array.from({ length: 40 }, (_, f) => `<f${f}>value ${i} ${f}</f${f}>`).join('')
    const wide = Array.from({ length: 5 }, (_, i) => `<row>${fields(i)}</row>`).join('')
    const document = openDocumentOf(`<t><s>${wide}${magazines(2)}</s></t>`)
    await show(document, document.store.firstChildOf(document.store.firstChildOf(0)))
    header('f0').querySelector<HTMLButtonElement>('.grid-header-pin')!.click()
    await settle()
    // The active cell in an unpinned column near the left, which the scroll below
    // leaves off screen — the case where re-running the column-follow effect
    // would move the view.
    container
      .querySelectorAll<HTMLElement>('.grid-row')[0]!
      .querySelectorAll<HTMLElement>('[role=gridcell]')[2]!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await settle()
    const scroller = (): HTMLElement => container.querySelector<HTMLElement>('.grid-scroll')!
    scroller().scrollLeft = 1500
    scroller().dispatchEvent(new Event('scroll'))
    await settle()
    const offset = scroller().scrollLeft
    expect(offset).toBeGreaterThan(1000)

    await switchTo('magazine')
    await switchTo('row')
    expect(scroller().scrollLeft).toBe(offset)
  })

  it('acceptance 6: a pending export confirmation is dismissed with its grid, not left to do nothing', async () => {
    const document = openDocumentOf(
      `<library><shelf>${Array.from({ length: 50_001 }, (_, i) => `<book><n>${i}</n></book>`).join('')}${magazines(2)}</shelf></library>`
    )
    await show(document, shelves(document)[0])
    copyGridAs('csv')
    await settle()
    expect(getPushedNotifications().map((n) => n.id)).toContain('dedupe:grid.exportConfirm')

    await switchTo('magazine')
    expect(getPushedNotifications().map((n) => n.id)).not.toContain('dedupe:grid.exportConfirm')
    await switchTo('book')
    expect(getPushedNotifications().map((n) => n.id)).not.toContain('dedupe:grid.exportConfirm')
  })
})

describe('R213 — the order of a table returned to is reused, not recomputed', () => {
  const clickLabel = (name: string): void =>
    header(name).querySelector<HTMLButtonElement>('.grid-header-label')!.click()

  it('switching back with the same sort and filter reuses the order, and unsorting afterwards is still right', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    clickLabel('isbn')
    await settle()
    await typeFilter('899', 5)
    await switchTo('magazine')
    await switchTo('book')
    expect(cacheHitCountForTests()).toBe(1)
    expect(firstColumn(0)).toEqual(['t5', 't4', 't3', 't2', 't1'])

    // asc → desc → unsorted: the filter's own document order, which on a hit is
    // derived from the cached order rather than from a filter pass.
    clickLabel('isbn')
    await settle()
    expect(firstColumn(0)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    clickLabel('isbn')
    await settle()
    expect(sortLabel()).toBeNull()
    expect(firstColumn(0)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('flipping between two sorted groups reuses both orders', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    clickLabel('year')
    await settle()
    await switchTo('magazine')
    clickLabel('issue')
    await settle()
    clickLabel('issue')
    await settle()
    expect(firstColumn(0)).toEqual(['2', '1', '0'])
    await switchTo('book')
    await switchTo('magazine')
    await switchTo('book')
    await switchTo('magazine')
    expect(cacheHitCountForTests()).toBe(4)
    expect(firstColumn(0)).toEqual(['2', '1', '0'])
  })

  it('a table left unsorted and unfiltered leaves nothing to reuse', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    await switchTo('magazine')
    await switchTo('book')
    expect(cacheHitCountForTests()).toBe(0)
  })

  it('an edit misses the cache and recomputes, with the view state still restored', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    clickLabel('year')
    await settle()
    await switchTo('magazine')
    // Every edit produces a new store for the same file.
    const edited = openDocumentOf(LIBRARY)
    await show(edited, shelves(edited)[0])
    await switchTo('book')
    expect(cacheHitCountForTests()).toBe(0)
    expect(sortLabel()).toBe('year ▲')
  })

  it('a filter still inside its debounce when the table is left is recomputed, not served stale', async () => {
    const document = openDocumentOf(LIBRARY)
    await show(document, shelves(document)[0])
    clickLabel('isbn')
    await settle()
    typeInto(quickFilter(), 't4')
    await switchTo('magazine')
    await switchTo('book')
    expect(cacheHitCountForTests()).toBe(0)
    expect(firstColumn(0)).toEqual(['t4'])
  })
})
