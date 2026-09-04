/**
 * R34 §7: the data-path fixes (§2–§6) were measured headless; this is the
 * "cheaper half" the plan calls out as still needed — real Chromium,
 * asserting the rendering/interaction claims rather than the algorithmic
 * ones already covered by `gridColumns.test.ts`/`gridSort.test.ts`/
 * `gridFilter.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// R34 §3/§7, R43: a browser-project test needs to count `sampleColumnStats`
// calls, not wall time — Vitest's browser mode can't `vi.spyOn` an ESM named
// export directly ("module namespace is not configurable"), so the module
// is mocked instead, wrapping the real implementation and counting through
// it. `vi.hoisted` is required because `vi.mock` itself is hoisted above
// this file's other top-level statements. R43/D-071 replaced `Grid.tsx`'s
// own direct `isNumericColumn` call with `sampleColumnStats` (one scan
// answering both numeric-ness and default width) — this is that same call
// site's counter, renamed to track what `Grid.tsx` actually calls now.
const { sampleColumnStatsCalls } = vi.hoisted(() => ({ sampleColumnStatsCalls: { count: 0 } }))
vi.mock('../src/renderer/components/Detail/gridColumnWidth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/renderer/components/Detail/gridColumnWidth')>()
  return {
    ...actual,
    sampleColumnStats: (...args: Parameters<typeof actual.sampleColumnStats>) => {
      sampleColumnStatsCalls.count++
      return actual.sampleColumnStats(...args)
    }
  }
})

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
  vi.restoreAllMocks()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  // The virtualizer measures via `ResizeObserver`, which doesn't always
  // settle within two rAFs in headless Chromium (R33's own treeExpansion
  // precedent) — an extra macrotask tick gives it room to fire.
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

describe('Grid on wide tables (R34 §7)', () => {
  it('renders a bounded number of cells for a >=200-column table (§4 regression guard)', async () => {
    const { store, sourceBuffer, members } = wideDocument(50, 220)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    // Every column pinned would bypass the virtualizer entirely pre-R34 —
    // the regression this guards against is an unbounded cell count, not a
    // specific one, so the assertion is "far fewer than 220 columns × 50
    // rows worth of cells," not an exact number tied to viewport pixels.
    const cells = container.querySelectorAll('.grid-cell')
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.length).toBeLessThan(220 * 5)
  })

  it('does not re-sample every column on a picker tick (§3)', async () => {
    const { store, sourceBuffer, members } = wideDocument(30, 80)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const columnsButton = container.querySelector(
      '.grid-column-picker > button'
    ) as HTMLButtonElement | null
    expect(columnsButton).not.toBeNull()
    columnsButton!.click()
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      '.grid-column-picker-list input[type="checkbox"]'
    )
    expect(checkboxes.length).toBeGreaterThan(0)

    sampleColumnStatsCalls.count = 0
    checkboxes[0]!.click()
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    // Showing one more column costs at most a small, bounded number of
    // fresh answers (the newly-shown column, plus whatever was already
    // rendered and not yet cached) — never one call per *ordered* column,
    // which is what the old `useMemo` over the whole set used to cost.
    expect(sampleColumnStatsCalls.count).toBeLessThan(10)
  })

  it("the quick filter's excluded-match count is correct for a known hidden-column match (§5)", async () => {
    // 70 columns pushes column 65 (say) past GRID_COLUMN_CAP (60), so it's
    // in the overflow set and never shown — a real hidden column, not a
    // contrived one.
    const { store, sourceBuffer, members } = wideDocument(5, 70)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const quickFilter = container.querySelector('.grid-quick-filter') as HTMLInputElement | null
    expect(quickFilter).not.toBeNull()

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!
    nativeSetter.call(quickFilter, 'v0_69') // f69's value on row 0 — column 69 is overflow
    quickFilter!.dispatchEvent(new Event('input', { bubbles: true }))
    // The quick filter commits on a debounce (`FILTER_DEBOUNCE_MS`).
    await new Promise((resolve) => setTimeout(resolve, 300))
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const toggle = container.querySelector(
      '.grid-hidden-matches-toggle'
    ) as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    expect(toggle!.textContent).toContain('1 more match')

    toggle!.click()
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)
    const revealed = container.querySelectorAll('.grid-hidden-matches-list li')
    expect(revealed.length).toBe(1)
    expect(revealed[0]!.textContent).toBe('f69')
  })
})

// R43 (`R43-grid-sizing-and-scroll.md`, D-071): every column was
// `CELL_WIDTH = 160` regardless of content — replaced by a content-derived
// default (sampled, clamped) plus drag-resize as the escape hatch.
describe('Grid column widths (R43)', () => {
  it('a short column (id) is narrower than a long-text column (description)', async () => {
    const rows = ['Golf, a rather long descriptive text about the base trim level']
    const xml =
      '<elements>' +
      rows
        .map((desc, i) => `<row><id>${i + 1}</id><description>${desc}</description></row>`)
        .join('') +
      '</elements>'
    const source = new TextEncoder().encode(xml)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, options)
    const elements = store.firstChildOf(0)
    const rowNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, rowNameId)
    const sourceBuffer = new SourceBuffer(source, 'utf-8', 0)

    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const headers = container.querySelectorAll<HTMLElement>('.grid-header-cell')
    const idHeader = [...headers].find((h) => h.textContent?.includes('id'))
    const descHeader = [...headers].find((h) => h.textContent?.includes('description'))
    expect(idHeader).toBeDefined()
    expect(descHeader).toBeDefined()

    const idWidth = idHeader!.getBoundingClientRect().width
    const descWidth = descHeader!.getBoundingClientRect().width
    expect(descWidth).toBeGreaterThan(idWidth)
  })

  it('dragging the resize handle sets an explicit width, and double-clicking it resets to derived', async () => {
    const xml = '<elements><row><id>1</id><name>Golf</name></row></elements>'
    const source = new TextEncoder().encode(xml)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, options)
    const elements = store.firstChildOf(0)
    const rowNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, rowNameId)
    const sourceBuffer = new SourceBuffer(source, 'utf-8', 0)

    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const idHeader = [...container.querySelectorAll<HTMLElement>('.grid-header-cell')].find((h) =>
      h.textContent?.includes('id')
    )!
    const handle = idHeader.querySelector<HTMLElement>('.grid-header-resize-handle')!
    const before = idHeader.getBoundingClientRect().width

    const startX = idHeader.getBoundingClientRect().right
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: startX, pointerId: 1 })
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: startX + 80, pointerId: 1 })
    )
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const afterDrag = idHeader.getBoundingClientRect().width
    expect(afterDrag).toBeGreaterThan(before + 60) // grew by ~80px, not just noise

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)
    const afterReset = idHeader.getBoundingClientRect().width
    expect(afterReset).toBeCloseTo(before, 0)
  })
})

// R44 (`R43-grid-sizing-and-scroll.md`): the horizontal scrollbar
// track used to span the full viewport (painted over by the sticky row
// header/pinned columns) and `.grid-scroll` reserved no bottom gutter for
// it, so it covered the last row.
describe('Grid scrollbar geometry (R44)', () => {
  it("the horizontal track starts after the row header, not at the viewport's own left edge", async () => {
    const { store, sourceBuffer, members } = wideDocument(50, 30)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const scrollHost = container.querySelector<HTMLElement>('.grid-scroll')!
    const track = container.querySelector<HTMLElement>('.scrollbar-track-horizontal')
    expect(track).not.toBeNull()

    const hostLeft = scrollHost.getBoundingClientRect().left
    const trackLeft = track!.getBoundingClientRect().left
    // ROW_HEADER_WIDTH alone (56px, no pinned columns here) is the floor —
    // exactly 0 is the R44a bug (spanning the whole viewport, including the
    // row-header column pinned content paints over).
    expect(trackLeft - hostLeft).toBeGreaterThanOrEqual(56)
  })

  it('.grid-scroll reserves a bottom gutter only when a horizontal track is actually showing', async () => {
    const wide = wideDocument(50, 30)
    await paint(<Grid store={wide.store} sourceBuffer={wide.sourceBuffer} members={wide.members} />)
    const wideScroll = container.querySelector<HTMLElement>('.grid-scroll')!
    expect(getComputedStyle(wideScroll).marginBottom).not.toBe('0px')

    const narrow = wideDocument(50, 1)
    await paint(
      <Grid store={narrow.store} sourceBuffer={narrow.sourceBuffer} members={narrow.members} />
    )
    const narrowScroll = container.querySelector<HTMLElement>('.grid-scroll')!
    expect(container.querySelector('.scrollbar-track-horizontal')).toBeNull()
    expect(getComputedStyle(narrowScroll).marginBottom).toBe('0px')
  })

  // R45: `onWheel` used to read `deltaX` alone on the horizontal axis,
  // which is 0 for an ordinary mouse wheel — pointing at the horizontal
  // track and scrolling did nothing at all.
  it('an ordinary mouse wheel (deltaY only) scrolls the horizontal track', async () => {
    const { store, sourceBuffer, members } = wideDocument(50, 30)
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const scrollHost = container.querySelector<HTMLElement>('.grid-scroll')!
    const track = container.querySelector<HTMLElement>('.scrollbar-track-horizontal')!
    expect(scrollHost.scrollLeft).toBe(0)

    track.dispatchEvent(
      new WheelEvent('wheel', { deltaX: 0, deltaY: 120, bubbles: true, cancelable: true })
    )
    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    expect(scrollHost.scrollLeft).toBeGreaterThan(0)
  })
})

// R40 (`R39-grid-followups.md` §"R40"): virtualized body cells were
// `position: absolute` with no height, so they shrank to their own content
// (18.4px, or 20px when italic/derived) instead of the row's 23px
// (`ROW_HEIGHT`) — real layout, so this needs the browser project the same
// way every other height/geometry assertion here does.
describe('Grid row height (R40)', () => {
  it('every .grid-cell in a row matches its .grid-row height, including a derived and an absent cell', async () => {
    const xml =
      '<elements>' +
      '<row><name>Golf</name><engine><type>diesel</type><kw>110</kw></engine></row>' +
      '<row><name>Polo</name></row>' + // no <engine> — Absent in that column
      '</elements>'
    const source = new TextEncoder().encode(xml)
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, options)
    const elements = store.firstChildOf(0)
    const rowNameId = store.nameIdOf(store.firstChildOf(elements))
    const members = collectGroupMembers(store, elements, rowNameId)
    const sourceBuffer = new SourceBuffer(source, 'utf-8', 0)

    await paint(<Grid store={store} sourceBuffer={sourceBuffer} members={members} />)

    const rows = container.querySelectorAll<HTMLElement>('.grid-row')
    expect(rows.length).toBeGreaterThan(0)
    // At least one derived (italic, `engine`) and one absent cell must be
    // present in the rendered set for this assertion to actually exercise
    // the bug — not just happen to pass on plain text cells.
    expect(container.querySelector('.grid-cell-derived')).not.toBeNull()
    expect(container.querySelector('.grid-cell-absent')).not.toBeNull()

    for (const row of rows) {
      const rowHeight = row.getBoundingClientRect().height
      const cells = row.querySelectorAll<HTMLElement>('.grid-cell')
      for (const cell of cells) {
        expect(cell.getBoundingClientRect().height).toBeCloseTo(rowHeight, 0)
      }
    }
  })
})
