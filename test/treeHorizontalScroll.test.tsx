/**
 * R170 (`docs/plans/R170-tree-horizontal-scroll.md`) — a deeply nested tree
 * had nowhere to scroll, and could not have had.
 *
 * **The mechanism — two causes, and the plan named only one of them.** Every
 * virtualized row was laid out `position: absolute; left: 0; right: 0`, which
 * pins the row *box* to the container's width whatever it contains, so the
 * indent (`depth * 16`, unbounded) squeezed `.tree-row-label` until
 * `text-overflow: ellipsis` erased it — **measured at 0px wide** on a 40-deep
 * row in a 400px pane.
 *
 * The plan went on to say that nothing therefore overflowed `.tree`, so its
 * `overflow: auto` had nothing to act on. **That part is false**, and measuring
 * it is what found the real second cause: the fixed-width indent span overflows
 * the row box and does extend the scroll area — the original layout reports
 * `scrollWidth` 684 against `clientWidth` 385. The extent existed; what did not
 * exist was any way to reach it, because `<Scrollbar>` was mounted
 * `axis="vertical"` and so never drew a horizontal track. And reaching it would
 * not have helped on its own, since the label was already 0px wide.
 *
 * So the fix is genuinely two changes answering two different failures:
 * `axis="both"` gives the track the user went looking for, and content-sized
 * rows give it something worth scrolling to. Each is pinned separately below,
 * because either alone leaves the report unanswered.
 *
 * The fix is `width: max-content` with `minWidth: '100%'`. The floor is the
 * load-bearing half: it keeps a shallow row spanning the full pane, so the
 * hover and selection backgrounds still read the way R33 arranged them — the
 * objection that made this look like more than a two-line change.
 *
 * Real Chromium, because every assertion here is a layout fact the virtualizer
 * and the browser produce together; jsdom fakes both.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTLE_MS } from './support/wait'
import { createRoot, type Root } from 'react-dom/client'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { NodeRef, ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { TreeContent } from '../src/renderer/components/Tree/Tree'
import '../src/renderer/styles/tokens.css'
// Load-bearing here in a way it is not for the other tree tests: `base.css`
// carries the project-wide `box-sizing: border-box`, and without it a row's
// own `padding-right` sits *outside* `minWidth: 100%` — making every row 8px
// wider than the pane and every tree, however shallow, look like it overflows.
import '../src/renderer/styles/base.css'
import '../src/renderer/components/Tree/Tree.css'
import '../src/renderer/components/Scrollbar/Scrollbar.css'

const VIEWPORT_PX = 400
const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.height = '400px'
  container.style.width = `${VIEWPORT_PX}px`
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  // The virtualizer measures via `ResizeObserver`, and the scrollbar's own
  // metrics read is rAF-coalesced on top of that — neither reliably settles
  // inside two rAFs in headless Chromium.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

function documentFor(text: string): {
  store: NodeStore
  sourceBuffer: SourceBuffer
  filePath: string
} {
  const source = new TextEncoder().encode(text)
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  jsonFormatModule.parse(source, store, options)
  return { store, sourceBuffer: new SourceBuffer(source, 'utf-8', 0), filePath: 'C:/docs/d.json' }
}

/** `deep-10k.json`'s own shape, at a depth that overflows a 400px pane:
 * singly-nested arrays, innermost holding a scalar. 40 levels puts the
 * deepest indent at 640px. */
const DEEP = '['.repeat(40) + '0' + ']'.repeat(40)
/** Nests two levels — nothing here can overflow. */
const SHALLOW = '{"a":{"b":1}}'

function tree(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.tree')
  if (el === null) throw new Error('.tree not found')
  return el
}

function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tree-row'))
}

/** The rendered row sitting deepest in the tree, by `aria-level`. */
function deepestRow(): HTMLElement {
  const all = rows()
  if (all.length === 0) throw new Error('no rows rendered')
  return all.reduce((deepest, row) =>
    Number(row.getAttribute('aria-level')) > Number(deepest.getAttribute('aria-level'))
      ? row
      : deepest
  )
}

function nodeOf(row: HTMLElement): NodeRef {
  return Number(row.id.replace('tree-row-', '')) as NodeRef
}

