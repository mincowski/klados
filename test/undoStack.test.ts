import { describe, expect, it } from 'vitest'
import type { Patch } from '../src/renderer/session/documentEdits'
import {
  canRedo,
  canUndo,
  EMPTY_UNDO_STACK,
  inversePatchOf,
  pushEntry,
  recordedSelectionOf,
  redoStep,
  undoStep,
  type UndoEntry
} from '../src/renderer/session/undoStack'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const NO_SELECTION_ENTRY: UndoEntry['selectionBefore'] = { path: [], caretOffset: 0 }

function entry(patches: readonly Patch[], inverses: readonly Patch[]): UndoEntry {
  return {
    patches,
    inverses,
    selectionBefore: NO_SELECTION_ENTRY,
    selectionAfter: NO_SELECTION_ENTRY,
    independent: false
  }
}

describe('inversePatchOf', () => {
  it('computes a patch that restores the bytes a forward patch replaced', () => {
    const before = utf8('hello world')
    const patch: Patch = { start: 6, end: 11, replacement: utf8('there') }
    const inverse = inversePatchOf(before, patch)
    expect(inverse).toEqual({ start: 6, end: 11, replacement: utf8('world') })
  })

  it('round-trips: applying the patch then the inverse restores the original bytes', () => {
    const before = utf8('the quick fox')
    const patch: Patch = { start: 4, end: 9, replacement: utf8('slow') }
    const inverse = inversePatchOf(before, patch)

    // Manual splice, mirroring documentEdits.ts's applyPatch shape.
    function splice(bytes: Uint8Array, p: Patch): Uint8Array {
      const out = new Uint8Array(p.start + p.replacement.length + (bytes.length - p.end))
      out.set(bytes.subarray(0, p.start), 0)
      out.set(p.replacement, p.start)
      out.set(bytes.subarray(p.end), p.start + p.replacement.length)
      return out
    }

    const after = splice(before, patch)
    const restored = splice(after, inverse)
    expect(restored).toEqual(before)
  })

  it('handles a pure insertion (empty original range)', () => {
    const before = utf8('ac')
    const patch: Patch = { start: 1, end: 1, replacement: utf8('b') }
    const inverse = inversePatchOf(before, patch)
    expect(inverse).toEqual({ start: 1, end: 2, replacement: utf8('') })
  })

  it('handles a pure deletion (empty replacement)', () => {
    const before = utf8('abc')
    const patch: Patch = { start: 1, end: 2, replacement: utf8('') }
    const inverse = inversePatchOf(before, patch)
    expect(inverse).toEqual({ start: 1, end: 1, replacement: utf8('b') })
  })
})

describe('recordedSelectionOf', () => {
  it('records an empty path for NO_SELECTION without calling pathOf', () => {
    let called = false
    const result = recordedSelectionOf(-1, 42, () => {
      called = true
      return []
    })
    expect(result).toEqual({ path: [], caretOffset: 42 })
    expect(called).toBe(false)
  })

  it('defers to pathOf for a real node', () => {
    const fakePath = [{ node: 3 }] as unknown as ReturnType<
      Parameters<typeof recordedSelectionOf>[2]
    >
    const result = recordedSelectionOf(3, 10, () => fakePath)
    expect(result).toEqual({ path: fakePath, caretOffset: 10 })
  })
})

describe('pushEntry / undoStep / redoStep', () => {
  it('starts with nothing undoable or redoable', () => {
    expect(canUndo(EMPTY_UNDO_STACK)).toBe(false)
    expect(canRedo(EMPTY_UNDO_STACK)).toBe(false)
  })

  it('a pushed entry becomes undoable, not redoable', () => {
    const e = entry(
      [{ start: 0, end: 0, replacement: utf8('x') }],
      [{ start: 0, end: 1, replacement: utf8('') }]
    )
    const state = pushEntry(EMPTY_UNDO_STACK, e, 100)
    expect(canUndo(state)).toBe(true)
    expect(canRedo(state)).toBe(false)
  })

  it('undo then redo returns to the same stack position', () => {
    const e = entry(
      [{ start: 0, end: 0, replacement: utf8('x') }],
      [{ start: 0, end: 1, replacement: utf8('') }]
    )
    const pushed = pushEntry(EMPTY_UNDO_STACK, e, 100)

    const undone = undoStep(pushed)!
    expect(undone.entry).toBe(e)
    expect(canUndo(undone.state)).toBe(false)
    expect(canRedo(undone.state)).toBe(true)

    const redone = redoStep(undone.state)!
    expect(redone.entry).toBe(e)
    expect(redone.state).toEqual(pushed)
  })

  it('undoStep returns null with nothing to undo', () => {
    expect(undoStep(EMPTY_UNDO_STACK)).toBeNull()
  })

  it('redoStep returns null with nothing to redo', () => {
    expect(redoStep(EMPTY_UNDO_STACK)).toBeNull()
  })

  it('a burst of many patches is still one entry — undo restores all of it at once', () => {
    const e = entry(
      [
        { start: 0, end: 0, replacement: utf8('a') },
        { start: 1, end: 1, replacement: utf8('b') },
        { start: 2, end: 2, replacement: utf8('c') }
      ],
      [
        { start: 0, end: 1, replacement: utf8('') },
        { start: 1, end: 2, replacement: utf8('') },
        { start: 2, end: 3, replacement: utf8('') }
      ]
    )
    const state = pushEntry(EMPTY_UNDO_STACK, e, 100)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]!.patches).toHaveLength(3)
    const undone = undoStep(state)!
    expect(canUndo(undone.state)).toBe(false) // the whole burst undone in one step
  })

  it('pushing after an undo discards the redo-able entries — the standard branch-off rule', () => {
    const e1 = entry(
      [{ start: 0, end: 0, replacement: utf8('a') }],
      [{ start: 0, end: 1, replacement: utf8('') }]
    )
    const e2 = entry(
      [{ start: 1, end: 1, replacement: utf8('b') }],
      [{ start: 1, end: 2, replacement: utf8('') }]
    )
    const e3 = entry(
      [{ start: 2, end: 2, replacement: utf8('c') }],
      [{ start: 2, end: 3, replacement: utf8('') }]
    )

    let state = pushEntry(EMPTY_UNDO_STACK, e1, 100)
    state = pushEntry(state, e2, 100)
    const undone = undoStep(state)!.state // back to right after e1
    const branched = pushEntry(undone, e3, 100)

    expect(branched.entries).toEqual([e1, e3])
    expect(canRedo(branched)).toBe(false)
  })

  it('exceeding maxDepth drops the oldest entry, never the one just pushed', () => {
    const e1 = entry(
      [{ start: 0, end: 0, replacement: utf8('a') }],
      [{ start: 0, end: 1, replacement: utf8('') }]
    )
    const e2 = entry(
      [{ start: 1, end: 1, replacement: utf8('b') }],
      [{ start: 1, end: 2, replacement: utf8('') }]
    )
    const e3 = entry(
      [{ start: 2, end: 2, replacement: utf8('c') }],
      [{ start: 2, end: 3, replacement: utf8('') }]
    )

    let state = pushEntry(EMPTY_UNDO_STACK, e1, 2)
    state = pushEntry(state, e2, 2)
    state = pushEntry(state, e3, 2)

    expect(state.entries).toEqual([e2, e3])
    expect(state.index).toBe(2)
  })
})
