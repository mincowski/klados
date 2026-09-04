/**
 * C1 — encoding and BOM through the pipeline. `runParseJob` previously used
 * the format's *declared* encoding only and never consulted `core/encoding.ts`'s
 * BOM detection, so a BOM'd document mis-parsed (see M0c-PLAN.md for the
 * measured defects). This suite pins down the fix: nothing strips a BOM,
 * spans stay absolute in the original buffer, and a BOM'd document parses
 * identically to its un-BOM'd twin modulo a constant offset.
 */
import { describe, expect, it } from 'vitest'
import type { FormatModule, NodeRef } from '../src/core/types'
import { NodeStore } from '../src/core/nodeStore'
import { Interner } from '../src/core/interner'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { xmlFormatModule } from '../src/formats/xml/index'
import { runParseJob, type ParseJobRequest } from '../src/worker/parse.worker'

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function withUtf8Bom(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(UTF8_BOM.length + bytes.length)
  out.set(UTF8_BOM, 0)
  out.set(bytes, UTF8_BOM.length)
  return out
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer as ArrayBuffer
}

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

interface FlatNode {
  kind: number
  name: string | null
  childCount: number
  spanStart: number
  spanEnd: number
}

/** Pre-order flattening, spans included so a caller can check a constant offset. */
function flatShape(store: NodeStore, root: NodeRef): FlatNode[] {
  const result: FlatNode[] = []
  const stack: NodeRef[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const children = Array.from(store.childrenOf(node))
    const span = store.spanOf(node)
    result.push({
      kind: store.kindOf(node),
      name: store.nameOf(node),
      childCount: children.length,
      spanStart: span.start,
      spanEnd: span.end
    })
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return result
}

function parseDirect(bytes: Uint8Array, format: FormatModule): NodeStore {
  const store = new NodeStore(bytes, new Interner())
  format.parse(bytes, store, OPTIONS)
  return store
}

describe('a BOM parses identically to a document with no BOM, offset by bomLength', () => {
  it.each([
    { label: 'JSON', format: jsonFormatModule, text: '{"a":1,"b":[1,2,3]}' },
    { label: 'XML', format: xmlFormatModule, text: '<a><b>1</b><c/></a>' }
  ])('$label', ({ format, text }) => {
    const plain = utf8(text)
    const bommed = withUtf8Bom(plain)
    const bomLength = UTF8_BOM.length

    const plainStore = parseDirect(plain, format)
    const bommedStore = parseDirect(bommed, format)

    const plainShape = flatShape(plainStore, 0)
    const bommedShape = flatShape(bommedStore, 0)

    expect(bommedShape.length).toBe(plainShape.length)
    for (let i = 0; i < plainShape.length; i++) {
      const p = plainShape[i]!
      const b = bommedShape[i]!
      expect(b.kind).toBe(p.kind)
      expect(b.name).toBe(p.name)
      expect(b.childCount).toBe(p.childCount)
      // The document root's own span always starts at 0 regardless of a BOM
      // (it spans the whole buffer); every other node's span is offset by
      // exactly bomLength.
      if (i === 0) {
        expect(b.spanStart).toBe(p.spanStart)
      } else {
        expect(b.spanStart).toBe(p.spanStart + bomLength)
      }
      expect(b.spanEnd).toBe(p.spanEnd + bomLength)
    }
  })
})

describe('runParseJob — BOM through the worker pipeline', () => {
  it('a UTF-8 BOM-prefixed JSON document parses to 3 nodes and 0 diagnostics', () => {
    const bytes = withUtf8Bom(utf8('{"a":1}'))
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 1,
      bytes: bufferOf(bytes),
      filename: 'x.json'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.storeBuffers.nodeCount).toBe(3)
    expect(response.diagnostics.length).toBe(0)
    expect(response.encoding).toBe('utf-8')
    expect(response.bomLength).toBe(3)
  })

  it('a UTF-8 BOM-prefixed XML document parses to 3 nodes, not 4, with no phantom Text node', () => {
    const bytes = withUtf8Bom(utf8('<?xml version="1.0"?><a><b>1</b></a>'))
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 2,
      bytes: bufferOf(bytes),
      filename: 'x.xml'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.storeBuffers.nodeCount).toBe(3)
    expect(response.diagnostics.length).toBe(0)
    expect(Array.from(response.storeBuffers.kind)).not.toContain(6) // NodeKind.Text
  })

  it('UTF-16LE input is refused with one Fatal diagnostic, not mis-parsed', () => {
    const text = '{"a":1}'
    const utf16 = new Uint8Array(UTF16LE_BOM.length + text.length * 2)
    utf16.set(UTF16LE_BOM, 0)
    for (let i = 0; i < text.length; i++) {
      utf16[UTF16LE_BOM.length + i * 2] = text.charCodeAt(i)
      utf16[UTF16LE_BOM.length + i * 2 + 1] = 0
    }
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 3,
      bytes: bufferOf(utf16),
      filename: 'x.json'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.complete).toBe(false)
    expect(response.encoding).toBe('utf-16le')
    expect(response.diagnostics.length).toBe(1)
    expect(response.diagnostics[0]!.code).toBe('klados.encoding.unsupported')
    expect(response.diagnostics[0]!.severity).toBe(2) // Severity.Fatal
  })

  it('a declared XML encoding round-trips through runParseJob when there is no BOM', () => {
    const bytes = utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 4,
      bytes: bufferOf(bytes),
      filename: 'x.xml'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.encoding).toBe('ISO-8859-1')
    expect(response.bomLength).toBe(0)
  })
})
