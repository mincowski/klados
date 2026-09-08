/**
 * R113–R116 (`R113-inactive-selection.md`): each pane's own selection or
 * active item says whether the keyboard is currently in that pane — blue
 * when it is, grey when it is not — as a second layer on top of the
 * whole-pane `:focus-within` border (R106). Real Chromium, not jsdom:
 * `:focus-within` and computed colours both need real focus and real
 * layout.
 *
 * Two kinds of test live here:
 * - Synthetic markup carrying the real classnames and importing the real
 *   CSS, focused with a real `.focus()` call — the pattern
 *   `test/scrollbarContrast.test.tsx` and `test/detailFocusRing.test.tsx`
 *   both use. Cheap, and enough for anything driven by `:focus-within`.
 * - A real mounted `Raw` with a real `EditorView`, for the two things that
 *   are not this app's own CSS at all: CodeMirror's own `.cm-focused` class
 *   and its base-theme caret visibility (§2's "already correct, no change"
 *   claim, characterized rather than assumed).
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
import { POLL_MS, TIMEOUT_MS } from './support/wait'
import { Raw } from '../src/renderer/components/Raw/Raw'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Tree/Tree.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Detail/Grid.css'
import '../src/renderer/components/Raw/Raw.css'
import '../src/renderer/components/Scrubber/Scrubber.css'
import '../src/renderer/components/Find/Find.css'

let container: HTMLDivElement

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  container.remove()
  delete document.documentElement.dataset.theme
})

/** Same trick `detailFocusRing.test.tsx`'s own `resolvedToken` uses:
 * `getPropertyValue` hands back the raw `var(...)` chain, not the colour it
 * resolves to, so resolve it through a probe element instead. */
function resolvedToken(
  name: string,
  prop: 'backgroundColor' | 'borderColor' = 'backgroundColor'
): string {
  const probe = document.createElement('div')
  probe.style[prop] = `var(${name})`
  document.body.appendChild(probe)
  const value = getComputedStyle(probe)[prop]
  probe.remove()
  return value
}

