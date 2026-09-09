/**
 * R168 (`docs/plans/R168-crlf-edit-offset.md`) — a Raw edit on a CRLF
 * document used to land at the wrong byte.
 *
 * **The mechanism, in one sentence:** CodeMirror's default line split
 * (`/\r\n?|\n/`) discards the `\r`, so its document was one unit shorter per
 * CRLF than the window text the byte offsets are measured against, and every
 * conversion from a CodeMirror position to a buffer offset undercounted by the
 * number of line breaks before it. Line 2 drifted one byte, line 10 drifted
 * nine. On an LF-only document the two agree exactly, which is why **every
 * fixture in this suite was LF-only and nothing ever caught it** (§5).
 *
 * The fix is `EditorState.lineSeparator.of('\n')` in `Raw.tsx`: split on `\n`
 * alone and the `\r` stays in the line's own text, making CodeMirror's
 * document byte-faithful to the window. Nothing else in the edit path
 * changed — see §8 of the plan for why every other candidate was worse.
 *
 * **These tests must be read as byte assertions, not text assertions.** They
 * decode `sourceBuffer.bytes` and compare whole strings *with the `\r`
 * written out*, because the entire defect is invisible to any assertion that
 * normalises line endings — which is precisely how it survived. Every
 * expectation below states the CRs it expects.
 *
 * Real Chromium, a real tab-backed `DocumentSession`, real CodeMirror. The
 * harness is `rawEditCaretSurvival.test.tsx`'s, which is the established
 * shape for driving a live Raw view (that file's own header explains why
 * jsdom cannot be trusted for it).
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

/** The caret offset the session records, in bytes (`SelectionState`). */
function caretOffset(): number {
  return readySnapshot().selection.caretOffset
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

/**
 * Dispatches a single change the way real typing does — the change plus an
 * explicit selection just past what it inserted. A bare `changes` dispatch
 * maps the old selection through instead, which is not what a keystroke does
 * and would make the caret assertions below meaningless.
 */
function edit(view: EditorView, from: number, to: number, insert: string): void {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length }
  })
}

