/**
 * R100 (`R100-raw-external-rewrite.md`): the Raw view's live `EditorView`
 * did not follow a buffer rewritten *outside* the editor — Replace All,
 * Format, Minify, Undo, Redo and Reload all update `document.sourceBuffer`
 * (and every other pane), but `.cm-content`'s own text stayed exactly what
 * it was before the operation ran. Traced to R41 (`R41-raw-editing.md`),
 * five days before this report: before it, every reparse tore the
 * `EditorView` down and rebuilt it from the current buffer, which is what
 * made these five paths display correctly *by accident*. R41 correctly
 * stopped that remount (it was destroying the caret on every keystroke's
 * debounced reparse) but left nothing else to carry an externally-rewritten
 * buffer to the view.
 *
 * Fixed via `OpenDocument.externalRewrites`, a counter `Raw.tsx`'s
 * live-update effect checks to tell "the buffer changed because of typing"
 * (the view already has it) apart from "the buffer changed because
 * something else rewrote it" (the view has never seen it) — the latter
 * gets a full `applyReslice` around the caret instead of the in-place
 * `handle.text`/`handle.map` refresh.
 *
 * Real Chromium, a real tab-backed `DocumentSession`, real `Raw` — same
 * harness `test/rawEditCaretSurvival.test.tsx` (R41's own regression test)
 * uses, extended here to the five paths R41 didn't cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob, runTransformJob } from '../src/worker/parse.worker'
import { resetContextForTests } from '../src/renderer/commands/context'
import type { KladosApi } from '../src/preload/api'
import type { DocumentSessionDeps } from '../src/renderer/session/documentSession'
import type { TransformClientOptions } from '../src/core/transformClient'
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

/** Same shape as `documentSession.test.ts`'s own `fakeTransform` — runs the
 * worker's transform logic directly, since there is no real `Worker` under
 * Vitest. Needed here because `requestTransform`'s default (`deps.transform
 * ?? transformInWorker`) spawns a real `Worker`, whose module resolution
 * this test harness (Vitest's browser mode, not the packaged app) doesn't
 * carry. */
function fakeTransform(
  bytes: ArrayBuffer,
  options: TransformClientOptions
): Promise<ArrayBuffer | null> {
  const response = runTransformJob({
    type: 'transform',
    requestId: nextRequestId++,
    bytes,
    formatId: options.formatId,
    options: options.options
  })
  if (response.type === 'transformError') return Promise.reject(new Error(response.message))
  return Promise.resolve(response.bytes)
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

/** `read` is a `vi.fn` the caller can reconfigure (`.mockResolvedValueOnce`)
 * before a reload — every other test only ever needs the constructor's own
 * fixed text. */
function fakeApi(initialText: string): {
  document: KladosApi['document']
  /** The bytes `mintReadToken` hands out, exposed so the reload test can
   * queue a different document on it. Deliberately *beside* `document`
   * rather than on it: the real API has no `read` method — the read-token
   * flow replaced it — so declaring one there made this stub a shape
   * `KladosApi` does not have, which is what the type error reported. */
  read: ReturnType<typeof vi.fn>
} {
  const read = vi.fn().mockResolvedValue(utf8(initialText))
  return {
    read,
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: initialText.length, readOnly: false }),
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
  return {
    parse: fakeParse,
    parseFromUrl: fakeParseFromUrl,
    transform: fakeTransform,
    api: fakeApi(text),
    reparseDelayMs
  }
}

