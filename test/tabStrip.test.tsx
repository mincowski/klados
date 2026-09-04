/**
 * R25 (`R24-tabs.md` §3) — the tab strip component itself: real
 * Chromium, real clicks, real DOM (jsdom can't be trusted for the layout
 * this renders, and `test/tabDisplay.test.ts` already covers the pure
 * logic in isolation). Same fake-parse infrastructure `test/tabs.test.ts`
 * uses (real `runParseJob`, no real `Worker`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import { resetContextForTests } from '../src/renderer/commands/context'
import type { KladosApi } from '../src/preload/api'
import type { DocumentSessionDeps } from '../src/renderer/session/documentSession'
import {
  activateNextTab,
  createTab,
  getActiveTabId,
  getSessionFor,
  resetTabsForTests
} from '../src/renderer/session/tabs'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/styles/base.css'
import '../src/renderer/components/TabStrip/TabStrip.css'
import { TabStrip } from '../src/renderer/components/TabStrip/TabStrip'

type FakeApi = {
  document: KladosApi['document'] & { read: (path: string) => Promise<ArrayBuffer> }
}

let nextRequestId = 1
const fakeReadTokenBytes = new Map<string, ArrayBuffer>()
let fakeReadTokenCounter = 0

function utf8(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

function fakeParse(bytes: ArrayBuffer, options: ParseClientOptions): Promise<ParseClientResult> {
  const response = runParseJob(
    { type: 'parse', requestId: nextRequestId++, bytes, filename: options.filename },
    (bytesConsumed) => options.onProgress?.(bytesConsumed)
  )
  if (response.type === 'error') return Promise.reject(new Error(response.message))
  return Promise.resolve(rehydrateParseResult(response))
}

async function fakeParseFromUrl(
  url: string,
  options: ParseClientOptions
): Promise<ParseClientResult> {
  const token = new URL(url).hostname
  const bytes = fakeReadTokenBytes.get(token)
  if (bytes === undefined) throw new Error(`no bytes registered for token ${token}`)
  fakeReadTokenBytes.delete(token)
  return fakeParse(bytes, options)
}

function fakeApi(text: string): FakeApi {
  const read = vi.fn().mockResolvedValue(utf8(text))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: text.length, readOnly: false }),
      read,
      mintReadToken: vi.fn().mockImplementation(async (path: string) => {
        const bytes = await read(path)
        const token = `fake-token-${fakeReadTokenCounter++}`
        fakeReadTokenBytes.set(token, bytes)
        return token
      }),
      getPathForFile: vi.fn().mockReturnValue(''),
      write: vi.fn().mockResolvedValue(undefined),
      saveAsDialog: vi.fn().mockResolvedValue(null),
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn().mockResolvedValue(undefined),
      onExternalChange: vi.fn().mockReturnValue(() => {})
    }
  }
}

function depsFor(text: string): Omit<DocumentSessionDeps, 'isActive'> {
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text) }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetTabsForTests()
  resetContextForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetContextForTests()
})

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(<TabStrip />)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

describe('TabStrip (R25)', () => {
  it('renders one tab per open document, marking the active one', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    createTab(depsFor('<b/>'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await paint()

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs.length).toBe(2)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false')
    expect(tabs[0]!.textContent).toContain('a.json')
  })

  it('clicking a background tab makes it active', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await getSessionFor(tabB)!.openPath('C:/docs/b.xml')
    await paint()

    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]')
    tabs[1]!.click()
    await paint()

    const tabsAfter = container.querySelectorAll('[role="tab"]')
    expect(tabsAfter[0]!.getAttribute('aria-selected')).toBe('false')
    expect(tabsAfter[1]!.getAttribute('aria-selected')).toBe('true')
  })

  it('clicking a tab close slot removes just that tab', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await getSessionFor(tabB)!.openPath('C:/docs/b.xml')
    await paint()

    const closeButtons = container.querySelectorAll<HTMLElement>('.tab-close-slot')
    closeButtons[0]!.click()
    await paint()

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs.length).toBe(1)
    expect(tabs[0]!.textContent).toContain('b.xml')
  })

  it('the same filename in two tabs is disambiguated by its parent directory', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"a":2}'))
    await getSessionFor(tabA)!.openPath('C:/proj/data/config.json')
    await getSessionFor(tabB)!.openPath('C:/proj/test/config.json')
    await paint()

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs[0]!.textContent).toContain('data/config.json')
    expect(tabs[1]!.textContent).toContain('test/config.json')
  })
})

/** Opens `count` tabs, each wide enough (120px floor) that a 400px strip
 * overflows well before they all fit — R35-tab-overflow.md §1's own
 * measurement (16 tabs in 1200px overflow at ~8) scaled down to a smaller
 * test viewport. */
async function openManyTabs(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const id = createTab(depsFor(`{"i":${i}}`))
    await getSessionFor(id)!.openPath(`C:/docs/file-${i}.json`)
  }
  await paint()
}