describe('R168 — Raw edits on a CRLF document land at the right byte', () => {
  it('the reported symptom: inserting on line 2 of a CRLF document (drift of one)', async () => {
    // Exactly the file and the keystroke the user reported: caret after
    // `Jante`, type `t`, expect `Jantet`. The buffer used to receive
    // `Jantte` — the character one byte early, because the single CRLF on
    // line 1 is one byte CodeMirror's document does not contain.
    const source = '{\r\n  "name": "Jante Doe"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    // 25 UTF-16 units against 27 bytes — the two CRs are the difference, and
    // this is the assertion the whole defect reduces to. It is stated here
    // rather than left implicit because if `lineSeparator` is ever unset
    // again this line fails first and says why.
    expect(view.state.doc.length).toBe(source.length)
    expect(view.state.doc.toString()).toContain('\r')

    const at = view.state.doc.toString().indexOf('Jante') + 'Jante'.length
    edit(view, at, at, 't')

    expect(bufferText()).toBe('{\r\n  "name": "Jantet Doe"\r\n}')
  })

  it('inserting on line 4 (drift of three) — a fix correct for one break is not correct', async () => {
    // §8.2: more than one line, so a fix that happens to be right for a drift
    // of one cannot pass. Three CRLFs precede the edit point here.
    const source = '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": "xy"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    const at = view.state.doc.toString().indexOf('xy') + 'xy'.length
    edit(view, at, at, 'z')

    expect(bufferText()).toBe('{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": "xyz"\r\n}')
  })

  it('deleting a selection on a CRLF document removes the right bytes at both ends', async () => {
    // §4's "expected but unverified": `toA` goes through the identical
    // conversion, so both ends of a range drift together. A deletion is what
    // demonstrates the far end — an insertion only ever exercises `fromA`.
    const source = '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": "xy"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    const from = view.state.doc.toString().indexOf('xy')
    edit(view, from, from + 2, '')

    expect(bufferText()).toBe('{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": ""\r\n}')
  })

  it('replacing a selection on a CRLF document replaces the right bytes', async () => {
    const source = '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": "xy"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    const from = view.state.doc.toString().indexOf('xy')
    edit(view, from, from + 2, 'wide')

    expect(bufferText()).toBe('{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": "wide"\r\n}')
  })

  it('the caret offset the session records is a correct byte offset on a CRLF document', async () => {
    // §8.3. `rawEdit.ts` builds a *second* map to compute this, so it is a
    // genuinely separate conversion from the one the splice uses — node
    // resolution, "Locate in source" and undo-restore positions all read it.
    const source = '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": "xy"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    const at = view.state.doc.toString().indexOf('xy') + 'xy'.length
    edit(view, at, at, 'z')

    // Derived from the *source* string, not from the edited buffer: the
    // buffer is what is under test, and computing the expectation from it
    // would make this assertion agree with any splice, correct or not.
    // Everything before the edit point is ASCII and unchanged, so the byte
    // offset just past the inserted `z` is its index in `source` plus one.
    const expected = source.indexOf('xy') + 'xy'.length + 1
    expect(caretOffset()).toBe(expected)
  })

  it('a CRLF document opened and saved without editing is byte-identical (invariants 6 and 7)', async () => {
    // §8.5. The fix must not touch the untouched case — this is the promise
    // the whole design hangs on, and a line-ending change is exactly the kind
    // of thing that would silently break it.
    const source = '{\r\n  "a": 1,\r\n  "b": "xy"\r\n}'
    await openTab(source)

    const outcome = await getActiveSession().save()
    expect(outcome.ok).toBe(true)

    const write = currentApi.document.write as ReturnType<typeof vi.fn>
    expect(write).toHaveBeenCalledTimes(1)
    const written = new Uint8Array(write.mock.calls[0]![1] as ArrayBuffer)
    expect(Array.from(written)).toEqual(Array.from(new Uint8Array(utf8(source))))
  })

  it('an edited CRLF document survives its reparse with the CRs intact', async () => {
    // The reparse rebuilds the window from the patched bytes — the step at
    // which the user saw the character visibly "jump". If the splice is right
    // the text is stable across it; if it were not, this is where it shows.
    const source = '{\r\n  "a": 1,\r\n  "b": "xy"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    const at = view.state.doc.toString().indexOf('xy') + 'xy'.length
    edit(view, at, at, 'z')
    await flushReparse()

    expect(bufferText()).toBe('{\r\n  "a": 1,\r\n  "b": "xyz"\r\n}')
    expect(editorViewIn(container).state.doc.toString()).toBe('{\r\n  "a": 1,\r\n  "b": "xyz"\r\n}')
  })

  it('the caret at a line end sits before the retained CR, not inside the CRLF', async () => {
    // §6a asked whether keeping the `\r` in the document creates a caret
    // position *between* it and the `\n`, since typing there would split the
    // pair and turn that line's ending into a bare LF.
    //
    // It does exist as an offset — `line.to` is past the `\r` — but the paths
    // real input actually takes do not land on it. This app installs no
    // `@codemirror/commands` keymap, so Home/End and the arrow keys are the
    // browser's own contentEditable motion, resolved against *rendered*
    // geometry; the `\r` renders as nothing (no `highlightSpecialChars` here,
    // asserted below), so the visual end of the line is before it.
    //
    // `Selection.modify(… 'lineboundary')` is the primitive the End key uses,
    // which is why this asserts through it rather than through
    // `view.moveToLineBoundary` — that is a CodeMirror geometry query on no
    // input path in this app, and it answers `line.to`, which is what made
    // this look broken until the real path was measured.
    const source = '{\r\n  "a": 1,\r\n  "b": "xy"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    // The CR is invisible: nothing renders a placeholder glyph for it.
    expect(container.querySelectorAll('.cm-specialChar').length).toBe(0)
    const firstLine = view.state.doc.line(1)
    expect(firstLine.text).toBe('{\r')

    view.focus()
    view.dispatch({ selection: { anchor: 0 } })
    const selection = window.getSelection()
    if (selection === null) throw new Error('no DOM selection')
    selection.modify('move', 'forward', 'lineboundary')
    const { focusNode, focusOffset } = selection
    if (focusNode === null) throw new Error('no focus node after lineboundary move')

    // Before the `\r` (`line.to - 1`), not between it and the line break.
    expect(view.posAtDOM(focusNode, focusOffset)).toBe(firstLine.to - 1)
  })

  it('mixed line endings: a document with both CRLF and LF edits correctly on either kind of line', async () => {
    // §8.6 — stated plainly rather than left to be discovered. Splitting on
    // `\n` alone means a **lone `\r`** is no longer a line break; a lone `\r`
    // is a pre-1999 Mac convention that no format this app parses emits, and
    // treating it as ordinary text is what keeps the document byte-faithful.
    // A *mixed* CRLF/LF file — which is common, and which is what this
    // asserts — is handled exactly, on both kinds of line.
    const source = '{\r\n  "a": "xy",\n  "b": "pq"\r\n}'
    await openTab(source)
    const view = editorViewIn(container)

    const crlfLine = view.state.doc.toString().indexOf('xy') + 'xy'.length
    edit(view, crlfLine, crlfLine, 'z')
    expect(bufferText()).toBe('{\r\n  "a": "xyz",\n  "b": "pq"\r\n}')

    const after = editorViewIn(container)
    const lfLine = after.state.doc.toString().indexOf('pq') + 'pq'.length
    edit(after, lfLine, lfLine, 'r')
    expect(bufferText()).toBe('{\r\n  "a": "xyz",\n  "b": "pqr"\r\n}')
  })
})
