/**
 * R42 addendum (`R42-stale-spans.md`'s "Addendum — the accepted
 * one-keystroke lag, now reported"): typing inside a tag name used to leave
 * Raw's syntax highlighting one keystroke stale — `rawDecorationsExtension`'s
 * rebuild is driven by CodeMirror's own `update.docChanged`, which fires
 * *inside* the same dispatch that `rawEditExtension` uses to call
 * `session.applyEdit`, but upstream of it: the decoration rebuild reads
 * `pendingSpanDeltasRef.current` before `Raw.tsx`'s `useLayoutEffect` has had
 * a chance to refresh it with the delta this keystroke just added. Fixed by
 * dispatching `bumpDecorationsEffect` a second time, from that same
 * `useLayoutEffect`, whenever `document.pendingSpanDeltas` actually changed
 * since the last dispatch — still before paint, so no wrong frame is shown.
 *
 * Real Chromium, same fake-parse/tab-backed-session infrastructure as
 * `test/rawEditCaretSurvival.test.tsx` (R41) — this is entirely about live
 * CodeMirror decoration state, which jsdom can't be trusted for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
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
  getActiveSession,
  getSessionFor,
  resetTabsForTests
} from '../src/renderer/session/tabs'
import { POLL_MS, TIMEOUT_MS } from './support/wait'
import { Raw } from '../src/renderer/components/Raw/Raw'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Raw/Raw.css'
import '../src/renderer/components/Scrubber/Scrubber.css'
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

// A long debounce, deliberately — this test asserts on state *inside* the
// window between an edit and the reparse, and a near-zero delay (R41's own
// tests use ~20ms) risks the reparse winning the race against the assertion
// on a slow CI runner and masking the very defect under test.
const REPARSE_DELAY_MS = 5000

function depsFor(text: string): Omit<DocumentSessionDeps, 'isActive'> {
  return {
    parse: fakeParse,
    parseFromUrl: fakeParseFromUrl,
    api: fakeApi(text),
    reparseDelayMs: REPARSE_DELAY_MS
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  resetTabsForTests()
  resetContextForTests()
  container = document.createElement('div')
  container.style.height = '400px'
  container.style.width = '600px'
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
    root.render(<Raw />)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

async function openTab(text: string): Promise<void> {
  const tabId = createTab(depsFor(text))
  await getSessionFor(tabId)!.openPath('C:/docs/edit.xml')
  await paint()
  // R159 (`docs/plans/R159-fixed-duration-waits.md`): the session ready *and*
  // CodeMirror mounted — a condition, not the 60 ms this file shared verbatim
  // with four others.
  await waitForEditorMounted()
  await paint()
}

async function waitForEditorMounted(): Promise<void> {
  await vi.waitFor(
    () => {
      if (getActiveSession().getSnapshot().phase !== 'ready') {
        throw new Error('waitForEditorMounted: session is not ready')
      }
      if (container.querySelector('.cm-content') === null) {
        throw new Error('waitForEditorMounted: CodeMirror has not mounted')
      }
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

function editorViewIn(el: HTMLElement): EditorView {
  const content = el.querySelector<HTMLElement>('.cm-content')
  if (content === null) throw new Error('.cm-content not found')
  const view = EditorView.findFromDOM(content)
  if (view === null) throw new Error('no EditorView found from .cm-content')
  return view
}

/** Concatenated text of every `cm-np-tagName`-marked span currently in the
 * DOM, in document order — the highlighted element-name text, whatever byte
 * range the most recent decoration rebuild thinks it covers. */
function tagNameHighlightText(el: HTMLElement): string {
  return Array.from(el.querySelectorAll('.cm-np-tagName'))
    .map((node) => node.textContent ?? '')
    .join('')
}

describe('Raw view: syntax highlighting keeps pace with typing (R42 addendum)', () => {
  it('the tag-name highlight covers the full edited name after one keystroke, inside the debounce window', async () => {
    await openTab('<name>Focus</name>')
    const view = editorViewIn(container)

    // Caret right after "na" in "<name>" — insert "Z" there, mirroring the
    // addendum's own measurement.
    const insertAt = view.state.doc.toString().indexOf('<na') + 3
    view.dispatch({ changes: { from: insertAt, to: insertAt, insert: 'Z' } })
    // `useLayoutEffect`'s corrective dispatch runs on React's next commit —
    // synchronous with respect to the browser's paint, but not with respect
    // to `view.dispatch` returning (React's own re-render is scheduled, not
    // nested into CodeMirror's still-in-progress update). A microtask tick
    // is enough for that commit to land; a real animation frame would also
    // work but would let a real paint happen first, which is exactly what
    // this test must not do.
    await Promise.resolve()

    expect(tagNameHighlightText(container)).toBe('naZme')
    expect(view.state.doc.toString()).toContain('<naZme>')
  })

  it('the highlight is still correct after a second keystroke, not merely shifted by one edit', async () => {
    await openTab('<name>Focus</name>')
    const view = editorViewIn(container)

    const base = view.state.doc.toString().indexOf('<na') + 3
    view.dispatch({ changes: { from: base, to: base, insert: 'Z' } })
    await Promise.resolve()
    expect(tagNameHighlightText(container)).toBe('naZme')

    view.dispatch({ changes: { from: base + 1, to: base + 1, insert: 'Y' } })
    await Promise.resolve()
    expect(tagNameHighlightText(container)).toBe('naZYme')
    expect(view.state.doc.toString()).toContain('<naZYme>')
  })
})
