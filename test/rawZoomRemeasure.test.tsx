/**
 * R59 (`R58-zoom.md` §4's own trap): CodeMirror's `defaultLineHeight`
 * (`Raw.tsx`'s `jumpTo` scroll-margin) does not recompute itself just
 * because the page's zoom changed — measured directly during this round: a
 * CSS `zoom` change on a bare `EditorView` left `defaultLineHeight`
 * completely stale with no auto-remeasure even ~100ms later, until an
 * explicit `requestMeasure()` was called. `Raw.tsx` now subscribes to
 * `zoom.ts` and nudges whichever `EditorView` is mounted to remeasure on
 * every zoom change, rather than trusting CodeMirror's own `ResizeObserver`
 * to catch it. This test pins down that wiring exists and fires — not the
 * CSS-zoom probe itself, which was exploratory and isn't real Electron zoom.
 *
 * Real Chromium, same fake-parse/tab-backed-session infrastructure as
 * `test/rawEditCaretSurvival.test.tsx` (R41).
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
import { createTab, getSessionFor, resetTabsForTests } from '../src/renderer/session/tabs'
import { Raw } from '../src/renderer/components/Raw/Raw'
import { resetZoom, zoomIn } from '../src/renderer/zoom'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Raw/Raw.css'
import '../src/renderer/components/Scrubber/Scrubber.css'
import '../src/renderer/components/Find/Find.css'

type FakeApi = {
  document: KladosApi['document'] & { read: (path: string) => Promise<ArrayBuffer> }
}

let nextRequestId = 1

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

function fakeApi(text: string): FakeApi {
  const read = vi.fn().mockResolvedValue(utf8(text))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: text.length, readOnly: false }),
      read,
      mintReadToken: vi.fn(),
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
  return { parse: fakeParse, parseFromUrl: fakeParse as never, api: fakeApi(text) }
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
  resetZoom()
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
  await new Promise((resolve) => setTimeout(resolve, 60))
  await paint()
}

function editorViewIn(el: HTMLElement): EditorView {
  const content = el.querySelector<HTMLElement>('.cm-content')
  if (content === null) throw new Error('.cm-content not found')
  const view = EditorView.findFromDOM(content)
  if (view === null) throw new Error('no EditorView found from .cm-content')
  return view
}

describe('Raw view: remeasures on zoom change (R59)', () => {
  it('a zoom change triggers requestMeasure on the mounted EditorView', async () => {
    await openTab('<name>Focus</name>')
    const view = editorViewIn(container)
    const measureSpy = vi.spyOn(view, 'requestMeasure')

    zoomIn()

    expect(measureSpy).toHaveBeenCalled()
  })

  it('does nothing (no throw) when no Raw view is mounted', () => {
    expect(() => zoomIn()).not.toThrow()
  })
})
