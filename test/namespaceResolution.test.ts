/**
 * **R209 removed XML namespace resolution.** This file is R134–R136's, kept
 * and rewritten rather than deleted, because it is where the next person to
 * propose namespace support will look to find out whether it was considered.
 * It was: built in R134–R136, and removed deliberately with the numbers in
 * D-101 and `docs/plans/R209-drop-namespaces.md` § 3.
 *
 * What it asserted before: that `a:price` and `b:price` bound to one URI
 * shared a resolved id, that a rebound prefix resolved position-aware, and
 * that a colon in a JSON key was never split. What it asserts now is the
 * behaviour that replaced all of that — **a name is the name the document
 * contains** — plus the two things that made the removal worth doing:
 * `fromBuffers` no longer takes state a caller can forget, and the round
 * trip carries none.
 *
 * The defect that ended the feature is `spliceSubtree` here: resolution
 * survived opening a document and not editing one, silently, because the
 * state lived outside `NodeStoreBuffers` and every path rebuilding a store
 * had to hand-carry it. Both such paths got it wrong.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { NodeRef, ParseOptions } from '../src/core/types'
import { NodeKind } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { runParseJob, type ParseJobRequest } from '../src/worker/parse.worker'
import { rehydrateParseResult } from '../src/core/parseClient'
import { spliceSubtree } from '../src/renderer/session/subtreeSplice'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function parseXml(text: string): NodeStore {
  const bytes = utf8(text)
  const store = new NodeStore(
    bytes,
    new Interner(undefined, xmlFormatModule.capabilities.hasNamespaces)
  )
  const result = xmlFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return store
}

function parseJson(text: string): NodeStore {
  const bytes = utf8(text)
  const store = new NodeStore(
    bytes,
    new Interner(undefined, jsonFormatModule.capabilities.hasNamespaces)
  )
  const result = jsonFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return store
}

/** Every Element child of `node`, in document order. */
function elementChildren(store: NodeStore, node: NodeRef): NodeRef[] {
  return [...store.childrenOf(node)].filter((c) => store.kindOf(c) === NodeKind.Element)
}

/** Node 0 is always the Document node, never the document's own root
 * element — every fixture below is one root element wrapping the shape
 * under test. */
function rootElement(store: NodeStore): NodeRef {
  return elementChildren(store, 0)[0]!
}

describe('R209 — a prefixed name is the name the document contains', () => {
  it('two prefixes bound to one URI are two distinct names', () => {
    const store = parseXml(
      '<catalog xmlns:inv="http://ex.com/i" xmlns:s="http://ex.com/i">' +
        '<inv:price>10</inv:price>' +
        '<s:price>20</s:price>' +
        '</catalog>'
    )
    const [first, second] = elementChildren(store, rootElement(store))

    expect(store.nameOf(first!)).toBe('inv:price')
    expect(store.nameOf(second!)).toBe('s:price')
    // Under R134 these shared one resolved id. The plan's § 3 measured what
    // that bought and what it cost; this is the decided answer.
    expect(store.nameIdOf(first!)).not.toBe(store.nameIdOf(second!))
  })

  it('one prefix used throughout is one name — the case that must not regress', () => {
    // **Almost every namespaced document.** R134's resolution changed
    // nothing here either, since a single prefix resolved to its own name.
    const store = parseXml(
      '<catalog xmlns:inv="http://ex.com/i">' +
        '<inv:price>10</inv:price>' +
        '<inv:price>20</inv:price>' +
        '</catalog>'
    )
    const [first, second] = elementChildren(store, rootElement(store))
    expect(store.nameIdOf(first!)).toBe(store.nameIdOf(second!))
    expect(store.nameOf(first!)).toBe('inv:price')
  })

  it('a rebound prefix is one name, not two — the R135 case, inverted', () => {
    // R135 resolved this position-aware: `p:price` under `urn:one` and under
    // `urn:two` were different resolved ids. Now the raw spelling is the
    // identity, so they are the same name in both subtrees.
    const store = parseXml(
      '<root>' +
        '<x xmlns:p="urn:one"><p:price>1</p:price></x>' +
        '<y xmlns:p="urn:two"><p:price>2</p:price></y>' +
        '</root>'
    )
    const [x, y] = elementChildren(store, rootElement(store))
    const underX = elementChildren(store, x!)[0]!
    const underY = elementChildren(store, y!)[0]!
    expect(store.nameIdOf(underX)).toBe(store.nameIdOf(underY))
    expect(store.nameOf(underX)).toBe('p:price')
  })

  it('a colon in a JSON key is still just a colon', () => {
    // R134's capability gate had to keep JSON out of namespace splitting.
    // There is no splitting to keep it out of now, but the property it was
    // protecting is worth keeping asserted: a JSON key is never interpreted.
    //
    // Walked with `childrenOf` rather than `elementChildren` — a JSON
    // property is not `NodeKind.Element`, and filtering for one silently
    // yields an empty list rather than failing, which is how the first
    // draft of this test "passed" against garbage.
    expect(jsonFormatModule.capabilities.hasNamespaces).toBe(false)
    const store = parseJson('{"a:b": 1, "c:b": 2}')
    const rootObject = [...store.childrenOf(0)][0]!
    const [first, second] = [...store.childrenOf(rootObject)]
    expect(store.nameOf(first!)).toBe('a:b')
    expect(store.nameOf(second!)).toBe('c:b')
    expect(store.nameIdOf(first!)).not.toBe(store.nameIdOf(second!))
  })
})

