import { describe, expect, it } from 'vitest'
import {
  buildLineIndex,
  buildRowIndex,
  estimateRowCount,
  incrementalRowIndex,
  lineAtOffset,
  offsetOfLine,
  rowAt
} from '../src/core/rowIndex'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const XML_BREAK_BYTES = ['>', ' '].map((c) => c.charCodeAt(0))

describe('buildRowIndex', () => {
  it('yields one row per line for a file with normal lines', () => {
    const text = 'line one\nline two\nline three\n'
    const bytes = utf8(text)
    const index = buildRowIndex(bytes, 512, XML_BREAK_BYTES)
    expect(index.length).toBe(3)
    expect(index[0]).toBe(0)
    expect(index[1]).toBe(text.indexOf('line two'))
    expect(index[2]).toBe(text.indexOf('line three'))
  })

  it('yields ceil(size / maxRowBytes) rows, within 5%, for a single 10 MB line', () => {
    const size = 10 * 1024 * 1024
    const bytes = new Uint8Array(size).fill('a'.charCodeAt(0))
    const maxRowBytes = 512
    const index = buildRowIndex(bytes, maxRowBytes, XML_BREAK_BYTES)
    const expected = Math.ceil(size / maxRowBytes)
    expect(index.length).toBeGreaterThanOrEqual(expected * 0.95)
    expect(index.length).toBeLessThanOrEqual(expected * 1.05)
  })

  it('never starts a row mid-character in a CJK fixture', () => {
    // Repeating 3-byte UTF-8 characters so a naive byte-N cut lands mid-char
    // unless snapToCharBoundary is applied.
    const text = '中'.repeat(2000)
    const bytes = utf8(text)
    const index = buildRowIndex(bytes, 100, [])
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (let i = 0; i < index.length - 1; i++) {
      const start = index[i]!
      const end = index[i + 1]!
      expect(() => decoder.decode(bytes.subarray(start, end))).not.toThrow()
    }
  })

  it('prefers a nearby break byte over cutting mid-token', () => {
    // A space sits 2 bytes before the 10-byte hard limit; the row should end
    // just after it rather than splitting the following token.
    const text = '1234567 8901234567890'
    const bytes = utf8(text)
    const index = buildRowIndex(bytes, 10, [' '.charCodeAt(0)])
    expect(index.length).toBeGreaterThan(1)
    const firstRowEnd = index[1]!
    expect(bytes[firstRowEnd - 1]).toBe(' '.charCodeAt(0))
    expect(firstRowEnd).toBe(text.indexOf(' ') + 1)
  })

  it('produces a single row for content shorter than maxRowBytes', () => {
    const bytes = utf8('short')
    const index = buildRowIndex(bytes, 512, XML_BREAK_BYTES)
    expect(Array.from(index)).toEqual([0])
  })
})

// D0.3 — the estimate feeding the initial Int32Array capacity. Before this,
// `bytes.length / maxRowBytes` was 19x under on pretty-printed input,
// driving the growable array through enough doublings that the transient
// peak measured 2.7x the final result on a 200 MB fixture.
describe('estimateRowCount', () => {
  it('is within 2x of the true row count for pretty-printed, one-record-per-line input', () => {
    const record = '  <car make="Ford" model="Fiesta" year="2020"/>\n'
    const bytes = utf8(record.repeat(20_000))
    const trueRows = buildRowIndex(bytes, 512, XML_BREAK_BYTES).length
    const estimate = estimateRowCount(bytes, 512, XML_BREAK_BYTES)
    expect(estimate).toBeGreaterThanOrEqual(trueRows / 2)
    expect(estimate).toBeLessThanOrEqual(trueRows * 2)
  })

  it('is within 2x of the true row count for minified input', () => {
    const bytes = utf8('{"a":1,"b":2,"c":[1,2,3,4,5]},'.repeat(50_000))
    const trueRows = buildRowIndex(bytes, 512, []).length
    const estimate = estimateRowCount(bytes, 512, [])
    expect(estimate).toBeGreaterThanOrEqual(trueRows / 2)
    expect(estimate).toBeLessThanOrEqual(trueRows * 2)
  })

  it('never estimates below the structural floor bytes.length / maxRowBytes', () => {
    const bytes = utf8('x'.repeat(1000))
    const estimate = estimateRowCount(bytes, 512, [])
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(bytes.length / 512))
  })

  it('clamps the upper bound to bytes.length / 16 when the sample is unrepresentative', () => {
    // A newline-dense header (many tiny rows) followed by a minified body —
    // sampling only the header would wildly overestimate the whole file.
    const header = '\n'.repeat(256 * 1024)
    const body = 'x'.repeat(10 * 1024 * 1024)
    const bytes = utf8(header + body)
    const estimate = estimateRowCount(bytes, 512, [])
    expect(estimate).toBeLessThanOrEqual(Math.ceil(bytes.length / 16))
  })
})

