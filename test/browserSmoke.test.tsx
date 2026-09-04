/**
 * M5e-PLAN.md R10a. Proves the browser project renders real components into
 * real Chromium layout, not jsdom — asserting on `getBoundingClientRect`
 * (jsdom always returns zeros) is the point.
 */
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'

describe('vitest browser mode', () => {
  it('gives a mounted element real layout', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await new Promise<void>((resolve) => {
        root.render(<div style={{ width: '120px', height: '40px' }}>hello</div>)
        // Two rAFs: one for React's commit, one for the browser to paint.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      const rect = container.firstElementChild!.getBoundingClientRect()
      expect(rect.width).toBe(120)
      expect(rect.height).toBe(40)
    } finally {
      root.unmount()
      container.remove()
    }
  })
})
