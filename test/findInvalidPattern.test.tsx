/**
 * R241 (`docs/plans/R241-regex-unicode-flag.md` §4, §4a; criteria 6, 8 and
 * 16) — the real Find bar, in real Chromium, for a regex that does not
 * compile under `u`, and for the harmless escapes §4a keeps working. Same
 * real-session-through-fakeParse harness `findPathMode.test.tsx` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
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
import { spawnedRegexFindWorkers } from '../src/renderer/session/regexFindJob'
import { POLL_MS, SETTLE_MS, TIMEOUT_MS } from './support/wait'
import { FindBar } from '../src/renderer/components/Find/FindBar'
import { openFind, resetFindStoreForTests } from '../src/renderer/components/Find/findStore'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Find/Find.css'

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

function fakeApi(text: string): { document: KladosApi['document'] } {
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
    } as unknown as KladosApi['document']
  }
}

function depsFor(text: string): Omit<DocumentSessionDeps, 'isActive'> {
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text), reparseDelayMs: 5 }
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  // Criterion 8 is about a normal window: in the harness's default narrow
  // viewport the bar has no room to grow, and the input is squeezed (§4).
  await page.viewport(1280, 800)
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
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

const DOC = '<items><item>x-y</item><item>a/b</item><item>-</item></items>'

async function openFindOn(text = DOC): Promise<void> {
  const id = createTab(depsFor(text))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/items.xml')
  openFind()
  await paint(<FindBar />)
}

function input(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.find-input')!
}

function counter(): string {
  return container.querySelector('.find-count-value')!.textContent ?? ''
}

function regexToggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.find-toggle[title="Use regular expression"]')!
}

function typeText(text: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )!.set!
  nativeSetter.call(input(), text)
  input().dispatchEvent(new Event('input', { bubbles: true }))
}

/** Types `pattern` and waits for the store to hold the query and a complete
 * result for it (the bar debounces). */
async function search(pattern: string): Promise<void> {
  typeText(pattern)
  await vi.waitFor(
    () => {
      const store = getActiveSearchStoreInstance()
      if (store.getQuery()?.text !== pattern) throw new Error('not searched yet')
      if (!store.getSnapshot().complete) throw new Error('not complete yet')
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
  await paint(<FindBar />)
}

describe('R241 — a regex that does not compile (criterion 6)', () => {
  const INVALID: readonly (readonly [string, string])[] = [
    // Invalid today as well.
    ['a(', 'Unterminated group'],
    // Invalid only under `u`, and not one §4a rewrites (`\k` is a letter).
    ['\\k', 'Invalid named reference'],
    ['a{', 'Incomplete quantifier']
  ]

  for (const [pattern, reason] of INVALID) {
    it(`${pattern} shows Invalid pattern, the engine's reason, and starts no worker`, async () => {
      await openFindOn()
      regexToggle().click()
      await paint(<FindBar />)
      const spawnedBefore = spawnedRegexFindWorkers()
      await search(pattern)
      expect(counter()).toBe('Invalid pattern')
      expect(container.querySelector('.find-footnote-pattern')!.textContent).toBe(reason)
      expect(input().getAttribute('aria-invalid')).toBe('true')
      expect(spawnedRegexFindWorkers()).toBe(spawnedBefore)
    })
  }

  it('the same text in plain mode just searches', async () => {
    await openFindOn()
    await search('a(')
    expect(counter()).toBe('No matches')
    expect(container.querySelector('.find-footnote-pattern')).toBeNull()
    expect(input().hasAttribute('aria-invalid')).toBe(false)
  })

  it('a valid pattern clears it', async () => {
    await openFindOn()
    regexToggle().click()
    await paint(<FindBar />)
    await search('a(')
    expect(counter()).toBe('Invalid pattern')
    await search('a(/)?')
    expect(counter()).toBe('1 of 1')
    expect(container.querySelector('.find-footnote-pattern')).toBeNull()
    expect(input().hasAttribute('aria-invalid')).toBe(false)
  })
})

describe('R241 §4a — harmless escapes keep working (criteria 6 and 16)', () => {
  // Find searches the markup too, so `\/` also finds every closing tag. The
  // expected count is the same pattern's without `u`: what it found before.
  const VALID: readonly string[] = ['x\\-y', '[\\-]', '\\/', 'a\\/b']

  for (const pattern of VALID) {
    it(`${pattern} searches as it did without u, and starts a worker`, async () => {
      const count = `1 of ${DOC.match(new RegExp(pattern, 'gi'))!.length}`
      await openFindOn()
      regexToggle().click()
      await paint(<FindBar />)
      const spawnedBefore = spawnedRegexFindWorkers()
      await search(pattern)
      expect(counter()).toBe(count)
      expect(input().hasAttribute('aria-invalid')).toBe(false)
      expect(spawnedRegexFindWorkers()).toBe(spawnedBefore + 1)
    })
  }
})

describe('R241 — the counter reserves the label (criterion 8)', () => {
  it('an invalid pattern does not change the input width', async () => {
    await openFindOn()
    regexToggle().click()
    await paint(<FindBar />)
    await search('a(/)?')
    const valid = input().getBoundingClientRect().width
    await search('a(')
    expect(counter()).toBe('Invalid pattern')
    expect(input().getBoundingClientRect().width).toBe(valid)
  })
})