describe('buildRowIndex — result correctness is unaffected by the sampling estimate', () => {
  it('returns the same offsets regardless of estimate accuracy (B7 unmodified)', () => {
    const text = 'line one\nline two\nline three\n'
    const bytes = utf8(text)
    const index = buildRowIndex(bytes, 512, XML_BREAK_BYTES)
    expect(Array.from(index)).toEqual([0, text.indexOf('line two'), text.indexOf('line three')])
  })
})

describe('rowAt', () => {
  it('agrees with a linear scan across 1000 random offsets', () => {
    const size = 200 * 1024
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = i % 97 === 0 ? 0x0a : 'x'.charCodeAt(0)
    const index = buildRowIndex(bytes, 256, XML_BREAK_BYTES)

    function linearRowAt(offset: number): number {
      let row = 0
      for (let i = 1; i < index.length; i++) {
        if (index[i]! <= offset) row = i
        else break
      }
      return row
    }

    let seed = 0x2f6e2b1
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    for (let i = 0; i < 1000; i++) {
      const offset = Math.floor(rand() * size)
      expect(rowAt(index, offset)).toBe(linearRowAt(offset))
    }
  })

  it('returns 0 for offset 0', () => {
    const index = buildRowIndex(utf8('a\nb\nc'), 512, [])
    expect(rowAt(index, 0)).toBe(0)
  })

  it('returns the last row for an offset past the final row start', () => {
    const bytes = utf8('a\nb\nc')
    const index = buildRowIndex(bytes, 512, [])
    expect(rowAt(index, bytes.length - 1)).toBe(index.length - 1)
  })
})

// ---------------------------------------------------------------------------
// Line index — the rank structure that makes line numbers exact without a
// second index (see rowIndex.ts's own note on why row number != line number).

describe('buildLineIndex', () => {
  it('counts addressable lines, with no trailing empty line for a final newline', () => {
    for (const [text, lines] of [
      ['', 1],
      ['a', 1],
      ['a\n', 1],
      ['a\nb', 2],
      ['a\nb\n', 2],
      ['\n\n\n', 3]
    ] as const) {
      const bytes = utf8(text)
      const index = buildLineIndex(bytes, buildRowIndex(bytes, 512, []))
      expect(index.lineCount, JSON.stringify(text)).toBe(lines)
    }
  })

  it('counts lines, not rows, when a line exceeds the row cap', () => {
    const bytes = utf8(`one\n${'x'.repeat(1200)}\nthree\n`)
    const rowIndex = buildRowIndex(bytes, 512, [])
    const lineIndex = buildLineIndex(bytes, rowIndex)
    expect(lineIndex.lineCount).toBe(3)
    // The long line spans several rows — which is exactly the case where
    // treating a row number as a line number drifts.
    expect(rowIndex.length).toBeGreaterThan(lineIndex.lineCount)
  })

  it('a checkpoint every row and a checkpoint every 1024 rows agree', () => {
    const bytes = utf8(Array.from({ length: 500 }, (_, i) => `row ${i}`).join('\n'))
    const rowIndex = buildRowIndex(bytes, 512, [])
    const dense = buildLineIndex(bytes, rowIndex, 1)
    const sparse = buildLineIndex(bytes, rowIndex, 1024)

    expect(dense.lineCount).toBe(sparse.lineCount)
    for (let offset = 0; offset < bytes.length; offset += 7) {
      expect(lineAtOffset(bytes, rowIndex, dense, offset)).toBe(
        lineAtOffset(bytes, rowIndex, sparse, offset)
      )
    }
  })
})

