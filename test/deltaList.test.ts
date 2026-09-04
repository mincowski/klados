import { describe, expect, it } from 'vitest'
import {
  EMPTY_DELTA_LIST,
  FOLD_THRESHOLD,
  fold,
  recordDelta,
  shiftedOffset,
  shouldFold,
  type DeltaList
} from '../src/core/deltaList'
import { buildLineIndex, buildRowIndex, lineAtOffset } from '../src/core/rowIndex'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const BREAK_BYTES = [' '.charCodeAt(0)]

describe('recordDelta', () => {
  it('inserts a single entry', () => {
    const list = recordDelta(EMPTY_DELTA_LIST, 10, 3)
    expect(list).toEqual([{ position: 10, delta: 3 }])
  })

  it('keeps the list ascending by position regardless of insertion order', () => {
    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, 30, 1)
    list = recordDelta(list, 10, 2)
    list = recordDelta(list, 20, 3)
    expect(list.map((d) => d.position)).toEqual([10, 20, 30])
  })

  it('merges a second delta at the same position by summing', () => {
    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, 10, 3)
    list = recordDelta(list, 10, -1)
    expect(list).toEqual([{ position: 10, delta: 2 }])
  })

  it('drops an entry whose merged delta is exactly zero', () => {
    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, 10, 3)
    list = recordDelta(list, 10, -3)
    expect(list).toEqual([])
  })

  it('does not mutate the input list', () => {
    const list = recordDelta(EMPTY_DELTA_LIST, 10, 3)
    const before = [...list]
    recordDelta(list, 20, 5)
    expect(list).toEqual(before)
  })
})

describe('shiftedOffset', () => {
  it('returns the offset unchanged with no deltas', () => {
    expect(shiftedOffset(EMPTY_DELTA_LIST, 42)).toBe(42)
  })

  it('leaves an offset before every delta untouched', () => {
    const list = recordDelta(EMPTY_DELTA_LIST, 10, 5)
    expect(shiftedOffset(list, 5)).toBe(5)
  })

  it('applies a single delta to an offset at or after its position', () => {
    const list = recordDelta(EMPTY_DELTA_LIST, 10, 5)
    expect(shiftedOffset(list, 10)).toBe(15)
    expect(shiftedOffset(list, 20)).toBe(25)
  })

  it('accumulates every delta at or before the offset — matches a manual bulk shift', () => {
    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, 10, 5) // +5 net insertion at 10
    list = recordDelta(list, 30, -3) // -3 net deletion at 30
    list = recordDelta(list, 50, 2) // +2 net insertion at 50

    // What a full rewrite would have produced, computed independently.
    function bulkShift(offset: number): number {
      let shift = 0
      if (offset >= 10) shift += 5
      if (offset >= 30) shift -= 3
      if (offset >= 50) shift += 2
      return offset + shift
    }

    for (const offset of [0, 9, 10, 15, 29, 30, 49, 50, 100]) {
      expect(shiftedOffset(list, offset)).toBe(bulkShift(offset))
    }
  })

  it('a negative delta (deletion) shifts a later offset backward', () => {
    const list = recordDelta(EMPTY_DELTA_LIST, 10, -4)
    expect(shiftedOffset(list, 20)).toBe(16)
  })

  it("position is the edit's end, not its start — an offset inside the replaced region reads unshifted", () => {
    // An edit replacing original [10, 15) with 2 bytes: position must be
    // the region's end (15), not its start (10) — recording it at the
    // start would incorrectly shift offset 10 itself (which is exactly
    // where a sibling row/span boundary can legitimately sit, unchanged,
    // right at the edit's start).
    const list = recordDelta(EMPTY_DELTA_LIST, 15, 2 - 5)
    expect(shiftedOffset(list, 10)).toBe(10) // untouched: before the edit's end
    expect(shiftedOffset(list, 15)).toBe(12) // at/after the edit's end: shifted
    expect(shiftedOffset(list, 20)).toBe(17)
  })
})

