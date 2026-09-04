import { describe, expect, it } from 'vitest'
import { buildLineIndex, buildRowIndex, type LineIndex } from '../src/core/rowIndex'
import { parseGoToPosition } from '../src/renderer/navigation/goToPosition'

interface Doc {
  readonly bytes: Uint8Array
  readonly rowIndex: Int32Array
  readonly lineIndex: LineIndex
  readonly length: number
}

function doc(text: string, maxRowBytes = 512, stride = 1024): Doc {
  const bytes = new TextEncoder().encode(text)
  const rowIndex = buildRowIndex(bytes, maxRowBytes, [0x20])
  return {
    bytes,
    rowIndex,
    lineIndex: buildLineIndex(bytes, rowIndex, stride),
    length: bytes.length
  }
}

function go(d: Doc, input: string): ReturnType<typeof parseGoToPosition> {
  return parseGoToPosition(d.bytes, d.rowIndex, d.lineIndex, d.length, input)
}

describe('parseGoToPosition (D14)', () => {
  it('interprets input as a line number for a pretty-printed document', () => {
    const d = doc('line1\nline2\nline3\n')
    expect(go(d, '2')).toEqual({ offset: d.rowIndex[1], kind: 'line' })
  })

  it('interprets input as a byte offset for a minified document', () => {
    const d = doc('<a>' + 'x'.repeat(2000) + '</a>')
    expect(go(d, '500')).toEqual({ offset: 500, kind: 'byte' })
  })

  it('clamps a line number past the end of the document', () => {
    const d = doc('a\nb\nc\n')
    expect(go(d, '9999')!.offset).toBe(d.rowIndex[d.rowIndex.length - 1])
  })

  it('clamps a byte offset past the end of a minified document', () => {
    const d = doc('<a>' + 'x'.repeat(2000) + '</a>')
    expect(go(d, '999999')!.offset).toBe(d.length)
  })

  it('rejects non-numeric input', () => {
    const d = doc('a\nb\n')
    expect(go(d, 'abc')).toBeNull()
    expect(go(d, '')).toBeNull()
    expect(go(d, '-1')).toBeNull()
    expect(go(d, '1.5')).toBeNull()
  })

  it('treats line 1 / line 0 as the first row', () => {
    const d = doc('a\nb\nc\n')
    expect(go(d, '1')).toEqual({ offset: d.rowIndex[0], kind: 'line' })
    expect(go(d, '0')).toEqual({ offset: d.rowIndex[0], kind: 'line' })
  })

  // The bug this replaced: `rowIndex[n - 1]` treats a row as a line, which is
  // true only while no line exceeds the byte cap. One longer line and every
  // subsequent line number lands on the wrong place, cumulatively.
  it('resolves a line after a line longer than the row cap', () => {
    const long = 'x'.repeat(1200)
    const text = `one\n${long}\nthree\nfour\n`
    const d = doc(text, 512)

    // The long line alone spans three rows, so line 3 is row 5, not row 2.
    expect(d.rowIndex.length).toBeGreaterThan(d.lineIndex.lineCount)

    const third = go(d, '3')!
    expect(third.kind).toBe('line')
    expect(third.offset).toBe(text.indexOf('three'))

    const fourth = go(d, '4')!
    expect(fourth.offset).toBe(text.indexOf('four'))
  })

  // Every line start must be found regardless of which side of a checkpoint
  // boundary it falls on — a stride of 1 checkpoints every row, exercising the
  // binary search rather than the residual scan.
  it('agrees with a linear scan at every line, at any checkpoint stride', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const expected: number[] = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') expected.push(i + 1)

    for (const stride of [1, 2, 7, 64, 1024]) {
      const d = doc(text, 512, stride)
      expect(d.lineIndex.lineCount).toBe(expected.length)
      for (let line = 1; line <= expected.length; line++) {
        expect(go(d, String(line))!.offset, `line ${line} at stride ${stride}`).toBe(
          expected[line - 1]
        )
      }
    }
  })
})