describe('R209 — the defect that ended the feature cannot recur', () => {
  it('names are the same before and after a real splice', () => {
    // **R209 acceptance 1.** This is the shape that hid the original defect
    // from every test R134 wrote: those built a `NodeStore` directly, and the
    // state only went missing on a path that *rebuilt* one. Before R209 the
    // two prefixes resolved to one id on open and to two different ids after
    // a one-character edit nowhere near an `xmlns`, with nothing marked
    // stale. Now they are two names throughout, which is the point — the
    // answer no longer depends on whether the document has been edited.
    const before =
      '<catalog xmlns:inv="http://ex.com/i" xmlns:s="http://ex.com/i">' +
      '<inv:price>10</inv:price>' +
      '<s:price>20</s:price>' +
      '<pad>x</pad>' +
      '</catalog>'
    const after = before.replace('<pad>x</pad>', '<pad>xy</pad>')

    const oldStore = parseXml(before)
    const [firstBefore, secondBefore] = elementChildren(oldStore, rootElement(oldStore))
    const namesBefore = [oldStore.nameOf(firstBefore!), oldStore.nameOf(secondBefore!)]
    const distinctBefore = oldStore.nameIdOf(firstBefore!) !== oldStore.nameIdOf(secondBefore!)

    const newBytes = utf8(after)
    const dirtyStart = before.indexOf('<pad>x</pad>') + '<pad>'.length
    const outcome = spliceSubtree({
      format: xmlFormatModule,
      oldStore,
      newBytes,
      interner: oldStore.interner,
      dirtyStart,
      dirtyEnd: dirtyStart + 1,
      delta: newBytes.length - utf8(before).length,
      options: OPTIONS
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const store = outcome.store
    const [firstAfter, secondAfter] = elementChildren(store, rootElement(store))
    expect([store.nameOf(firstAfter!), store.nameOf(secondAfter!)]).toEqual(namesBefore)
    expect(store.nameIdOf(firstAfter!) !== store.nameIdOf(secondAfter!)).toBe(distinctBefore)
    expect(distinctBefore).toBe(true)
  })

  it('fromBuffers takes no state a caller can forget', () => {
    // **R209 acceptance 3.** The namespace parameter was optional, and
    // `subtreeSplice.ts` omitted it — which is exactly why the defect was
    // invisible: forgetting it was not a type error. Asserted on arity so a
    // future optional parameter of the same shape fails here.
    expect(NodeStore.fromBuffers.length).toBe(3)
  })

  it('the worker round trip carries no namespace state', () => {
    // **R209 acceptance 3, the other half.** The worker's own threading was
    // the first of the two store-rebuilding paths to get this wrong; it was
    // caught in review rather than by a test, since nothing round-tripped.
    const text =
      '<catalog xmlns:inv="http://ex.com/i" xmlns:s="http://ex.com/i">' +
      '<inv:price>10</inv:price>' +
      '<s:price>20</s:price>' +
      '</catalog>'
    const bytes = utf8(text)
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 1,
      bytes: bytes.buffer.slice(0) as ArrayBuffer,
      filename: 'ns.xml'
    }
    const response = runParseJob(request, () => {})
    expect(response.type).toBe('done')
    if (response.type !== 'done') return

    expect('namespaceState' in response).toBe(false)

    const { store } = rehydrateParseResult(response)
    const [first, second] = elementChildren(store, rootElement(store))
    expect(store.nameOf(first!)).toBe('inv:price')
    expect(store.nameOf(second!)).toBe('s:price')
    expect(store.nameIdOf(first!)).not.toBe(store.nameIdOf(second!))
  })

  it('the removed surface is gone, not merely unused', () => {
    // Named individually rather than as a count: a re-added method should
    // fail here with its own name, and this list is the inventory
    // `docs/plans/R209-drop-namespaces.md` § 4 promised to remove.
    const store = parseXml('<root xmlns:a="urn:x"><a:x/></root>')
    for (const member of [
      'resolvedNameIdOf',
      'namespaceUriOf',
      'namespaceUriOfName',
      'hasNamespaceRebinding',
      'exportNamespaceState'
    ]) {
      expect(member in store).toBe(false)
    }
  })
})
