/**
 * R124 (`R124-go-to-position-hint.md`) — the `:` mode's empty-query hint and
 * the status bar caret button's `title` state the actual unit the document
 * takes (line number or byte offset), rather than promising a choice that
 * `parseGoToPosition`/`hasMeaningfulLines` never offered. Real Chromium,
 * real document open through the fake-parse transport
 * (`test/palettePathQuery.test.tsx`'s own harness) — the palette's `:`
 * mode needs a real `readyDocument` to render anything but the "open a
 * document" placeholder, and the hint text depends on the real `lineCount`
 * / `byteLength` of that document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  openPalette,
  resetPaletteStoreForTests
} from '../src/renderer/components/Palette/paletteStore'
import { resetPaletteRecencyForTests } from '../src/renderer/components/Palette/paletteLogic'
import { ReadyStatus } from '../src/renderer/components/StatusBar/StatusBar'
import { resetStatisticsPanelStoreForTests } from '../src/renderer/components/StatusBar/statisticsPanelStore'
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Palette/CommandPalette.css'
import '../src/renderer/components/StatusBar/StatusBar.css'
import '../src/renderer/components/StatusBar/StatisticsPanel.css'

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
  resetStatisticsPanelStoreForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetContextForTests()
  resetPaletteStoreForTests()
  resetPaletteRecencyForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
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

// A pretty-printed multi-line JSON document — `hasMeaningfulLines` is true:
// several short lines, well under the mean-bytes-per-line threshold.
const LINES_DOC = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}'

// A single-line JSON document with no newline at all — `lineCount` is 1,
// so `hasMeaningfulLines` is false regardless of length (D9's predicate
// requires `lineCount > 1` first).
const NO_LINES_DOC = `{${Array.from({ length: 40 }, (_, i) => `"k${i}":${i}`).join(',')}}`

async function openDocument(text: string): Promise<{ lineCount: number; byteLength: number }> {
  const id = createTab(depsFor(text))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/file.json')
  const snapshot = getSessionFor(id)!.getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error('document did not reach ready phase')
  return {
    lineCount: snapshot.document.lineIndex.lineCount,
    byteLength: snapshot.document.sourceBuffer.byteLength
  }
}

describe('R124 §2 — the palette `:` mode hint states the actual unit', () => {
  it('a document with meaningful lines: "Type a line number (1–N)", no mention of bytes', async () => {
    const { lineCount } = await openDocument(LINES_DOC)
    openPalette(':')
    await paint(<Palette />)
    typeInPalette(':')
    await paint(<Palette />)

    const status = container.querySelector('#klados-palette-listbox')!
    expect(status.textContent).toBe(`Type a line number (1–${lineCount.toLocaleString()})`)
    expect(status.textContent).not.toMatch(/byte/i)
  })

  it('a document with no meaningful lines: byte form, with the explanatory second sentence', async () => {
    const { byteLength } = await openDocument(NO_LINES_DOC)
    openPalette(':')
    await paint(<Palette />)
    typeInPalette(':')
    await paint(<Palette />)

    const status = container.querySelector('#klados-palette-listbox')!
    expect(status.textContent).toBe(
      `Type a byte offset (0–${byteLength.toLocaleString()}). This document has no lines to number.`
    )
  })
})

describe('R124 §3 — the status bar caret button title states the actual unit', () => {
  it('is "Go to Line" for a document with meaningful lines', async () => {
    const id = createTab(depsFor(LINES_DOC))
    setActiveTab(id)
    await getSessionFor(id)!.openPath('C:/docs/file.json')
    const snapshot = getSessionFor(id)!.getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('document did not reach ready phase')

    await paint(<ReadyStatus document={snapshot.document} caretOffset={0} />)
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.title === 'Go to Line' || b.title === 'Go to Byte Offset'
    )!
    expect(button.title).toBe('Go to Line')
  })

  it('is "Go to Byte Offset" for a document with no meaningful lines', async () => {
    const id = createTab(depsFor(NO_LINES_DOC))
    setActiveTab(id)
    await getSessionFor(id)!.openPath('C:/docs/file.json')
    const snapshot = getSessionFor(id)!.getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('document did not reach ready phase')

    await paint(<ReadyStatus document={snapshot.document} caretOffset={0} />)
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.title === 'Go to Line' || b.title === 'Go to Byte Offset'
    )!
    expect(button.title).toBe('Go to Byte Offset')
  })
})