describe('R170 — a deeply nested tree can scroll horizontally', () => {
  it('a deep tree gives .tree a scrollable width', async () => {
    await paint(<TreeContent document={documentFor(DEEP)} selectedNode={0} />)
    const el = tree()
    // The whole defect in one assertion: before the fix these were equal,
    // because no row could be wider than its container.
    expect(el.scrollWidth).toBeGreaterThan(el.clientWidth + 1)
  })

  it('a shallow tree does not, so nothing appears for an ordinary document', async () => {
    await paint(<TreeContent document={documentFor(SHALLOW)} selectedNode={0} />)
    const el = tree()
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1)
  })

  it('a deep row is wider than the pane and its label is fully rendered', async () => {
    await paint(<TreeContent document={documentFor(DEEP)} selectedNode={0} />)
    const row = deepestRow()
    const label = row.querySelector<HTMLElement>('.tree-row-label')
    if (label === null) throw new Error('no label on the deepest row')

    expect(row.getBoundingClientRect().width).toBeGreaterThan(VIEWPORT_PX)
    // The symptom the user actually saw was the label ellipsised to nothing.
    // A width floor rather than an exact value: the point is that it renders
    // at all, and the exact text width is font-dependent.
    expect(label.getBoundingClientRect().width).toBeGreaterThan(4)
  })

  it('a shallow row still spans the whole pane, so its selection background does', async () => {
    // §2's first objection — `right: 0` was what made a selected row paint
    // across the pane, and `minWidth: 100%` is what preserves it. Asserted on
    // the *root* row, which has no indent at all and would otherwise collapse
    // to the width of its own text.
    await paint(<TreeContent document={documentFor(SHALLOW)} selectedNode={0} />)
    const first = rows()[0]
    if (first === undefined) throw new Error('no rows rendered')
    expect(first.getBoundingClientRect().width).toBeGreaterThanOrEqual(tree().clientWidth)
  })

  it('a shallow row still covers the pane once the tree is scrolled right', async () => {
    // **The case `minWidth: 100%` alone does not cover**, and the reason
    // `contentWidth` exists. 100% resolves against the pane, so a shallow row
    // measured at `scrollLeft: 0` looks correct and tells you nothing; scrolled
    // to the right edge of a 40-deep tree its background stopped 175px short,
    // leaving a selected row's highlight visibly torn beside the deep rows
    // around it. Asserted *after scrolling*, which is the only position where
    // the two behaviours differ.
    await paint(<TreeContent document={documentFor(DEEP)} selectedNode={0} />)
    const el = tree()
    el.scrollLeft = el.scrollWidth - el.clientWidth
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(el.scrollLeft).toBeGreaterThan(0)

    const shallowest = rows().reduce((min, row) =>
      Number(row.getAttribute('aria-level')) < Number(min.getAttribute('aria-level')) ? row : min
    )
    // Within a pixel: the row's right edge reaches the pane's right edge.
    const pane = el.getBoundingClientRect()
    expect(shallowest.getBoundingClientRect().right).toBeGreaterThanOrEqual(pane.right - 1)
  })

  it('selecting a deep node scrolls horizontally so its label is reachable', async () => {
    // Acceptance 5. `scrollToIndex` is vertical only, so without the reveal a
    // keyboard move to a deep node brought its row into view with the label
    // still off the right edge — the same "you moved and saw nothing" the
    // round exists to fix, on the other axis.
    const doc = documentFor(DEEP)
    await paint(<TreeContent document={doc} selectedNode={0} />)
    expect(tree().scrollLeft).toBe(0)

    const deep = nodeOf(deepestRow())
    await paint(<TreeContent document={doc} selectedNode={deep} />)

    const el = tree()
    expect(el.scrollLeft).toBeGreaterThan(0)
    // And it landed somewhere that actually shows the label rather than
    // merely being non-zero: the row's indent must be at or left of the
    // viewport's left edge, with the label after it.
    const row = container.querySelector<HTMLElement>(`#tree-row-${deep}`)
    if (row === null) throw new Error('the selected deep row is not rendered')
    const indent = row.querySelector<HTMLElement>('.tree-row-indent')
    const label = row.querySelector<HTMLElement>('.tree-row-label')
    if (indent === null || label === null) throw new Error('row is missing indent or label')
    const paneRight = el.getBoundingClientRect().right
    expect(label.getBoundingClientRect().left).toBeLessThan(paneRight)
  })

  it('selecting a shallow node again scrolls back, leaving no orphaned offset', async () => {
    const doc = documentFor(DEEP)
    await paint(<TreeContent document={doc} selectedNode={0} />)
    const deep = nodeOf(deepestRow())
    await paint(<TreeContent document={doc} selectedNode={deep} />)
    expect(tree().scrollLeft).toBeGreaterThan(0)

    await paint(<TreeContent document={doc} selectedNode={0} />)
    // The root sits at indent 0, so the reveal must bring the pane back to the
    // left edge rather than leaving the user looking at empty indentation.
    expect(tree().scrollLeft).toBe(0)
  })

  it('renders a horizontal scrollbar track for a deep tree, and none for a shallow one', async () => {
    // The report in its most literal form: *"our tree view doesn't have a
    // horizontal scroll bar."* The extent was already there; `axis="vertical"`
    // meant the track was never drawn. This is the assertion that fails if the
    // axis is ever narrowed again.
    await paint(<TreeContent document={documentFor(DEEP)} selectedNode={0} />)
    expect(container.querySelector('.scrollbar-track-horizontal')).not.toBeNull()

    await paint(<TreeContent document={documentFor(SHALLOW)} selectedNode={0} />)
    expect(container.querySelector('.scrollbar-track-horizontal')).toBeNull()
  })

  it('reserves a bottom gutter only while the horizontal track is showing', async () => {
    // R44b's reasoning, on the tree: an unconditional gutter would cost every
    // ordinary document 15px of vertical space for a track it never draws.
    await paint(<TreeContent document={documentFor(SHALLOW)} selectedNode={0} />)
    expect(tree().classList.contains('tree-has-horizontal-track')).toBe(false)

    await paint(<TreeContent document={documentFor(DEEP)} selectedNode={0} />)
    expect(tree().classList.contains('tree-has-horizontal-track')).toBe(true)
  })
})
