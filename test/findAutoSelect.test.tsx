/**
 * R79 (`R78-find-affordances.md` §2, text search half) — a plain text
 * search selects a match when its result lands, without waiting for a
 * keypress: the count reads `1 of N` from a document-start caret, and the
 * correct non-1 index from a caret already past the first match — the
 * proof the selection is anchored, not pinned to match 0. Also: an
 * edit-driven re-run (the debounced reparse re-running the active query)
 * must not move the caret or the selection out from under someone typing.
 *
 * Same real-session-through-fakeParse harness `palettePathQuery.test.tsx`
 * and `searchStore.test.ts` use — real Chromium, a real document open
 * through the fake-parse transport, not a hand-built mock of the session.
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
import { activeSession } from '../src/renderer/session/activeSession'
import { FindBar } from '../src/renderer/components/Find/FindBar'
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
  // A near-zero reparse delay — `rawEditCaretSurvival.test.tsx`'s own
  // reasoning — so the edit-driven re-run test doesn't cost a real 200ms.
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

function typeNeedle(text: string): void {
  const input = container.querySelector<HTMLInputElement>('.find-input')!
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )!.set!
  nativeSetter.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// "<a>needle needle needle</a>" — three matches at byte offsets 3, 10, 17.
const SOURCE = '<a>needle needle needle</a>'

async function openDocument(): Promise<void> {
  const id = createTab(depsFor(SOURCE))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/file.xml')
}

// Debounce (150ms, `FindBar.tsx`'s own `runSearch`) plus the chunked job's
// own settle time.
async function waitForSearch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

describe('R79 — a text search selects a match when its result lands', () => {
  it('selects the first match, reading "1 of 3", from a document-start caret', async () => {
    await openDocument()
    openFind()
    await paint(<FindBar />)
    typeNeedle('needle')
    await waitForSearch()
    await paint(<FindBar />)

    expect(container.querySelector('.find-count')!.textContent).toContain('1 of 3')
    expect(activeSession.getSnapshot().phase).toBe('ready')
    const snapshot = activeSession.getSnapshot()
    if (snapshot.phase === 'ready') expect(snapshot.selection.caretOffset).toBe(3)
  })

  it('selects the match at or after the caret, not always the first', async () => {
    await openDocument()
    activeSession.setCaretOffset(12) // inside the second "needle" (10-16)
    openFind() // anchor captured now, at 12
    await paint(<FindBar />)
    typeNeedle('needle')
    await waitForSearch()
    await paint(<FindBar />)

    // The first match at or after 12 is the third, at offset 17 — index 2.
    expect(container.querySelector('.find-count')!.textContent).toContain('3 of 3')
    const snapshot = activeSession.getSnapshot()
    if (snapshot.phase === 'ready') expect(snapshot.selection.caretOffset).toBe(17)
  })

  it('an edit-driven re-run does not move the caret or the selection', async () => {
    await openDocument()
    openFind()
    await paint(<FindBar />)
    typeNeedle('needle')
    await waitForSearch()
    await paint(<FindBar />)
    expect(container.querySelector('.find-count')!.textContent).toContain('1 of 3')

    // An edit far from any match, that doesn't remove or add one — this is
    // an *edit-driven* re-run (searchStore's own session subscription),
    // never `FindBar`'s own `runSearch`, so `pendingAutoSelectRef` must
    // stay unset for it.
    // "<a>needle needle needle</a>" — insert a space just before the
    // closing '>' (offset 26), which touches none of the three matches.
    activeSession.applyEdit({ start: 26, end: 26, text: ' ' })
    activeSession.setCaretOffset(26)

    await new Promise((resolve) => setTimeout(resolve, 150)) // past the 5ms reparse debounce + settle
    await paint(<FindBar />)

    const snapshot = activeSession.getSnapshot()
    if (snapshot.phase === 'ready') expect(snapshot.selection.caretOffset).toBe(26)
    // Still reporting the match the user was already on, not reset or
    // jumped elsewhere by the reparse's own re-run.
    expect(container.querySelector('.find-count')!.textContent).toContain('1 of 3')
  })
})