function parseRgb(color: string): [number, number, number] {
  const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color)
  if (match === null) throw new Error(`unparseable color: ${color}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(parseRgb(a))
  const l2 = relativeLuminance(parseRgb(b))
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

// ---------------------------------------------------------------------------
// R113 — Tree
// ---------------------------------------------------------------------------

describe('R113 — Tree selection colour follows focus', () => {
  it('the selected row is grey unfocused and blue with focus in the Tree, on computed colour', () => {
    container.innerHTML = `
      <div class="tree-viewport">
        <div class="tree" tabindex="-1">
          <div class="tree-row tree-row-selected">a row</div>
        </div>
      </div>
    `
    const row = container.querySelector<HTMLElement>('.tree-row-selected')!
    const treeEl = container.querySelector<HTMLElement>('.tree')!

    expect(getComputedStyle(row).backgroundColor).toBe(resolvedToken('--row-selected-inactive-bg'))

    treeEl.focus()
    expect(document.activeElement).toBe(treeEl)
    expect(getComputedStyle(row).backgroundColor).toBe(resolvedToken('--row-selected-bg'))
  })

  it('the Find marker (.tree-row-matched) is unchanged in both states', () => {
    container.innerHTML = `
      <div class="tree-viewport">
        <div class="tree" tabindex="-1">
          <div class="tree-row tree-row-selected tree-row-matched">a row</div>
        </div>
      </div>
    `
    const row = container.querySelector<HTMLElement>('.tree-row-selected')!
    const treeEl = container.querySelector<HTMLElement>('.tree')!

    const unfocusedShadow = getComputedStyle(row).boxShadow
    treeEl.focus()
    const focusedShadow = getComputedStyle(row).boxShadow

    expect(unfocusedShadow).toBe(focusedShadow)
    expect(unfocusedShadow).toContain('inset')
  })
})

// ---------------------------------------------------------------------------
// R114 — Detail, grid mode
// ---------------------------------------------------------------------------

function gridMarkup(): string {
  return `
    <div class="detail-viewport">
      <div class="detail" tabindex="-1">
        <div class="grid-wrapper">
          <div class="grid-toolbar">
            <input class="grid-quick-filter" />
          </div>
          <div class="grid-viewport">
            <div class="grid-scroll" tabindex="-1">
              <div class="grid-row grid-row-selected">
                <div class="grid-cell">a</div>
              </div>
              <div class="grid-cell grid-cell-active">b</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

describe('R114 — Detail grid: selected row and active cell both follow focus', () => {
  it('both switch together, in the same test, since they are driven by two different variables', () => {
    container.innerHTML = gridMarkup()
    const selectedCell = container.querySelector<HTMLElement>('.grid-row-selected .grid-cell')!
    const activeCell = container.querySelector<HTMLElement>('.grid-cell-active')!
    const gridScroll = container.querySelector<HTMLElement>('.grid-scroll')!

    expect(getComputedStyle(selectedCell).backgroundColor).toBe(
      resolvedToken('--row-selected-inactive-bg')
    )
    expect(getComputedStyle(activeCell).outlineColor).toBe(
      resolvedToken('--focus-ring-inactive', 'borderColor')
    )

    gridScroll.focus()
    expect(document.activeElement).toBe(gridScroll)

    expect(getComputedStyle(selectedCell).backgroundColor).toBe(resolvedToken('--row-selected-bg'))
    expect(getComputedStyle(activeCell).outlineColor).toBe(
      resolvedToken('--focus-ring', 'borderColor')
    )
  })

  it('focus in the quick-filter leaves the selection blue — the case the element choice in §3 exists for', () => {
    container.innerHTML = gridMarkup()
    const selectedCell = container.querySelector<HTMLElement>('.grid-row-selected .grid-cell')!
    const quickFilter = container.querySelector<HTMLElement>('.grid-quick-filter')!

    expect(getComputedStyle(selectedCell).backgroundColor).toBe(
      resolvedToken('--row-selected-inactive-bg')
    )

    quickFilter.focus()
    expect(document.activeElement).toBe(quickFilter)

    expect(getComputedStyle(selectedCell).backgroundColor).toBe(resolvedToken('--row-selected-bg'))
  })

  it('Detail in list mode renders unchanged in both states — nothing there reads the variables', () => {
    container.innerHTML = `
      <div class="detail-viewport">
        <div class="detail" tabindex="-1">
          <div class="detail-child-row">a child</div>
        </div>
      </div>
    `
    const row = container.querySelector<HTMLElement>('.detail-child-row')!
    const detailEl = container.querySelector<HTMLElement>('.detail')!

    const unfocused = getComputedStyle(row).backgroundColor
    detailEl.focus()
    const focused = getComputedStyle(row).backgroundColor

    expect(unfocused).toBe(focused)
    expect(unfocused).toBe('rgba(0, 0, 0, 0)')
  })
})

// §8's static-source check (which sites deliberately keep their original
// tokens) lives in `test/inactiveSelectionSites.test.ts` — it needs
// `node:fs`, which the browser project's Vite build externalizes.

// ---------------------------------------------------------------------------
// R115 — Raw
// ---------------------------------------------------------------------------

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

let root: Root

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(<Raw />)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

async function openTab(text: string): Promise<void> {
  const tabId = createTab(depsFor(text, 20))
  await getSessionFor(tabId)!.openPath('C:/docs/edit.json')
  await paint()
  // R159 (`docs/plans/R159-fixed-duration-waits.md`): the session ready *and*
  // CodeMirror mounted — a condition, not the 60 ms this file shared verbatim
  // with four others.
  await waitForEditorMounted()
  await paint()
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

describe('R115 — Raw', () => {
  beforeEach(() => {
    resetTabsForTests()
    resetContextForTests()
    container.style.height = '400px'
    container.style.width = '600px'
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    resetTabsForTests()
    resetContextForTests()
  })

  it(".cm-np-selected — the selected node's span — switches between focused and unfocused", async () => {
    await openTab('{"a":"hello world"}')
    await paint()

    const span = container.querySelector<HTMLElement>('.cm-np-selected')
    expect(span).not.toBeNull()
    const unfocusedColor = getComputedStyle(span!).backgroundColor
    expect(unfocusedColor).toBe(resolvedToken('--row-selected-inactive-bg'))

    const view = editorViewIn(container)
    view.focus()
    await paint()

    const focusedColor = getComputedStyle(
      container.querySelector<HTMLElement>('.cm-np-selected')!
    ).backgroundColor
    expect(focusedColor).toBe(resolvedToken('--row-selected-bg'))
    expect(focusedColor).not.toBe(unfocusedColor)
  })

  // R117 (`R113-inactive-selection.md` §12) — the text selection, through
  // `::selection`, which is what actually paints it.
  //
  // R115 first wrote this as a `.cm-selectionBackground` pair, on the
  // reasonable-looking assumption that CodeMirror draws the selection
  // itself. It does not here (see the characterization test below), so
  // those rules were dead and the selection was left unthemed — Chromium's
  // own default blue, in both themes, and never dimming on blur. That was
  // the one row of §2's table still wrong on screen.
  //
  // Asserted on both `.cm-content` and a `.cm-line`: the rule is written in
  // two forms because the text lives in descendant elements, so the
  // descendant form is the one that actually colours what the user sees.
  it('the text selection follows the pane through ::selection', async () => {
    await openTab('{"a":"hello world"}')
    await paint()

    const contentOf = (): HTMLElement => container.querySelector<HTMLElement>('.cm-content')!
    const lineOf = (): HTMLElement => container.querySelector<HTMLElement>('.cm-line')!

    const unfocusedContent = getComputedStyle(contentOf(), '::selection').backgroundColor
    const unfocusedLine = getComputedStyle(lineOf(), '::selection').backgroundColor
    expect(unfocusedContent).toBe(resolvedToken('--row-selected-inactive-bg'))
    expect(unfocusedLine).toBe(resolvedToken('--row-selected-inactive-bg'))

    const view = editorViewIn(container)
    view.focus()
    await paint()

    const focusedContent = getComputedStyle(contentOf(), '::selection').backgroundColor
    const focusedLine = getComputedStyle(lineOf(), '::selection').backgroundColor
    expect(focusedContent).toBe(resolvedToken('--row-selected-bg'))
    expect(focusedLine).toBe(resolvedToken('--row-selected-bg'))
    expect(focusedContent).not.toBe(unfocusedContent)
  })

  // The caret row of §2's table holds on native behaviour plus this one
  // rule, not on CodeMirror's base theme (which never applies — see below).
  // A caret is painted only in the focused editing host, so "hidden when
  // the pane is unfocused" comes for free from `contenteditable`; what does
  // *not* come for free is it being the app's colour rather than the
  // browser's, which is what this locks.
  it('the caret is themed, and .cm-content is the contenteditable host that governs its visibility', async () => {
    await openTab('{"a":"hello world"}')
    await paint()

    const content = container.querySelector<HTMLElement>('.cm-content')!
    expect(content.getAttribute('contenteditable')).toBe('true')
    expect(getComputedStyle(content).caretColor).toBe(resolvedToken('--accent'))
  })

  // R117: `drawSelection()` (`@codemirror/view`) is what mounts
  // `.cm-selectionBackground` and `.cm-cursorLayer`, and it is not among
  // `Raw.tsx`'s extensions — there is no `basicSetup` here, every extension
  // is listed explicitly. So CodeMirror's own base-theme rules for those
  // classes never apply, and the browser's native selection/caret rendering
  // is what the user actually sees. That is why the test above reaches for
  // `::selection` rather than `.cm-selectionBackground`.
  //
  // Kept as a characterization test so this stays honest: it fails loudly
  // the day someone adds `drawSelection()` and both mechanisms would
  // otherwise go live at once — the one state that would be genuinely
  // confusing to debug.
  it('CodeMirror does not currently draw .cm-selectionBackground or .cm-cursorLayer at all — drawSelection() is not wired up', async () => {
    await openTab('{"a":"hello world"}')
    const view = editorViewIn(container)
    view.dispatch({ selection: { anchor: 0, head: 5 } })
    view.focus()
    await paint()

    expect(container.querySelector('.cm-selectionBackground')).toBeNull()
    expect(container.querySelector('.cm-cursorLayer')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// R116 — enumeration over the panes
// ---------------------------------------------------------------------------

describe('R116 — every pane participates in the focused/unfocused selection colour', () => {
  const panes: Array<{
    name: string
    markup: string
    viewportSelector: string
    focusableSelector: string
    selectedSelector: string
  }> = [
    {
      name: 'Tree',
      markup: `
        <div class="tree-viewport">
          <div class="tree" tabindex="-1">
            <div class="tree-row tree-row-selected">a row</div>
          </div>
        </div>
      `,
      viewportSelector: '.tree-viewport',
      focusableSelector: '.tree',
      selectedSelector: '.tree-row-selected'
    },
    {
      name: 'Detail grid',
      markup: gridMarkup(),
      viewportSelector: '.detail-viewport',
      focusableSelector: '.grid-scroll',
      selectedSelector: '.grid-row-selected .grid-cell'
    }
  ]

  for (const pane of panes) {
    it(`${pane.name}: selection colour differs between focused and unfocused`, () => {
      container.innerHTML = pane.markup
      const selected = container.querySelector<HTMLElement>(pane.selectedSelector)!
      const focusable = container.querySelector<HTMLElement>(pane.focusableSelector)!

      const unfocused = getComputedStyle(selected).backgroundColor
      focusable.focus()
      expect(document.activeElement).toBe(focusable)
      const focused = getComputedStyle(selected).backgroundColor

      expect(focused).not.toBe(unfocused)
      expect(unfocused).toBe(resolvedToken('--row-selected-inactive-bg'))
      expect(focused).toBe(resolvedToken('--row-selected-bg'))
    })
  }

  it('found a non-trivial number of panes to check (the enumeration itself works)', () => {
    expect(panes.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Contrast (§4, §10's last item)
// ---------------------------------------------------------------------------

describe('R113–R116 — contrast, asserted rather than eyeballed', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`text on the inactive band clears 4.5:1 in ${theme}`, () => {
      document.documentElement.dataset.theme = theme
      const fg = resolvedToken('--row-selected-fg', 'borderColor')
      const bg = resolvedToken('--row-selected-inactive-bg')
      const ratio = contrastRatio(fg, bg)
      expect(
        ratio,
        `--row-selected-fg over --row-selected-inactive-bg in ${theme} (${ratio.toFixed(2)}:1)`
      ).toBeGreaterThanOrEqual(4.5)
    })

    it(`the inactive ring clears 3:1 against the inactive band in ${theme}`, () => {
      document.documentElement.dataset.theme = theme
      const ring = resolvedToken('--focus-ring-inactive', 'borderColor')
      const band = resolvedToken('--row-selected-inactive-bg')
      const ratio = contrastRatio(ring, band)
      expect(
        ratio,
        `--focus-ring-inactive over --row-selected-inactive-bg in ${theme} (${ratio.toFixed(2)}:1)`
      ).toBeGreaterThanOrEqual(3)
    })
  }
})
