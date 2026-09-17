import { describe, expect, it } from 'vitest'
import { SourceBuffer, snapToCharBoundary } from '../src/core/buffer'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('snapToCharBoundary', () => {
  it('leaves an ASCII offset unchanged', () => {
    const bytes = utf8('hello')
    expect(snapToCharBoundary(bytes, 2)).toBe(2)
  })

  it('advances past continuation bytes of a CJK character', () => {
    // U+4E2D ("中") encodes as three bytes; offset 1 lands mid-character.
    const bytes = utf8('中')
    expect(bytes.length).toBe(3)
    expect(snapToCharBoundary(bytes, 1)).toBe(3)
    expect(snapToCharBoundary(bytes, 2)).toBe(3)
  })

  it('advances past continuation bytes of an emoji (surrogate pair, 4-byte UTF-8)', () => {
    const bytes = utf8('😀')
    expect(bytes.length).toBe(4)
    expect(snapToCharBoundary(bytes, 1)).toBe(4)
    expect(snapToCharBoundary(bytes, 3)).toBe(4)
  })

  it('does not move an offset already at a lead byte', () => {
    const bytes = utf8('a中b')
    const leadOfChun = 1
    expect(snapToCharBoundary(bytes, leadOfChun)).toBe(leadOfChun)
  })

  it('clamps to the buffer length at the end', () => {
    const bytes = utf8('abc')
    expect(snapToCharBoundary(bytes, 3)).toBe(3)
  })
})

describe('SourceBuffer', () => {
  it('decodes a slice on demand', () => {
    const bytes = utf8('hello world')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)
    expect(buf.slice(0, 5)).toBe('hello')
    expect(buf.slice(6, 11)).toBe('world')
  })

  it('reports byteLength', () => {
    const bytes = utf8('hello')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)
    expect(buf.byteLength).toBe(5)
  })

  it('a naive slice at an arbitrary byte offset mangles CJK content, snapToCharBoundary fixes it', () => {
    const bytes = utf8('中文abc')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)

    // Byte 1 is the middle of the first character's 3-byte encoding.
    const naive = buf.slice(1, bytes.length)
    expect(naive).toContain('�') // replacement character(s)

    const snapped = buf.snapToCharBoundary(1)
    const fixed = buf.slice(snapped, bytes.length)
    expect(fixed).not.toContain('�')
    expect(fixed).toBe('文abc')
  })

  it('delegates snapToCharBoundary to the free function', () => {
    const bytes = utf8('中x')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)
    expect(buf.snapToCharBoundary(1)).toBe(snapToCharBoundary(bytes, 1))
  })
})

// R214 (`docs/plans/R214-filter-pass.md` § 0): short all-ASCII slices are built
// without `TextDecoder`. The fast path must be invisible — same string as the
// decoder for every encoding, every range, including the ones it declines.
describe('SourceBuffer.slice — the ASCII fast path', () => {
  function mulberry32(seed: number): () => number {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const ENCODINGS = ['utf-8', 'windows-1252', 'iso-8859-2', 'shift_jis', 'iso-2022-jp', 'utf-16le']

  for (const encoding of ENCODINGS) {
    it(`${encoding}: every slice equals TextDecoder's`, () => {
      const rand = mulberry32(encoding.length * 7919)
      for (let doc = 0; doc < 40; doc++) {
        // Mostly ASCII, with escape bytes and high bytes mixed in, so both
        // paths and the switch between them are exercised.
        const bytes = new Uint8Array(300)
        for (let i = 0; i < bytes.length; i++) {
          const r = rand()
          bytes[i] =
            r < 0.8 ? 0x20 + Math.floor(rand() * 0x5f) : r < 0.85 ? 0x1b : Math.floor(rand() * 256)
        }
        const buffer = new SourceBuffer(bytes, encoding, 0)
        for (let k = 0; k < 200; k++) {
          const start = Math.floor(rand() * 320) - 10
          const end = start + Math.floor(rand() * 200) - 20
          const expected = new TextDecoder(encoding).decode(bytes.subarray(start, end))
          expect(buffer.slice(start, end), `${encoding} [${start}, ${end})`).toBe(expected)
        }
      }
    })
  }

  it('a range past the end is clamped, as `subarray` clamps it', () => {
    const buffer = new SourceBuffer(utf8('abc'), 'utf-8', 0)
    expect(buffer.slice(1, 99)).toBe('bc')
    expect(buffer.slice(2, 1)).toBe('')
  })
})

describe('SourceBuffer.slice — ranges the fast path declines', () => {
  it('negative and fractional bounds decode exactly as `subarray` reads them', () => {
    const bytes = utf8('hello world')
    const buffer = new SourceBuffer(bytes, 'utf-8', 0)
    for (const [start, end] of [
      [0, -1],
      [-5, 11],
      [1.5, 4.7],
      [0, 2.2]
    ] as const) {
      expect(buffer.slice(start, end)).toBe(new TextDecoder().decode(bytes.subarray(start, end)))
    }
  })
})
