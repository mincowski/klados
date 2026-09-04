/**
 * F6 was dead after opening a document: focus sat visibly in the Tree pane
 * and every press left it there, until the user clicked another pane by
 * hand. `focus.ts`'s `lastFocusedPane` was `null` while the Tree held
 * focus, so `moveFocus` started from `PANE_ORDER[0]` — the Tree — whose
 * element was already focused, making `.focus()` a no-op that fired no
 * `focusin` and left the state `null` for the next press too.
 *
 * `StrictMode` (which `main.tsx` wraps the whole app in) is what produced
 * that state: its mount → cleanup → mount replay ran `registerPane`'s
 * cleanup, which clears `lastFocusedPane`, while the DOM element itself
 * never unmounted and so kept focus — and `Layout`'s open-a-document effect
 * does not run a second time to repair it. `registerPane` now adopts focus
 * that is already inside the shell it is given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import type { KladosApi } from '../src/preload/api'
import type { DocumentSessionDeps } from '../src/renderer/session/documentSession'
import {
  createTab,
  getSessionFor,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import { Layout } from '../src/renderer/components/Layout/Layout'
import { resetLayoutForTests } from '../src/renderer/components/Layout/layoutStore'
import {
  moveFocus,
  registerPane,
  resetFocusForTests,
  wasLastFocusedPane,
  type FocusablePane
} from '../src/renderer/focus'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Layout/Layout.css'
import '../src/renderer/components/Tree/Tree.css'
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
  resetLayoutForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetFocusForTests()
  resetLayoutForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** `test/focusIntoContent.test.tsx`'s own shell double — a plain object, no
 * DOM, which is also what keeps `FocusablePane.contains` optional. */
function fakeShell(): FocusablePane {
  return { focus: vi.fn(), addEventListener: () => {}, removeEventListener: () => {} }
}

describe('F6 works on the first press after opening a document', () => {
  it('under StrictMode, registering a shell that already holds focus adopts it', async () => {
    // `StrictMode` is not incidental — `main.tsx` renders the whole app
    // inside it, and its mount → cleanup → mount replay is what produced
    // the bug. Without the fix in `focus.ts` both assertions below fail:
    // `wasLastFocusedPane` reads `false`, and focus never leaves `.tree`.
    await paint(
      <StrictMode>
        <Layout />
      </StrictMode>
    )
    const id = createTab(depsFor('<garage><car/><car/></garage>'))
    setActiveTab(id)
    await getSessionFor(id)!.openPath('C:/docs/a.xml')
    await paint(
      <StrictMode>
        <Layout />
      </StrictMode>
    )

    const treeEl = container.querySelector<HTMLElement>('.tree')
    expect(treeEl).not.toBeNull()
    expect(document.activeElement).toBe(treeEl)
    // The state the bug got wrong: focus is visibly in the Tree, so the
    // focus model has to agree that it is.
    expect(wasLastFocusedPane('tree')).toBe(true)

    // The observable symptom: the *first* F6 has to move focus out of the
    // Tree. The bug left it there indefinitely.
    moveFocus('next')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(document.activeElement).not.toBe(treeEl)
  })

  it('a shell registering while focus is elsewhere does not claim it', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    registerPane('detail', fakeShell())
    expect(wasLastFocusedPane('detail')).toBe(false)

    outside.remove()
  })

  it('a shell registering while nothing at all is focused does not claim it', () => {
    // `document.body` "contains" everything and is also where focus sits
    // when nothing is focused — the case the guard has to exclude, or every
    // registration would claim the focus.
    ;(document.activeElement as HTMLElement | null)?.blur()
    const shell = document.createElement('div')
    document.body.appendChild(shell)

    registerPane('raw', shell as unknown as FocusablePane)
    expect(wasLastFocusedPane('raw')).toBe(false)

    shell.remove()
  })
})