describe('lineAtOffset / offsetOfLine', () => {
  it('agrees with a linear newline count at every offset', () => {
    const text = 'alpha\nbeta\n\ngamma\ndelta'
    const bytes = utf8(text)
    const rowIndex = buildRowIndex(bytes, 512, [])
    const lineIndex = buildLineIndex(bytes, rowIndex, 2)

    for (let offset = 0; offset < bytes.length; offset++) {
      // Newlines strictly before `offset`: the newline that ends a line
      // belongs to the line it terminates, not the one it precedes, which is
      // what the row rule already encodes.
      let expected = 1
      for (let i = 0; i < offset; i++) if (text[i] === '\n') expected++
      expect(lineAtOffset(bytes, rowIndex, lineIndex, offset), `offset ${offset}`).toBe(expected)
    }
  })

  it('round-trips: the offset of line N is on line N', () => {
    const bytes = utf8(`one\n${'x'.repeat(1500)}\nthree\nfour\nfive\n`)
    const rowIndex = buildRowIndex(bytes, 512, [])
    const lineIndex = buildLineIndex(bytes, rowIndex, 3)

    for (let line = 1; line <= lineIndex.lineCount; line++) {
      const offset = offsetOfLine(bytes, rowIndex, lineIndex, line)
      expect(lineAtOffset(bytes, rowIndex, lineIndex, offset), `line ${line}`).toBe(line)
    }
  })

  it('checkpoints cost a fraction of a second line index', () => {
    // 40,000 short lines: a second Int32Array of line starts would be 160 KB,
    // the stride-1024 checkpoints are 160 bytes. The ratio is the whole point.
    const bytes = utf8(Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join('\n'))
    const rowIndex = buildRowIndex(bytes, 512, [])
    const lineIndex = buildLineIndex(bytes, rowIndex)

    expect(lineIndex.lineCount).toBe(40_000)
    expect(lineIndex.checkpoints.byteLength * 100).toBeLessThan(lineIndex.lineCount * 4)
  })
})

