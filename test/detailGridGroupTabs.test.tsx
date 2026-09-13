/**
 * R211 (`docs/plans/R210-grid-grouping.md` § 11, D-104) — one table at a time,
 * a tab per group. Real layout in the browser project, because the tab strip
 * is fitted to its measured width and the questions are geometric: how many
 * tabs fit, whether anything overflows, whether the table still claims the
 * pane.
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
import { nextGridGroup, previousGridGroup } from '../src/renderer/components/Detail/gridController'
import type { OpenDocument } from '../src/renderer/session/documentSession'
import '../src/renderer/styles/tokens.css'
// **`base.css` too, unlike the neighbouring Detail tests.** It carries the
// global `box-sizing: border-box`, and without it every width and height
// measured here is a content box while the application measures a border box
// — the test would be describing a layout the app does not have.
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
})

async function settle(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

async function paint(jsx: React.ReactNode): Promise<void> {
  root.render(jsx)
  await settle()
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function openDocumentOf(xml: string): OpenDocument {
  const source = new TextEncoder().encode(xml)
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    xmlFormatModule.capabilities.rowBreakBytes
  )
  return {
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
}

function membersXml(groups: readonly (readonly [string, number])[]): string {
  const parts: string[] = []
  for (const [name, count] of groups) {
    for (let i = 0; i < count; i++) {
      parts.push(`<${name}><title>${name}${i}</title><n>${i}</n></${name}>`)
    }
  }
  return parts.join('')
}

/** `groups` is a list of `[childName, memberCount]`, emitted in the order
 * given — so document order is whatever the test says it is. */
function documentOf(groups: readonly (readonly [string, number])[]): {
  document: OpenDocument
  selectedNode: number
} {
  // The Document root; its one child (`catalogue`) is the grid-eligible node
  // wrapper descent lands on.
  return {
    document: openDocumentOf(`<catalogue>${membersXml(groups)}</catalogue>`),
    selectedNode: 0
  }
}

const tabs = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('.grid-group-tablist [role=tab]')
]
const tabNames = (): string[] =>
  tabs().map((t) => t.querySelector('.grid-group-tab-name')!.textContent ?? '')
const selectedTab = (): string | undefined =>
  tabs()
    .find((t) => t.getAttribute('aria-selected') === 'true')
    ?.querySelector('.grid-group-tab-name')?.textContent ?? undefined
const gridLabel = (): string | null =>
  container.querySelector('[role=grid]')?.getAttribute('aria-label') ?? null
const moreButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('.grid-group-more-button:not([data-measure])')
const menuItems = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('.grid-group-menu-item')
]

