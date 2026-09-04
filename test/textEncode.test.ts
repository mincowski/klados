/**
 * R53 (`R53-interner-encoding.md`) — `encodeText`'s three encoding
 * families: UTF-8 (delegates to `TextEncoder`), UTF-16LE/BE (a direct
 * code-unit write), and single-byte code pages (probed via `TextDecoder`
 * and inverted). And the one thing that makes the third family worth
 * having at all: a genuinely unrepresentable character returns `null`
 * rather than silently substituting or throwing.
 */
import { describe, expect, it } from 'vitest'
import { encodeText } from '../src/core/textEncode'

describe('encodeText — utf-8', () => {
  it('matches TextEncoder byte-for-byte, including non-ASCII', () => {
    expect(encodeText('café', 'utf-8')).toEqual(new TextEncoder().encode('café'))
  })

  it('is case-insensitive on the label', () => {
    expect(encodeText('a', 'UTF-8')).toEqual(new TextEncoder().encode('a'))
  })
})

describe('encodeText — utf-16', () => {
  it('encodes utf-16le as little-endian code units', () => {
    // 'A' is U+0041 — LE bytes are [0x41, 0x00].
    expect(Array.from(encodeText('A', 'utf-16le')!)).toEqual([0x41, 0x00])
  })

  it('encodes utf-16be as big-endian code units', () => {
    expect(Array.from(encodeText('A', 'utf-16be')!)).toEqual([0x00, 0x41])
  })

  it('round-trips a character outside the BMP as a surrogate pair, 4 bytes', () => {
    const bytes = encodeText('\u{1F600}', 'utf-16le')! // 😀
    expect(bytes.length).toBe(4)
  })
})

describe('encodeText — single-byte code pages', () => {
  it('encodes windows-1252, including a byte above 0x7F', () => {
    // 'é' is 0xE9 in windows-1252 (and in Latin-1/ISO-8859-1).
    expect(Array.from(encodeText('café', 'windows-1252')!)).toEqual([0x63, 0x61, 0x66, 0xe9])
  })

  it('encodes iso-8859-1 the same way for the same characters', () => {
    expect(Array.from(encodeText('café', 'iso-8859-1')!)).toEqual([0x63, 0x61, 0x66, 0xe9])
  })

  it('round-trips against TextDecoder for every byte in a single-byte page', () => {
    const decoder = new TextDecoder('windows-1252')
    for (let byte = 0x20; byte < 0x100; byte++) {
      const decoded = decoder.decode(new Uint8Array([byte]))
      if (decoded === '�') continue // an unmapped byte in this page — nothing to round-trip
      expect(Array.from(encodeText(decoded, 'windows-1252')!)).toEqual([byte])
    }
  })

  it('returns null for a character the encoding genuinely cannot represent', () => {
    // 日本語 has no representation in windows-1252.
    expect(encodeText('日本語', 'windows-1252')).toBeNull()
  })

  it('returns null for just one unrepresentable character among representable ones', () => {
    expect(encodeText('café日', 'windows-1252')).toBeNull()
  })
})

describe('encodeText — unrecognized encoding label', () => {
  it('returns null rather than throwing', () => {
    expect(encodeText('a', 'not-a-real-encoding')).toBeNull()
  })
})
