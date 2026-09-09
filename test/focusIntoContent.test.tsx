/**
 * R91–R94 (`R91-focus-into-content.md`): F6 used to land on `PaneShell`'s
 * own `tabIndex={-1}` wrapper, which handles no keys at all — every pane's
 * arrow-key handling lives on an element *inside* it, and a `keydown` on
 * the wrapper bubbles up, never down. `registerPaneContent` (`focus.ts`)
 * lets each pane register where focus should actually land; these tests
 * exercise the delegates Tree, Raw and Detail register, and the fallback
 * to the shell when nothing is registered at all.
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
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import type { ParseOptions } from '../src/core/types'
import type { KladosApi } from '../src/preload/api'
import type { DocumentSessionDeps, OpenDocument } from '../src/renderer/session/documentSession'
import { NO_SELECTION } from '../src/renderer/session/documentSession'
import {
  createTab,
  getActiveSession,
  getSessionFor,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import { CARET_SYNC_DEBOUNCE_MS } from '../src/renderer/components/Raw/rawCaretSync'
import { POLL_MS, SETTLE_MS, TIMEOUT_MS } from './support/wait'
import { activeSession } from '../src/renderer/session/activeSession'
import { xmlFormatModule } from '../src/formats/xml/index'
import { Tree } from '../src/renderer/components/Tree/Tree'
import { Raw } from '../src/renderer/components/Raw/Raw'
import { Detail, DetailContent } from '../src/renderer/components/Detail/Detail'
import {
  focusPane,
  registerPane,
  resetFocusForTests,
  type FocusablePane
} from '../src/renderer/focus'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Tree/Tree.css'
import '../src/renderer/components/Raw/Raw.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Detail/Grid.css'

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
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text), reparseDelayMs: 5 }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.height = '400px'
  container.style.width = '600px'
  document.body.appendChild(container)
  root = createRoot(container)
  resetTabsForTests()
  resetFocusForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetFocusForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

/** A shell double, `test/focus.test.ts`'s own `fakePane` — `PaneShell`'s
 * real registration, standing in for it so `focusPane` has a floor to fall
 * back to when a content delegate isn't registered (or returns `false`). */
