/**
 * R46 (`R43-grid-sizing-and-scroll.md`): dragging the Grid's vertical
 * thumb measured at p90 33ms/frame, and the lead suspect was `Scrollbar`'s
 * own `MutationObserver`-driven `readMetrics` — a forced synchronous layout
 * — running once per *event* (a `scroll` firing on every `scrollTop` write,
 * a `MutationObserver` batch firing again for the same frame's
 * virtualization churn) rather than once per frame. This asserts the fix
 * (`requestAnimationFrame` coalescing) actually holds: many scroll +
 * mutation events dispatched within the same frame produce exactly one
 * `Scrollbar` re-render, not one per event.
 *
 * The cause itself (forced layout cost) was never measured directly — this
 * environment has no display for real frame-time profiling — so this
 * verifies the *mechanism* the fix relies on (fewer reads per frame),
 * which is what the fix can actually change, rather than a frame-time
 * number this environment cannot produce meaningfully.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { useRef } from 'react'
import { Scrollbar } from '../src/renderer/components/Scrollbar/Scrollbar'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Scrollbar/Scrollbar.css'

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
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function Harness(): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className="scrollbar-host" style={{ height: '100px', overflow: 'auto' }}>
      <div style={{ height: '1000px' }} />
      <Scrollbar target={ref} axis="vertical" />
    </div>
  )
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

describe('Scrollbar frame coalescing (R46)', () => {
  it('a scroll write plus two DOM mutations within the same frame cost one forced-layout read, not three', async () => {
    // `readMetrics` reads `scrollHeight`/`clientHeight`/`scrollWidth`/
    // `clientWidth` — spying on the getter directly measures how many
    // times the *forced layout* itself runs, independent of React's own
    // render batching (which would hide the difference this fix makes:
    // React 18 already coalesces multiple `setState` calls made within one
    // browser task into one commit, so counting re-renders can't tell a
    // coalesced read apart from three separate ones collapsed by React
    // itself rather than by this fix).
    let reads = 0
    const originalGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!.get!
    const spy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: Element
    ) {
      reads++
      return originalGetter.call(this) as number
    })

    await paint(<Harness />)
    const scrollEl = container.querySelector<HTMLElement>('.scrollbar-host')!
    reads = 0 // only count what the drag simulation below causes

    // A real thumb drag is one `pointermove` per frame — each one both
    // writes `scrollTop` (a `scroll` event) *and*, once virtualized rows
    // mount/unmount for the new position, triggers the `MutationObserver`
    // again for the same frame. Simulated here as one `scrollTop` write
    // plus two DOM mutations per simulated frame, over several frames —
    // each source read-worthy on its own, which is exactly the shape that
    // used to cost one forced layout per source instead of per frame.
    const FRAMES = 6
    for (let i = 0; i < FRAMES; i++) {
      scrollEl.scrollTop = i * 10
      const a = document.createElement('span')
      scrollEl.appendChild(a)
      const b = document.createElement('span')
      scrollEl.appendChild(b)
      scrollEl.removeChild(a)
      scrollEl.removeChild(b)
      await nextFrame()
    }
    await nextFrame() // settle any trailing coalesced callback

    spy.mockRestore()

    // Coalesced: at most one forced-layout read per simulated frame (plus
    // a little slack for a trailing callback), never the 3x a per-event
    // read would cost (one for the scroll, two for the two mutation
    // batches) — that 3x is exactly what ran before this fix.
    expect(reads).toBeLessThanOrEqual(FRAMES + 1)
    expect(reads).toBeGreaterThan(0)
  })
})
