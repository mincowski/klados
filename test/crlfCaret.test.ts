/**
 * R179 (`docs/plans/R179-crlf-caret-position.md`) — the rules that keep a
 * selection endpoint out of a CRLF pair, against plain objects.
 *
 * The extension itself needs a real browser to be worth anything (the input
 * paths that reach the gap are native arrow motion and real clicks, measured in
 * `test/crlfCaretPosition.test.tsx`); these are the branches, which need no DOM
 * and should not pay for one.
 *
 * Every case here is written with the `\r` spelled out. This defect is
 * invisible to any assertion that normalises line endings — which is exactly
 * how R168 shipped with it.
 */
import { describe, expect, it } from 'vitest'
import { EditorSelection, Text } from '@codemirror/state'
import {
  clampOutOfCrlfPair,
  clampSelectionOutOfCrlfPairs,
  crlfBackspaceRange,
  crlfDeleteRange,
  isInsideCrlfPair,
  lineBreakAt,
  lineEndingOf
} from '../src/renderer/components/Raw/crlfCaret'

/** A real CodeMirror `Text`, split the way `Raw.tsx` splits it (R168:
 * `lineSeparator` is `\n`, so the `\r` stays in its line's own text). Using the
 * real rope rather than a hand-rolled stub keeps these tests honest about what
 * `sliceString` does at a chunk boundary. */
function doc(text: string): Text {
  return Text.of(text.split('\n'))
}

describe('isInsideCrlfPair (R179)', () => {
  it('is true only between the CR and the LF', () => {
    // "alpha\r\nbeta" — the CR is at 5, the LF at 6, so 6 is the gap.
    const d = doc('alpha\r\nbeta')
    expect(d.sliceString(5, 6)).toBe('\r')
    expect(d.sliceString(6, 7)).toBe('\n')

    expect(isInsideCrlfPair(d, 5)).toBe(false) // before the CR
    expect(isInsideCrlfPair(d, 6)).toBe(true) // the gap
    expect(isInsideCrlfPair(d, 7)).toBe(false) // after the LF
  })

  it('leaves a bare LF alone', () => {
    const d = doc('alpha\nbeta')
    for (let pos = 0; pos <= d.length; pos++) {
      expect(isInsideCrlfPair(d, pos), `position ${pos}`).toBe(false)
    }
  })

  it('leaves a bare CR alone — it is ordinary text, not a line ending (R168)', () => {
    const d = doc('alpha\rbeta')
    for (let pos = 0; pos <= d.length; pos++) {
      expect(isInsideCrlfPair(d, pos), `position ${pos}`).toBe(false)
    }
  })

  it('answers the document boundaries without reading outside them', () => {
    // Both ends, asserted for the behaviour rather than for the guard that
    // implements it. Removing the explicit bounds check keeps these green,
    // because CodeMirror's rope clamps an out-of-range `sliceString` to `''` —
    // an equivalent mutation, recorded in `crlfCaret.ts` rather than left
    // looking like a branch nobody covered.
    const d = doc('\r\n')
    expect(isInsideCrlfPair(d, 0)).toBe(false)
    expect(isInsideCrlfPair(d, d.length)).toBe(false)
    expect(isInsideCrlfPair(d, 1)).toBe(true)

    const empty = doc('')
    expect(isInsideCrlfPair(empty, 0)).toBe(false)
  })

  it('judges a mixed-ending document per position, not per document', () => {
    // "a\r\nb\nc\r\n" — CRLF, then LF, then CRLF. A document-level verdict
    // would be wrong for at least one of them whichever way it went.
    const d = doc('a\r\nb\nc\r\n')
    expect(isInsideCrlfPair(d, 2)).toBe(true) // inside the first CRLF
    expect(isInsideCrlfPair(d, 4)).toBe(false) // the bare LF after "b"
    expect(isInsideCrlfPair(d, 7)).toBe(true) // inside the second CRLF
  })

  it('handles consecutive CRLF pairs, including a blank CRLF line', () => {
    // "a\r\n\r\nb": positions 2 and 4 are both gaps, and 3 is the start of the
    // blank line — a legitimate place for the caret that must not be moved.
    const d = doc('a\r\n\r\nb')
    expect(isInsideCrlfPair(d, 2)).toBe(true)
    expect(isInsideCrlfPair(d, 3)).toBe(false)
    expect(isInsideCrlfPair(d, 4)).toBe(true)
  })
})