describe('shouldFold', () => {
  it('is false at and below the threshold', () => {
    let list: DeltaList = EMPTY_DELTA_LIST
    for (let i = 0; i < FOLD_THRESHOLD; i++) list = recordDelta(list, i, 1)
    expect(list.length).toBe(FOLD_THRESHOLD)
    expect(shouldFold(list)).toBe(false)
  })

  it('is true once past the threshold', () => {
    let list: DeltaList = EMPTY_DELTA_LIST
    for (let i = 0; i < FOLD_THRESHOLD + 1; i++) list = recordDelta(list, i, 1)
    expect(shouldFold(list)).toBe(true)
  })
})

describe('fold', () => {
  it('applies every delta to each element of an Int32Array, in place', () => {
    const values = new Int32Array([0, 5, 10, 15, 20])
    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, 8, 3)
    const result = fold(values, list)
    expect(Array.from(result)).toEqual([0, 5, 13, 18, 23])
    expect(result).toBe(values) // mutated and returned, not copied
  })

  it('applies multiple accumulated deltas correctly, not just a single one', () => {
    const values = new Int32Array([0, 5, 10, 15, 20, 25])
    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, 8, 3) // +3 at/after 8
    list = recordDelta(list, 18, -2) // -2 at/after 18
    list = recordDelta(list, 23, 5) // +5 at/after 23
    const result = fold(values, list)
    // 0: unshifted. 5: unshifted. 10: +3=13. 15: +3=18.
    // 20: +3-2=21. 25: +3-2+5=31.
    expect(Array.from(result)).toEqual([0, 5, 13, 18, 21, 31])
  })

  it('is idempotent: folding an empty list (the post-fold state) is a no-op', () => {
    const values = new Int32Array([0, 5, 10])
    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, 3, 2)
    fold(values, list)
    const afterFirstFold = Array.from(values)

    // A real caller resets its own delta list to empty once folded.
    fold(values, EMPTY_DELTA_LIST)
    expect(Array.from(values)).toEqual(afterFirstFold)
  })

  it('leaves the array unchanged when the list is empty', () => {
    const values = new Int32Array([1, 2, 3])
    fold(values, EMPTY_DELTA_LIST)
    expect(Array.from(values)).toEqual([1, 2, 3])
  })
})

