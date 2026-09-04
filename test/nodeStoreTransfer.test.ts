import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore, type NodeStoreBuffers } from '../src/core/nodeStore'
import { NodeKind, type ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

describe('NodeStore export/hydrate (B11 worker transfer)', () => {
  it('reconstructs an equivalent, fully queryable store from exported buffers', () => {
    const text = '{"a":1,"b":{"c":[1,2,3]},"d":"hi"}'
    const source = utf8(text)
    const interner = new Interner()
    const store = new NodeStore(source, interner)
    jsonFormatModule.parse(source, store, options)

    const storeBuffers = store.exportBuffers()
    const internerBuffers = interner.exportBuffers()

    const rehydratedInterner = Interner.fromBuffers(
      internerBuffers.nameBytes,
      internerBuffers.starts,
      internerBuffers.ends
    )
    const rehydrated = NodeStore.fromBuffers(source, rehydratedInterner, storeBuffers)

    expect(rehydrated.nodeCount).toBe(store.nodeCount)
    for (let node = 0; node < store.nodeCount; node++) {
      expect(rehydrated.kindOf(node)).toBe(store.kindOf(node))
      expect(rehydrated.nameOf(node)).toBe(store.nameOf(node))
      expect(rehydrated.parentOf(node)).toBe(store.parentOf(node))
      expect(rehydrated.firstChildOf(node)).toBe(store.firstChildOf(node))
      expect(rehydrated.spanOf(node)).toEqual(store.spanOf(node))
      expect(rehydrated.ownValueOf(node)).toEqual(store.ownValueOf(node))
    }
  })

  it('the rehydrated interner can still intern new names', () => {
    const bytes = utf8('name')
    const interner = new Interner()
    const id = interner.intern(bytes, 0, bytes.length)
    const buffers = interner.exportBuffers()

    const rehydrated = Interner.fromBuffers(buffers.nameBytes, buffers.starts, buffers.ends)
    expect(rehydrated.text(id)).toBe('name')

    const other = utf8('other')
    const newId = rehydrated.intern(other, 0, other.length)
    expect(rehydrated.text(newId)).toBe('other')
    // Re-interning the original bytes still returns the original id.
    expect(rehydrated.intern(bytes, 0, bytes.length)).toBe(id)
  })

  it('exported buffers are standalone copies, not views into the live store', () => {
    const source = utf8('{"a":1}')
    const store = new NodeStore(source, new Interner())
    jsonFormatModule.parse(source, store, options)
    const buffers = store.exportBuffers()

    // Growing the live store further must not retroactively change what was
    // already exported — otherwise a transfer would race the next parse.
    const before = buffers.kind[0]
    const scratch = new NodeStore(utf8('0'.repeat(20000)), new Interner(), 2)
    for (let i = 0; i < 5000; i++) {
      const n = scratch.openNode(NodeKind.Scalar, i, i, i)
      scratch.closeNode(n, i + 1)
    }
    expect(buffers.kind[0]).toBe(before)
  })

  // M5-PLAN.md H2c: exportBuffers() now reassigns the store's own fields
  // to the trimmed slices (releasing the oversized originals as it goes,
  // rather than holding all fifteen originals and all fifteen copies at
  // once) — which makes growing the *same* store afterward a real
  // question, not just growing an unrelated one. `growNodesIfNeeded`
  // always reallocates into a fresh array rather than mutating in place,
  // even when capacity already equals `count` exactly, so this must stay
  // just as safe as growing any other store — assert it directly rather
  // than only against an unrelated scratch store.
  it('growing the same store after exportBuffers does not corrupt the already-exported buffers', () => {
    const source = utf8('{"a":1}')
    const store = new NodeStore(source, new Interner())
    jsonFormatModule.parse(source, store, options)
    const buffers = store.exportBuffers()
    const exportedKindBefore = Array.from(buffers.kind)
    const exportedSpanStartBefore = Array.from(buffers.spanStart)

    for (let i = 0; i < 5000; i++) {
      const n = store.openNode(NodeKind.Scalar, i, i, i)
      store.closeNode(n, i + 1)
    }

    expect(Array.from(buffers.kind)).toEqual(exportedKindBefore)
    expect(Array.from(buffers.spanStart)).toEqual(exportedSpanStartBefore)
    // The store itself grew correctly — its own view is unaffected by what
    // was already handed out.
    expect(store.nodeCount).toBe(buffers.nodeCount + 5000)
  })

  it('fromBuffers allocates nothing beyond the buffers handed to it (C3)', () => {
    // Every array below is about to be overwritten wholesale by
    // `fromBuffers` — sizing the constructor's own scratch allocation at
    // `nodeCount` just to discard it immediately cost ~54 bytes/node before
    // the fix (~356 MB thrown away for cars-200mb.xml's 6.6M nodes).
    const nodeCount = 1_000_000
    const buffers: NodeStoreBuffers = {
      kind: new Uint8Array(nodeCount),
      nameId: new Int32Array(nodeCount),
      valueStart: new Int32Array(nodeCount),
      valueEnd: new Int32Array(nodeCount),
      spanStart: new Int32Array(nodeCount),
      spanEnd: new Int32Array(nodeCount),
      parent: new Int32Array(nodeCount),
      firstChild: new Int32Array(nodeCount),
      nextSibling: new Int32Array(nodeCount),
      prevSibling: new Int32Array(nodeCount),
      flags: new Uint8Array(nodeCount),
      attrOwner: new Int32Array(0),
      attrNameId: new Int32Array(0),
      attrValueStart: new Int32Array(0),
      attrValueEnd: new Int32Array(0),
      nodeCount,
      attrCount: 0
    }
    const source = new Uint8Array(1)
    const interner = new Interner()

    global.gc?.()
    const before = process.memoryUsage().external
    const store = NodeStore.fromBuffers(source, interner, buffers)
    const after = process.memoryUsage().external

    expect(store.nodeCount).toBe(nodeCount)
    expect(after - before).toBeLessThan(1024 * 1024)
  })
})