/**
 * R48b (`R47-repo-hygiene.md`): the overflow buttons only appear once
 * the strip's own `ResizeObserver`-backed effect has actually run and found
 * `scrollWidth > clientWidth` (`TabStrip.tsx`'s `readOverflowState`) — that
 * effect fires synchronously on mount, but a cold-started browser instance
 * (this file run alone, or first in a batch) measured slower than `paint`'s
 * two `requestAnimationFrame`s allow, so a fixed-frame wait flaked here
 * specifically while passing reliably once other files had already warmed
 * the engine up. Polls for the actual condition instead of assuming a frame
 * count, the same "wait for what you're actually waiting for" fix R35's own
 * test above already applies via `scrollend`.
 */
async function waitForOverflowButtons(timeoutMs = 1000): Promise<void> {
  const start = performance.now()
  while (container.querySelectorAll('.tab-strip-scroll-btn').length === 0) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('waitForOverflowButtons: no overflow buttons appeared within the timeout')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

describe('TabStrip overflow (R35–R37)', () => {
  beforeEach(() => {
    container.style.width = '400px'
  })

  it('the overflow controls are absent when every tab fits, present when it does not', async () => {
    await openManyTabs(2)
    expect(container.querySelector('.tab-strip-scroll-btn')).toBeNull()

    await openManyTabs(8) // 10 total — well past a 400px strip's capacity
    await waitForOverflowButtons()
    expect(container.querySelectorAll('.tab-strip-scroll-btn').length).toBeGreaterThan(0)
    expect(container.querySelector('.tab-strip-menu')).not.toBeNull()
  })

  it('R35: activating a tab outside the visible range scrolls it into view', async () => {
    await openManyTabs(10)
    const scrollEl = container.querySelector<HTMLElement>('.tab-strip-scroll')!
    expect(scrollEl.scrollLeft).toBe(0)

    // Jump straight to the last tab, mirroring Ctrl+Tab wrapping all the
    // way around — R35-tab-overflow.md §1's own reproduction. R38 made this
    // `scrollIntoView` smooth, so the assertion below can't check the final
    // position immediately after paint() — wait for the animation's own
    // `scrollend` event instead of asserting on its timing.
    const scrollSettled = new Promise<void>((resolve) => {
      scrollEl.addEventListener('scrollend', () => resolve(), { once: true })
    })
    for (let i = 0; i < 9; i++) activateNextTab()
    await paint()
    await scrollSettled

    const activeTab = container.querySelector<HTMLElement>('.tab-active')!
    expect(activeTab.textContent).toContain('file-9.json')

    const stripRect = scrollEl.getBoundingClientRect()
    const tabRect = activeTab.getBoundingClientRect()
    expect(tabRect.left).toBeGreaterThanOrEqual(stripRect.left - 1)
    expect(tabRect.right).toBeLessThanOrEqual(stripRect.right + 1)
  })

  it('clicking the right chevron scrolls the strip without changing the active tab', async () => {
    await openManyTabs(10)
    const scrollEl = container.querySelector<HTMLElement>('.tab-strip-scroll')!
    const activeBefore = getActiveTabId()
    await waitForOverflowButtons()

    const buttons = container.querySelectorAll<HTMLButtonElement>('.tab-strip-scroll-btn')
    expect(buttons).toHaveLength(3) // left chevron, right chevron, menu
    const [, rightChevron] = buttons
    rightChevron!.click()
    await paint()

    expect(scrollEl.scrollLeft).toBeGreaterThan(0)
    expect(getActiveTabId()).toBe(activeBefore)
  })

  it('the left chevron is disabled at scrollLeft 0, the right one at the maximum', async () => {
    await openManyTabs(10)
    const scrollEl = container.querySelector<HTMLElement>('.tab-strip-scroll')!
    await waitForOverflowButtons()
    const buttons = container.querySelectorAll<HTMLButtonElement>('.tab-strip-scroll-btn')
    expect(buttons).toHaveLength(3)
    const [leftChevron, rightChevron] = buttons
    expect(leftChevron!.disabled).toBe(true)
    expect(rightChevron!.disabled).toBe(false)

    scrollEl.scrollLeft = scrollEl.scrollWidth
    scrollEl.dispatchEvent(new Event('scroll'))
    await paint()

    const [leftAfter, rightAfter] =
      container.querySelectorAll<HTMLButtonElement>('.tab-strip-scroll-btn')
    expect(leftAfter!.disabled).toBe(false)
    expect(rightAfter!.disabled).toBe(true)
  })

  it('a wheel over the strip changes scrollLeft', async () => {
    await openManyTabs(10)
    const scrollEl = container.querySelector<HTMLElement>('.tab-strip-scroll')!
    expect(scrollEl.scrollLeft).toBe(0)

    scrollEl.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 200, deltaX: 0, bubbles: true, cancelable: true })
    )
    await paint()

    expect(scrollEl.scrollLeft).toBeGreaterThan(0)
  })

  it('the menu lists every open tab and activates the chosen one', async () => {
    await openManyTabs(10)
    await waitForOverflowButtons()
    const buttons = container.querySelectorAll<HTMLButtonElement>('.tab-strip-scroll-btn')
    expect(buttons).toHaveLength(3)
    const menuButton = buttons[2]!
    menuButton.click()
    await paint()

    const items = container.querySelectorAll('.tab-strip-menu-item')
    expect(items.length).toBe(10)

    ;(items[3] as HTMLElement).click()
    await paint()

    const activeTab = container.querySelector<HTMLElement>('.tab-active')!
    expect(activeTab.textContent).toContain('file-3.json')
  })
})