describe('row index and line index shift consistently with an edit (F2 acceptance)', () => {
  it('a folded row index plus a rebuilt line index agree with a from-scratch parse of the edited text', () => {
    const original = 'line one\nline two\nline three\nline four\n'
    const originalBytes = utf8(original)
    const rowIndex = buildRowIndex(originalBytes, 512, BREAK_BYTES)

    // Edit "two" -> "TWOOO" on line 2 — same line count, different length.
    const editStart = original.indexOf('two')
    const editEnd = editStart + 'two'.length
    const replacement = 'TWOOO'
    const edited = original.slice(0, editStart) + replacement + original.slice(editEnd)
    const editedBytes = utf8(edited)
    const delta = replacement.length - (editEnd - editStart)

    // `position` is the *end* of the edited region (deltaList.ts's own
    // contract) — the replaced [editStart, editEnd) has no shifted
    // position of its own, only what comes after it does.
    const list = recordDelta(EMPTY_DELTA_LIST, editEnd, delta)
    const foldedRowIndex = fold(rowIndex.slice(), list)
    // Newline count is unchanged by this edit, so the line index doesn't
    // need a delta-list shift of its own (see deltaList.ts's own comment)
    // — it's rebuilt from the (cheap, already-fast) existing builder.
    const rebuiltLineIndex = buildLineIndex(editedBytes, foldedRowIndex)

    const freshRowIndex = buildRowIndex(editedBytes, 512, BREAK_BYTES)
    const freshLineIndex = buildLineIndex(editedBytes, freshRowIndex)

    expect(Array.from(foldedRowIndex)).toEqual(Array.from(freshRowIndex))

    for (const offset of [0, 5, editStart, editStart + 2, editedBytes.length - 1]) {
      const viaFold = lineAtOffset(editedBytes, foldedRowIndex, rebuiltLineIndex, offset)
      const fresh = lineAtOffset(editedBytes, freshRowIndex, freshLineIndex, offset)
      expect(viaFold).toBe(fresh)
    }
  })

  it('agrees with a plain linear newline count, not just with itself', () => {
    const original = 'aaa\nbbb\nccc\nddd\n'
    const originalBytes = utf8(original)
    const rowIndex = buildRowIndex(originalBytes, 512, BREAK_BYTES)

    const editStart = original.indexOf('bbb')
    const editEnd = editStart + 'bbb'.length
    const replacement = 'B'
    const edited = original.slice(0, editStart) + replacement + original.slice(editEnd)
    const editedBytes = utf8(edited)
    const delta = replacement.length - (editEnd - editStart)

    const list = recordDelta(EMPTY_DELTA_LIST, editEnd, delta)
    const foldedRowIndex = fold(rowIndex.slice(), list)
    const lineIndex = buildLineIndex(editedBytes, foldedRowIndex)

    function linearLineAt(bytes: Uint8Array, offset: number): number {
      let line = 1
      for (let i = 0; i < offset; i++) if (bytes[i] === 0x0a) line++
      return line
    }

    for (let offset = 0; offset < editedBytes.length; offset += 3) {
      expect(lineAtOffset(editedBytes, foldedRowIndex, lineIndex, offset)).toBe(
        linearLineAt(editedBytes, offset)
      )
    }
  })

  it('two accumulated, non-overlapping edits fold consistently with a full rewrite', () => {
    const original = 'line one\nline two\nline three\nline four\nline five\n'
    const originalBytes = utf8(original)
    const rowIndex = buildRowIndex(originalBytes, 512, BREAK_BYTES)

    // Two independent substitutions, both computed against the pristine
    // original text — non-overlapping, so applying order doesn't matter.
    const edit1Start = original.indexOf('two')
    const edit1End = edit1Start + 'two'.length
    const edit1Replacement = 'TWOOO'
    const edit2Start = original.indexOf('four')
    const edit2End = edit2Start + 'four'.length
    const edit2Replacement = 'F'

    const edited =
      original.slice(0, edit1Start) +
      edit1Replacement +
      original.slice(edit1End, edit2Start) +
      edit2Replacement +
      original.slice(edit2End)
    const editedBytes = utf8(edited)

    let list: DeltaList = EMPTY_DELTA_LIST
    list = recordDelta(list, edit1End, edit1Replacement.length - (edit1End - edit1Start))
    list = recordDelta(list, edit2End, edit2Replacement.length - (edit2End - edit2Start))
    expect(list.length).toBe(2)

    const foldedRowIndex = fold(rowIndex.slice(), list)
    const rebuiltLineIndex = buildLineIndex(editedBytes, foldedRowIndex)

    const freshRowIndex = buildRowIndex(editedBytes, 512, BREAK_BYTES)
    const freshLineIndex = buildLineIndex(editedBytes, freshRowIndex)

    expect(Array.from(foldedRowIndex)).toEqual(Array.from(freshRowIndex))
    for (let offset = 0; offset < editedBytes.length; offset += 5) {
      expect(lineAtOffset(editedBytes, foldedRowIndex, rebuiltLineIndex, offset)).toBe(
        lineAtOffset(editedBytes, freshRowIndex, freshLineIndex, offset)
      )
    }
  })

  it('an edit that changes the newline count still folds consistently (rebuild, not shift)', () => {
    const original = 'line one\nline two\nline three\n'
    const originalBytes = utf8(original)
    const rowIndex = buildRowIndex(originalBytes, 512, BREAK_BYTES)

    // Replace "two" with "two-a\nand-b" — inserts a newline, adding a row/line.
    const editStart = original.indexOf('two')
    const editEnd = editStart + 'two'.length
    const replacement = 'two-a\nand-b'
    const edited = original.slice(0, editStart) + replacement + original.slice(editEnd)
    const editedBytes = utf8(edited)
    const delta = replacement.length - (editEnd - editStart)

    const list = recordDelta(EMPTY_DELTA_LIST, editEnd, delta)
    const foldedRowIndex = fold(rowIndex.slice(), list)
    // The folded row index itself does NOT gain a new row for the inserted
    // newline — fold only shifts existing entries, it cannot invent a new
    // one. This is exactly why an edit that changes row/line topology needs
    // more than this module alone (F3/F4's subtree splice or a full
    // reparse) — documented here as confirming the boundary, not a defect.
    const freshRowIndex = buildRowIndex(editedBytes, 512, BREAK_BYTES)
    expect(foldedRowIndex.length).not.toBe(freshRowIndex.length)
  })
})
