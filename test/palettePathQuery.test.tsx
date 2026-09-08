/**
 * R72 (`R72-path-query.md` §5) — the `/` mode's empty-state grammar
 * block and the caret-annotated error line. Real Chromium, real document
 * open through the fake-parse transport (`test/tabStrip.test.tsx`'s own
 * harness) — the palette's path-query UI needs a real `readyDocument` to
 * render anything but the "open a document" placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL_MS, SETTLE_MS, TIMEOUT_MS } from './support/wait'
import { createRoot, type Root } from 'react-dom/client'
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
  createTab,
  getSessionFor,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import { Palette } from '../src/renderer/components/Palette/Palette'
import {
  isPaletteOpen,
  openPalette,
  resetPaletteStoreForTests
} from '../src/renderer/components/Palette/paletteStore'
import { resetPaletteRecencyForTests } from '../src/renderer/components/Palette/paletteLogic'
import { FindBar } from '../src/renderer/components/Find/FindBar'
import { getFindState, resetFindStoreForTests } from '../src/renderer/components/Find/findStore'
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Palette/CommandPalette.css'
import '../src/renderer/components/Find/Find.css'

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
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetTabsForTests()
  resetContextForTests()
  resetPaletteStoreForTests()
  resetPaletteRecencyForTests()
  resetFindStoreForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetContextForTests()
  resetPaletteStoreForTests()
  resetPaletteRecencyForTests()
  resetFindStoreForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

/**
 * R160 (`docs/plans/R159-fixed-duration-waits.md` §5): the palette evaluates a
 * path query inside a debounced effect, so every assertion below it used to sit
 * behind a 200 ms sleep — a 1.33× margin over a debounce that is a bare
 * `}, 150)` literal in `Palette.tsx`, which this file cannot even name. Two of
 * the seven sites that failed when the review halved every sleep were here.
 *
 * The DOM says when the preview has landed, so wait for that. Repainting inside
 * the poll is deliberate: these tests drive `root.render` explicitly rather
 * than leaving a mounted tree to re-render itself.
 */
async function waitForPalette(isSettled: () => boolean): Promise<void> {
  await vi.waitFor(
    async () => {
      await paint(<Palette />)
      if (!isSettled()) throw new Error('waitForPalette: the preview has not landed')
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

function typeInPalette(text: string): void {
  const input = container.querySelector<HTMLInputElement>('.palette-input')!
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )!.set!
  nativeSetter.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function openDocument(text: string): Promise<void> {
  const id = createTab(depsFor(text))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/file.xml')
}

describe('R72 §5 — the path-query empty state shows the grammar', () => {
  it('shows all six grammar rows when the / query is empty', async () => {
    await openDocument('<a><b/></a>')
    openPalette()
    await paint(<Palette />)
    typeInPalette('/')
    await paint(<Palette />)

    const examples = Array.from(container.querySelectorAll('.palette-path-help-example')).map(
      (el) => el.textContent
    )
    expect(examples).toEqual([
      'cars/car',
      'cars//price',
      'car[3]',
      'car[@id="c-001"]',
      // R129 added this row — the comparison predicate.
      'car[price>100]',
      '*'
    ])
  })
})

describe('R72 §5 — a malformed query renders a caret under the offending character', () => {
  it('the caret row lines up under the bad character, and the message renders separately', async () => {
    await openDocument('<a><b/></a>')
    openPalette()
    await paint(<Palette />)
    typeInPalette('/a[') // unterminated '['
    // The query is parsed inside the same debounced effect that evaluates it
    // against the store (`Palette.tsx`'s own comment: "a diagnostic shows
    // before Enter is pressed," not synchronously on every keystroke) — so the
    // diagnostic appearing is the condition (R160).
    await waitForPalette(() => container.querySelector('.palette-path-error-query') !== null)

    const query = container.querySelector('.palette-path-error-query')
    const caret = container.querySelector('.palette-path-error-caret')
    const message = container.querySelector('.palette-path-error-message')
    expect(query).not.toBeNull()
    expect(caret).not.toBeNull()
    expect(message).not.toBeNull()
    expect(query!.textContent).toBe('a[')
    // The caret string is spaces up to the offset, then '^' — its length
    // is offset + 1, which is what "lines up under the character" means
    // for a monospace row sharing the query's own font.
    expect(caret!.textContent!.indexOf('^')).toBe(caret!.textContent!.length - 1)
    expect(message!.textContent).toContain('[')
  })
})

// R88 (`R86-find-as-query-surface.md` §4) — Enter on a valid `/` query
// hands off to Find rather than publishing a `setDirectResult` snapshot:
// the palette closes, Find opens prefilled in path mode, and re-evaluates
// the query itself (R86) rather than being handed an already-computed
// node list.
describe('R88 — Enter on / hands off to Find rather than publishing a result', () => {
  it('closes the palette and opens Find with the query prefilled in path mode', async () => {
    await openDocument('<cars><car id="c-1"><price>100</price></car></cars>')
    openPalette()
    await paint(<Palette />)
    typeInPalette('/cars/car')
    // Enter is gated on `displayedPathQueryResult?.ok === true`, which the
    // palette reports as "Enter to show N matches" once the debounced preview
    // has landed — until then it reads "Evaluating…" (R160).
    await waitForPalette(() =>
      (container.querySelector('.palette-disabled-mode')?.textContent ?? '').includes(
        'Enter to show'
      )
    )

    const input = container.querySelector<HTMLInputElement>('.palette-input')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )

    expect(isPaletteOpen()).toBe(false)
    expect(getFindState().isOpen).toBe(true)

    await paint(<FindBar />)
    // Find re-evaluates the handed-off query itself and shows the count —
    // not a snapshot the palette computed and handed over. R160: that count
    // arriving is the condition.
    await vi.waitFor(
      async () => {
        await paint(<FindBar />)
        const count = container.querySelector('.find-count')?.textContent ?? ''
        if (!count.includes(' of ')) throw new Error('Find has not reported a count yet')
      },
      { interval: POLL_MS, timeout: TIMEOUT_MS }
    )
    const pathToggle = container.querySelector<HTMLButtonElement>(
      '.find-toggle[title*="Path query"]'
    )!
    expect(pathToggle.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector<HTMLInputElement>('.find-input')!.value).toBe('cars/car')
    expect(container.querySelector('.find-count')!.textContent).toContain('of 1')
  })
})
