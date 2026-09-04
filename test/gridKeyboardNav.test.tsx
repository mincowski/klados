/**
 * R62 (`R61-keyboard-workflow.md` §3) — real-Chromium coverage for the
 * three keyboard changes text-only tests can't verify: that the header's
 * Pin/sort-label buttons are no longer separate Tab stops, that ArrowUp
 * from the grid body reaches the header row and Enter/`P` act on it, and
 * that the toolbar's roving-tabindex group moves with arrow keys. Follows
 * `test/grid.test.tsx`'s own harness (`Grid` mounted directly via
 * `react-dom/client`, a synthetic wide document).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { Grid } from '../src/renderer/components/Detail/Grid'
import { collectGroupMembers } from '../src/renderer/components/Detail/gridColumns'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Detail/Grid.css'
import '../src/renderer/components/Scrollbar/Scrollbar.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.height = '400px'
  container.style.width = '800px'
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
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function wideDocument(
  rows: number,
  cols: number
): { store: NodeStore; sourceBuffer: SourceBuffer; members: readonly number[] } {
  const parts: string[] = ['<elements>']
  for (let r = 0; r < rows; r++) {
    parts.push('<row>')
    for (let c = 0; c < cols; c++) parts.push(`<f${c}>v${r}_${c}</f${c}>`)
    parts.push('</row>')
  }
  parts.push('</elements>')
  const source = new TextEncoder().encode(parts.join(''))
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  const elements = store.firstChildOf(0)
  const rowNameId = store.nameIdOf(store.firstChildOf(elements))
  const members = collectGroupMembers(store, elements, rowNameId)
  return { store, sourceBuffer: new SourceBuffer(source, 'utf-8', 0), members }
}

function keydown(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('R62 §2 — the grid header no longer spends two Tab stops per column', () => {
  it('every Pin button and sortable header label has tabIndex -1', async () => {
    const { store, sourceBuffer, members } = wideDocument(10, 12)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const pins = container.querySelectorAll<HTMLButtonElement>('.grid-header-pin')
    const labels = container.querySelectorAll<HTMLButtonElement>('.grid-header-label')
    expect(pins.length).toBeGreaterThan(0)
    expect(labels.length).toBeGreaterThan(0)
    for (const btn of [...pins, ...labels]) expect(btn.tabIndex).toBe(-1)
  })
})

describe('R62 §3 — the header row is arrow-reachable from the grid pane', () => {
  it('ArrowUp from the body enters the header row on the active column', async () => {
    const { store, sourceBuffer, members } = wideDocument(10, 5)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const gridPane = container.querySelector('.grid-scroll') as HTMLDivElement
    expect(container.querySelectorAll('.grid-header-cell.grid-cell-active').length).toBe(0)

    keydown(gridPane, 'ArrowUp')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const activeHeaderCells = container.querySelectorAll('.grid-header-cell.grid-cell-active')
    expect(activeHeaderCells.length).toBe(1)
    expect(activeHeaderCells[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('Enter on the header row toggles sort for the active column', async () => {
    const { store, sourceBuffer, members } = wideDocument(10, 5)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const gridPane = container.querySelector('.grid-scroll') as HTMLDivElement
    keydown(gridPane, 'ArrowUp')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)
    keydown(gridPane, 'Enter')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const firstLabel = container.querySelector('.grid-header-label')!
    expect(firstLabel.textContent).toContain('▲')
  })

  it('"P" on the header row toggles pin for the active column', async () => {
    const { store, sourceBuffer, members } = wideDocument(10, 5)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const gridPane = container.querySelector('.grid-scroll') as HTMLDivElement
    keydown(gridPane, 'ArrowUp')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)
    keydown(gridPane, 'p')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const firstPin = container.querySelector('.grid-header-pin')!
    expect(firstPin.getAttribute('aria-pressed')).toBe('true')
  })

  it('leaving the header row (ArrowDown) clears the header-active highlight', async () => {
    const { store, sourceBuffer, members } = wideDocument(10, 5)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const gridPane = container.querySelector('.grid-scroll') as HTMLDivElement
    keydown(gridPane, 'ArrowUp')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)
    expect(container.querySelectorAll('.grid-header-cell.grid-cell-active').length).toBe(1)

    keydown(gridPane, 'ArrowDown')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    expect(container.querySelectorAll('.grid-header-cell.grid-cell-active').length).toBe(0)
  })
})

describe('R62 §3 — the toolbar buttons are one roving-tabindex group', () => {
  it('only one of filter/CSV/TSV/MD carries tabIndex 0 at a time, and ArrowRight moves it', async () => {
    const { store, sourceBuffer, members } = wideDocument(5, 3)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const filterToggle = container.querySelector<HTMLButtonElement>('.grid-filter-toggle')!
    const copyButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.grid-copy-buttons > button')
    )
    expect(copyButtons.length).toBe(3)

    const group = [filterToggle, ...copyButtons]
    expect(group.filter((b) => b.tabIndex === 0).length).toBe(1)
    expect(filterToggle.tabIndex).toBe(0)

    filterToggle.focus()
    keydown(filterToggle, 'ArrowRight')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    expect(filterToggle.tabIndex).toBe(-1)
    expect(copyButtons[0]!.tabIndex).toBe(0)
  })
})

// R93 (`R91-focus-into-content.md` §4): a defect found while checking R94
// would work — `Grid.tsx` had no scroll-into-view of any kind, so
// ArrowDown past the last *rendered* row moved `active.row` to a row the
// virtualizer had never mounted: the highlight vanished and further
// presses looked dead.
describe('R93 — the grid scrolls its active cell into view', () => {
  it('ArrowDown past the last visible row scrolls the grid and keeps the active row rendered', async () => {
    const { store, sourceBuffer, members } = wideDocument(200, 4)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const gridPane = container.querySelector('.grid-scroll') as HTMLDivElement
    expect(gridPane.scrollTop).toBe(0)

    // The 400px-tall container fits well under 30 of the 23px rows —
    // pressing far past that must scroll, not just move an invisible index.
    for (let i = 0; i < 100; i++) keydown(gridPane, 'ArrowDown')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    expect(gridPane.scrollTop).toBeGreaterThan(0)
    const active = container.querySelector('.grid-row-selected')
    expect(active).not.toBeNull()
    expect(active!.getAttribute('aria-rowindex')).toBe('101') // 1-based document position
  })

  it('ArrowRight past a pinned column lands the target clear of the sticky columns', async () => {
    const { store, sourceBuffer, members } = wideDocument(5, 20)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const gridPane = container.querySelector('.grid-scroll') as HTMLDivElement
    // Pin the first column via the header row's own "P" action (R62 §3).
    keydown(gridPane, 'ArrowUp')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)
    keydown(gridPane, 'p')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)
    keydown(gridPane, 'ArrowDown') // back to the body, column 0 still active
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const pinnedCell = container.querySelector('.grid-row-header-cell + .grid-cell')!
    const pinnedRight = pinnedCell.getBoundingClientRect().right

    for (let i = 0; i < 15; i++) keydown(gridPane, 'ArrowRight')
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    expect(gridPane.scrollLeft).toBeGreaterThan(0)
    const activeCell = container.querySelector('.grid-cell.grid-cell-active')
    expect(activeCell).not.toBeNull()
    // Not hidden underneath the pinned/sticky column.
    expect(activeCell!.getBoundingClientRect().left).toBeGreaterThanOrEqual(pinnedRight)
  })
})
