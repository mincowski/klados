/**
 * R41 (`R41-raw-editing.md`): typing in the Raw view used to lose the
 * caret. Two causes, verified separately here, per §6:
 *
 * - Symptom A: `Raw.tsx`'s mount effect was keyed on `store` identity, so
 *   the debounced reparse every edit schedules recreated the whole
 *   `EditorView` — destroying focus, selection and scroll. Fixed by keying
 *   the mount effect on document identity instead, with a second effect
 *   that refreshes the window's bookkeeping without tearing the view down.
 * - Symptom B: the `caretOffset` effect treated *every* `caretOffset`
 *   change as an external "Locate in source" jump, including the one the
 *   edit itself just caused via `session.setCaretOffset` — scrolling the
 *   pane out from under the person typing in it. Fixed by
 *   `rawEditExtension`'s `onCaretMoved` callback marking that offset as
 *   already applied before the state change reaches React.
 *
 * Real Chromium, a real (tab-backed) `DocumentSession` with the fake-parse
 * infrastructure `test/tabStrip.test.tsx` and `test/documentSession.test.ts`
 * both use (real `runParseJob`, no real `Worker`; a near-zero
 * `reparseDelayMs` so the debounce doesn't cost a real 200ms per test) —
 * this is entirely about live DOM/CodeMirror state, which jsdom can't be
 * trusted for.
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
import { POLL_MS, TIMEOUT_MS, waitForQuiet } from './support/wait'
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

function depsFor(text: string, reparseDelayMs: number): Omit<DocumentSessionDeps, 'isActive'> {
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text), reparseDelayMs }
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

/** Waits for the debounced reparse to land, by watching the session rather
 * than by sleeping.
 *
 * R159 (`docs/plans/R159-fixed-duration-waits.md`): this was 60 ms, justified
 * by a comment citing `documentSession.test.ts`'s `flushReparse` as using "the
 * same 40ms figure for the same reason" — a helper R154 had already replaced
 * with a quiescence loop. **The fix reached two files; the rationale had
 * already reached five.** */
async function flushReparse(): Promise<void> {
  await waitForQuiet(() => getActiveSession().getSnapshot(), { label: 'flushReparse' })
  await paint()
}

async function openTab(text: string): Promise<void> {
  const tabId = createTab(depsFor(text, 20))
  await getSessionFor(tabId)!.openPath('C:/docs/edit.json')
  await paint()
  // R159: the mount effect creates the `EditorView` synchronously once the
  // document reaches 'ready', but the open pipeline can still be settling
  // beyond what two rAFs cover. That is a condition, not a duration — wait for
  // both halves of it and return the moment they hold.
  await waitForEditorMounted()
  await paint()
}

/** The session is ready *and* CodeMirror is in the DOM. Both, because either
 * alone is reachable while the other is not. */
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

describe('Raw view: typing survives a same-document reparse (R41)', () => {
  it('the .cm-content element is the same DOM node after the debounced reparse lands', async () => {
    await openTab('{"a":"xy"}')
    const before = container.querySelector('.cm-content')
    expect(before).not.toBeNull()

    const view = editorViewIn(container)
    // Insert a character right before the closing quote, mirroring a real
    // keystroke — a `changes` dispatch is exactly what CodeMirror's own DOM
    // input handling produces internally.
    const insertAt = view.state.doc.toString().indexOf('xy') + 2
    view.dispatch({ changes: { from: insertAt, to: insertAt, insert: 'z' } })

    await flushReparse()

    const after = container.querySelector('.cm-content')
    expect(after).not.toBeNull()
    expect(after).toBe(before) // identity survives — no remount (Symptom A)
  })

  it('focus and selection offset are unchanged after the reparse lands, and a third keystroke appends correctly', async () => {
    await openTab('{"a":"xy"}')
    const view = editorViewIn(container)
    view.focus()

    const base = view.state.doc.toString().indexOf('xy') + 2 // right before the closing quote
    // Real typing moves the caret to just past what it inserted — a plain
    // `changes` dispatch doesn't do that on its own (it maps whatever
    // selection existed before through the change, which isn't necessarily
    // "after this insert" unless the selection already was there), so the
    // selection is set explicitly, matching what CodeMirror's own DOM input
    // handling does for a real keystroke.
    view.dispatch({
      changes: { from: base, to: base, insert: 'z' },
      selection: { anchor: base + 1 }
    })
    view.dispatch({
      changes: { from: base + 1, to: base + 1, insert: 'w' },
      selection: { anchor: base + 2 }
    })
    expect(view.state.selection.main.head).toBe(base + 2)

    await flushReparse()

    // Re-resolve the view — an assertion in its own right (R41's whole
    // point): if the mount effect had remounted, `EditorView.findFromDOM`
    // would still find *something*, but it would be a fresh view with a
    // reset selection.
    const viewAfter = editorViewIn(container)
    expect(viewAfter).toBe(view)
    expect(document.activeElement).toBe(viewAfter.contentDOM)
    expect(viewAfter.state.selection.main.head).toBe(base + 2)
    expect(viewAfter.state.doc.toString()).toContain('xyzw')

    viewAfter.dispatch({
      changes: { from: base + 2, to: base + 2, insert: 'v' },
      selection: { anchor: base + 3 }
    })
    expect(viewAfter.state.doc.toString()).toContain('xyzwv')
    expect(viewAfter.state.selection.main.head).toBe(base + 3)
  })

  it('scrollTop is unchanged across the whole typing sequence', async () => {
    // Enough real lines (pretty-printed, real `\n`s — a single unbroken
    // line has nothing for `scrollTop` to move through) that the editor
    // actually has scroll room, and a non-zero starting scrollTop so a
    // spurious jump-to-top would also be caught, not just a jump-to-caret.
    const obj: Record<string, number> = {}
    for (let i = 0; i < 200; i++) obj[`line${i}`] = i
    const text = JSON.stringify(obj, null, 2)
    await openTab(text)

    const view = editorViewIn(container)
    view.scrollDOM.scrollTop = 500
    // R159: CodeMirror clamps and re-measures the scroll position on its own
    // schedule, so wait for it to take rather than for 50 ms. The wait throws
    // on timeout, so a scroll that never lands fails here instead of making the
    // assertion below meaningless.
    await vi.waitFor(() => expect(view.scrollDOM.scrollTop).toBeGreaterThan(0), {
      interval: POLL_MS,
      timeout: TIMEOUT_MS
    })
    const scrollBefore = view.scrollDOM.scrollTop
    expect(scrollBefore).toBeGreaterThan(0)

    // Edit far from the visible scroll position — at the very start of the
    // document, not wherever the viewport happens to be scrolled to.
    view.dispatch({ changes: { from: 1, to: 1, insert: '"z":1,' } })
    await flushReparse()

    const viewAfter = editorViewIn(container)
    expect(viewAfter.scrollDOM.scrollTop).toBe(scrollBefore)
  })
})
