/**
 * M5c-PLAN.md J1 — `rawOffsetMap.ts` replaces per-call O(window) walks
 * (`rawOffsets.ts`) with a map built once per window. `rawOffsets.ts` stays
 * as the oracle: every case here checks `buildOffsetMap` agrees with it.
 */
import { describe, expect, it } from 'vitest'
import { buildOffsetMap } from '../src/renderer/components/Raw/rawOffsetMap'
import {
  byteOffsetToLocalUnits,
  localUnitsToByteOffset
} from '../src/renderer/components/Raw/rawOffsets'

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('buildOffsetMap — ascii fast path', () => {
  it('is flagged ascii and is the identity for pure ASCII UTF-8 text', () => {
    const map = buildOffsetMap('hello world', 'utf-8')
    expect(map.ascii).toBe(true)
    expect(map.toBytes(5)).toBe(5)
    expect(map.toUnits(5)).toBe(5)
  })

  it('takes the fast path when given ascii-only bytes even without scanning text again', () => {
    const text = 'hello world'
    const map = buildOffsetMap(text, 'utf-8', utf8Bytes(text))
    expect(map.ascii).toBe(true)
  })

  it('is not ascii once any byte is non-ASCII', () => {
    const text = 'café'
    expect(buildOffsetMap(text, 'utf-8').ascii).toBe(false)
    expect(buildOffsetMap(text, 'utf-8', utf8Bytes(text)).ascii).toBe(false)
  })

  it('clamps to text length past the end', () => {
    const map = buildOffsetMap('hi', 'utf-8')
    expect(map.toBytes(1000)).toBe(2)
    expect(map.toUnits(1000)).toBe(2)
  })
})

describe('buildOffsetMap — utf-16', () => {
  it('multiplies/divides by 2', () => {
    const map = buildOffsetMap('abc', 'utf-16le')
    expect(map.toBytes(3)).toBe(6)
    expect(map.toUnits(6)).toBe(3)
    expect(map.toUnits(5)).toBe(2) // floors mid-unit
    expect(buildOffsetMap('abc', 'utf-16be').toBytes(3)).toBe(6)
  })
})

describe('buildOffsetMap — legacy single-byte encoding', () => {
  it('is the identity regardless of byte value', () => {
    const map = buildOffsetMap('hello', 'windows-1252')
    expect(map.ascii).toBe(true)
    expect(map.toBytes(3)).toBe(3)
    expect(map.toUnits(3)).toBe(3)
  })
})

describe('buildOffsetMap — utf-8 checkpoint path agrees with rawOffsets.ts', () => {
  const fixtures = [
    'café straße münchen',
    '你好世界',
    'a\u{1f600}b\u{1f601}c',
    // Long enough to force multiple checkpoints past the 1024-unit stride,
    // mixing ASCII, accented Latin, CJK and an astral emoji throughout.
    'the quick brown fox café 你好 '.repeat(80) +
      '\u{1f600}' +
      'jumps over münchen 世界 '.repeat(80)
  ]

  for (const text of fixtures) {
    it(`round-trips at every code-point boundary (len=${text.length})`, () => {
      const map = buildOffsetMap(text, 'utf-8')
      expect(map.ascii).toBe(false)

      const boundaries = [0]
      for (const ch of text) boundaries.push(boundaries[boundaries.length - 1]! + ch.length)

      for (const units of boundaries) {
        const expectedBytes = localUnitsToByteOffset(text, units, 'utf-8')
        expect(map.toBytes(units)).toBe(expectedBytes)
        expect(byteOffsetToLocalUnits(text, expectedBytes, 'utf-8')).toBe(units)
        expect(map.toUnits(expectedBytes)).toBe(units)
      }
    })
  }

  it('agrees with rawOffsets.ts at 1000 random offsets, sampled at code-point boundaries', () => {
    // Positions between a surrogate pair's two halves aren't a valid
    // character boundary either axis lands on consistently (rawOffsets.ts's
    // own test file makes the same restriction) — sample from the boundary
    // set, not the raw unit/byte ranges.
    const text =
      'quick brown fox jumps over the lazy dog café straße münchen 你好世界 ' +
      '\u{1f600}\u{1f601}\u{1f602} '.repeat(200)
    const map = buildOffsetMap(text, 'utf-8')

    const unitBoundaries = [0]
    for (const ch of text)
      unitBoundaries.push(unitBoundaries[unitBoundaries.length - 1]! + ch.length)
    const byteBoundaries = unitBoundaries.map((u) => localUnitsToByteOffset(text, u, 'utf-8'))

    let seed = 42
    function rand(max: number): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % max
    }

    for (let i = 0; i < 1000; i++) {
      const units = unitBoundaries[rand(unitBoundaries.length)]!
      expect(map.toBytes(units)).toBe(localUnitsToByteOffset(text, units, 'utf-8'))
      const bytes = byteBoundaries[rand(byteBoundaries.length)]!
      expect(map.toUnits(bytes)).toBe(byteOffsetToLocalUnits(text, bytes, 'utf-8'))
    }
  })

  it('toBytes(toUnits(b)) round-trips at every checkpoint-spanning boundary', () => {
    const text = ('café 你好 ' + '\u{1f600}'.repeat(3) + ' straße ').repeat(150)
    const map = buildOffsetMap(text, 'utf-8')
    const boundaries = [0]
    for (const ch of text) boundaries.push(boundaries[boundaries.length - 1]! + ch.length)
    for (const bytes of boundaries.map((u) => map.toBytes(u))) {
      expect(map.toBytes(map.toUnits(bytes))).toBe(bytes)
    }
  })
})
