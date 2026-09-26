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

async function openTab(text: string, path = 'C:/docs/caret.json'): Promise<void> {
  const tabId = createTab(depsFor(text))
  await getSessionFor(tabId)!.openPath(path)
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

// R218 (`docs/plans/R218-range-selection-sync.md`). All ASCII in one window,
// so a CodeMirror position is a byte offset here too.
const SHELF = [
  '<shelf>',
  '  <book>',
  '    <title>Odyssey</title>',
  '    <author>Homer</author>',
  '  </book>',
  '  <book>',
  '    <title>Faust</title>',
  '  </book>',
  '</shelf>'
].join('\n')

/** Offset of the `nth` occurrence of `needle`, plus `plus`. */
function at(needle: string, plus = 0, nth = 0): number {
  let index = -1
  for (let i = 0; i <= nth; i++) index = SHELF.indexOf(needle, index + 1)
  if (index === -1) throw new Error(`${needle} not in SHELF`)
  return index + plus
}

async function selectRange(anchor: number, head: number): Promise<void> {
  editorView().dispatch({ selection: { anchor, head } })
}

async function resolvesTo(name: string, occurrence: number | null = null): Promise<void> {
  await vi.waitFor(
    () => {
      if (nameOfSelected() !== name) throw new Error(`selected ${nameOfSelected()}, not ${name}`)
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
  if (occurrence !== null) {
    const snapshot = getActiveSession().getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('unreachable')
    expect(snapshot.document.store.spanOf(selectedNode()).start).toBe(occurrence)
  }
}

describe('R218 — a range selection resolves to the smallest node containing it', () => {
  it('across two children: their parent', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    await selectRange(at('Odyssey'), at('Homer', 2))
    await resolvesTo('book', at('<book>'))
  })

  it('inside one element: that element', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    await selectRange(at('Odyssey', 1), at('Odyssey', 5))
    await resolvesTo('title', at('<title>'))
  })

  it('backwards, head before anchor: the same node', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    await selectRange(at('Homer', 2), at('Odyssey'))
    await resolvesTo('book', at('<book>'))
  })

  it('a whole line, indentation and line break included: the element on it', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    // What Shift+Down from a line's start selects. The indentation and the
    // line break belong to <book>; without trimming this resolved to <book>.
    await selectRange(at('    <title>Odyssey'), at('    <author>'))
    await resolvesTo('title', at('<title>'))
  })

  it('across two siblings of the node: the shelf', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    // The document opens with <shelf> selected, so move off it first — else
    // this passes whether or not anything resolves.
    await selectRange(at('Faust', 1), at('Faust', 1))
    await resolvesTo('title', at('<title>', 0, 1))
    await selectRange(at('Homer'), at('Faust'))
    await resolvesTo('shelf', at('<shelf>'))
  })

  it('whitespace only: the node at the head, as a caret would', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    // From <title>'s start back over the indentation to the line break after
    // <book>: nothing but whitespace, head inside <book>. (Not <shelf>, which
    // the document opens with selected.)
    await selectRange(at('<title>'), at('\n    <title>'))
    await resolvesTo('book', at('<book>'))
  })
})

describe('R218 — nothing resolves while the mouse button is held', () => {
  function mouse(type: 'mousedown' | 'mouseup', target: EventTarget, pos: number): void {
    const coords = editorView().coordsAtPos(pos)
    if (coords === null) throw new Error(`no coordinates for ${pos}`)
    target.dispatchEvent(
      new MouseEvent(type, {
        button: 0,
        detail: 1,
        buttons: type === 'mousedown' ? 1 : 0,
        clientX: coords.left + 1,
        clientY: (coords.top + coords.bottom) / 2,
        bubbles: true,
        cancelable: true
      })
    )
  }

  it('a drag resolves once, on release, to the node containing what it selected', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    const before = selectedNode()
    const view = editorView()

    // Press inside <title>, then the selection a drag to <author> produces —
    // tagged the way CodeMirror tags every selection its drag makes. Before
    // R218 either would resolve after the debounce, button still down.
    mouse('mousedown', view.contentDOM, at('Odyssey'))
    view.dispatch({
      selection: { anchor: at('Odyssey'), head: at('Homer', 2) },
      userEvent: 'select.pointer'
    })

    await new Promise((resolve) => setTimeout(resolve, WELL_PAST_MS))
    expect(selectedNode()).toBe(before)

    mouse('mouseup', document, at('Homer', 2))
    await resolvesTo('book', at('<book>'))
  })

  it('a missed release does not switch caret sync off: a keyboard move resolves anyway', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    const view = editorView()
    mouse('mousedown', view.contentDOM, at('Odyssey'))
    // No mouseup. A selection that is not the pointer's — what the keyboard
    // dispatches — must still resolve.
    await selectRange(at('Faust', 1), at('Faust', 1))
    await resolvesTo('title', at('<title>', 0, 1))
  })

  it('a click still resolves to the node under it', async () => {
    await openTab(SHELF, 'C:/docs/shelf.xml')
    const view = editorView()
    mouse('mousedown', view.contentDOM, at('Faust', 2))
    mouse('mouseup', document, at('Faust', 2))
    await resolvesTo('title', at('<title>', 0, 1))
  })
})

describe('R218 — trimLayoutWhitespace', () => {
  it('trims spaces, tabs and both line breaks from both ends, and nothing else', async () => {
    const { Text } = await import('@codemirror/state')
    const { trimLayoutWhitespace } = await import('../src/renderer/components/Raw/rawCaretSync')
    const doc = Text.of([' \t<a>x</a>\r', '  ', '\u00a0b '])
    const whole = { from: 0, to: doc.length }
    expect(trimLayoutWhitespace(doc, whole.from, whole.to)).toEqual({ from: 2, to: doc.length - 1 })
    expect(trimLayoutWhitespace(Text.of(['  ', ' ']), 0, 4)).toBeNull()
    // A no-break space at an edge was selected on purpose, and stays.
    expect(trimLayoutWhitespace(Text.of([' x ']), 0, 3)).toEqual({ from: 0, to: 3 })
  })
})
