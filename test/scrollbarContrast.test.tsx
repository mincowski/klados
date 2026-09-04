/**
 * R33/1b/1c/D-051. This is a contrast bug ("looks right" is not acceptance,
 * per R33-scrollbars-and-selection.md's own §1 acceptance section) —
 * so it's asserted on computed background colours through the browser
 * project (real Chromium; jsdom's getComputedStyle can't be trusted for
 * this), in both themes, rather than eyeballed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Scrollbar/Scrollbar.css'
import '../src/renderer/components/Scrubber/Scrubber.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  delete document.documentElement.dataset.theme
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function parseRgb(color: string): [number, number, number] {
  const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color)
  if (match === null) throw new Error(`unparseable color: ${color}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(parseRgb(a))
  const l2 = relativeLuminance(parseRgb(b))
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

describe('scrollbar track/thumb contrast (R33 §1b/§1c)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`thumb-vs-track meets the >= 3:1 minimum in ${theme}`, async () => {
      document.documentElement.dataset.theme = theme
      await paint(
        <div style={{ position: 'relative', width: '200px', height: '200px' }}>
          <div className="scrollbar-track scrollbar-track-vertical">
            <div className="scrollbar-thumb" style={{ top: '0%', height: '50%' }} />
          </div>
        </div>
      )
      const track = container.querySelector('.scrollbar-track') as HTMLElement
      const thumb = container.querySelector('.scrollbar-thumb') as HTMLElement
      const trackColor = getComputedStyle(track).backgroundColor
      const thumbColor = getComputedStyle(thumb).backgroundColor

      // §1c: the track must be a real, visible background — not transparent.
      expect(trackColor).not.toBe('rgba(0, 0, 0, 0)')

      const ratio = contrastRatio(trackColor, thumbColor)
      expect(ratio).toBeGreaterThanOrEqual(3)
    })
  }
})

// R33 addendum 2, item 6: the Scrubber now draws from the same shared
// ScrollStrip.css tokens as Scrollbar — asserted as parity, not just its own
// contrast minimum, so the two can't drift apart again without a test
// noticing.
describe('scrubber track/thumb contrast and parity with Scrollbar (R33 addendum 2)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`thumb-vs-track meets the >= 3:1 minimum in ${theme}`, async () => {
      document.documentElement.dataset.theme = theme
      await paint(
        <div style={{ position: 'relative', width: '200px', height: '200px' }}>
          <div className="scrubber">
            <div className="scrubber-thumb" style={{ top: '0%', height: '50%' }} />
          </div>
        </div>
      )
      const track = container.querySelector('.scrubber') as HTMLElement
      const thumb = container.querySelector('.scrubber-thumb') as HTMLElement
      const trackColor = getComputedStyle(track).backgroundColor
      const thumbColor = getComputedStyle(thumb).backgroundColor

      expect(trackColor).not.toBe('rgba(0, 0, 0, 0)')

      const ratio = contrastRatio(trackColor, thumbColor)
      expect(ratio).toBeGreaterThanOrEqual(3)
    })

    it(`renders pixel-identical track/thumb colours to Scrollbar in ${theme}`, async () => {
      document.documentElement.dataset.theme = theme
      await paint(
        <div style={{ position: 'relative', width: '200px', height: '200px' }}>
          <div className="scrollbar-track scrollbar-track-vertical">
            <div className="scrollbar-thumb" style={{ top: '0%', height: '50%' }} />
          </div>
          <div className="scrubber">
            <div className="scrubber-thumb" style={{ top: '0%', height: '50%' }} />
          </div>
        </div>
      )
      const scrollbarTrack = container.querySelector('.scrollbar-track') as HTMLElement
      const scrollbarThumb = container.querySelector('.scrollbar-thumb') as HTMLElement
      const scrubberTrack = container.querySelector('.scrubber') as HTMLElement
      const scrubberThumb = container.querySelector('.scrubber-thumb') as HTMLElement

      expect(getComputedStyle(scrubberTrack).backgroundColor).toBe(
        getComputedStyle(scrollbarTrack).backgroundColor
      )
      expect(getComputedStyle(scrubberThumb).backgroundColor).toBe(
        getComputedStyle(scrollbarThumb).backgroundColor
      )
      expect(getComputedStyle(scrubberTrack).width).toBe(getComputedStyle(scrollbarTrack).width)
    })
  }
})