function fakeShell(): FocusablePane {
  return {
    focus: vi.fn(),
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

function keydown(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

async function openDocument(text: string): Promise<void> {
  const id = createTab(depsFor(text))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/file.xml')
}

describe('R91 — F6 into the Tree', () => {
  it('lands on .tree, and the very next ArrowDown moves the selection', async () => {
    // Document(0) > garage(1) > car(2), car(3) — two siblings, so ArrowDown
    // from the first has somewhere to go.
    await openDocument('<garage><car/><car/></garage>')
    const shell = fakeShell()
    registerPane('tree', shell)
    await paint(<Tree />)

    const before = activeSession.getSnapshot()
    if (before.phase !== 'ready') throw new Error('expected a ready document')
    const startNode = before.selection.selectedNode

    focusPane('tree')
    const treeEl = container.querySelector('.tree')!
    expect(document.activeElement).toBe(treeEl)
    expect(shell.focus).not.toHaveBeenCalled() // the delegate handled it, not the shell fallback

    // The initial selection is `garage` (D-065's wrapper-descent target),
    // which starts collapsed — expand it first (ArrowRight), the same way
    // a keyboard-only user would, so ArrowDown has a row to move onto.
    keydown(treeEl, 'ArrowRight')
    await paint(<Tree />)
    keydown(treeEl, 'ArrowDown')
    await paint(<Tree />)

    const after = activeSession.getSnapshot()
    if (after.phase !== 'ready') throw new Error('expected a ready document')
    expect(after.selection.selectedNode).not.toBe(startNode)
  })
})

describe('R92 — F6 into Raw', () => {
  it('focuses .cm-content with the caret at the selected node span start, and the caret is on screen after scrolling away', async () => {
    // A body long enough that Raw's ~1MB window and CodeMirror's own
    // viewport both matter, and long enough to scroll several screens away
    // from the caret's own position near the top.
    const filler = 'x'.repeat(200) + '\n'
    const body = filler.repeat(2000)
    await openDocument(`<a>${body}</a>`)
    const shell = fakeShell()
    registerPane('raw', shell)
    await paint(<Raw />)

    const contentEl = container.querySelector<HTMLElement>('.cm-content')!
    const editorEl = container.querySelector<HTMLElement>('.cm-editor')!
    const view = EditorView.findFromDOM(editorEl)!
    const scroller = container.querySelector<HTMLElement>('.cm-scroller')!

    const headBefore = view.state.selection.main.head
    expect(headBefore).toBe(0) // the selected node's span start, node 0 of a document opening at offset 0

    // Scroll far away from the caret with the mouse, the way the plan's
    // own trap describes.
    scroller.scrollTop = scroller.scrollHeight
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    focusPane('raw')
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    expect(document.activeElement).toBe(contentEl)
    expect(shell.focus).not.toHaveBeenCalled()

    // Caret on screen: its coordinates fall within the scroller's own
    // visible band, not scrolled out of view.
    const coords = view.coordsAtPos(view.state.selection.main.head)
    expect(coords).not.toBeNull()
    const scrollerRect = scroller.getBoundingClientRect()
    expect(coords!.top).toBeGreaterThanOrEqual(scrollerRect.top - 1)
    expect(coords!.bottom).toBeLessThanOrEqual(scrollerRect.bottom + 1)

    // And the caret itself was never moved — an F6 focus must not disturb
    // where the user left it.
    expect(view.state.selection.main.head).toBe(headBefore)
  })

  it('leaving Raw and returning with F6 does not move the caret from where it was left', async () => {
    const body = 'y'.repeat(5000)
    await openDocument(`<a>${body}<b/></a>`)
    const shell = fakeShell()
    registerPane('raw', shell)
    await paint(<Raw />)

    const editorEl = container.querySelector<HTMLElement>('.cm-editor')!
    const view = EditorView.findFromDOM(editorEl)!

    // Move the caret the way a user would while editing, not via the
    // session (which is what a *different* selection change looks like).
    view.dispatch({ selection: { anchor: 20 } })

    // R162 (`docs/plans/R159-fixed-duration-waits.md` §7): this line used to
    // read `setTimeout(resolve, 250) // past rawCaretSync's debounce`, and the
    // review that produced this round used it as its worked example. **It
    // passed at 125 ms — below the debounce — at 0 ms, and with the extension
    // disabled entirely**, so the comment named a mechanism the test had no
    // power over. What is under test here is F6, not caret sync; the sync is
    // covered for real in `test/rawCaretSync.test.tsx`, whose acceptance
    // criterion is that raising this same constant to 200_000 turns it red.
    //
    // The wait stays, because the caret resolution firing *during* the F6
    // round-trip is exactly the interference this test wants to rule out — but
    // it now derives its length from the constant instead of copying a number,
    // and says what it is for.
    await vi.waitFor(
      () => {
        if (getActiveSession().getSnapshot().phase !== 'ready') {
          throw new Error('the session is not ready')
        }
      },
      { interval: POLL_MS, timeout: TIMEOUT_MS }
    )
    await new Promise((resolve) => setTimeout(resolve, CARET_SYNC_DEBOUNCE_MS * 2))

    const headAfterTyping = view.state.selection.main.head

    focusPane('raw') // F6 away isn't modeled directly; re-focusing is the observable half
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    expect(view.state.selection.main.head).toBe(headAfterTyping)
  })
})

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function baseOpenDocument(source: Uint8Array, store: NodeStore, filePath: string): OpenDocument {
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    xmlFormatModule.capabilities.rowBreakBytes
  )
  const lineIndex = buildLineIndex(source, rowIndex)
  const nameIndex = buildNameIndex(store, store.interner.size)
  return {
    filePath,
    fileName: filePath.split('/').pop()!,
    store,
    sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
    rowIndex,
    lineIndex,
    nameIndex,
    diagnostics: store.diagnostics,
    complete: true,
    formatId: 'xml',
    encoding: 'utf-8',
    readOnly: false,
    errorNode: null,
    errorOffset: null,
    pendingParseError: null,
    dirty: false,
    externalChangeDetected: false,
    reloadPending: false,
    pendingTransform: null,
    minifiedBannerDismissed: false,
    reparsePending: false,
    transformInProgress: false,
    lastTransformWasNoOp: false,
    undoBytes: 0,
    undoEntryCount: 0,
    pendingSpanDeltas: EMPTY_DELTA_LIST,
    // R100: this fixture predates the field; a freshly opened document
    // has had no external rewrite yet.
    externalRewrites: 0
  }
}

function gridDocument(rows: number): { document: OpenDocument; selectedNode: number } {
  const parts: string[] = ['<garage>']
  for (let r = 0; r < rows; r++)
    parts.push(`<car><name>car${r}</name><year>20${10 + r}</year></car>`)
  parts.push('</garage>')
  const source = new TextEncoder().encode(parts.join(''))
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return { document: baseOpenDocument(source, store, 'C:/docs/garage.xml'), selectedNode: 0 } // Document root — its child (garage) is grid-eligible
}

function listDocument(): { document: OpenDocument; selectedNode: number } {
  const source = new TextEncoder().encode('<a><b/><c/></a>')
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return { document: baseOpenDocument(source, store, 'C:/docs/list.xml'), selectedNode: 1 } // <a>, whose children <b/>/<c/> are not grid-eligible (too few, no repeats)
}

describe('R94 — F6 into Detail', () => {
  it('grid mode: focuses .grid-scroll, with the first row already active', async () => {
    const { document: doc, selectedNode } = gridDocument(30)
    const shell = fakeShell()
    registerPane('detail', shell)
    await paint(<DetailContent document={doc} selectedNode={selectedNode} />)

    focusPane('detail')
    const gridEl = container.querySelector('.grid-scroll')!
    expect(document.activeElement).toBe(gridEl)
    expect(shell.focus).not.toHaveBeenCalled()
    expect(container.querySelector('.grid-cell-active')).not.toBeNull()
  })

  it('list mode: focuses .detail itself, and arrow keys scroll it', async () => {
    const { document: doc, selectedNode } = listDocument()
    const shell = fakeShell()
    registerPane('detail', shell)
    await paint(<DetailContent document={doc} selectedNode={selectedNode} />)

    focusPane('detail')
    const detailEl = container.querySelector('.detail')!
    expect(document.activeElement).toBe(detailEl)
    expect(shell.focus).not.toHaveBeenCalled()
  })

  it('with nothing selected, no delegate is registered — the shell takes focus exactly as today', async () => {
    await openDocument('<a><b/></a>')
    activeSession.setSelectedNode(NO_SELECTION)
    const shell = fakeShell()
    registerPane('detail', shell)
    await paint(<Detail />)

    expect(container.querySelector('.detail-empty')).not.toBeNull()

    focusPane('detail')
    expect(shell.focus).toHaveBeenCalledOnce()
  })
})
