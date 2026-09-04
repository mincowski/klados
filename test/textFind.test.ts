import { describe, expect, it } from 'vitest'
import {
  chooseFindPath,
  decodedWindowsFor,
  findAll,
  findAsciiInRange,
  findDecodedInWindow,
  isAsciiOnly
} from '../src/core/textFind'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** Naive reference: every byte offset where `needle` occurs, decoding the
 * whole (small, test-only) buffer — the oracle G2's own acceptance
 * criterion calls for. */
function naiveIndexOf(text: string, needle: string, caseSensitive: boolean): number[] {
  const haystack = caseSensitive ? text : text.toLowerCase()
  const target = caseSensitive ? needle : needle.toLowerCase()
  const offsets: number[] = []
  let from = 0
  while (true) {
    const idx = haystack.indexOf(target, from)
    if (idx === -1) break
    offsets.push(idx)
    from = idx + 1
  }
  return offsets
}

describe('isAsciiOnly / chooseFindPath', () => {
  it('is true for plain ASCII', () => {
    expect(isAsciiOnly('hello world')).toBe(true)
  })
  it('is false for a non-ASCII character', () => {
    expect(isAsciiOnly('café')).toBe(false)
  })
  it('routes an ASCII, non-regex needle to the byte path', () => {
    expect(chooseFindPath('cat', { caseSensitive: true, regex: false })).toBe('byte')
  })
  it('routes a non-ASCII needle to the decoded path', () => {
    expect(chooseFindPath('café', { caseSensitive: true, regex: false })).toBe('decoded')
  })
  it('routes any regex to the decoded path, even an ASCII one', () => {
    expect(chooseFindPath('cat', { caseSensitive: true, regex: true })).toBe('decoded')
  })
})

describe('findAsciiInRange (byte path)', () => {
  it('finds every occurrence, matching a naive reference', () => {
    const text = 'the cat sat on the mat with another cat'
    const bytes = utf8(text)
    const result = findAsciiInRange(bytes, 'cat', true, 0, bytes.length)
    expect([...result.starts]).toEqual(naiveIndexOf(text, 'cat', true))
    for (let i = 0; i < result.starts.length; i++) {
      expect(result.ends[i]).toBe(result.starts[i]! + 3)
    }
  })

  it('finds overlapping matches', () => {
    const bytes = utf8('aaaa')
    const result = findAsciiInRange(bytes, 'aa', true, 0, bytes.length)
    expect([...result.starts]).toEqual([0, 1, 2])
  })

  it('is case-insensitive via ASCII folding when requested', () => {
    const bytes = utf8('Cat cAt CAT cat')
    const result = findAsciiInRange(bytes, 'cat', false, 0, bytes.length)
    expect(result.starts.length).toBe(4)
  })

  it('is case-sensitive by default behavior when requested', () => {
    const bytes = utf8('Cat cAt CAT cat')
    const result = findAsciiInRange(bytes, 'cat', true, 0, bytes.length)
    expect(result.starts.length).toBe(1)
  })

  it('finds nothing for an empty needle', () => {
    const bytes = utf8('hello')
    expect(findAsciiInRange(bytes, '', true, 0, bytes.length).starts.length).toBe(0)
  })

  it('a match starting within [from, to) is found even if it extends past `to`', () => {
    const bytes = utf8('xxxcatxxx')
    // `to` cuts right after the match's start byte — chunk-boundary safety.
    const result = findAsciiInRange(bytes, 'cat', true, 3, 4)
    expect([...result.starts]).toEqual([3])
  })

  it('a match starting at or after `to` is not found by this chunk', () => {
    const bytes = utf8('xxxcatxxx')
    const result = findAsciiInRange(bytes, 'cat', true, 4, bytes.length)
    expect([...result.starts]).toEqual([])
  })

  it('chunking a document into consecutive ranges finds exactly the same matches as one whole-range call', () => {
    const text = Array.from({ length: 50 }, (_, i) => (i % 7 === 0 ? 'needle' : 'hay')).join(' ')
    const bytes = utf8(text)
    const whole = findAsciiInRange(bytes, 'needle', true, 0, bytes.length)

    const chunkSize = 17 // deliberately not aligned to word boundaries
    const chunked: number[] = []
    for (let from = 0; from < bytes.length; from += chunkSize) {
      const to = Math.min(from + chunkSize, bytes.length)
      chunked.push(...findAsciiInRange(bytes, 'needle', true, from, to).starts)
    }
    expect(chunked.sort((a, b) => a - b)).toEqual([...whole.starts])
  })
})