describe('clampOutOfCrlfPair (R179)', () => {
  it('moves back to before the CR, which is where the text visibly ends', () => {
    const d = doc('alpha\r\nbeta')
    expect(clampOutOfCrlfPair(d, 6)).toBe(5)
  })

  it('leaves every other position exactly where it is', () => {
    const d = doc('alpha\r\nbeta')
    for (const pos of [0, 1, 5, 7, 8, d.length]) {
      expect(clampOutOfCrlfPair(d, pos), `position ${pos}`).toBe(pos)
    }
  })

  it('never moves a position to another line', () => {
    // The clamp is `pos - 1`, so the result is always on the line the caret was
    // already on. Moving *forward* would put it on the next line, which no
    // measured input path was asking for.
    const d = doc('a\r\nb\r\nc')
    for (let pos = 0; pos <= d.length; pos++) {
      const clamped = clampOutOfCrlfPair(d, pos)
      expect(d.lineAt(clamped).number, `position ${pos}`).toBe(d.lineAt(pos).number)
    }
  })
})

describe('clampSelectionOutOfCrlfPairs (R179)', () => {
  const d = doc('alpha\r\nbeta\r\ngamma')

  it('returns null when nothing needs moving, so the transaction is untouched', () => {
    expect(clampSelectionOutOfCrlfPairs(d, EditorSelection.single(3))).toBeNull()
    expect(clampSelectionOutOfCrlfPairs(d, EditorSelection.single(0, 5))).toBeNull()
  })

  it('moves a bare cursor out of the gap', () => {
    const clamped = clampSelectionOutOfCrlfPairs(d, EditorSelection.single(6))
    expect(clamped?.main.head).toBe(5)
    expect(clamped?.main.anchor).toBe(5)
  })

  it('moves the anchor as well as the head — a drag can strand either', () => {
    // Anchor in the gap, head elsewhere: fixing only the head would leave the
    // selection starting between the two bytes, and deleting it would split
    // the pair just as typing does.
    const anchored = clampSelectionOutOfCrlfPairs(d, EditorSelection.single(6, 9))
    expect(anchored?.main.anchor).toBe(5)
    expect(anchored?.main.head).toBe(9)

    const headed = clampSelectionOutOfCrlfPairs(d, EditorSelection.single(2, 6))
    expect(headed?.main.anchor).toBe(2)
    expect(headed?.main.head).toBe(5)
  })

  it('keeps a backwards range backwards', () => {
    // `EditorSelection.range(anchor, head)` with head < anchor is a selection
    // made right-to-left; clamping must not silently reverse it.
    const clamped = clampSelectionOutOfCrlfPairs(d, EditorSelection.single(9, 6))
    expect(clamped?.main.anchor).toBe(9)
    expect(clamped?.main.head).toBe(5)
  })

  it('handles every range, and preserves which one is main', () => {
    const selection = EditorSelection.create(
      [EditorSelection.cursor(2), EditorSelection.cursor(6), EditorSelection.cursor(12)],
      1
    )
    const clamped = clampSelectionOutOfCrlfPairs(d, selection)
    if (clamped === null) throw new Error('expected the selection to be clamped')
    expect(clamped.ranges.map((r) => r.head)).toEqual([2, 5, 11])
    expect(clamped.mainIndex).toBe(1)
  })

  it('leaves an LF-only document completely alone', () => {
    // Acceptance 6: today's behaviour is unchanged where there are no CRs.
    const lf = doc('alpha\nbeta\ngamma')
    for (let pos = 0; pos <= lf.length; pos++) {
      expect(clampSelectionOutOfCrlfPairs(lf, EditorSelection.single(pos)), `position ${pos}`).toBe(
        null
      )
    }
  })
})

