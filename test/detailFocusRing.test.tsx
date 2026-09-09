/**
 * R106–R107 (`R106-detail-focus-ring.md`): R94 made `.detail` focusable
 * (`tabIndex={-1}`, for arrow-key scrolling) but gave it no focus style, so
 * F6 into Detail in list mode drew the user-agent's own `outline: auto`
 * ring — visible only as a stray line across the top edge, since the rest
 * of the ring straddles `.pane-body`'s clipped padding box.
 *
 * R106 first replaced it with `.grid-scroll`'s inset `--focus-ring` ring;
 * the addendum removed that too. A ring drawn inside the pane reads as a
 * sub-region being highlighted rather than the pane, and this app already
 * answers "which pane has focus" in one place for all three —
 * `.pane:focus-within::after`. `.detail` now carries only `outline: none`,
 * exactly like `.tree`.
 *
 * R107, found while explaining why the grid route never showed the line:
 * pressing Enter on a grid row for a node with no repeating children
 * unmounts `Grid`, taking the focused `.grid-scroll` with it — focus falls
 * to `<body>` even though the user never left the pane.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTLE_MS } from './support/wait'
import { createRoot, type Root } from 'react-dom/client'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import type { ParseOptions } from '../src/core/types'
import type { OpenDocument } from '../src/renderer/session/documentSession'
import { resetTabsForTests } from '../src/renderer/session/tabs'
import { xmlFormatModule } from '../src/formats/xml/index'
import { DetailContent } from '../src/renderer/components/Detail/Detail'
import {
  focusPane,
  registerPane,
  resetFocusForTests,
  type FocusablePane
} from '../src/renderer/focus'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Layout/Layout.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Detail/Grid.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  // The real shell Detail renders inside, not a bare `<div>`: the focus
  // indication under test is `.pane:focus-within::after` (`Layout.css`),
  // which needs `.pane`'s own class and `position: relative` to exist at
  // all. Registering this same element as the pane's shell mirrors
  // `Layout.tsx`'s `PaneShell`.
  container.className = 'pane'
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

/**
 * A real DOM element, not `focusIntoContent.test.tsx`'s own inert
 * `fakeShell()` stub — `wasLastFocusedPane` (`focus.ts`) is driven by a
 * real `focusin` bubbling up to whatever's registered as the pane's shell,
 * the same way `Layout.tsx`'s `PaneShell` wires it in the app, and a stub
 * whose `addEventListener` does nothing would never see that event.
 */
function registerRealShell(pane: Parameters<typeof registerPane>[0], el: HTMLElement): void {
  registerPane(pane, el as unknown as FocusablePane)
}

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

/** `<garage>` with `rows` `<car>` children — grid-eligible, matching
 * `test/focusIntoContent.test.tsx`'s own fixture. */
function gridDocument(rows: number): { document: OpenDocument; selectedNode: number } {
  const parts: string[] = ['<garage>']
  for (let r = 0; r < rows; r++)
    parts.push(`<car><name>car${r}</name><year>20${10 + r}</year></car>`)
  parts.push('</garage>')
  const source = new TextEncoder().encode(parts.join(''))
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return { document: baseOpenDocument(source, store, 'C:/docs/garage.xml'), selectedNode: 0 }
}

/** `<a><b/><c/></a>` — `<a>`'s children are not grid-eligible (too few, no
 * repeats), so selecting `<a>` renders list mode. */
function listDocument(): { document: OpenDocument; selectedNode: number } {
  const source = new TextEncoder().encode('<a><b/><c/></a>')
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return { document: baseOpenDocument(source, store, 'C:/docs/list.xml'), selectedNode: 1 }
}

/** The one place this app indicates which pane has focus: `Layout.css`'s
 * `.pane:focus-within::after`. Read off the pseudo-element rather than
 * inferred from a class, since that rule *is* the behaviour under test. */
function paneOverlayBorderColor(): string {
  return getComputedStyle(container, '::after').borderColor
}

/** Resolved to an actual color through a probe element, not read with
 * `getPropertyValue` — the token's declared value is `var(--gray-300)`,
 * so `getPropertyValue` hands back that literal string rather than the
 * color it eventually resolves to, and the comparison would never match. */
function resolvedToken(name: string): string {
  const probe = document.createElement('div')
  probe.style.borderColor = `var(${name})`
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).borderColor
  probe.remove()
  return value
}

