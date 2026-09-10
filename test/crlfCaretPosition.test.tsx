/**
 * R179 (`docs/plans/R179-crlf-caret-position.md`) — the caret can no longer
 * rest between a `\r` and its `\n`.
 *
 * **Real Chromium, and real input events, because that is where the previous
 * round went wrong.** R168 considered this exact failure, built a module to
 * prevent it, and deleted the module after establishing that the CodeMirror
 * APIs it relied on were on no input path — which was true. The inference drawn
 * from it was not: "motion is native, and native motion resolves against
 * rendered geometry" was taken to mean the caret could not land on a character
 * that paints as nothing. **The evidence was about the keyboard API surface;
 * the conclusion was about the browser's behaviour, which was never measured.**
 *
 * So every path below is driven through `userEvent`, which issues genuine CDP
 * key and mouse events, rather than through CodeMirror's own geometry helpers
 * (`moveToLineBoundary` and friends are on no input path in this app and answer
 * `line.to`, which is what made this look fine) or through synthetic
 * `KeyboardEvent`s (which contentEditable does not act on).
 *
 * **Assertions are on the bytes, with the `\r` spelled out.** The defect is
 * invisible to anything that normalises line endings, which is how it shipped.
 *
 * The harness is `rawCrlfEdit.test.tsx`'s, unchanged apart from `userEvent`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { userEvent } from '@vitest/browser/context'
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

let currentApi: FakeApi

function depsFor(text: string, reparseDelayMs: number): Omit<DocumentSessionDeps, 'isActive'> {
  currentApi = fakeApi(text)
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: currentApi, reparseDelayMs }
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

/** The session is ready *and* CodeMirror is in the DOM — both, because either
 * alone is reachable while the other is not (R159's rule: wait for the
 * condition, never for a duration). */
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

async function openTab(text: string): Promise<void> {
  const tabId = createTab(depsFor(text, 20))
  await getSessionFor(tabId)!.openPath('C:/docs/crlf.json')
  await paint()
  await waitForEditorMounted()
  await paint()
}

function editorViewIn(el: HTMLElement): EditorView {
  const content = el.querySelector<HTMLElement>('.cm-content')
  if (content === null) throw new Error('.cm-content not found')
  const view = EditorView.findFromDOM(content)
  if (view === null) throw new Error('no EditorView found from .cm-content')
  return view
}

/** The live document bytes, decoded — the thing `save` writes and the only
 * side of this that the defect ever showed up on. */
function bufferText(): string {
  return new TextDecoder().decode(readySnapshot().document.sourceBuffer.bytes)
}

function readySnapshot(): Extract<
  ReturnType<ReturnType<typeof getActiveSession>['getSnapshot']>,
  { phase: 'ready' }
> {
  const snapshot = getActiveSession().getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error(`session is ${snapshot.phase}, not ready`)
  return snapshot
}

/** Waits for the debounced reparse to land, by watching the session rather
 * than by sleeping (R159). */
async function flushReparse(): Promise<void> {
  await waitForQuiet(() => getActiveSession().getSnapshot(), { label: 'flushReparse' })
  await paint()
}