describe('crlfBackspaceRange and crlfDeleteRange (R180)', () => {
  it('Backspace at the start of a line takes the whole preceding CRLF', () => {
    // Without this, native deletion removes the `\r\n`'s LF alone and leaves
    // `alpha\rbeta` — a lone CR in the middle of a line, silently.
    const d = doc('alpha\r\nbeta')
    expect(crlfBackspaceRange(d, 7)).toEqual({ from: 5, to: 7 })
  })

  it('Delete at the visible end of a line takes the whole following CRLF', () => {
    // The caret sits at 5 after R179's clamp, which makes this the common case
    // rather than an edge one.
    const d = doc('alpha\r\nbeta')
    expect(crlfDeleteRange(d, 5)).toEqual({ from: 5, to: 7 })
  })

  it('answers null for an ordinary deletion, so native behaviour handles it', () => {
    const d = doc('alpha\r\nbeta')
    // Mid-word, both directions.
    expect(crlfBackspaceRange(d, 3)).toBeNull()
    expect(crlfDeleteRange(d, 3)).toBeNull()
    // Either side of a bare LF: one unit is the whole ending, so native
    // deletion is already correct and must not be overridden.
    const lf = doc('alpha\nbeta')
    expect(crlfBackspaceRange(lf, 6)).toBeNull()
    expect(crlfDeleteRange(lf, 5)).toBeNull()
  })

  it('answers null rather than reading outside the document', () => {
    const d = doc('\r\n')
    expect(crlfBackspaceRange(d, 0)).toBeNull()
    expect(crlfBackspaceRange(d, 1)).toBeNull()
    expect(crlfDeleteRange(d, 1)).toBeNull()
    expect(crlfDeleteRange(d, d.length)).toBeNull()
    // And the one case that does match, at both ends of the same pair.
    expect(crlfBackspaceRange(d, 2)).toEqual({ from: 0, to: 2 })
    expect(crlfDeleteRange(d, 0)).toEqual({ from: 0, to: 2 })
  })

  it('does not mistake a lone CR followed by text for a pair', () => {
    const d = doc('alpha\rbeta')
    expect(crlfDeleteRange(d, 5)).toBeNull()
    expect(crlfBackspaceRange(d, 6)).toBeNull()
  })
})

describe('lineEndingOf and lineBreakAt (R181)', () => {
  it('reports a CRLF line as CRLF and an LF line as LF', () => {
    const d = doc('a\r\nb\nc')
    expect(lineEndingOf(d, 1)).toBe('\r\n')
    expect(lineEndingOf(d, 2)).toBe('\n')
  })

  it('reports the last line as having no ending', () => {
    const d = doc('a\r\nb')
    expect(d.lines).toBe(2)
    expect(lineEndingOf(d, 2)).toBeUndefined()
    // Out of range in either direction is the same answer, not a throw.
    expect(lineEndingOf(d, 0)).toBeUndefined()
    expect(lineEndingOf(d, 99)).toBeUndefined()
  })

  it('splitting a CRLF line yields a CRLF', () => {
    const d = doc('alpha\r\nbeta\r\ngamma')
    expect(lineBreakAt(d, 2)).toBe('\r\n')
  })

  it('splitting an LF line yields an LF, in the same mixed document', () => {
    // The rule is per position, not per document: a mixed file keeps its local
    // structure rather than being healed toward a dominant ending.
    const d = doc('a\r\nb\nc\r\nd')
    expect(lineBreakAt(d, 0)).toBe('\r\n') // line 1, CRLF
    expect(lineBreakAt(d, 3)).toBe('\n') // line 2, LF
    expect(lineBreakAt(d, 5)).toBe('\r\n') // line 3, CRLF
  })

  it('Enter at the very end of a CRLF file uses the line before', () => {
    // **The single most common Enter in the editor.** A document with a
    // trailing newline has an empty final line, which has no ending of its
    // own — so without the second clause every such Enter would insert an LF
    // into a CRLF file.
    const d = doc('alpha\r\nbeta\r\n')
    expect(d.lines).toBe(3)
    expect(lineEndingOf(d, 3)).toBeUndefined()
    expect(lineBreakAt(d, d.length)).toBe('\r\n')
  })

  it('falls back to LF only when the document has no line break at all', () => {
    const d = doc('no breaks here')
    expect(lineBreakAt(d, 5)).toBe('\n')
    expect(lineBreakAt(doc(''), 0)).toBe('\n')
  })
})
