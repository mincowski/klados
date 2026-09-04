/**
 * R83 (`R82-hover-and-glyphs.md` §2) — `.tree-row-glyph` regains
 * `--font-mono`, matching `.tab-icon`'s own restoration
 * (`test/tabStrip.test.tsx`'s R71/R83 describe block), so the tab marker
 * and the tree's node glyph go back to looking like the same mark R71 was
 * originally asked to make them. Real Chromium — `getComputedStyle`'s
 * `fontFamily` resolution needs it, jsdom fakes it.
 *
 * R98 (`R98-glyph-font-per-glyph.md` §2) narrows that to every marker
 * *except* `<>`, which goes back to `--font-ui` — Cascadia (`--font-mono`'s
 * second entry) closes its two chevrons into a diamond at this size. The
 * second describe block below covers that site.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { xmlFormatModule } from '../src/formats/xml/index'
import { TreeContent } from '../src/renderer/components/Tree/Tree'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/styles/base.css'
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
  await new Promise((resolve) => setTimeout(resolve, 50))
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

describe('R83 — .tree-row-glyph resolves a monospace font-family, matching .tab-icon', () => {
  it('the node glyph draws in --font-mono', async () => {
    const doc = documentFor('{"child":1}', 'C:/docs/data.json')
    await paint(<TreeContent document={doc} selectedNode={0} />)

    const glyph = container.querySelector<HTMLElement>('.tree-row-glyph')!
    const style = getComputedStyle(glyph)
    expect(style.fontFamily).toContain('mono')
    expect(style.width).toBe('20px')
    expect(style.textAlign).toBe('center')
  })
})

describe('R98 — .tree-row-glyph draws the XML marker in --font-ui, not --font-mono', () => {
  it('the element glyph (<>) draws in --font-ui', async () => {
    const source = new TextEncoder().encode('<a/>')
    const store = new NodeStore(source, new Interner())
    xmlFormatModule.parse(source, store, options)
    const doc = {
      store,
      sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
      filePath: 'C:/docs/a.xml'
    }
    // node 0 is Document (glyph 'D'); node 1 is the <a/> element itself —
    // select it directly rather than relying on which row the virtualizer
    // happens to render first.
    await paint(<TreeContent document={doc} selectedNode={1} />)

    const glyphs = Array.from(container.querySelectorAll<HTMLElement>('.tree-row-glyph'))
    const glyph = glyphs.find((g) => g.textContent === '<>')!
    const style = getComputedStyle(glyph)
    expect(style.fontFamily).not.toContain('mono')
  })
})