describe('R106 — the Detail pane indicates focus the way every other pane does', () => {
  it('F6 in list mode draws no ring of its own — not the user agent’s, and not an app one', async () => {
    const { document: doc, selectedNode } = listDocument()
    registerRealShell('detail', container)
    await paint(<DetailContent document={doc} selectedNode={selectedNode} />)

    focusPane('detail')
    const detailEl = container.querySelector<HTMLElement>('.detail')!
    expect(document.activeElement).toBe(detailEl)

    const style = getComputedStyle(detailEl)
    // `auto` is the specific value that means "nobody styled this" — the
    // original defect, where the UA ring's surviving sliver read as a stray
    // 1px line across the pane's top edge.
    expect(style.outlineStyle).not.toBe('auto')
    // And no replacement ring either: a second box drawn inside the pane
    // reads as a sub-region being highlighted rather than the pane itself,
    // which is what the pane overlay below is for.
    expect(style.outlineStyle).toBe('none')
  })

  it('F6 in list mode lights the whole-pane focus overlay instead', async () => {
    const { document: doc, selectedNode } = listDocument()
    registerRealShell('detail', container)
    await paint(<DetailContent document={doc} selectedNode={selectedNode} />)

    const unfocused = paneOverlayBorderColor()

    focusPane('detail')
    expect(document.activeElement).toBe(container.querySelector('.detail'))

    const focused = paneOverlayBorderColor()
    expect(focused).not.toBe(unfocused)
    expect(focused).toBe(resolvedToken('--pane-focus-ring'))
  })

  it('grid mode and list mode light the same whole-pane overlay, neither ringing inside it', async () => {
    const grid = gridDocument(30)
    registerRealShell('detail', container)
    await paint(<DetailContent document={grid.document} selectedNode={grid.selectedNode} />)
    focusPane('detail')
    const gridEl = container.querySelector<HTMLElement>('.grid-scroll')!
    expect(document.activeElement).toBe(gridEl)
    // R106 addendum: `.grid-scroll` was dropped from `Grid.css`'s
    // `:focus-visible` selector for the same reason `.detail` never got
    // one — an inset box reads as a sub-region, not as the pane. The
    // quick-filter input keeps its own ring and is not covered here.
    expect(getComputedStyle(gridEl).outlineStyle).toBe('none')
    const gridOverlay = paneOverlayBorderColor()

    const list = listDocument()
    resetFocusForTests()
    registerRealShell('detail', container)
    await paint(<DetailContent document={list.document} selectedNode={list.selectedNode} />)
    focusPane('detail')
    const detailEl = container.querySelector<HTMLElement>('.detail')!
    expect(document.activeElement).toBe(detailEl)
    expect(getComputedStyle(detailEl).outlineStyle).toBe('none')

    expect(paneOverlayBorderColor()).toBe(gridOverlay)
  })
})

describe('R107 — focus survives the grid unmounting under it', () => {
  it('Enter on a grid row for a node with no repeating children leaves focus inside Detail, not on <body>', async () => {
    const grid = gridDocument(30)
    registerRealShell('detail', container)
    await paint(<DetailContent document={grid.document} selectedNode={grid.selectedNode} />)

    focusPane('detail')
    const gridEl = container.querySelector('.grid-scroll')!
    expect(document.activeElement).toBe(gridEl)

    // Simulate "Enter on a grid row" the way it's observable from Detail's
    // own props: the selection moves to a node whose children are not
    // grid-eligible, so `useGrid` flips to false and `Grid` unmounts.
    const list = listDocument()
    await paint(<DetailContent document={list.document} selectedNode={list.selectedNode} />)

    const detailEl = container.querySelector<HTMLElement>('.detail')!
    expect(document.activeElement).toBe(detailEl)
  })

  it('changing the selection to a non-grid node while another pane has focus does not move focus', async () => {
    const grid = gridDocument(30)
    registerRealShell('detail', container)
    await paint(<DetailContent document={grid.document} selectedNode={grid.selectedNode} />)

    focusPane('detail')
    const gridEl = container.querySelector('.grid-scroll')!
    expect(document.activeElement).toBe(gridEl)

    // Focus moves to a *registered* pane — Tree — before the selection
    // changes underneath Detail. `wasLastFocusedPane('detail')` must read
    // false once Tree's own `focusin` fires, exactly the way two real
    // `PaneShell`s would behave.
    const treeShell = document.createElement('div')
    document.body.appendChild(treeShell)
    registerRealShell('tree', treeShell)
    const treeButton = document.createElement('button')
    treeShell.appendChild(treeButton)
    treeButton.focus()
    expect(document.activeElement).toBe(treeButton)

    const list = listDocument()
    await paint(<DetailContent document={list.document} selectedNode={list.selectedNode} />)

    expect(document.activeElement).toBe(treeButton)
    treeShell.remove()
  })
})
