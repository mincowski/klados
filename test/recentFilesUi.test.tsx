/**
 * R96–R97 (`R95-recent-files.md` §4–5): the start pane's two-column
 * layout — clicking a recent file opens it into the active tab (not a new
 * one), the columns stack rather than overflow at narrow widths, the empty
 * state reads plainly, and a stale entry cleans itself up while leaving the
 * pane usable for a second try. Real Chromium (`getBoundingClientRect`) is
 * what the stacking assertion needs; the rest just needs a real session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from '@vitest/browser/context'
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
  getTabIds,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import { resetContextForTests } from '../src/renderer/commands/context'
import '../src/renderer/session/commands' // registers klados.document.clearRecentFiles, once, on import
import {
  recordRecentFile,
  resetRecentFilesForTests,
  type RecentFile
} from '../src/renderer/session/recentFiles'
import { DocumentArea } from '../src/renderer/components/Layout/DocumentArea'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Layout/DocumentArea.css'

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

/** `stat` rejects (a gone/unreadable file) when `text` is `null`. */
function fakeApi(text: string | null): FakeApi {
  const read = vi.fn().mockResolvedValue(utf8(text ?? ''))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat:
        text === null
          ? vi.fn().mockRejectedValue(new Error('ENOENT'))
          : vi.fn().mockResolvedValue({ size: text.length, readOnly: false }),
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

function depsFor(text: string | null): Omit<DocumentSessionDeps, 'isActive'> {
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
  resetContextForTests()
  resetRecentFilesForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetContextForTests()
  resetRecentFilesForTests()
})

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(<DocumentArea />)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function entry(path: string, formatId = 'json'): RecentFile {
  return { path, fileName: path.split('/').pop()!, formatId }
}

describe('R96 — clicking a recent file opens it into the active tab', () => {
  it('does not change the number of open tabs', async () => {
    recordRecentFile(entry('C:/docs/a.json'))
    const tabId = createTab(depsFor('{"a":1}'))
    setActiveTab(tabId)
    // The tab starts empty; recording above happened before this tab
    // existed, so it's still the one recent entry on screen.
    await paint()

    const before = getTabIds().length
    const nameLink = Array.from(container.querySelectorAll('.document-area-recent-name')).find(
      (el) => el.getAttribute('title')?.includes('a.json')
    )!
    nameLink.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(getTabIds().length).toBe(before)
    expect(getSessionFor(tabId)!.getSnapshot().phase).toBe('ready')
  })
})

describe('R96 — narrow layout', () => {
  it('the two columns stack rather than overflow at a narrow width', async () => {
    recordRecentFile(entry('C:/docs/a.json'))
    container.style.width = '300px'
    await paint()

    const open = container.querySelector('.document-area-open-column')!
    const recent = container.querySelector('.document-area-recent-column')!
    const openRect = open.getBoundingClientRect()
    const recentRect = recent.getBoundingClientRect()

    // Stacked: Recent starts at or below Open's bottom edge, not beside it.
    expect(recentRect.top).toBeGreaterThanOrEqual(openRect.bottom - 1)
    // And nothing pushed past the container's own width.
    const containerRect = container.getBoundingClientRect()
    expect(openRect.right).toBeLessThanOrEqual(containerRect.right + 1)
    expect(recentRect.right).toBeLessThanOrEqual(containerRect.right + 1)
  })
})

describe('R96 — empty state', () => {
  it('reads "No recent files." with no Clear button', async () => {
    await paint()

    expect(container.querySelector('.document-area-empty-inline')?.textContent).toBe(
      'No recent files.'
    )
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).not.toContain('Clear')
  })

  it('Clear is present and removes every entry once there is something to clear', async () => {
    recordRecentFile(entry('C:/docs/a.json'))
    await paint()

    const clear = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear'
    )!
    clear.click()
    await paint()

    expect(container.querySelector('.document-area-empty-inline')?.textContent).toBe(
      'No recent files.'
    )
  })
})

