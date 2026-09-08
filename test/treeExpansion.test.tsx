/**
 * M5g-PLAN.md O4: `Tree.tsx` used to reset all expansion state whenever
 * `store` identity changed — which happens on *every* reparse of the same
 * document (an edit, a Transform), not just when a genuinely different
 * file opens. Verifies against real Chromium layout (the virtualizer needs
 * real container geometry, which jsdom fakes) that expansion now survives
 * a same-document reparse and still resets when the document actually
 * changes.
 *
 * Asserts on a specific row id (`tree-row-<node>`) rather than raw row
 * counts — `NodeRef`s are allocated in document order (deterministic for a
 * fixed input), but the exact starting expansion state can carry a node or
 * two beyond just the root (`autoExpandChain`'s single-child descent, or
 * module-level singletons like `treeController.ts` this test doesn't fully
 * isolate from). A specific id's presence/absence is unambiguous regardless
 * of exactly how many rows happen to be visible around it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTLE_MS } from './support/wait'
import { createRoot, type Root } from 'react-dom/client'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { TreeContent } from '../src/renderer/components/Tree/Tree'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Tree/Tree.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.height = '400px'
  container.style.width = '400px'
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
  // The virtualizer measures its scroll container via `ResizeObserver`,
  // which doesn't necessarily settle within two rAFs in headless Chromium
  // — an extra macrotask tick gives it room to fire before rows are read.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function documentFor(
  text: string,
  filePath: string
): { store: NodeStore; sourceBuffer: SourceBuffer; filePath: string } {
  const source = new TextEncoder().encode(text)
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  jsonFormatModule.parse(source, store, options)
  return { store, sourceBuffer: new SourceBuffer(source, 'utf-8', 0), filePath }
}

// Document(0) > Object(1) > Property "child"(2) > Object(3) > Property
// "grandchild"(4) — deterministic for this fixed input, since `NodeRef`s
// are allocated in document order (invariant 2's context).
const NESTED_JSON = '{"child":{"grandchild":1}}'
const NESTED_OBJECT_ROW = '#tree-row-3' // the "child" property's own Object value
const GRANDCHILD_ROW = '#tree-row-4' // only visible once NESTED_OBJECT_ROW is expanded

/** Expands node 3 if it isn't already (tolerates any pre-existing
 * expansion state rather than assuming a pristine `expandedRef`). */
function ensureNestedObjectExpanded(): void {
  const row = container.querySelector(NESTED_OBJECT_ROW)
  if (row === null) throw new Error(`${NESTED_OBJECT_ROW} not found`)
  if (row.getAttribute('aria-expanded') === 'true') return
  const disclosure = row.querySelector<HTMLButtonElement>('.tree-row-disclosure')!
  disclosure.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

describe('Tree expansion survives a same-document reparse (M5g-PLAN.md O4)', () => {
  it('keeps a manually expanded node visible when store changes but filePath does not', async () => {
    const doc = documentFor(NESTED_JSON, 'C:/docs/data.json')
    await paint(<TreeContent document={doc} selectedNode={0} />)

    ensureNestedObjectExpanded()
    await paint(<TreeContent document={doc} selectedNode={0} />)
    expect(container.querySelector(GRANDCHILD_ROW)).not.toBeNull()

    // A reparse of the same document: a genuinely new `NodeStore` object
    // (never `===` the old one, same as a real reparse produces), same
    // `filePath`. Pre-O4, this alone reset `expandedRef` to root-only.
    const reparsed = documentFor(NESTED_JSON, 'C:/docs/data.json')
    expect(reparsed.store).not.toBe(doc.store)
    await paint(<TreeContent document={reparsed} selectedNode={0} />)

    expect(container.querySelector(GRANDCHILD_ROW)).not.toBeNull()
  })

  it('still resets expansion when a genuinely different document opens', async () => {
    const doc = documentFor(NESTED_JSON, 'C:/docs/data.json')
    await paint(<TreeContent document={doc} selectedNode={0} />)

    ensureNestedObjectExpanded()
    await paint(<TreeContent document={doc} selectedNode={0} />)
    expect(container.querySelector(GRANDCHILD_ROW)).not.toBeNull()

    const otherDoc = documentFor(NESTED_JSON, 'C:/docs/other.json')
    await paint(<TreeContent document={otherDoc} selectedNode={0} />)

    expect(container.querySelector(GRANDCHILD_ROW)).toBeNull()
  })
})