describe('TabStrip icons and scroll feel (R38)', () => {
  beforeEach(() => {
    container.style.width = '400px'
  })

  it('the three overflow buttons and + render an <svg>, not a text node', async () => {
    await openManyTabs(10)

    const scrollButtons = container.querySelectorAll<HTMLButtonElement>('.tab-strip-scroll-btn')
    expect(scrollButtons.length).toBe(3) // left chevron, right chevron, menu chevron
    scrollButtons.forEach((button) => {
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.textContent).toBe('')
    })

    const newTabButton = container.querySelector<HTMLButtonElement>('.tab-strip-new')!
    expect(newTabButton.querySelector('svg')).not.toBeNull()
    expect(newTabButton.textContent).toBe('')
  })

  it('with prefers-reduced-motion emulated, activation scrolls with behavior "auto"', async () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {}
        }) as unknown as MediaQueryList
    )
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      await openManyTabs(10)
      for (let i = 0; i < 9; i++) activateNextTab()
      await paint()

      expect(scrollIntoViewSpy).toHaveBeenCalled()
      const lastCallArgs = scrollIntoViewSpy.mock.calls.at(-1)![0]
      expect(lastCallArgs.behavior).toBe('auto')
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
      matchMediaSpy.mockRestore()
    }
  })

  it('a scroll event whose overflow state is unchanged does not re-render the strip', async () => {
    let renderCount = 0
    const onRender: ProfilerOnRenderCallback = () => {
      renderCount++
    }

    await new Promise<void>((resolve) => {
      root.render(
        <Profiler id="tabStrip" onRender={onRender}>
          <TabStrip />
        </Profiler>
      )
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

    for (let i = 0; i < 9; i++) {
      const id = createTab(depsFor(`{"i":${i}}`))
      await getSessionFor(id)!.openPath(`C:/docs/file-${i}.json`)
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

    const scrollEl = container.querySelector<HTMLElement>('.tab-strip-scroll')!
    renderCount = 0

    // Same scrollLeft as before (0) — overflow/atStart/atEnd all unchanged,
    // so this scroll event must not cause a re-render (R38 §2d).
    scrollEl.dispatchEvent(new Event('scroll'))
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

    expect(renderCount).toBe(0)
  })
})

// R71 (`R71-text-as-icons.md` §1/§5a, acceptance 3) removed
// `font-family: var(--font-mono)` from `.tab-icon` on the theory that it
// couldn't equalise the three markers' widths anyway (`<>`/`{}` two
// characters, `[ ]` three) — true when written, false by the end of the
// same round once §5a itself changed `[ ]` to `[]`. R83
// (`R82-hover-and-glyphs.md` §2) restored it for all three; R98
// (`R98-glyph-font-per-glyph.md` §2) narrowed that back to `{}`/`[]` only —
// Cascadia (`--font-mono`'s second entry) draws `<>`'s two chevrons
// meeting at a point at UI sizes, so the XML marker alone goes back to
// `--font-ui`, drawn open. The fixed width + centring stays, from R71.
describe('TabStrip format glyph styling (R71/R83/R98)', () => {
  beforeEach(() => {
    container.style.width = '400px'
  })

  it('.tab-icon resolves --font-ui for the XML marker (R98), with a fixed width', async () => {
    const id = createTab(depsFor('<a/>'))
    await getSessionFor(id)!.openPath('C:/docs/file.xml')
    await paint()

    const icon = container.querySelector<HTMLElement>('.tab-icon')!
    expect(icon.textContent).toBe('<>')
    const style = getComputedStyle(icon)
    expect(style.fontFamily).not.toContain('mono')
    expect(style.width).toBe('20px')
    expect(style.textAlign).toBe('center')
  })

  it('.tab-icon resolves --font-mono for the JSON marker, unchanged by R98', async () => {
    const id = createTab(depsFor('{"a":1}'))
    await getSessionFor(id)!.openPath('C:/docs/file.json')
    await paint()

    const icon = container.querySelector<HTMLElement>('.tab-icon')!
    expect(icon.textContent).toBe('{}')
    const style = getComputedStyle(icon)
    expect(style.fontFamily).toContain('mono')
  })
})
