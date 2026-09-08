/**
 * R87 (`R86-find-as-query-surface.md` §3) — the Find bar's `/` mode control:
 * `.*` and `/` are one exclusive group with `Aa` disabled while `/` is
 * active, and a path query runs on Enter rather than as you type. Same
 * real-session-through-fakeParse harness `findAutoSelect.test.tsx` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import type { KladosApi } from '../src/preload/api'
import type { DocumentSessionDeps } from '../src/renderer/session/documentSession'
import {
  createTab,
  getActiveSearchStoreInstance,
  getSessionFor,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import { POLL_MS, TIMEOUT_MS } from './support/wait'
import { FindBar, FIND_DEBOUNCE_MS } from '../src/renderer/components/Find/FindBar'
import { openFind, resetFindStoreForTests } from '../src/renderer/components/Find/findStore'
import '../src/renderer/styles/tokens.css'
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
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text), reparseDelayMs: 5 }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetTabsForTests()
  resetFindStoreForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetFindStoreForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const CARS_XML =
  '<cars><car id="c-1"><price>100</price></car><car id="c-2"><price>200</price></car></cars>'

async function openDocument(text = CARS_XML): Promise<void> {
  const id = createTab(depsFor(text))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/cars.xml')
}

function pathToggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.find-toggle[title*="Path query"]')!
}

function regexToggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.find-toggle[title="Use regular expression"]')!
}

function caseToggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.find-toggle[title*="Match case"]')!
}

function typeText(text: string): void {
  const input = container.querySelector<HTMLInputElement>('.find-input')!
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )!.set!
  nativeSetter.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressEnter(): void {
  const input = container.querySelector<HTMLInputElement>('.find-input')!
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  )
}

/**
 * R160 (`docs/plans/R159-fixed-duration-waits.md` §5): Enter in path mode runs
 * a chunked query, so "200 ms" was a guess at how long it takes. A new,
 * complete snapshot says it ran and finished.
 */
async function waitForPathResult(before: unknown): Promise<void> {
  await vi.waitFor(
    () => {
      const snapshot = getActiveSearchStoreInstance().getSnapshot()
      if (snapshot === before) throw new Error('waitForPathResult: the query has not run yet')
      if (!snapshot.complete) throw new Error('waitForPathResult: the result is not complete yet')
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

describe('R87 — the / mode control', () => {
  it('clicking / disables Aa and marks / checked, .* unchecked', async () => {
    await openDocument()
    openFind()
    await paint(<FindBar />)

    pathToggle().click()
    await paint(<FindBar />)

    expect(pathToggle().getAttribute('aria-checked')).toBe('true')
    expect(regexToggle().getAttribute('aria-checked')).toBe('false')
    expect(caseToggle().disabled).toBe(true)
  })

  it('clicking / again returns to plain mode and re-enables Aa', async () => {
    await openDocument()
    openFind()
    await paint(<FindBar />)
    pathToggle().click()
    await paint(<FindBar />)
    pathToggle().click()
    await paint(<FindBar />)

    expect(pathToggle().getAttribute('aria-checked')).toBe('false')
    expect(caseToggle().disabled).toBe(false)
  })

  it('/ and .* are mutually exclusive — clicking one switches off the other', async () => {
    await openDocument()
    openFind()
    await paint(<FindBar />)
    regexToggle().click()
    await paint(<FindBar />)
    expect(regexToggle().getAttribute('aria-checked')).toBe('true')

    pathToggle().click()
    await paint(<FindBar />)
    expect(pathToggle().getAttribute('aria-checked')).toBe('true')
    expect(regexToggle().getAttribute('aria-checked')).toBe('false')
  })

  it('typing in path mode does not search — only Enter does', async () => {
    await openDocument()
    openFind()
    await paint(<FindBar />)
    pathToggle().click()
    await paint(<FindBar />)

    typeText('cars/car')
    // R160 (`docs/plans/R159-fixed-duration-waits.md` §5): **deliberately still
    // a duration.** The assertion is that typing did *not* search, and there is
    // no condition for a thing that must not happen — a window comfortably past
    // the debounce a text search would have used is the correct tool.
    await new Promise((resolve) => setTimeout(resolve, FIND_DEBOUNCE_MS * 2))
    await paint(<FindBar />)
    expect(container.querySelector('.find-count')!.textContent).toContain('No matches')

    // Enter *does* search, so this half has a condition: a new, complete result.
    const beforeEnter = getActiveSearchStoreInstance().getSnapshot()
    pressEnter()
    await waitForPathResult(beforeEnter)
    await paint(<FindBar />)
    expect(container.querySelector('.find-count')!.textContent).toContain('of 2')
  })

  it('a malformed path shows a caret diagnostic in the footnote row', async () => {
    await openDocument()
    openFind()
    await paint(<FindBar />)
    pathToggle().click()
    await paint(<FindBar />)

    typeText('cars/')
    pressEnter()
    // R160: a *malformed* query never reaches the search store at all — it is
    // rejected at parse and rendered as a diagnostic — so there is no result
    // transition to wait for, and `waitForPathResult` times out on it. The
    // footnote appearing is this path's own condition. Worth writing down: two
    // assertions one line apart in the same file want different waits, and the
    // duration they shared was what made them look interchangeable.
    await vi.waitFor(
      async () => {
        await paint(<FindBar />)
        if (container.querySelector('.find-footnote-path') === null) {
          throw new Error('the path diagnostic has not rendered')
        }
      },
      { interval: POLL_MS, timeout: TIMEOUT_MS }
    )

    const footnote = container.querySelector('.find-footnote-path')
    expect(footnote).not.toBeNull()
    expect(footnote!.querySelector('.find-footnote-path-query')!.textContent).toBe('cars/')
  })
})
