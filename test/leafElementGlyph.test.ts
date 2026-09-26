/**
 * R216 (`docs/plans/R215-raw-band-and-leaf-glyph.md` §2): an element without
 * element children shows `•`; every other node keeps its kind's glyph.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, type FormatModule, type NodeRef, type ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { glyphOf, glyphOfNode, LEAF_ELEMENT_GLYPH } from '../src/renderer/nodeDisplay'
import { glyphFontClass } from '../src/renderer/glyphFont'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parse(module: FormatModule, text: string): NodeStore {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  module.parse(source, store, options)
  return store
}

function named(store: NodeStore, name: string): NodeRef {
  for (let node = 0; node < store.nodeCount; node++) {
    if (store.nameOf(node) === name) return node
  }
  throw new Error(`no node named ${name}`)
}

describe('glyphOfNode (R216)', () => {
  const xml =
    '<library name="City">' +
    '<shelf><book><title>The Odyssey</title></book></shelf>' +
    '<notes>Closed on holidays.</notes>' +
    '<reviewed/>' +
    '<stamped by="me"/>' +
    '<commented><!-- only a comment --></commented>' +
    '<instructed><?render fast?></instructed>' +
    '<wrapped><![CDATA[<not an element>]]></wrapped>' +
    '<mixed>text <b>bold</b> tail</mixed>' +
    '</library>'

  it('marks exactly the elements that have element children with <>', () => {
    const store = parse(xmlFormatModule, xml)
    const expected: Record<string, string> = {
      library: '<>',
      shelf: '<>',
      book: '<>',
      mixed: '<>',
      title: LEAF_ELEMENT_GLYPH,
      notes: LEAF_ELEMENT_GLYPH,
      reviewed: LEAF_ELEMENT_GLYPH,
      // Attributes, comments, processing instructions and CDATA are not
      // element children.
      stamped: LEAF_ELEMENT_GLYPH,
      commented: LEAF_ELEMENT_GLYPH,
      instructed: LEAF_ELEMENT_GLYPH,
      wrapped: LEAF_ELEMENT_GLYPH,
      b: LEAF_ELEMENT_GLYPH
    }
    for (const [name, glyph] of Object.entries(expected)) {
      expect(glyphOfNode(store, named(store, name)), name).toBe(glyph)
    }
  })

  it('finds an element child however late it comes', () => {
    const comments = '<!-- c -->'.repeat(2000)
    const store = parse(xmlFormatModule, `<outer>${comments}<inner/></outer>`)
    expect(glyphOfNode(store, named(store, 'outer'))).toBe('<>')
    expect(glyphOfNode(store, named(store, 'inner'))).toBe(LEAF_ELEMENT_GLYPH)
  })

  it('leaves every node that is not an element on its kind glyph', () => {
    for (const [module, text] of [
      [xmlFormatModule, xml],
      [jsonFormatModule, '{"a":{"b":[1,"x",{"c":null}]},"d":true}']
    ] as const) {
      const store = parse(module, text)
      for (let node = 0; node < store.nodeCount; node++) {
        const kind = store.kindOf(node)
        if (kind === NodeKind.Element) continue
        expect(glyphOfNode(store, node)).toBe(glyphOf(kind))
      }
    }
  })

  it('draws in the monospace font, like every marker but <>', () => {
    expect(glyphFontClass(LEAF_ELEMENT_GLYPH)).toBe('glyph-mono')
  })
})