function depsForWithApi(
  text: string,
  reparseDelayMs: number
): { deps: Omit<DocumentSessionDeps, 'isActive'>; api: ReturnType<typeof fakeApi> } {
  const api = fakeApi(text)
  return {
    deps: {
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      transform: fakeTransform,
      api,
      reparseDelayMs
    },
    api
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

/** Waits for the session to stop moving, rather than for 60 ms.
 *
 * R159 (`docs/plans/R159-fixed-duration-waits.md`): the number used to justify
 * itself by citing `rawEditCaretSurvival.test.tsx` *and*
 * `documentSession.test.ts` — the second of which R154 had already converted
 * away from a fixed wait, so the citation pointed at the counter-example. */
async function settle(): Promise<void> {
  await waitForQuiet(() => getActiveSession().getSnapshot(), { label: 'settle' })
  await paint()
}

async function openTab(text: string): Promise<string> {
  const tabId = createTab(depsFor(text, 20))
  await getSessionFor(tabId)!.openPath('C:/docs/edit.json')
  await paint()
  // R159: the session ready *and* CodeMirror mounted — a condition, not 60 ms.
  await waitForEditorMounted()
  await paint()
  return tabId
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

/** The core assertion every case in this file makes: what the live editor
 * shows must equal what `sourceBuffer` actually holds — measured on the
 * pane's own text (`.cm-content`'s `EditorView`), not by eye, per §1's own
 * "screenshotted, and asserted on the pane's own text" methodology. */
function expectViewMatchesBuffer(tabId: string): void {
  const session = getSessionFor(tabId)!
  const snapshot = session.getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error('unreachable')
  const expected = snapshot.document.sourceBuffer.slice(
    0,
    snapshot.document.sourceBuffer.byteLength
  )
  const view = editorViewIn(container)
  expect(view.state.doc.toString()).toBe(expected)
}

describe('Raw view follows a buffer rewritten outside it (R100)', () => {
  it('Replace All', async () => {
    const tabId = await openTab('{"a":"xy","b":"xy"}')
    const session = getSessionFor(tabId)!
    // `{"a":"xy","b":"xy"}` — "xy" occupies bytes 6-8 (after `"a":"`) and
    // 15-17 (after `,"b":"`).
    const outcome = session.applyReplaceAll(
      [
        { start: 6, end: 8 },
        { start: 15, end: 17 }
      ],
      'ZZZZ'
    )
    expect(outcome.ok).toBe(true)
    await settle()
    expectViewMatchesBuffer(tabId)
  })

  it('Format', async () => {
    const tabId = await openTab('{"a":1,"b":2}')
    const session = getSessionFor(tabId)!
    session.requestTransform('format')
    await settle()
    expectViewMatchesBuffer(tabId)
  })

  it('Minify', async () => {
    const tabId = await openTab('{\n  "a": 1,\n  "b": 2\n}\n')
    const session = getSessionFor(tabId)!
    session.requestTransform('minify')
    await settle()
    expectViewMatchesBuffer(tabId)
  })

  it('Undo', async () => {
    const tabId = await openTab('{"a":"xy"}')
    const session = getSessionFor(tabId)!
    session.applyEdit({ start: 8, end: 8, text: 'QQ' }) // Raw's own edit path — the view already agrees
    await settle()
    session.undo()
    await settle()
    expectViewMatchesBuffer(tabId)
  })

  it('Redo', async () => {
    const tabId = await openTab('{"a":"xy"}')
    const session = getSessionFor(tabId)!
    session.applyEdit({ start: 8, end: 8, text: 'QQ' })
    await settle()
    session.undo()
    await settle()
    session.redo()
    await settle()
    expectViewMatchesBuffer(tabId)
  })

  it('Reload', async () => {
    const { deps, api } = depsForWithApi('{"a":1}', 20)
    const tabId = createTab(deps)
    const session = getSessionFor(tabId)!
    await session.openPath('C:/docs/edit.json')
    await paint()
    // R159: `openTab`'s body, inlined here because this test needs the api
    // handle — so it gets `openTab`'s wait too, not the sleep it replaced.
    await waitForEditorMounted()
    await paint()

    // `mintReadToken` calls `read` once at open (already resolved via the
    // constructor's default) and once more at reload — `mockResolvedValueOnce`
    // queues a genuinely different document for that next call, so the
    // reload is a real rewrite, not a same-bytes no-op.
    api.read.mockResolvedValueOnce(utf8('{"a":99,"b":2}'))
    await session.reloadAndDiscard()
    await settle()
    expectViewMatchesBuffer(tabId)
  })
})
