/**
 * M5e-PLAN.md R10c — proves 8a, 8c and 8e against real Chromium layout
 * (`getBoundingClientRect`/`getComputedStyle`, which jsdom fakes). Renders
 * the actual component CSS files with the actual class names, not a
 * re-description of them — a class rename in the source would break these
 * the same way it would break the real UI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX } from 'react'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/TitleBar/TitleBar.css'
import '../src/renderer/components/Layout/Layout.css'
import '../src/renderer/components/Find/Find.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
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

describe('R8a — Detail children row colour', () => {
  // User feedback after R8 landed: the header row reuses each column's own
  // `.detail-child-*` class for width alignment, so 8a's fix (giving
  // `.detail-child-name`/`.detail-child-preview` `--surface-fg`) also lit
  // up the *header's* copies of those same classes — the two rules tie on
  // specificity, and whichever comes later in the file wins regardless of
  // where the element actually sits. The original version of this test
  // couldn't have caught that: it queried `.detail-child-name` globally,
  // which — with the header rendered first in the DOM — matched the
  // header's own span, not the body row's, so "row differs from header"
  // was accidentally comparing the header against itself. Scoped queries
  // below, so each assertion measures the element it claims to.
  async function renderTable(): Promise<void> {
    await paint(
      <div className="detail-children-list">
        <div className="detail-children-header">
          <span className="detail-child-name">name</span>
          <span className="detail-child-kind">kind</span>
          <span className="detail-child-preview">value</span>
          <span className="detail-child-count">children</span>
        </div>
        <div className="detail-child-row">
          <span className="detail-child-name">car-0001</span>
          <span className="detail-child-kind">element</span>
          <span className="detail-child-preview">Honda Civic</span>
          <span className="detail-child-count">3</span>
        </div>
      </div>
    )
  }

  function colorOf(selector: string): string {
    return getComputedStyle(container.querySelector(selector)!).color
  }

  it('every header cell is uniformly dimmed, regardless of column', async () => {
    await renderTable()
    const header = '.detail-children-header '
    const secondary = colorFromVar(
      getComputedStyle(document.documentElement).getPropertyValue('--surface-fg-secondary')
    )
    expect(colorOf(header + '.detail-child-name')).toBe(secondary)
    expect(colorOf(header + '.detail-child-kind')).toBe(secondary)
    expect(colorOf(header + '.detail-child-preview')).toBe(secondary)
    expect(colorOf(header + '.detail-child-count')).toBe(secondary)
  })

  it('body rows read as more present than the header (D-050 shape)', async () => {
    await renderTable()
    const referenceFg = colorFromVar(
      getComputedStyle(document.documentElement).getPropertyValue('--surface-fg')
    )
    const row = '.detail-child-row '
    // Name, value and child-count are the row's own content — full
    // strength, matching the Attributes table's `td`.
    expect(colorOf(row + '.detail-child-name')).toBe(referenceFg)
    expect(colorOf(row + '.detail-child-preview')).toBe(referenceFg)
    expect(colorOf(row + '.detail-child-count')).toBe(referenceFg)
    // Kind stays metadata, dimmed — unchanged by this round of feedback.
    const secondary = colorFromVar(
      getComputedStyle(document.documentElement).getPropertyValue('--surface-fg-secondary')
    )
    expect(colorOf(row + '.detail-child-kind')).toBe(secondary)
  })
})

/** Resolves a CSS color token the same way the browser would when used as
 * a `color` value, so it can be compared against a computed `color`. */
function colorFromVar(rawValue: string): string {
  const probe = document.createElement('div')
  probe.style.color = rawValue.trim()
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return resolved
}

describe('R8c — title bar border spans the full window width', () => {
  it('the border lives below the overlay-obscured region, not inside it', async () => {
    await paint(
      <div style={{ width: '900px' }}>
        <div className="title-bar title-bar-win32" style={{ height: '32px' }}>
          bar content
        </div>
        <div className="layout" style={{ height: '400px' }} />
      </div>
    )
    const titleBar = container.querySelector('.title-bar')!
    const layout = container.querySelector('.layout')!

    // 8c's bug: `.title-bar`'s own border-bottom sat under Windows'
    // opaque caption-button overlay at its top-right, so the last ~138px
    // never painted visibly. The fix removes that border entirely.
    expect(getComputedStyle(titleBar).borderBottomWidth).toBe('0px')

    // It now lives on `.layout`'s border-top instead, and — critically —
    // `.layout` carries none of `.title-bar-win32`'s 138px reservation, so
    // its rect spans the container's full width edge to edge.
    const layoutStyle = getComputedStyle(layout)
    expect(layoutStyle.borderTopWidth).not.toBe('0px')
    const containerRect = container.querySelector('div')!.getBoundingClientRect()
    const layoutRect = layout.getBoundingClientRect()
    expect(layoutRect.width).toBeCloseTo(containerRect.width, 0)
  })
})