// M5-PLAN.md H2b — the incremental row index must be element-for-element
// identical to a full rebuild of the post-edit buffer, for every edit shape,
// including the two `fold` alone gets wrong: an edit that inserts a newline
// and one that deletes one (test/deltaList.test.ts pins the same boundary
// for `fold`; this is the same boundary for the row index).
describe('incrementalRowIndex', () => {
  function checkEdit(
    oldText: string,
    start: number,
    end: number,
    replacement: string,
    maxRowBytes = 512,
    breakBytes: readonly number[] = XML_BREAK_BYTES
  ): void {
    const oldBytes = utf8(oldText)
    const oldRowIndex = buildRowIndex(oldBytes, maxRowBytes, breakBytes)
    const newText = oldText.slice(0, start) + replacement + oldText.slice(end)
    const newBytes = utf8(newText)
    // `newBytes.length - oldBytes.length`, the document's net length change —
    // NOT `newBytes.length - (end - start)`, which this helper used to
    // compute. That produced a `delta` so large that `incrementalRowIndex`'s
    // realignment check (`oldCandidate = next - delta >= dirtyEnd`) could
    // never be satisfied, so **every test in this describe block silently
    // exercised only the scan-to-EOF fallback** and never the tail-reuse
    // path that is the entire point of H2b. The results were still correct,
    // for the wrong reason. `documentSession.ts`'s `trySpliceReparse` always
    // passed the real net delta, so production ran the untested path.
    const delta = newBytes.length - oldBytes.length

    const incremental = incrementalRowIndex(
      oldRowIndex,
      newBytes,
      start,
      end,
      delta,
      maxRowBytes,
      breakBytes
    )
    const expected = buildRowIndex(newBytes, maxRowBytes, breakBytes)
    expect(Array.from(incremental)).toEqual(Array.from(expected))
  }

  it('matches a full rebuild for an edit that keeps the row count constant', () => {
    checkEdit('line one\nline two\nline three\n', 5, 8, 'ONE')
  })

  it('matches a full rebuild for an edit that inserts a newline', () => {
    checkEdit('line one\nline two\nline three\n', 5, 8, 'ONE\nMORE')
  })

  it('matches a full rebuild for an edit that deletes a newline', () => {
    checkEdit('line one\nline two\nline three\n', 8, 9, '')
  })

  it('matches a full rebuild for an edit that deletes several rows worth of newlines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `row ${i}`).join('\n')
    checkEdit(text, text.indexOf('row 5'), text.indexOf('row 40'), 'replaced')
  })

  it('matches a full rebuild for an edit near the very end of the document', () => {
    const text = 'alpha\nbeta\ngamma\n'
    checkEdit(text, text.length - 1, text.length, '\nextra\n')
  })

  it('matches a full rebuild for an edit at the very start of the document', () => {
    checkEdit('alpha\nbeta\ngamma\n', 0, 0, 'PREFIX\n')
  })

  it('matches a full rebuild when the edit crosses a hard maxRowBytes cut', () => {
    const text = 'x'.repeat(2000)
    checkEdit(text, 500, 520, 'y'.repeat(30), 100, [])
  })

  it('matches a full rebuild for a large edit deep inside a large document', () => {
    const record = '<car make="Ford" model="Fiesta" year="2020"/>\n'
    const text = record.repeat(5000)
    const start = text.indexOf(record.repeat(1)) + 2000 * record.length
    checkEdit(text, start, start + record.length * 10, 'REPLACED\n'.repeat(3))
  })

  it('matches a full rebuild for a zero-width insertion mid-row, not at a boundary', () => {
    checkEdit('line one\nline two\nline three\n', 12, 12, 'X')
  })

  // A minified, newline-free document never gives the re-scan a `\n` to
  // resync against — every cut is a hard maxRowBytes cut whose position
  // depends on distance since the previous cut, so realignment can fail
  // all the way to EOF (this function's own doc comment). Still exact,
  // just without the saving — assert the "still exact" half directly.
  it('matches a full rebuild for an edit in a minified, newline-free document', () => {
    const text = '{"a":1,"b":2,"c":[1,2,3,4,5]},'.repeat(500)
    checkEdit(text, 100, 105, 'XXXXXXXXXXXX', 64, [])
  })

  // The tail-reuse path specifically: a long, newline-rich document where the
  // re-scan realigns almost immediately and nearly every row is reused
  // shifted. Worth its own test because every case above happens to realign
  // late or not at all, so without this the optimization H2b exists for has
  // no direct coverage — which is exactly how the `delta` bug in `checkEdit`
  // above went unnoticed.
  it('reuses the shifted tail and still matches a full rebuild', () => {
    const text = 'line\n'.repeat(5000)
    checkEdit(text, 10, 15, 'LONGER LINE\n')
  })

  // An edit landing inside the *previous* row's cut window. A row decides
  // where it ends via `findBreak`, which scans backward from `rowStart +
  // maxRowBytes` for a break byte, so an edit a few bytes before a hard cut
  // can move that cut — and therefore move the start of the row that
  // contains the edit. Beginning the re-scan at the containing row kept the
  // old, now-wrong boundary.
  //
  // The concrete case below (found by differential fuzzing, then minimized):
  // rows fall at 0 and 62, because the last break byte in row 0's backward
  // scan window is the `>` at 61. Inserting a single space at 62 puts a
  // *later* break byte in that same window, so row 0 now ends at 63 — a row
  // boundary moving because of an edit that is not inside that row at all.
  it('matches a full rebuild when the edit moves the preceding row cut', () => {
    const text = '<c id="0"><n>x</n></c>'.repeat(40)
    checkEdit(text, 62, 62, ' ', 64, XML_BREAK_BYTES)
  })

  // The same hazard swept across a whole cut window, in both directions
  // (insertions and deletions), rather than resting on the single minimized
  // case above.
  it('matches a full rebuild across a whole cut window, inserting and deleting', () => {
    const text = '<c id="0"><n>x</n></c>'.repeat(40)
    for (let offset = 48; offset <= 66; offset++) {
      checkEdit(text, offset, offset, ' ', 64, XML_BREAK_BYTES)
      checkEdit(text, offset, offset, '>', 64, XML_BREAK_BYTES)
      checkEdit(text, offset, Math.min(offset + 2, text.length), '', 64, XML_BREAK_BYTES)
    }
  })
})
