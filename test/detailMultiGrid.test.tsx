/**
 * R211 (`docs/plans/R210-grid-grouping.md` §7) — several tables, one per
 * group. Real layout in the browser project, because the questions are
 * geometric: how tall a stacked table is, how many render, and whether the
 * single-table case still looks exactly like it did.
 *
 * The document fixture is `test/detailGrid.test.tsx`'s, with the child names
 * varied — kept as a local copy rather than extracted, the same way that file
 * and `test/detailBreadcrumbNav.test.tsx` already each carry their own.
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
import { GRID_TABLE_CAP } from '../src/renderer/components/Detail/gridDetection'
import {
  mountedGridCount,
  resetGridControllersForTests
} from '../src/renderer/components/Detail/gridController'
import type { OpenDocument } from '../src/renderer/session/documentSession'
import '../src/renderer/styles/tokens.css'
// **`base.css` too, unlike the neighbouring Detail tests.** It carries the
// global `box-sizing: border-box`, and without it every height measured here
// is a content box while the application measures a border box — a 320px
// bound reads as 322px, and the test would be describing a layout the app
// does not have.
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
  resetGridControllersForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetGridControllersForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

/** `groups` is a list of `[childName, memberCount]`, emitted in the order
 * given — so document order is whatever the test says it is. */
function documentOf(groups: readonly (readonly [string, number])[]): {
  document: OpenDocument
  selectedNode: number
} {
  const parts: string[] = ['<catalogue>']
  for (const [name, count] of groups) {
    for (let i = 0; i < count; i++) {
      parts.push(`<${name}><title>${name}${i}</title><n>${i}</n></${name}>`)
    }
  }
  parts.push('</catalogue>')
  const source = new TextEncoder().encode(parts.join(''))
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    xmlFormatModule.capabilities.rowBreakBytes
  )
  const document: OpenDocument = {
    filePath: 'C:/docs/catalogue.xml',
    fileName: 'catalogue.xml',
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
  // The Document root; its one child (`catalogue`) is the grid-eligible node
  // wrapper descent lands on.
  return { document, selectedNode: 0 }
}

const titles = (): string[] =>
  [...container.querySelectorAll('.detail-grid-title')].map((el) =>
    (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
  )
const tableCount = (): number => container.querySelectorAll('.detail-grid-container').length

describe('R211 — one table per group, rendered', () => {
  it('renders a table per qualifying group, in document order, each with its name', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 24],
          ['magazine', 3],
          ['dvd', 7]
        ])}
      />
    )
    expect(tableCount()).toBe(3)
    expect(titles()).toEqual(['book 24 rows', 'magazine 3 rows', 'dvd 7 rows'])
  })

  it('a single table is unchanged: one container, and no name heading above it', async () => {
    // The common case, and the one that must not gain chrome — "Children"
    // plus one table needs no second label.
    await paint(<DetailContent {...documentOf([['car', 12]])} />)
    expect(tableCount()).toBe(1)
    expect(titles()).toEqual([])
    expect(container.querySelector('.detail-grid-container-stacked')).toBeNull()
  })

  it('a singleton group is not a table and still lists beneath (D-014 unchanged)', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['car', 4],
          ['metadata', 1]
        ])}
      />
    )
    expect(tableCount()).toBe(1)
    expect(container.querySelector('.detail-children-list')).not.toBeNull()
  })

  it('acceptance 1, at the render level: growing a later group never changes which tables render', async () => {
    for (const magazines of [2, 3, 40]) {
      await paint(
        <DetailContent
          {...documentOf([
            ['book', 3],
            ['magazine', magazines]
          ])}
        />
      )
      expect(titles()[0]?.startsWith('book')).toBe(true)
      expect(titles()[1]?.startsWith('magazine')).toBe(true)
    }
  })

  it('caps the tables and says so, listing the rest', async () => {
    const groups = Array.from(
      { length: GRID_TABLE_CAP + 3 },
      (_, i) => [`kind${i}`, 2] as readonly [string, number]
    )
    await paint(<DetailContent {...documentOf(groups)} />)

    expect(tableCount()).toBe(GRID_TABLE_CAP)
    const note = container.querySelector<HTMLElement>('.detail-grid-overflow-note')
    expect(note).not.toBeNull()
    expect(note!.innerText).toContain(`${GRID_TABLE_CAP} of ${GRID_TABLE_CAP + 3}`)
    // The overflow is listed rather than dropped.
    expect(container.querySelector('.detail-children-list')).not.toBeNull()
  })

  it('each stacked table is sized to its own rows, and a long one is bounded', async () => {
    // `flex: 1` across several tables would give these two the same height,
    // which is the layout this replaces.
    await paint(
      <DetailContent
        {...documentOf([
          ['short', 2],
          ['long', 200]
        ])}
      />
    )
    const [shortTable, longTable] = [
      ...container.querySelectorAll<HTMLElement>('.detail-grid-container')
    ]
    const shortHeight = shortTable!.getBoundingClientRect().height
    const longHeight = longTable!.getBoundingClientRect().height

    expect(shortHeight).toBeLessThan(longHeight)
    // Two rows plus the toolbar and header row — nowhere near the 230px
    // floor a single table keeps.
    expect(shortHeight).toBeLessThan(150)
    // 200 rows would be 4,600px unbounded.
    expect(longHeight).toBeLessThanOrEqual(320)
  })

  it('the single-table case keeps R43 flex sizing rather than the stacked height', async () => {
    await paint(<DetailContent {...documentOf([['car', 2]])} />)
    const table = container.querySelector<HTMLElement>('.detail-grid-container')!
    // Two rows, but it still claims the pane: R43/D-071's floor and `flex: 1`.
    expect(table.getBoundingClientRect().height).toBeGreaterThanOrEqual(230)
  })

  it('a stacked table shows all its rows without scrolling when they fit', async () => {
    // **The assertion the estimated chrome constants failed.** They were
    // written as 41 + 24 against a real 44 + 23, so every stacked table
    // clipped 2px off its last row and each one scrolled by two pixels —
    // invisible in a screenshot, and exactly what a geometry test is for.
    await paint(
      <DetailContent
        {...documentOf([
          ['short', 3],
          ['other', 3]
        ])}
      />
    )
    for (const scroll of container.querySelectorAll<HTMLElement>('.grid-scroll')) {
      expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight)
    }
  })

  it('each grid is named after its group, so five tables are not five "Data grid"s', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 3],
          ['magazine', 2]
        ])}
      />
    )
    const labels = [...container.querySelectorAll('[role=grid]')].map((el) =>
      el.getAttribute('aria-label')
    )
    expect(labels).toEqual(['book data grid', 'magazine data grid'])
  })

  it('every rendered table is a live grid in the controller registry', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 3],
          ['magazine', 2],
          ['dvd', 2]
        ])}
      />
    )
    expect(mountedGridCount()).toBe(3)
  })
})