describe('R179 — the selection cannot rest inside a CRLF pair', () => {
  /** `alpha\r\nbeta\r\ngamma\r\n` — the document §3 measured against. Line 1 is
   * `alpha\r`, its `line.to` is 6, and position 6 is the gap. */
  const SOURCE = 'alpha\r\nbeta\r\ngamma\r\n'

  /** Every position that sits between a CR and its LF, found from the text
   * rather than hardcoded, so a change to `SOURCE` cannot silently empty this. */
  function gapPositions(text: string): number[] {
    const gaps: number[] = []
    for (let i = 1; i < text.length; i++) {
      if (text[i - 1] === '\r' && text[i] === '\n') gaps.push(i)
    }
    return gaps
  }

  function selectionEndpoints(view: EditorView): number[] {
    return view.state.selection.ranges.flatMap((r) => [r.anchor, r.head])
  }

  function expectOutOfEveryGap(view: EditorView, label: string): void {
    const gaps = gapPositions(view.state.doc.toString())
    expect(gaps.length, 'the fixture must actually contain CRLF pairs').toBeGreaterThan(0)
    for (const pos of selectionEndpoints(view)) {
      expect(gaps, `${label}: endpoint ${pos} is inside a CRLF pair`).not.toContain(pos)
    }
  }

  it('the fixture reaches CodeMirror with its CRs intact (R168)', async () => {
    await openTab(SOURCE)
    const view = editorViewIn(container)
    // If this ever fails the rest of the file is asserting nothing: the whole
    // subject is a position that only exists because the CR is in the document.
    expect(view.state.doc.line(1).text).toBe('alpha\r')
    expect(view.state.doc.toString()).toBe(SOURCE)
    expect(gapPositions(SOURCE)).toEqual([6, 12, 19])
  })

  it('ArrowRight crosses the whole line ending instead of entering it', async () => {
    // §3 measured this landing at 6 — inside the pair — before the fix.
    await openTab(SOURCE)
    const view = editorViewIn(container)
    view.focus()
    view.dispatch({ selection: { anchor: 5 } })

    await userEvent.keyboard('{ArrowRight}')

    expectOutOfEveryGap(view, 'ArrowRight from position 5')
  })

  it('ArrowUp from the line below does not land in the pair', async () => {
    // §3 measured this landing at 12, the previous line's `line.to`.
    await openTab(SOURCE)
    const view = editorViewIn(container)
    view.focus()
    view.dispatch({ selection: { anchor: 17 } })

    await userEvent.keyboard('{ArrowUp}')

    expectOutOfEveryGap(view, 'ArrowUp from the line below')
  })

  it('End and Shift+End still land where they always did', async () => {
    // These two were already correct (§3). Asserted because a clamp that
    // "fixed" them would be moving the caret somewhere the user did not ask
    // for, which is the failure mode of an over-eager filter.
    await openTab(SOURCE)
    const view = editorViewIn(container)
    view.focus()
    view.dispatch({ selection: { anchor: 2 } })

    await userEvent.keyboard('{End}')
    expect(view.state.selection.main.head).toBe(5)
    expectOutOfEveryGap(view, 'End')

    view.dispatch({ selection: { anchor: 2 } })
    await userEvent.keyboard('{Shift>}{End}{/Shift}')
    expect(view.state.selection.main.head).toBe(5)
    expect(view.state.selection.main.anchor).toBe(2)
  })

  it('a click past the end of a line puts the caret before the CR', async () => {
    // §3: both "click at the end of the rendered text" and "click past the end
    // of the line" landed at 6. This is the path the user actually took.
    await openTab(SOURCE)
    const view = editorViewIn(container)
    const firstLine = container.querySelectorAll('.cm-line')[0]
    if (!(firstLine instanceof HTMLElement)) throw new Error('no first line element')
    const box = firstLine.getBoundingClientRect()

    view.focus()
    await userEvent.click(firstLine, {
      position: { x: Math.round(box.width - 4), y: Math.round(box.height / 2) }
    })

    expectOutOfEveryGap(view, 'click past the end of line 1')
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
  })

  it('every position the caret can reach has screen coordinates (acceptance 5)', async () => {
    // §3's visible symptom, measured: `coordsAtPos(line.to)` returned NULL for
    // the gap. The caret was not missing — it was at a position with no box.
    // With the clamp in place no reachable position may keep that property.
    await openTab(SOURCE)
    const view = editorViewIn(container)
    const gaps = gapPositions(view.state.doc.toString())

    for (let pos = 0; pos <= view.state.doc.length; pos++) {
      if (gaps.includes(pos)) continue // unreachable now, and asserted so above
      expect(view.coordsAtPos(pos), `position ${pos} has no coordinates`).not.toBeNull()
    }
  })

  it("the user's own sequence: click past the end of a line, type, and the bytes are right", async () => {
    // Acceptance 2, end to end. Before the fix this produced
    // `alpha\rds\nbeta…` — the CR terminating a line by itself and the LF
    // starting the next, which is what VS Code showed the user as a stray break.
    await openTab(SOURCE)
    const view = editorViewIn(container)
    const firstLine = container.querySelectorAll('.cm-line')[0]
    if (!(firstLine instanceof HTMLElement)) throw new Error('no first line element')
    const box = firstLine.getBoundingClientRect()

    view.focus()
    await userEvent.click(firstLine, {
      position: { x: Math.round(box.width - 4), y: Math.round(box.height / 2) }
    })
    await userEvent.keyboard('ds')
    await flushReparse()

    expect(bufferText()).toBe('alphads\r\nbeta\r\ngamma\r\n')
    // Said again as a property, because the whole-string comparison above is
    // easy to update carelessly: no CR may be left without its LF.
    expect(/\r(?!\n)/.test(bufferText())).toBe(false)
    expect(/(?<!\r)\n/.test(bufferText())).toBe(false)
  })

  it('a drop past the end of a CRLF line does not split the pair', async () => {
    // **The path the selection clamp does not cover, found by measuring rather
    // than reasoning.** A drop carries its own position from `posAtCoords` and
    // dispatches the insertion directly, so it never passes through a selection
    // this filter has already moved. With only the selection clamp in place,
    // this produced `alpha\rds\nbeta…` — the same corruption by a second
    // route, which is why `crlfInsertionCorrections` exists.
    //
    // Dispatched as a real `DragEvent` on the content DOM: CodeMirror's drop
    // handling is an ordinary JS listener, so this drives the real handler.
    // (`userEvent` cannot express a drop at a point inside text.)
    await openTab(SOURCE)
    const view = editorViewIn(container)
    const content = container.querySelector('.cm-content')
    if (!(content instanceof HTMLElement)) throw new Error('no .cm-content')

    const coords = view.coordsAtPos(5)
    if (coords === null) throw new Error('no coords for position 5')

    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', 'ds')
    content.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: Math.round(coords.right + 40),
        clientY: Math.round((coords.top + coords.bottom) / 2)
      })
    )
    await flushReparse()

    expect(bufferText()).toBe('alphads\r\nbeta\r\ngamma\r\n')
    expect(/\r(?!\n)/.test(bufferText())).toBe(false)
    expect(/(?<!\r)\n/.test(bufferText())).toBe(false)
    // The caret ends up after the dropped text and before the line ending,
    // which is where the relocation puts it.
    expectOutOfEveryGap(view, 'after a drop')
    expect(view.state.selection.main.head).toBe(7)
  })

  it('an LF-only document behaves exactly as it does today (acceptance 6)', async () => {
    await openTab('alpha\nbeta\ngamma\n')
    const view = editorViewIn(container)
    view.focus()
    view.dispatch({ selection: { anchor: 5 } })

    await userEvent.keyboard('{ArrowRight}')
    // Straight into the line break, exactly as before — there is no pair to
    // protect and the filter must not invent one.
    expect(view.state.selection.main.head).toBe(6)

    view.dispatch({ selection: { anchor: 5 } })
    await userEvent.keyboard('ds')
    await flushReparse()
    expect(bufferText()).toBe('alphads\nbeta\ngamma\n')
  })
})