describe('decodedWindowsFor', () => {
  it('produces one window covering everything for a small document', () => {
    const rowIndex = buildRowIndex(utf8('a\nb\nc\n'), DEFAULT_MAX_ROW_BYTES, [])
    const windows = decodedWindowsFor(rowIndex, 64 * 1024)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toEqual({ startRow: 0, endRow: rowIndex.length })
  })

  it('overlaps consecutive windows by exactly one row when the target is small', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `row${i}`).join('\n')
    const rowIndex = buildRowIndex(utf8(rows), DEFAULT_MAX_ROW_BYTES, [])
    const windows = decodedWindowsFor(rowIndex, 20) // tiny target forces many windows
    expect(windows.length).toBeGreaterThan(1)
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.startRow).toBe(windows[i - 1]!.endRow - 1)
    }
  })

  it('terminates when a single row alone already reaches targetBytes (regression: infinite loop)', () => {
    // Each row is ~5 bytes ("aaaa\n") — a targetBytes smaller than that
    // means a single row on its own already meets/exceeds the target,
    // which used to leave `startRow` unchanged forever (`endRow - 1 ===
    // startRow` when `endRow === startRow + 1`).
    const rows = Array.from({ length: 10 }, () => 'aaaa').join('\n')
    const rowIndex = buildRowIndex(utf8(rows), DEFAULT_MAX_ROW_BYTES, [])
    const windows = decodedWindowsFor(rowIndex, 3) // smaller than a single row
    expect(windows.length).toBeGreaterThan(0)
    // Covers the whole document — the last window's endRow reaches the end.
    expect(windows[windows.length - 1]!.endRow).toBe(rowIndex.length)
    // Every window still advances (no repeated startRow).
    const starts = windows.map((w) => w.startRow)
    expect(new Set(starts).size).toBe(starts.length)
  })
})

