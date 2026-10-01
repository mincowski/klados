/**
 * R223 (`docs/plans/R223-raw-pane-default.md` §2.3) — the commands that only
 * act on Raw used to do nothing while it was hidden, because a hidden Raw is
 * not mounted at all (`Layout.tsx`) and `rawController.ts` was a no-op with
 * no view registered. Each now shows Raw first and then does its job.
 *
 * Every case starts from Raw hidden, through the same toggle a user presses,
 * and asserts the job was *done* rather than only that Raw appeared: the
 * caret at the target, wrap flipped, focus in the editor. Revealing is
 * asynchronous to the command — the view mounts on React's next commit — so
 * each waits on a condition rather than a duration (R159).
 *
 * Mutations run against `rawController.ts` while writing this file, each
 * turning the five reveal cases red as listed (the no-document case is
 * unaffected by all three, as it should be):
 * - `withRawView` without `showRawPane()`: all five (Raw never mounts).
 * - the pending action dropped instead of run once Raw registers: all five.
 *   A freshly mounted Raw places its window around the selection's caret
 *   but does not put CodeMirror's caret there, so even Locate in Source and
 *   F8 need the deferred scrub.
 * - the pending action run synchronously inside `registerRawController`
 *   instead of after the commit's effects: Focus Raw Source and the `:` jump
 *   (the pane is not yet registered with the focus model).
 *
 * The Soft Wrap case uses a document long enough to scroll. On a short one
 * Raw turns wrap on by itself (`wrapPolicy.ts`), and the case passed with
 * the pending action dropped — found by the second mutation, not by reading.
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
import type { KladosApi } from '../src/preload/api'
import '../src/renderer/commands/builtins'
import { getContext, resetContextForTests } from '../src/renderer/commands/context'
import { getCommand } from '../src/renderer/commands/registry'
import type { DocumentSessionDeps } from '../src/renderer/session/documentSession'
import { activeSession } from '../src/renderer/session/activeSession'
import {
  createTab,
  getActiveSession,
  getSessionFor,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import { Layout } from '../src/renderer/components/Layout/Layout'
import {
  getLayoutState,
  resetLayoutForTests,
  toggleRawPane
} from '../src/renderer/components/Layout/layoutStore'
import { Palette } from '../src/renderer/components/Palette/Palette'
import {
  openPalette,
  resetPaletteStoreForTests
} from '../src/renderer/components/Palette/paletteStore'
import { resetFocusForTests } from '../src/renderer/focus'
import { nodeContainingOffset } from '../src/renderer/nodeSpanLookup'
import { selectNode } from '../src/renderer/selectNode'
import { POLL_MS, TIMEOUT_MS } from './support/wait'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Layout/Layout.css'
import '../src/renderer/components/Tree/Tree.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Detail/Grid.css'
import '../src/renderer/components/Raw/Raw.css'
import '../src/renderer/components/Palette/CommandPalette.css'

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

// One member per line and no indentation, so a line's first byte is its
// member's span start — the palette's `:` jump lands on the line start, and
// indentation there would belong to the enclosing object instead. All ASCII
// and far under one Raw window, so a byte offset equals a CodeMirror position.
const SOURCE = [
  '{',
  '"first": 1,',
  '"second": 2,',
  '"third": 3,',
  '"fourth": 4,',
  '"fifth": 5',
  '}'
].join('\n')

// Long enough that Raw's window scrolls, so Raw does not turn wrap on by
// itself (`wrapPolicy.ts`: a window with nothing to scroll is wrapped
// automatically, which would make the Soft Wrap case pass with no toggle).
const LONG = ['[', ...Array.from({ length: 300 }, (_, i) => `${i},`), '0', ']'].join('\n')

// A missing value after "b" — the parser reports a diagnostic and continues.
const BROKEN = '{\n  "a": 1,\n  "b": ,\n  "c": 3\n}'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.height = '600px'
  container.style.width = '900px'
  document.body.appendChild(container)
  root = createRoot(container)
  resetTabsForTests()
  resetFocusForTests()
  resetLayoutForTests()
  resetContextForTests()
  resetPaletteStoreForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetFocusForTests()
  resetLayoutForTests()
  resetContextForTests()
  resetPaletteStoreForTests()
})

function app(): React.ReactNode {
  return (
    <>
      <Layout />
      <Palette />
    </>
  )
}

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(app())
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/** Opens `text` with Raw hidden, the state every case starts from. */
async function openWithRawHidden(text: string): Promise<void> {
  toggleRawPane()
  expect(getLayoutState().rawVisible).toBe(false)
  const id = createTab(depsFor(text))
  setActiveTab(id)
  await getSessionFor(id)!.openPath('C:/docs/reveal.json')
  await paint()
  await vi.waitFor(
    () => {
      if (getActiveSession().getSnapshot().phase !== 'ready') throw new Error('not ready')
      if (container.querySelector('.tree') === null) throw new Error('Tree not mounted')
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
  expect(container.querySelector('.cm-content')).toBeNull()
}

function readyStore(): Parameters<typeof selectNode>[0] {
  const snapshot = getActiveSession().getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error('unreachable')
  return snapshot.document.store
}

function run(commandId: string): void {
  const command = getCommand(commandId)
  if (command === undefined) throw new Error(`${commandId} is not registered`)
  void command.run({ context: getContext(), session: activeSession })
}

/** Waits for Raw to mount and returns its editor. */
async function revealedEditor(): Promise<EditorView> {
  return vi.waitFor(
    () => {
      const content = container.querySelector<HTMLElement>('.cm-content')
      if (content === null) throw new Error('Raw has not mounted')
      const view = EditorView.findFromDOM(content)
      if (view === null) throw new Error('no EditorView')
      return view
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

async function expectCaretAt(view: EditorView, offset: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(view.state.selection.main.head).toBe(offset)
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

async function expectFocusInRaw(): Promise<void> {
  await vi.waitFor(
    () => {
      const content = container.querySelector('.cm-content')
      expect(content !== null && content.contains(document.activeElement)).toBe(true)
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

describe('R223 — a command that needs Raw shows it, then does its job', () => {
  it('Locate in Source: Raw appears with the caret at the selected node', async () => {
    await openWithRawHidden(SOURCE)
    const target = SOURCE.indexOf('"fourth"')
    const store = readyStore()
    const node = nodeContainingOffset(store, target)
    expect(store.spanOf(node).start).toBe(target)
    selectNode(store, node)

    run('klados.navigate.locateInSource')

    const view = await revealedEditor()
    expect(getLayoutState().rawVisible).toBe(true)
    await expectCaretAt(view, target)
  })

  it('Soft Wrap: Raw appears and wrap is on', async () => {
    await openWithRawHidden(LONG)
    expect(getContext().isWrapped).toBe(false)

    run('klados.raw.toggleWrap')

    const view = await revealedEditor()
    await vi.waitFor(
      () => {
        expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
        expect(getContext().isWrapped).toBe(true)
      },
      { interval: POLL_MS, timeout: TIMEOUT_MS }
    )
  })

  it('Focus Raw Source: Raw appears and holds the keyboard', async () => {
    await openWithRawHidden(SOURCE)

    run('klados.focus.raw')

    await revealedEditor()
    await expectFocusInRaw()
  })

  it('Next Diagnostic (F8): Raw appears with the caret at the diagnostic', async () => {
    await openWithRawHidden(BROKEN)
    const snapshot = getActiveSession().getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('unreachable')
    const diagnostic = snapshot.document.diagnostics[0]
    expect(diagnostic).toBeDefined()

    run('klados.navigate.nextDiagnostic')

    const view = await revealedEditor()
    await expectCaretAt(view, diagnostic!.offset)
  })

  it("the palette's position jump: Raw appears, caret on the line, keyboard in Raw", async () => {
    await openWithRawHidden(SOURCE)
    const target = SOURCE.indexOf('"fifth"') // line 6
    expect(readyStore().spanOf(nodeContainingOffset(readyStore(), target)).start).toBe(target)

    openPalette(':6')
    await paint()
    const input = container.querySelector<HTMLInputElement>('.palette-input')
    expect(input).not.toBeNull()
    input!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )

    const view = await revealedEditor()
    await expectCaretAt(view, target)
    await expectFocusInRaw()
  })
})

describe('R223 — what does not change', () => {
  it('with no document open, Focus Raw Source neither shows Raw nor saves a layout', () => {
    toggleRawPane()
    localStorage.removeItem('klados.layout')

    run('klados.focus.raw')
    run('klados.raw.toggleWrap')

    expect(getLayoutState().rawVisible).toBe(false)
    expect(localStorage.getItem('klados.layout')).toBeNull()
  })
})
