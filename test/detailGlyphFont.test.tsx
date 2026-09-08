/**
 * R99 (`R98-glyph-font-per-glyph.md` §3) — `.detail-node-glyph` and
 * `.detail-child-glyph` inherit `--font-ui` from `.detail` today (R83
 * never touched Detail), so their `<>` is already correct; this applies
 * the same `glyphFontClass` rule R98 gave the tab strip and tree, which
 * leaves `<>` unchanged here and switches `{}`/`[]` from the thin
 * `--font-ui` rendering to `--font-mono`, matching every other pane.
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
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { DetailContent } from '../src/renderer/components/Detail/Detail'
import type { OpenDocument } from '../src/renderer/session/documentSession'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/styles/base.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Detail/Grid.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.width = '900px'
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
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function openDocumentOver(
  source: Uint8Array,
  store: NodeStore,
  filePath: string,
  formatId: 'xml' | 'json'
): OpenDocument {
  const module = formatId === 'xml' ? xmlFormatModule : jsonFormatModule
  const rowIndex = buildRowIndex(source, DEFAULT_MAX_ROW_BYTES, module.capabilities.rowBreakBytes)
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
    formatId,
    encoding: 'utf-8',
    readOnly: false,
    errorNode: null,
    errorOffset: null,
    pendingParseError: null,
    dirty: false,
    externalChangeDetected: false,
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

function xmlDocument(): OpenDocument {
  const source = new TextEncoder().encode('<a><b/><c/></a>')
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, options)
  return openDocumentOver(source, store, 'C:/docs/a.xml', 'xml')
}

function jsonDocument(): OpenDocument {
  const source = new TextEncoder().encode('{"a":{"b":1}}')
  const store = new NodeStore(source, new Interner())
  jsonFormatModule.parse(source, store, options)
  return openDocumentOver(source, store, 'C:/docs/a.json', 'json')
}

describe('R99 — Detail glyphs follow glyphFontClass, same as the tab strip and tree', () => {
  it('the node glyph (<>, an XML element) stays --font-ui', async () => {
    const document = xmlDocument()
    // node 0 is Document; node 1 is <a>, the destination D-050's wrapper
    // descent would land on anyway.
    await paint(<DetailContent document={document} selectedNode={1} />)

    const glyph = container.querySelector<HTMLElement>('.detail-node-glyph')!
    expect(glyph.textContent).toBe('<>')
    expect(getComputedStyle(glyph).fontFamily).not.toContain('mono')
  })

  it('the node glyph ({}, a JSON object) switches to --font-mono', async () => {
    const document = jsonDocument()
    // node 0 is Document, whose one child (the outer object) is what
    // wrapper descent lands the selection on.
    await paint(<DetailContent document={document} selectedNode={0} />)

    const glyph = container.querySelector<HTMLElement>('.detail-node-glyph')!
    expect(glyph.textContent).toBe('{}')
    expect(getComputedStyle(glyph).fontFamily).toContain('mono')
  })

  it('a child row glyph (<>, an XML element) stays --font-ui', async () => {
    const document = xmlDocument()
    await paint(<DetailContent document={document} selectedNode={1} />)

    const glyphs = Array.from(container.querySelectorAll<HTMLElement>('.detail-child-glyph'))
    const glyph = glyphs.find((g) => g.textContent === '<>')!
    expect(getComputedStyle(glyph).fontFamily).not.toContain('mono')
  })

  it('a child row glyph ({}, a JSON object) switches to --font-mono', async () => {
    // A single Object among the array's children, not two — two would
    // qualify as a grid group (`GRID_MIN_MEMBERS`) and render `Grid`
    // instead of `ChildrenList`, which has no `.detail-child-glyph` at all.
    const source = new TextEncoder().encode('{"list":[{"a":1},2]}')
    const store = new NodeStore(source, new Interner())
    jsonFormatModule.parse(source, store, options)
    const document = openDocumentOver(source, store, 'C:/docs/list.json', 'json')
    const arrayNode = store.firstChildOf(store.firstChildOf(store.firstChildOf(0)))
    await paint(<DetailContent document={document} selectedNode={arrayNode} />)

    const glyphs = Array.from(container.querySelectorAll<HTMLElement>('.detail-child-glyph'))
    const glyph = glyphs.find((g) => g.textContent === '{}')!
    expect(getComputedStyle(glyph).fontFamily).toContain('mono')
  })
})
