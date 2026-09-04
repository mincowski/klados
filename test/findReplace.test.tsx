/**
 * R90 (`R86-find-as-query-surface.md` §6) — Replace and Replace All. Real
 * Chromium, a real document open through the fake-parse transport
 * (`findAutoSelect.test.tsx`'s own harness), `<FindBar>` and
 * `<Notifications>` rendered together so a Replace All confirmation's own
 * action buttons are real DOM elements wired through the real command
 * registry (`notifications.test.tsx`'s own note: no existing test stood
 * this combination up before).
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
  getSessionFor,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import { registerPane, resetFocusForTests } from '../src/renderer/focus'
import { FindBar } from '../src/renderer/components/Find/FindBar'
import {
  closeFind,
  openFind,
  openFindWithReplace,
  resetFindStoreForTests,
  setCurrentMatchIndex
} from '../src/renderer/components/Find/findStore'
import { Notifications } from '../src/renderer/notifications/Notifications'
import { resetNotificationsForTests } from '../src/renderer/notifications/notificationStore'
import {
  DEFAULT_TOTAL_MEMORY_BUDGET_BYTES,
  setTotalMemoryBudgetBytes
} from '../src/renderer/settings'
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Find/Find.css'
import '../src/renderer/notifications/Notifications.css'

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

function fakeApi(text: string, readOnly = false): FakeApi {
  const read = vi.fn().mockResolvedValue(utf8(text))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: text.length, readOnly }),
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

function depsFor(
  text: string,
  overrides: Partial<Omit<DocumentSessionDeps, 'isActive'>> = {}
): Omit<DocumentSessionDeps, 'isActive'> {
  return {
    parse: fakeParse,
    parseFromUrl: fakeParseFromUrl,
    api: fakeApi(text),
    reparseDelayMs: 5,
    ...overrides
  }
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
  resetNotificationsForTests()
  resetFocusForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetFindStoreForTests()
  resetNotificationsForTests()
  resetFocusForTests()
  setTotalMemoryBudgetBytes(DEFAULT_TOTAL_MEMORY_BUDGET_BYTES)
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

async function openDocument(
  text: string,
  overrides: Partial<Omit<DocumentSessionDeps, 'isActive'>> = {}
): Promise<void> {
  const id = createTab(depsFor(text, overrides))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/cats.json')
}

function typeIn(selector: string, text: string): void {
  const el = container.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector)!
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  nativeSetter.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function search(text: string): Promise<void> {
  typeIn('.find-input', text)
  await new Promise((resolve) => setTimeout(resolve, 250))
  await paint(<FindBar />)
}

function keydown(
  el: Element,
  key: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}
): void {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
  )
}

const CONTENT = '{"value":"cat cat cat"}'

// This content is short enough to also trip the unrelated
// "looks minified" banner (`minifiedDetection.ts`) — filtered out here so
// these assertions target the Replace-specific notification, not whichever
// one happens to render first.
function replaceNotifications(): Element[] {
  return [...container.querySelectorAll('.notification')].filter((el) =>
    /replac|read-only/i.test(el.textContent ?? '')
  )
}

describe('R90 — the replace row', () => {
  it('is collapsed by default and Ctrl+H opens it expanded', async () => {
    await openDocument(CONTENT)
    openFind()
    await paint(<FindBar />)
    expect(container.querySelector('.find-replace-row')).toBeNull()

    openFindWithReplace()
    await paint(<FindBar />)
    expect(container.querySelector('.find-replace-row')).not.toBeNull()
  })

  it('the replace row sits directly under the find row, same width, replace input aligned under the find textarea', async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    // A wide, positioned wrapper — `.find-bar`'s `max-width` is a
    // percentage of its positioned ancestor (`.layout` in the real app,
    // D-080); without one here it resolves against whatever this
    // harness's own root happens to be, narrow enough that both rows get
    // clamped and squeeze their textareas by different amounts (more
    // fixed-width siblings on the find row than the replace row), which
    // would make this geometry assertion measure the clamp, not the
    // layout it's meant to check (`test/r8Layout.test.tsx`'s own pattern).
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )

    const findRow = container.querySelector('.find-bar-row:not(.find-replace-row)')!
    const replaceRow = container.querySelector('.find-replace-row')!
    const findInput = container.querySelector('.find-input:not(.find-replace-input)')!
    const replaceInput = container.querySelector('.find-replace-input')!

    const findRowRect = findRow.getBoundingClientRect()
    const replaceRowRect = replaceRow.getBoundingClientRect()
    const findInputRect = findInput.getBoundingClientRect()
    const replaceInputRect = replaceInput.getBoundingClientRect()

    // Same left/right edges (same width), stacked directly (replace row's
    // top meets the find row's bottom, gap aside).
    expect(replaceRowRect.left).toBeCloseTo(findRowRect.left, 0)
    expect(replaceRowRect.right).toBeCloseTo(findRowRect.right, 0)
    expect(replaceRowRect.top).toBeGreaterThan(findRowRect.bottom - 1)

    // The replace input lines up under the find textarea — the spacer is
    // standing in for the disclosure button that only exists on the row
    // above.
    expect(replaceInputRect.left).toBeCloseTo(findInputRect.left, 0)
    expect(replaceInputRect.width).toBeCloseTo(findInputRect.width, 0)
  })

  it('is hidden in path mode even if it was expanded', async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(<FindBar />)
    expect(container.querySelector('.find-replace-row')).not.toBeNull()

    const pathToggle = container.querySelector<HTMLButtonElement>(
      '.find-toggle[title*="Path query"]'
    )!
    pathToggle.click()
    await paint(<FindBar />)
    expect(container.querySelector('.find-replace-row')).toBeNull()
    expect(container.querySelector('.find-replace-disclosure')).toBeNull()
  })

  it('Replace replaces only the current match and advances to the next', async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(<FindBar />)
    await search('cat')
    typeIn('.find-replace-input', 'dog')
    await paint(<FindBar />)

    expect(container.querySelector('.find-count')!.textContent).toContain('1 of 3')

    const replaceButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace'
    )!
    replaceButton.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await paint(<FindBar />)

    // Two "cat"s remain, and the bar has already landed on the next one.
    expect(container.querySelector('.find-count')!.textContent).toContain('of 2')
  })

  it('Replace All below the threshold runs immediately, no confirmation', async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(<FindBar />)
    await search('cat')
    typeIn('.find-replace-input', 'dog')
    await paint(<FindBar />)

    const replaceAllButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace All'
    )!
    replaceAllButton.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    expect(replaceNotifications()).toHaveLength(0)
    await search('dog')
    expect(container.querySelector('.find-count')!.textContent).toContain('of 3')
  })

  it('warns before committing when the undo entry would exceed the memory budget, and running it anyway still replaces', async () => {
    // A budget too small for the undo entry (original + replacement bytes)
    // but big enough for the tiny document itself to open.
    setTotalMemoryBudgetBytes(100)
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )
    await search('cat')
    typeIn('.find-replace-input', 'x'.repeat(200))
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    const replaceAllButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace All'
    )!
    replaceAllButton.click()
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    const notifications = replaceNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.textContent).toContain('cannot be undone')

    const confirmButton = [...notifications[0]!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Replace All'
    )!
    confirmButton.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    await search('x'.repeat(200))
    expect(container.querySelector('.find-count')!.textContent).toContain('of 3')
  })

  it('Cancel on the confirmation leaves the document untouched', async () => {
    setTotalMemoryBudgetBytes(100)
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )
    await search('cat')
    typeIn('.find-replace-input', 'x'.repeat(200))
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    const replaceAllButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace All'
    )!
    replaceAllButton.click()
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    const notifications = replaceNotifications()
    expect(notifications).toHaveLength(1)
    const cancelButton = [...notifications[0]!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel'
    )!
    cancelButton.click()
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    expect(replaceNotifications()).toHaveLength(0)
    await search('cat')
    expect(container.querySelector('.find-count')!.textContent).toContain('of 3')
  })

  it('a read-only document produces a clear refusal notification, not a silent no-op', async () => {
    await openDocument(CONTENT, { api: fakeApi(CONTENT, true) })
    openFindWithReplace()
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )
    await search('cat')
    typeIn('.find-replace-input', 'dog')
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    const replaceButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace'
    )!
    replaceButton.click()
    await paint(
      <>
        <FindBar />
        <Notifications />
      </>
    )

    const notification = container.querySelector('.notification')
    expect(notification).not.toBeNull()
    expect(notification!.textContent).toContain('read-only')
  })
})

describe('R120-R123 — the Find bar keyboard', () => {
  it('R120: Tab from the find input reaches the replace input, then Aa; Shift+Tab reverses', async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(<FindBar />)
    await search('cat')

    const findInput = container.querySelector<HTMLInputElement>(
      '.find-input:not(.find-replace-input)'
    )!
    const replaceInput = container.querySelector<HTMLInputElement>('.find-replace-input')!
    const aaToggle = container.querySelector<HTMLButtonElement>('.find-toggle[title="Match case"]')!

    findInput.focus()
    keydown(findInput, 'Tab')
    expect(document.activeElement).toBe(replaceInput)

    keydown(replaceInput, 'Tab')
    expect(document.activeElement).toBe(aaToggle)

    keydown(aaToggle, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(replaceInput)

    keydown(replaceInput, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(findInput)
  })

  it('R120: with the replace row collapsed, Tab from the find input reaches Aa directly', async () => {
    await openDocument(CONTENT)
    openFind()
    await paint(<FindBar />)
    await search('cat')

    const findInput = container.querySelector<HTMLInputElement>(
      '.find-input:not(.find-replace-input)'
    )!
    const aaToggle = container.querySelector<HTMLButtonElement>('.find-toggle[title="Match case"]')!

    findInput.focus()
    keydown(findInput, 'Tab')
    expect(document.activeElement).toBe(aaToggle)
  })

  it('R121: Enter in the replace field replaces exactly one match, on document bytes', async () => {
    const id = createTab(depsFor(CONTENT))
    setActiveTab(id)
    await getSessionFor(id)!.openPath('C:/docs/cats.json')
    openFindWithReplace()
    await paint(<FindBar />)
    await search('cat')
    typeIn('.find-replace-input', 'dog')
    await paint(<FindBar />)

    const replaceInput = container.querySelector<HTMLInputElement>('.find-replace-input')!
    keydown(replaceInput, 'Enter')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await paint(<FindBar />)

    expect(container.querySelector('.find-count')!.textContent).toContain('of 2')
    const state = getSessionFor(id)!.getSnapshot()
    expect(state.phase).toBe('ready')
    const bytes = state.phase === 'ready' ? state.document.sourceBuffer.bytes : new Uint8Array()
    expect(new TextDecoder().decode(bytes)).toBe('{"value":"dog cat cat"}')
  })

  it('R121: Ctrl+Alt+Enter from the find input is a no-op with the replace row collapsed', async () => {
    const id = createTab(depsFor(CONTENT))
    setActiveTab(id)
    await getSessionFor(id)!.openPath('C:/docs/cats.json')
    openFind()
    await paint(<FindBar />)
    await search('cat')

    const findInput = container.querySelector<HTMLInputElement>(
      '.find-input:not(.find-replace-input)'
    )!
    keydown(findInput, 'Enter', { ctrlKey: true, altKey: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await paint(<FindBar />)

    const state = getSessionFor(id)!.getSnapshot()
    const bytes = state.phase === 'ready' ? state.document.sourceBuffer.bytes : new Uint8Array()
    expect(new TextDecoder().decode(bytes)).toBe(CONTENT)
  })

  it('R121: Ctrl+Alt+Enter from the find input replaces all, with the replace row expanded', async () => {
    const id = createTab(depsFor(CONTENT))
    setActiveTab(id)
    await getSessionFor(id)!.openPath('C:/docs/cats.json')
    openFindWithReplace()
    await paint(<FindBar />)
    await search('cat')
    typeIn('.find-replace-input', 'dog')
    await paint(<FindBar />)

    const findInput = container.querySelector<HTMLInputElement>(
      '.find-input:not(.find-replace-input)'
    )!
    keydown(findInput, 'Enter', { ctrlKey: true, altKey: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await paint(<FindBar />)

    const state = getSessionFor(id)!.getSnapshot()
    const bytes = state.phase === 'ready' ? state.document.sourceBuffer.bytes : new Uint8Array()
    expect(new TextDecoder().decode(bytes)).toBe('{"value":"dog dog dog"}')
  })

  it("R121: the Replace and Replace All buttons' titles name their chords", async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(<FindBar />)

    const replaceButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace'
    )!
    const replaceAllButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace All'
    )!
    expect(replaceButton.title).toContain('Enter')
    expect(replaceAllButton.title).toContain('Ctrl+Alt+Enter')
  })

  it('R122: Escape on the Replace All button closes the bar and returns focus to a pane', async () => {
    await openDocument(CONTENT)
    const rawShell = document.createElement('div')
    rawShell.tabIndex = -1
    document.body.appendChild(rawShell)
    const unregister = registerPane('raw', rawShell)
    try {
      openFindWithReplace()
      await paint(<FindBar />)
      await search('cat')

      const replaceAllButton = [...container.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === 'Replace All'
      )!
      replaceAllButton.focus()
      keydown(replaceAllButton, 'Escape')
      await paint(<FindBar />)

      expect(container.querySelector('.find-bar')).toBeNull()
      expect(document.activeElement).toBe(rawShell)
    } finally {
      unregister()
      rawShell.remove()
    }
  })

  it('R122: Ctrl+Tab inside the bar does not move focus within the bar', async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(<FindBar />)
    await search('cat')

    const findInput = container.querySelector<HTMLInputElement>(
      '.find-input:not(.find-replace-input)'
    )!
    findInput.focus()
    keydown(findInput, 'Tab', { ctrlKey: true })
    expect(document.activeElement).toBe(findInput)
  })

  it('R123: Tab from the last control (Replace All) wraps to the disclosure button', async () => {
    await openDocument(CONTENT)
    openFindWithReplace()
    await paint(<FindBar />)
    await search('cat')

    const replaceAllButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Replace All'
    )!
    const disclosure = container.querySelector<HTMLButtonElement>('.find-replace-disclosure')!

    replaceAllButton.focus()
    keydown(replaceAllButton, 'Tab')
    expect(document.activeElement).toBe(disclosure)

    keydown(disclosure, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(replaceAllButton)
  })
})

describe('R126-R128 — the match count', () => {
  const MANY_CATS = `{"value":"${Array(65_432).fill('cat').join(' ')}"}`

  it('R126: the bar width is identical for a short and a long ordinal, and no label contains "(stale)"', async () => {
    await openDocument(MANY_CATS)
    openFind()
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )
    await search('cat')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )

    const bar = container.querySelector('.find-bar')!
    const widthAtOne = bar.getBoundingClientRect().width

    // Advance the ordinal into five digits without changing the total —
    // `setCurrentMatchIndex` directly, rather than clicking Next 12,344
    // times, since only the displayed ordinal (not real navigation) is
    // under test here.
    setCurrentMatchIndex(12_344)
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )

    expect(container.querySelector('.find-count')!.textContent).toContain(
      `${(12_345).toLocaleString()} of ${(65_432).toLocaleString()}`
    )
    const widthAtManyDigits = bar.getBoundingClientRect().width
    expect(widthAtManyDigits).toBeCloseTo(widthAtOne, 0)
    expect(container.textContent).not.toContain('(stale)')
  })

  it('R126: on a small document, "No matches" and a real count hit the same (floor) width', async () => {
    await openDocument(CONTENT)
    openFind()
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )

    await search('cat')
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )
    expect(container.querySelector('.find-count')!.textContent).toContain('of 3')
    const widthWithCount = container.querySelector('.find-bar')!.getBoundingClientRect().width

    await search('no-such-needle')
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )
    expect(container.querySelector('.find-count')!.textContent).toContain('No matches')
    const widthNoMatches = container.querySelector('.find-bar')!.getBoundingClientRect().width

    expect(widthNoMatches).toBeCloseTo(widthWithCount, 0)
  })

  it('R126: a short document keeps the 6em floor, no wider than before', async () => {
    await openDocument(CONTENT)
    openFind()
    await paint(
      <div style={{ position: 'relative', width: '900px', height: '400px' }}>
        <FindBar />
      </div>
    )
    await search('cat')

    const count = container.querySelector('.find-count')!
    const fontSize = parseFloat(getComputedStyle(count).fontSize)
    expect(count.getBoundingClientRect().width).toBeLessThanOrEqual(fontSize * 6 + 1)
  })

  it('R127: the count is vertically centred with the Aa button', async () => {
    await openDocument(CONTENT)
    openFind()
    await paint(<FindBar />)
    await search('cat')

    const count = container.querySelector('.find-count')!.getBoundingClientRect()
    const aa = container.querySelector('.find-toggle[title="Match case"]')!.getBoundingClientRect()
    const countCentre = count.top + count.height / 2
    const aaCentre = aa.top + aa.height / 2
    expect(Math.abs(countCentre - aaCentre)).toBeLessThanOrEqual(1)
  })

  it('R128: reopening Find restores both the query and the result', async () => {
    await openDocument(CONTENT)
    openFind()
    await paint(<FindBar />)
    await search('cat')
    expect(container.querySelector('.find-count')!.textContent).toContain('1 of 3')

    closeFind()
    await paint(<FindBar />)
    expect(container.querySelector('.find-bar')).toBeNull()

    openFind()
    await paint(<FindBar />)
    await new Promise((resolve) => setTimeout(resolve, 250))
    await paint(<FindBar />)

    expect(container.querySelector<HTMLInputElement>('.find-input')!.value).toBe('cat')
    expect(container.querySelector('.find-count')!.textContent).toContain('1 of 3')
  })

  it('R128: a case-sensitive search stays case-sensitive across a reopen', async () => {
    await openDocument('{"value":"Cat cat cat"}')
    openFind()
    await paint(<FindBar />)
    const aaToggle = container.querySelector<HTMLButtonElement>('.find-toggle[title="Match case"]')!
    aaToggle.click()
    await paint(<FindBar />)
    await search('cat')
    expect(container.querySelector('.find-count')!.textContent).toContain('of 2')

    closeFind()
    await paint(<FindBar />)
    openFind()
    await paint(<FindBar />)
    await new Promise((resolve) => setTimeout(resolve, 250))
    await paint(<FindBar />)

    expect(container.querySelector('.find-count')!.textContent).toContain('of 2')
    expect(
      container
        .querySelector<HTMLButtonElement>('.find-toggle[title="Match case"]')!
        .getAttribute('aria-pressed')
    ).toBe('true')
  })
})
