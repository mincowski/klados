import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { computeMemoryBudget } from '../src/renderer/components/StatusBar/memoryBudget'
import type { OpenDocument } from '../src/renderer/session/documentSession'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function openDocumentFor(
  text: string,
  undoOverrides: { undoBytes?: number; undoEntryCount?: number } = {}
): OpenDocument {
  const source = utf8(text)
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  jsonFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    jsonFormatModule.capabilities.rowBreakBytes
  )
  const lineIndex = buildLineIndex(source, rowIndex)
  const nameIndex = buildNameIndex(store, interner.size)
  return {
    filePath: 'C:/docs/data.json',
    fileName: 'data.json',
    store,
    sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
    rowIndex,
    lineIndex,
    nameIndex,
    diagnostics: store.diagnostics,
    complete: true,
    formatId: 'json',
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
    undoBytes: undoOverrides.undoBytes ?? 0,
    undoEntryCount: undoOverrides.undoEntryCount ?? 0,
    pendingSpanDeltas: EMPTY_DELTA_LIST,
    // R100: this fixture predates the field; a freshly opened document
    // has had no external rewrite yet.
    externalRewrites: 0
  }
}

describe('Interner.packedMemoryBytes (M5-PLAN.md H9)', () => {
  it('matches an independently-computed sum of its own exported buffers', () => {
    const interner = new Interner()
    interner.intern(utf8('alpha'), 0, 5)
    interner.intern(utf8('beta'), 0, 4)
    interner.intern(utf8('gamma'), 0, 5)

    const buffers = interner.exportBuffers()
    const expected =
      buffers.nameBytes.byteLength + buffers.starts.byteLength + buffers.ends.byteLength
    expect(interner.packedMemoryBytes).toBe(expected)
  })

  it('is zero for an empty interner', () => {
    expect(new Interner().packedMemoryBytes).toBe(0)
  })
})

describe('computeMemoryBudget (M5-PLAN.md H9)', () => {
  it('matches an independently-computed sum of every component', () => {
    const document = openDocumentFor('{"a":1,"b":{"c":[1,2,3]},"d":"hello world"}')
    const budget = computeMemoryBudget(document)

    const storeBuffers = document.store.exportBuffers()
    let expectedNodeStoreBytes = 0
    for (const value of Object.values(storeBuffers)) {
      if (ArrayBuffer.isView(value)) expectedNodeStoreBytes += value.byteLength
    }
    const internerBuffers = document.store.interner.exportBuffers()
    const expectedInternerBytes =
      internerBuffers.nameBytes.byteLength +
      internerBuffers.starts.byteLength +
      internerBuffers.ends.byteLength

    expect(budget.sourceBufferBytes).toBe(document.sourceBuffer.bytes.length)
    expect(budget.nodeStoreBytes).toBe(expectedNodeStoreBytes)
    expect(budget.rowIndexBytes).toBe(document.rowIndex.byteLength)
    expect(budget.lineIndexBytes).toBe(document.lineIndex.checkpoints.byteLength)
    expect(budget.nameIndexBytes).toBe(
      document.nameIndex.starts.byteLength + document.nameIndex.nodes.byteLength
    )
    expect(budget.internerBytes).toBe(expectedInternerBytes)
    expect(budget.undoBytes).toBe(0)
    expect(budget.undoEntryCount).toBe(0)

    const expectedTotal =
      budget.sourceBufferBytes +
      budget.nodeStoreBytes +
      budget.rowIndexBytes +
      budget.lineIndexBytes +
      budget.nameIndexBytes +
      budget.internerBytes +
      budget.undoBytes
    expect(budget.totalBytes).toBe(expectedTotal)
  })

  it('grows with document size', () => {
    const small = computeMemoryBudget(openDocumentFor('{"a":1}'))
    const large = computeMemoryBudget(
      openDocumentFor(`{${Array.from({ length: 200 }, (_, i) => `"k${i}":${i}`).join(',')}}`)
    )
    expect(large.totalBytes).toBeGreaterThan(small.totalBytes)
  })

  // M5f-PLAN.md §3a: the regression guard for the whole point of this task
  // — before R12, `undoBytes` didn't exist and the total was wrong by
  // exactly this much whenever the undo stack held anything.
  it('counts undo history in the total, not just the row it feeds', () => {
    const withoutUndo = computeMemoryBudget(openDocumentFor('{"a":1}'))
    const withUndo = computeMemoryBudget(
      openDocumentFor('{"a":1}', { undoBytes: 1024, undoEntryCount: 3 })
    )
    expect(withUndo.undoBytes).toBe(1024)
    expect(withUndo.undoEntryCount).toBe(3)
    expect(withUndo.totalBytes).toBe(withoutUndo.totalBytes + 1024)
  })
})
