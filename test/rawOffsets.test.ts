/**
 * UI-FEEDBACK.md M5b: "Byte offsets and CodeMirror positions are
 * mixed throughout the Raw view" — invisible on ASCII, where a UTF-16 unit
 * and a byte coincide, and wrong everywhere else. This is the non-ASCII
 * Raw-view-adjacent test the entry says the suite had none of:
 * `byteOffsetToLocalUnits` (new) round-tripping against
 * `localUnitsToByteOffset` (existing, `rawEdit.test.ts` covers it
 * directly) across accented Latin, CJK and emoji — the same content
 * classes that entry measured real drift against.
 */
import { describe, expect, it } from 'vitest'
import {
  byteOffsetToLocalUnits,
  localUnitsToByteOffset
} from '../src/renderer/components/Raw/rawOffsets'

describe('byteOffsetToLocalUnits', () => {
  it('equals the byte count for pure ASCII UTF-8 text', () => {
    expect(byteOffsetToLocalUnits('hello world', 5, 'utf-8')).toBe(5)
  })

  it('lands on the correct unit boundary for accented Latin (2-byte UTF-8)', () => {
    const text = 'café au lait' // "café au lait" — é is 2 bytes in UTF-8, 1 unit
    // "caf" = 3 bytes/units, "é" = 2 bytes but 1 unit — byte 5 is right after "é"
    expect(byteOffsetToLocalUnits(text, 5, 'utf-8')).toBe(4)
  })

  it('lands on the correct unit boundary for CJK (3-byte UTF-8, 1 unit each)', () => {
    const text = '你好' // "你好" — each character is 3 bytes, 1 unit
    expect(byteOffsetToLocalUnits(text, 3, 'utf-8')).toBe(1)
    expect(byteOffsetToLocalUnits(text, 6, 'utf-8')).toBe(2)
  })

  it('lands on the correct unit boundary for an astral emoji (4-byte UTF-8, 2 units)', () => {
    const text = 'a\u{1f600}b' // "a😀b" — the emoji is 4 bytes, 2 UTF-16 units (a surrogate pair)
    expect(byteOffsetToLocalUnits(text, 1, 'utf-8')).toBe(1) // just past "a"
    expect(byteOffsetToLocalUnits(text, 5, 'utf-8')).toBe(3) // just past the emoji
    expect(byteOffsetToLocalUnits(text, 6, 'utf-8')).toBe(4) // past "b" too
  })

  it('clamps to text length when localBytes runs past the end', () => {
    const text = '你好'
    expect(byteOffsetToLocalUnits(text, 1000, 'utf-8')).toBe(text.length)
  })

  it('is 0 for a non-positive byte offset', () => {
    expect(byteOffsetToLocalUnits('hello', 0, 'utf-8')).toBe(0)
    expect(byteOffsetToLocalUnits('hello', -3, 'utf-8')).toBe(0)
  })

  it('divides by 2 for utf-16le/be, where every unit is exactly 2 bytes', () => {
    expect(byteOffsetToLocalUnits('abc', 6, 'utf-16le')).toBe(3)
    expect(byteOffsetToLocalUnits('abc', 6, 'utf-16be')).toBe(3)
    expect(byteOffsetToLocalUnits('abc', 5, 'utf-16le')).toBe(2) // floors mid-unit
  })

  it('round-trips with localUnitsToByteOffset across every code-point boundary', () => {
    // The drift the M5b entry actually measured: German, CJK and emoji
    // content, checked at every *code-point* boundary — not every raw
    // UTF-16 unit position, since a position between a surrogate pair's two
    // halves isn't a valid character boundary either axis can land on
    // consistently (encoding a lone surrogate differs from encoding the
    // pair it's half of), and no real caret/CodeMirror position lands there.
    const fixtures = ['café straße münchen', '你好世界', 'a\u{1f600}b\u{1f601}c']
    for (const text of fixtures) {
      const boundaries = [0]
      for (const ch of text) boundaries.push(boundaries[boundaries.length - 1]! + ch.length)
      for (const units of boundaries) {
        const bytes = localUnitsToByteOffset(text, units, 'utf-8')
        expect(byteOffsetToLocalUnits(text, bytes, 'utf-8')).toBe(units)
      }
    }
  })

  it('falls back to bytes-as-units for an encoding it cannot represent', () => {
    // Same "slightly wrong beats a crash" fallback localUnitsToByteOffset
    // takes for windows-1252 and friends (documentEdits.ts).
    expect(byteOffsetToLocalUnits('hello', 3, 'windows-1252')).toBe(3)
  })
})
