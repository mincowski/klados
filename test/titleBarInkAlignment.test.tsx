/**
 * User feedback after R8 shipped: the mark and the title text sit in boxes
 * centered on the same line, but their *ink* didn't optically match — the
 * mark's artwork is taller and already ink-centered in its own box, while
 * a capital letter's cap-height ink sits low in its line box (the font
 * reserves descender space below the baseline even though "N" has none).
 * Fixed with a 1px `transform: translateY` nudge on `.title-bar-mark`
 * (`TitleBar.css`) so the two ink *centers* coincide instead of their
 * boxes. Real Chromium only: `SVGGraphicsElement.getBBox()` and canvas
 * `TextMetrics.actualBoundingBox{Ascent,Descent}` are both exact-geometry
 * APIs jsdom cannot back with real numbers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/TitleBar/TitleBar.css'
import { Mark } from '../src/renderer/components/TitleBar/Mark'

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

/** The mark's true visual ink extent — its own bounding box in viewBox
 * units, widened by half the 2px stroke width (round caps/joins extend
 * ink slightly past the raw path geometry), then mapped to page pixels
 * via the rendered element's own scale. */
function markInkCenter(markEl: SVGSVGElement): number {
  const rect = markEl.getBoundingClientRect()
  const bbox = markEl.getBBox()
  const strokeExtent = 1
  const scale = rect.height / 16 // viewBox is `0 0 16 16`
  const inkTop = rect.top + (bbox.y - strokeExtent) * scale
  const inkBottom = rect.top + (bbox.y + bbox.height + strokeExtent) * scale
  return (inkTop + inkBottom) / 2
}

/** The title text's true glyph-ink center for its first character — CSS
 * inline layout's own baseline math (half-leading + font ascent), not the
 * line box's geometric center, which is what makes a capital letter's
 * ink sit off-center in its box in the first place. */
function titleGlyphInkCenter(titleEl: HTMLElement): number {
  const rect = titleEl.getBoundingClientRect()
  const cs = getComputedStyle(titleEl)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const metrics = ctx.measureText(titleEl.textContent!.charAt(0))
  const lineHeightPx = rect.height
  const halfLeading =
    (lineHeightPx - (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) / 2
  const baselineFromTop = halfLeading + metrics.fontBoundingBoxAscent
  const inkTop = rect.top + baselineFromTop - metrics.actualBoundingBoxAscent
  const inkBottom = rect.top + baselineFromTop + metrics.actualBoundingBoxDescent
  return (inkTop + inkBottom) / 2
}

describe('title bar mark/title optical (ink) alignment', () => {
  it('the mark and the title text share an ink center, not just a box center', async () => {
    await paint(
      <div className="title-bar" style={{ height: '36px' }}>
        <div className="title-bar-title-area">
          <Mark />
          <span className="title-bar-title">Klados</span>
        </div>
      </div>
    )

    const mark = container.querySelector('.title-bar-mark') as unknown as SVGSVGElement
    const title = container.querySelector('.title-bar-title') as HTMLElement

    const markCenter = markInkCenter(mark)
    const titleCenter = titleGlyphInkCenter(title)

    // Box centers (both elements are flex-centered on the same line) are
    // already within a fraction of a pixel of each other by construction
    // — the bug was ink not matching despite that. Half a pixel of
    // tolerance is well under anything a person could perceive.
    expect(Math.abs(markCenter - titleCenter)).toBeLessThan(0.5)
  })
})