describe('R8e — Find bar position', () => {
  it('stays clear of the caption-button region and inside the pane', async () => {
    // `.raw-container` here is a stand-in for whatever `position: relative`
    // ancestor wraps `.find-bar` — R70 (`R69-focus-and-find.md` §2)
    // moved the real one from `.raw-container` (`Raw.tsx`) to `.layout`
    // (`Layout.tsx`), but `.find-bar`'s own CSS contract this test checks
    // (absolute, clear of the caption region, never escaping its ancestor)
    // is unchanged by which element actually provides the anchor.
    await paint(
      <div
        className="raw-container"
        style={{ position: 'relative', width: '640px', height: '400px' }}
      >
        <div className="find-bar" role="search" aria-label="Find in document">
          <div className="find-bar-row">
            <input className="find-input" defaultValue="needle" readOnly />
            <span className="find-count">1 of 3</span>
          </div>
        </div>
      </div>
    )
    const paneRect = container.querySelector('.raw-container')!.getBoundingClientRect()
    const findRect = container.querySelector('.find-bar')!.getBoundingClientRect()

    // Windows' caption-button overlay occupies the top-right ~138px of the
    // window — simulated here as the region right of `paneRect.right - 138`
    // within the first `title-bar` height's worth of vertical space. The
    // find bar must not start inside it.
    const captionRegionLeft = paneRect.right - 138
    expect(findRect.right).toBeLessThanOrEqual(paneRect.right + 0.5)
    expect(findRect.left).toBeLessThanOrEqual(captionRegionLeft)

    // And it must stay fully inside the pane it searches — no viewport-
    // relative `position: fixed` escaping `.raw-container`'s own bounds.
    expect(findRect.left).toBeGreaterThanOrEqual(paneRect.left - 0.5)
    expect(findRect.top).toBeGreaterThanOrEqual(paneRect.top - 0.5)
    expect(findRect.bottom).toBeLessThanOrEqual(paneRect.bottom + 0.5)
  })

  it('does not wrap: the footnote sits on its own row, not mid-control', async () => {
    await paint(
      <div
        className="raw-container"
        style={{ position: 'relative', width: '900px', height: '400px' }}
      >
        <div className="find-bar" role="search" aria-label="Find in document">
          <div className="find-bar-row">
            <input className="find-input" defaultValue="" readOnly />
            <button type="button" className="find-toggle">
              Aa
            </button>
            <button type="button" className="find-toggle">
              .*
            </button>
          </div>
          <span className="find-footnote">
            Case-insensitive matching uses byte-exact ASCII folding for plain text, platform Unicode
            casing for non-ASCII or regex searches.
          </span>
        </div>
      </div>
    )
    const row = container.querySelector('.find-bar-row')!.getBoundingClientRect()
    const input = container.querySelector('.find-input')!.getBoundingClientRect()
    const toggles = [...container.querySelectorAll('.find-toggle')].map((el) =>
      el.getBoundingClientRect()
    )
    // Every control in the row shares the row's own top — none of them
    // wrapped onto a second line within the row.
    for (const rect of [input, ...toggles]) {
      expect(Math.abs(rect.top - row.top)).toBeLessThan(2)
    }
  })
})

// R89 (`R86-find-as-query-surface.md` §5) — the pre-existing defect: below
// ~530px of `.layout` width the row's content no longer fit the clamped
// bar, and with no `overflow` declared anywhere the controls painted
// *outside* the bar and the window — the close button included, so Find
// couldn't be dismissed with the mouse (screenshotted at 420px). Fixed by
// making `.find-input` the row's only shrinkable item (`flex: 1 1 auto;
// min-width: 0`) and everything else `flex: none`, plus `overflow-x: auto`
// as the fallback below the point where even that isn't enough room
// (measured ~314px). Asserted geometrically, not by eye.
function findBarRow(): JSX.Element {
  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <div className="find-bar-row">
        <input className="find-input" defaultValue="" readOnly />
        <span className="find-count">1 of 3</span>
        <button type="button" className="find-toggle">
          Aa
        </button>
        <div className="find-mode-group">
          <button type="button" className="find-toggle">
            .*
          </button>
          <button type="button" className="find-toggle">
            /
          </button>
        </div>
        <button type="button" aria-label="Previous match">
          ↑
        </button>
        <button type="button" aria-label="Next match">
          ↓
        </button>
        <button type="button" aria-label="Close find">
          ✕
        </button>
      </div>
    </div>
  )
}

describe('R89 — the close button is reachable at every window width the app allows', () => {
  it('every control stays inside the bar at 420px — the width the pre-existing defect was screenshotted at', async () => {
    await paint(
      <div style={{ position: 'relative', width: '420px', height: '200px' }}>{findBarRow()}</div>
    )
    const bar = container.querySelector('.find-bar')!.getBoundingClientRect()
    const close = container.querySelector('[aria-label="Close find"]')!.getBoundingClientRect()
    const down = container.querySelector('[aria-label="Next match"]')!.getBoundingClientRect()

    // The bar itself never exceeds its container (the pre-existing
    // max-width clamp, unaffected by this round).
    expect(bar.right).toBeLessThanOrEqual(420 + 0.5)
    // And now every control paints inside the bar, not past its edge —
    // the close button and ↓ specifically, since those were the two that
    // left the window entirely at this width before the fix.
    expect(close.right).toBeLessThanOrEqual(bar.right + 0.5)
    expect(close.left).toBeGreaterThanOrEqual(bar.left - 0.5)
    expect(down.right).toBeLessThanOrEqual(bar.right + 0.5)
  })

  it('the row does not need to scroll at ~530px, above the measured floor', async () => {
    await paint(
      <div style={{ position: 'relative', width: '530px', height: '200px' }}>{findBarRow()}</div>
    )
    const row = container.querySelector<HTMLDivElement>('.find-bar-row')!
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1)
  })

  it('the row scrolls rather than overflows the bar at 314px, the measured floor', async () => {
    await paint(
      <div style={{ position: 'relative', width: '314px', height: '200px' }}>{findBarRow()}</div>
    )
    const bar = container.querySelector('.find-bar')!.getBoundingClientRect()
    const close = container.querySelector('[aria-label="Close find"]')!.getBoundingClientRect()
    // Still painted inside the bar's own bounds — reachable by scrolling
    // the row, never clipped off past the surface's edge the way it was
    // pre-fix.
    expect(close.right).toBeLessThanOrEqual(bar.right + 0.5)
  })
})