describe('R104 — stacked layout at 560px', () => {
  it('neither the file name nor the directory is clipped with a 48-character filename', async () => {
    const longName = `${'a'.repeat(44)}.json`
    recordRecentFile(entry(`C:/docs/${longName}`))
    container.style.width = '560px'
    await paint()

    const nameEl = container.querySelector<HTMLElement>('.document-area-recent-name')!
    const dirEl = container.querySelector<HTMLElement>('.document-area-recent-dir')!

    expect(nameEl.scrollWidth).toBeLessThanOrEqual(nameEl.clientWidth + 1)
    expect(dirEl.scrollWidth).toBeLessThanOrEqual(dirEl.clientWidth + 1)
  })

  it('has no "No document open." heading and StartColumns has no status region', async () => {
    await paint()

    expect(container.textContent).not.toContain('No document open.')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('the error banner alone carries role="alert", not the whole start pane', async () => {
    recordRecentFile(entry('C:/docs/gone.json'))
    const tabId = createTab(depsFor(null))
    setActiveTab(tabId)
    await paint()

    const nameLink = Array.from(container.querySelectorAll('.document-area-recent-name')).find(
      (el) => el.getAttribute('title')?.includes('gone.json')
    )!
    nameLink.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await paint()

    const alert = container.querySelector('[role="alert"]')!
    expect(alert.classList.contains('document-area-banner-error')).toBe(true)
    expect(alert.textContent).not.toContain('Open File')
  })

  it("the Open hint's line box is at least as tall as its kbd border box while wrapped", async () => {
    container.style.width = '200px'
    await paint()

    const hint = container.querySelector<HTMLElement>('.document-area-hint')!
    const kbd = hint.querySelector<HTMLElement>('kbd')!
    const hintLineHeight = parseFloat(getComputedStyle(hint).lineHeight)
    const kbdBorderBoxHeight = kbd.getBoundingClientRect().height

    expect(hintLineHeight).toBeGreaterThanOrEqual(kbdBorderBoxHeight)
  })
})

describe('R105 — recent row spacing and truncation', () => {
  it('rows have visible vertical separation', async () => {
    recordRecentFile(entry('C:/docs/a.json'))
    recordRecentFile(entry('C:/docs/b.json'))
    await paint()

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.document-area-recent-row'))
    expect(rows.length).toBe(2)
    const gap = rows[1]!.getBoundingClientRect().top - rows[0]!.getBoundingClientRect().bottom
    expect(gap).toBeGreaterThan(0)
  })

  it('narrowing the pane truncates the directory before the file name, and the row clips rather than overflows', async () => {
    const longName = `${'b'.repeat(16)}.json`
    recordRecentFile(entry(`C:/a/very/long/directory/path/that/keeps/going/${longName}`))
    container.style.width = '260px'
    await paint()

    const row = container.querySelector<HTMLElement>('.document-area-recent-row')!
    const nameEl = container.querySelector<HTMLElement>('.document-area-recent-name')!
    const dirEl = container.querySelector<HTMLElement>('.document-area-recent-dir')!

    // The directory has started to ellipsize...
    expect(dirEl.scrollWidth).toBeGreaterThan(dirEl.clientWidth)
    // ...while the file name is still whole.
    expect(nameEl.scrollWidth).toBeLessThanOrEqual(nameEl.clientWidth + 2)
    // And the row itself does not overflow its own box.
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1)
  })

  it('the file name renders in --accent both at rest and on hover, underlined on hover', async () => {
    recordRecentFile(entry('C:/docs/a.json'))
    await paint()

    const nameEl = container.querySelector<HTMLElement>('.document-area-recent-name')!
    const accent = hexToRgbString(
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    )

    expect(getComputedStyle(nameEl).color).toBe(accent)
    expect(getComputedStyle(nameEl).textDecorationLine).toBe('none')

    await userEvent.hover(nameEl)
    expect(getComputedStyle(nameEl).color).toBe(accent)
    expect(getComputedStyle(nameEl).textDecorationLine).toBe('underline')
  })
})

function hexToRgbString(hex: string): string {
  const div = document.createElement('div')
  div.style.color = hex
  document.body.appendChild(div)
  const rgb = getComputedStyle(div).color
  div.remove()
  return rgb
}

describe('R97 — a stale entry', () => {
  it('a click on a missing file shows the error, drops the entry, and leaves the list usable', async () => {
    recordRecentFile(entry('C:/docs/good.json'))
    recordRecentFile(entry('C:/docs/gone.json'))
    const tabId = createTab(depsFor(null))
    setActiveTab(tabId)
    await paint()

    const nameLink = Array.from(container.querySelectorAll('.document-area-recent-name')).find(
      (el) => el.getAttribute('title')?.includes('gone.json')
    )!
    nameLink.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await paint()

    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    const remainingTitles = Array.from(
      container.querySelectorAll('.document-area-recent-name')
    ).map((el) => el.getAttribute('title'))
    expect(remainingTitles).not.toContain('C:/docs/gone.json')
    expect(remainingTitles).toContain('C:/docs/good.json')
  })
})