describe('R211 — one table at a time, a tab per group', () => {
  it('mounts exactly one grid, with a tab per group in document order and the first selected', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 24],
          ['magazine', 3],
          ['dvd', 7]
        ])}
      />
    )
    expect(container.querySelectorAll('[role=grid]')).toHaveLength(1)
    expect(tabNames()).toEqual(['book', 'magazine', 'dvd'])
    expect(selectedTab()).toBe('book')
    expect(gridLabel()).toBe('book data grid')
  })

  it('shows each tab with its row count', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 24],
          ['magazine', 3]
        ])}
      />
    )
    const counts = tabs().map((t) => t.querySelector('.grid-group-tab-count')!.textContent)
    expect(counts).toEqual(['24', '3'])
  })

  it('clicking a tab swaps the table', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 4],
          ['magazine', 3]
        ])}
      />
    )
    tabs()[1]!.click()
    await settle()
    expect(selectedTab()).toBe('magazine')
    expect(gridLabel()).toBe('magazine data grid')
    expect(container.querySelectorAll('[role=grid]')).toHaveLength(1)
    expect(container.querySelectorAll('.grid-row')).toHaveLength(3)
  })

  it('a node with one group shows no tabs at all — the view from before R210', async () => {
    await paint(<DetailContent {...documentOf([['car', 12]])} />)
    expect(container.querySelector('.grid-group-tabs')).toBeNull()
    expect(container.querySelector('[role=tabpanel]')).toBeNull()
    expect(gridLabel()).toBe('car data grid')
  })

  it('the table keeps R43 flex sizing under the tabs', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['car', 2],
          ['bike', 2]
        ])}
      />
    )
    const table = container.querySelector<HTMLElement>('.detail-grid-container')!
    // Two rows, but it still claims the pane: R43/D-071's floor and `flex: 1`.
    expect(table.getBoundingClientRect().height).toBeGreaterThanOrEqual(230)
  })

  it('lists the one-off children beneath, and not the rows of the other groups', async () => {
    // The other groups are one tab away; listing their rows again would put
    // the same children in two places.
    await paint(
      <DetailContent
        {...documentOf([
          ['car', 4],
          ['bike', 3],
          ['metadata', 1],
          ['licence', 1]
        ])}
      />
    )
    const listed = container.querySelector<HTMLElement>('.detail-children-list')
    expect(listed).not.toBeNull()
    expect(listed!.innerText).toContain('metadata')
    expect(listed!.innerText).toContain('licence')
    expect(listed!.innerText).not.toContain('bike')
    expect(listed!.innerText).not.toContain('car')
  })

  it('acceptance 1, at the render level: growing a later group never changes the tabs or the selection', async () => {
    for (const magazines of [2, 3, 40]) {
      await paint(
        <DetailContent
          {...documentOf([
            ['book', 3],
            ['magazine', magazines]
          ])}
        />
      )
      expect(tabNames()).toEqual(['book', 'magazine'])
      expect(selectedTab()).toBe('book')
    }
  })

  it('there is no cap: all 21 groups of the cliff document are reachable', async () => {
    const groups = Array.from(
      { length: 21 },
      (_, i) => [`kind${String(i).padStart(2, '0')}`, 2] as readonly [string, number]
    )
    await paint(<DetailContent {...documentOf(groups)} />)

    const visible = tabs().length
    expect(visible).toBeGreaterThan(0)
    expect(visible).toBeLessThan(21) // 900px cannot fit 21 tabs
    expect(moreButton()!.textContent).toContain(`+${21 - visible} more`)

    moreButton()!.click()
    await settle()
    expect(menuItems()).toHaveLength(21 - visible)
    expect(visible + menuItems().length).toBe(21)
  })

  it('the tab row never overflows its width', async () => {
    const groups = Array.from(
      { length: 21 },
      (_, i) => [`a-rather-long-group-name-${i}`, 2] as readonly [string, number]
    )
    await paint(<DetailContent {...documentOf(groups)} />)
    const row = container.querySelector<HTMLElement>('.grid-group-tabs')!
    const rowRight = row.getBoundingClientRect().right
    for (const el of [...tabs(), moreButton()!]) {
      expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(rowRight + 0.5)
    }
    // And the pane itself gains no horizontal scroll range. The invisible
    // measuring copy of the row lays every tab out at natural width, and an
    // absolutely positioned box that wide still extends its scroll container.
    const pane = container.querySelector<HTMLElement>('.detail')!
    expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth)
  })

  it('a group chosen from the menu names itself on the more button and swaps the table', async () => {
    container.style.width = '360px'
    await paint(
      <DetailContent
        {...documentOf([
          ['alpha', 2],
          ['bravo', 2],
          ['charlie', 2],
          ['delta', 2],
          ['echo', 2],
          ['foxtrot', 2]
        ])}
      />
    )
    moreButton()!.click()
    await settle()
    const last = menuItems().at(-1)!
    expect(last.textContent).toContain('foxtrot')
    last.click()
    await settle()

    expect(gridLabel()).toBe('foxtrot data grid')
    // The current group is never invisible: when it lives in the menu, the
    // more button says which it is instead of "+N more".
    expect(moreButton()!.textContent).toContain('foxtrot')
    expect(moreButton()!.classList.contains('grid-group-tab-active')).toBe(true)
    expect(menuItems()).toHaveLength(0) // closed after choosing
    // And focus is not dropped to <body> by the chosen item unmounting.
    expect(document.activeElement).toBe(moreButton())
  })

  it('the menu closes on Escape and on a press outside it', async () => {
    container.style.width = '360px'
    await paint(
      <DetailContent
        {...documentOf([
          ['alpha', 2],
          ['bravo', 2],
          ['charlie', 2],
          ['delta', 2],
          ['echo', 2],
          ['foxtrot', 2],
          ['golf', 2],
          ['hotel', 2]
        ])}
      />
    )
    moreButton()!.click()
    await settle()
    expect(menuItems().length).toBeGreaterThan(0)
    menuItems()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(menuItems()).toHaveLength(0)

    moreButton()!.click()
    await settle()
    expect(menuItems().length).toBeGreaterThan(0)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await settle()
    expect(menuItems()).toHaveLength(0)
  })

  it('arrow keys move focus along the tabs without switching the table', async () => {
    // Manual activation: switching remounts the grid, which on a large group
    // is not free, so arrows must not do it on every press.
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 3],
          ['magazine', 3],
          ['dvd', 3]
        ])}
      />
    )
    const [first, second] = tabs()
    first!.focus()
    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await settle()
    expect(document.activeElement).toBe(second)
    expect(selectedTab()).toBe('book')
    // One Tab stop for the strip: only the focused tab is tabbable.
    expect(tabs().filter((t) => t.tabIndex === 0)).toEqual([second])
  })

  it('the palette commands step through the groups, wrapping at both ends', async () => {
    await paint(
      <DetailContent
        {...documentOf([
          ['book', 3],
          ['magazine', 3],
          ['dvd', 3]
        ])}
      />
    )
    nextGridGroup()
    await settle()
    expect(selectedTab()).toBe('magazine')
    previousGridGroup()
    previousGridGroup()
    await settle()
    expect(selectedTab()).toBe('dvd')
    nextGridGroup()
    await settle()
    expect(selectedTab()).toBe('book')
  })

  it('remembers the chosen group by name across sibling nodes of the same shape', async () => {
    const shelf = membersXml([
      ['book', 3],
      ['magazine', 2]
    ])
    const document = openDocumentOf(
      `<library><shelf>${shelf}</shelf><shelf>${shelf}</shelf><bin>${membersXml([
        ['crate', 2],
        ['box', 2]
      ])}</bin></library>`
    )
    const { store } = document
    const library = store.firstChildOf(0)
    const firstShelf = store.firstChildOf(library)
    const secondShelf = store.nextSiblingOf(firstShelf)
    const bin = store.nextSiblingOf(secondShelf)

    await paint(<DetailContent document={document} selectedNode={firstShelf} />)
    expect(selectedTab()).toBe('book')
    tabs()[1]!.click()
    await settle()
    expect(selectedTab()).toBe('magazine')

    await paint(<DetailContent document={document} selectedNode={secondShelf} />)
    expect(selectedTab()).toBe('magazine')

    // A node without that group shows its first, and does not forget it.
    await paint(<DetailContent document={document} selectedNode={bin} />)
    expect(selectedTab()).toBe('crate')
    await paint(<DetailContent document={document} selectedNode={firstShelf} />)
    expect(selectedTab()).toBe('magazine')
  })
})
