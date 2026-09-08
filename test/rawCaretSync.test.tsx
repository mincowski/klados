/**
 * R162 (`docs/plans/R159-fixed-duration-waits.md` §7) — `rawCaretSync` had no
 * test coverage at all, and the review that found this is the reason the round
 * exists.
 *
 * `focusIntoContent.test.tsx` waits 250 ms with the comment
 * `// past rawCaretSync's debounce`, so the feature *looked* covered. It passed
 * at 125 ms, below the 200 ms debounce. It passed at 0 ms. So the debounce was
 * raised from 200 to 200_000 — disabling caret sync outright — and the whole
 * browser project was run: **43 files, 239 tests, all green.** Nothing in the
 * suite could tell whether the extension existed.
 *
 * That is the second harm a fixed-duration wait carries, and the one nothing in
 * this project had ever found: a sleep that is too short does not only flake.
 * Where the assertion is negative, or the state is unchanged either way, the
 * awaited thing never happening produces exactly the expected result — the test
 * goes green and never turns red, so no round ever goes looking.
 *
 * **The acceptance criterion for this file is the mutation, not the
 * assertion.** Raising `CARET_SYNC_DEBOUNCE_MS` to `200_000` must turn it red.
 * Demonstrated, not argued: writing a test that passes under the mutation,
 * while fixing the class of tests that pass under mutations, would be the round
 * defeating itself.
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
import { CARET_SYNC_DEBOUNCE_MS } from '../src/renderer/components/Raw/rawCaretSync'
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

function depsFor(text: string): Omit<DocumentSessionDeps, 'isActive'> {
  return {
    parse: fakeParse,
    parseFromUrl: fakeParseFromUrl,
    api: fakeApi(text),
    reparseDelayMs: 20
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
  await getSessionFor(tabId)!.openPath('C:/docs/caret.json')
  await paint()
  await vi.waitFor(
    () => {
      if (getActiveSession().getSnapshot().phase !== 'ready') {
        throw new Error('openTab: session is not ready')
      }
      if (container.querySelector('.cm-content') === null) {
        throw new Error('openTab: CodeMirror has not mounted')
      }
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
  await paint()
}

function editorView(): EditorView {
  const content = container.querySelector<HTMLElement>('.cm-content')
  if (content === null) throw new Error('.cm-content not found')
  const view = EditorView.findFromDOM(content)
  if (view === null) throw new Error('no EditorView found from .cm-content')
  return view
}

function selectedNode(): number {
  const snapshot = getActiveSession().getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error('unreachable')
  return snapshot.selection.selectedNode
}

function nameOfSelected(): string | null {
  const snapshot = getActiveSession().getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error('unreachable')
  return snapshot.document.store.nameOf(snapshot.selection.selectedNode)
}

// `{"a":1,"bb":22}` — offset 13 is inside `bb`'s value, and nothing else in
// the document shares that span. Byte offsets equal UTF-16 units here (all
// ASCII, one window), which is what lets the test dispatch a CodeMirror
// position directly.
const SOURCE = '{"a":1,"bb":22}'
const INSIDE_BB = 13

/**
 * The two negative assertions below are the legitimate case for a duration —
 * there is no condition for a thing that must not happen — and they derive it
 * from the exported constant rather than copying a number.
 *
 * **The ceilings exist so the mutation fails fast rather than hanging.** With
 * `CARET_SYNC_DEBOUNCE_MS` raised to `200_000` an underived wait would sleep for
 * 100 and 400 *seconds*, turning a clean red into two 30-second timeouts and
 * burying the one failure that matters. Capped, both still mean what they say:
 * 1 s is under any plausible debounce, and 2 s is over the real one.
 */
const NOT_YET_MS = Math.min(CARET_SYNC_DEBOUNCE_MS / 2, 1000)
const WELL_PAST_MS = Math.min(CARET_SYNC_DEBOUNCE_MS * 2, 2000)

describe('R162 — moving the caret in Raw resolves to the node containing it (D14)', () => {
  it('selects the node under the caret once the debounce elapses', async () => {
    await openTab(SOURCE)
    const before = selectedNode()

    editorView().dispatch({ selection: { anchor: INSIDE_BB } })

    // The condition, not the duration — and it is the *whole* mechanism:
    // if `rawCaretSync` never fires, nothing else in the app moves the
    // selection here, so this wait times out and the test fails.
    await vi.waitFor(
      () => {
        if (selectedNode() === before) {
          throw new Error('the caret has not resolved to a node yet')
        }
      },
      { interval: POLL_MS, timeout: TIMEOUT_MS }
    )

    expect(nameOfSelected()).toBe('bb')
  })

  it('does not resolve before the debounce elapses — a caret in flight is not a selection', async () => {
    await openTab(SOURCE)
    const before = selectedNode()

    editorView().dispatch({ selection: { anchor: INSIDE_BB } })

    // A negative assertion, so this one *is* a duration — there is no
    // condition for a thing that must not happen yet. The number is derived
    // from the exported constant rather than copied, which is the other half
    // of R162: before this round `rawCaretSync`'s debounce was a module-private
    // 200, and every test that cared about it wrote its own guess.
    await new Promise((resolve) => setTimeout(resolve, NOT_YET_MS))
    expect(selectedNode()).toBe(before)
  })

  it('a programmatic reposition does not resolve at all', async () => {
    await openTab(SOURCE)
    const before = selectedNode()

    // `Raw.tsx`'s own "Locate in source" jump annotates its dispatch so the
    // resolution it would otherwise trigger is skipped — without the
    // annotation this is the same dispatch as the first test's.
    const { programmaticSelection } = await import('../src/renderer/components/Raw/rawCaretSync')
    editorView().dispatch({
      selection: { anchor: INSIDE_BB },
      annotations: programmaticSelection.of(true)
    })

    await new Promise((resolve) => setTimeout(resolve, WELL_PAST_MS))
    expect(selectedNode()).toBe(before)
  })
})