describe('findDecodedInWindow / findAll (decoded path)', () => {
  it('finds a non-ASCII needle at the right byte offset', () => {
    const text = 'plain café plain'
    const bytes = utf8(text)
    const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [])
    const result = findAll(bytes, rowIndex, 'utf-8', 'café', { caseSensitive: true, regex: false })
    expect(result.starts.length).toBe(1)
    const expectedByteOffset = utf8('plain ').length
    expect(result.starts[0]).toBe(expectedByteOffset)
    expect(result.ends[0]).toBe(expectedByteOffset + utf8('café').length)
  })

  it('finds a non-ASCII needle at the right byte offset in a windows-1252 fixture', () => {
    // windows-1252 is single-byte: 'é' is one byte (0xE9), not the two
    // UTF-8 bytes (0xC3 0xA9) it would be in a UTF-8 document — the exact
    // case G2's own acceptance criterion names, and the one the byte-offset
    // math got wrong before `isSingleByteEncoding` (a UTF-8 re-encode of
    // the decoded string produced an offset 1 byte too far for every match
    // after the first non-ASCII character).
    const encoder = new TextEncoder()
    const bytes = new Uint8Array([
      ...encoder.encode('plain caf'),
      0xe9, // 'é' in windows-1252, one byte
      ...encoder.encode(' plain')
    ])
    const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [])
    const result = findAll(bytes, rowIndex, 'windows-1252', 'café', {
      caseSensitive: true,
      regex: false
    })
    expect(result.starts.length).toBe(1)
    const expectedStart = encoder.encode('plain ').length
    expect(result.starts[0]).toBe(expectedStart)
    // 'café' is 4 bytes in windows-1252 (c-a-f-é, one byte each), not 5.
    expect(result.ends[0]).toBe(expectedStart + 4)
  })

  it('finds a needle spanning a row boundary at the right offset in windows-1252', () => {
    const encoder = new TextEncoder()
    // Short rows (maxRowBytes: 6) force 'café' to straddle a row break.
    const bytes = new Uint8Array([
      ...encoder.encode('short\nrowXca'),
      0x66, // 'f'
      0xe9, // 'é' in windows-1252, one byte
      ...encoder.encode('Yrow\nshort')
    ])
    const rowIndex = buildRowIndex(bytes, 6, [0x0a])
    expect(rowIndex.length).toBeGreaterThan(1)
    const result = findAll(bytes, rowIndex, 'windows-1252', 'café', {
      caseSensitive: true,
      regex: false
    })
    expect(result.starts.length).toBe(1)
    const decoded = new TextDecoder('windows-1252').decode(bytes)
    const stringIndex = decoded.indexOf('café')
    expect(result.starts[0]).toBe(stringIndex) // single-byte: string index === byte offset
  })

  it('supports regex matches', () => {
    const text = 'a1 b22 c333'
    const bytes = utf8(text)
    const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [])
    const result = findAll(bytes, rowIndex, 'utf-8', '\\d+', { caseSensitive: true, regex: true })
    expect(result.starts.length).toBe(3)
  })

  it('a needle spanning a row boundary is found exactly once', () => {
    // Force short rows so the needle straddles a row break.
    const bytes = utf8('short\nrowXneedleYrow\nshort')
    const rowIndex = buildRowIndex(bytes, 6, [0x0a])
    // Sanity: the fixture really does split across more than one row.
    expect(rowIndex.length).toBeGreaterThan(1)
    const windows = decodedWindowsFor(rowIndex, 12) // small target forces multiple windows
    expect(windows.length).toBeGreaterThan(1)

    const seen = new Set<number>()
    let total = 0
    for (const window of windows) {
      const result = findDecodedInWindow(
        bytes,
        rowIndex,
        'utf-8',
        'needle',
        { caseSensitive: true, regex: false },
        window,
        bytes.length
      )
      for (const start of result.starts) {
        expect(seen.has(start)).toBe(false)
        seen.add(start)
        total++
      }
    }
    expect(total).toBe(1)
    // Cross-check against a straight decode-and-search of the whole fixture.
    const naiveByteOffset = (() => {
      const s = new TextDecoder('utf-8').decode(bytes)
      const idx = s.indexOf('needle')
      return new TextEncoder().encode(s.slice(0, idx)).length
    })()
    expect([...seen][0]).toBe(naiveByteOffset)
  })

  it('is case-insensitive via platform casing when requested', () => {
    const text = 'Café CAFÉ café'
    const bytes = utf8(text)
    const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [])
    const result = findAll(bytes, rowIndex, 'utf-8', 'café', { caseSensitive: false, regex: false })
    expect(result.starts.length).toBe(3)
  })

  it('windows.decodedWindowsFor tiling matches whole-document findAll exactly, for a larger fixture', () => {
    const text = Array.from({ length: 2000 }, (_, i) => (i % 37 === 0 ? 'needle' : `w${i}`)).join(
      ' '
    )
    const bytes = utf8(text)
    const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [])
    const result = findAll(bytes, rowIndex, 'utf-8', 'needle', { caseSensitive: true, regex: true })
    const expectedCount = (text.match(/needle/g) ?? []).length
    expect(result.starts.length).toBe(expectedCount)
    // Ascending, and matches the whole-string reference exactly.
    const decoded = new TextDecoder('utf-8').decode(bytes)
    const ref: number[] = []
    let from = 0
    while (true) {
      const idx = decoded.indexOf('needle', from)
      if (idx === -1) break
      ref.push(new TextEncoder().encode(decoded.slice(0, idx)).length)
      from = idx + 1
    }
    expect([...result.starts]).toEqual(ref)
  })
})
