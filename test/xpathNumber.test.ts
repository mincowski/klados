/**
 * R129 acceptance 2 — `docs/plans/R129-query-predicates.md` §4's table, as
 * a test.
 *
 * **The divergence from `Number()` is the point, not a bug.** Five of the
 * nine cases below answer differently from JavaScript, and they answer the
 * way every other XPath 1.0 engine does. This file exists so that someone
 * who notices `1e3` "not working" and reaches for `Number()` breaks a test
 * that says why, rather than silently making Klados's path queries
 * disagree with Klados's own future XPath mode.
 */
import { describe, expect, it } from 'vitest'
import {
  ASCII_LAYOUT,
  bytesEqual,
  numberByteLayout,
  xpathNumberFromBytes,
  xpathNumberFromText
} from '../src/core/path/xpathNumber'

function num(text: string): number {
  const bytes = new TextEncoder().encode(text)
  return xpathNumberFromBytes(bytes, 0, bytes.length, ASCII_LAYOUT)
}

describe('xpathNumberFromBytes — §4, the cases that diverge from Number()', () => {
  const diverging: readonly [string, number][] = [
    ['1e3', 1000],
    ['0x10', 16],
    ['', 0],
    ['+5', 5],
    ['Infinity', Infinity]
  ]

  for (const [input, jsAnswer] of diverging) {
    it(`'${input}' is NaN under XPath, where JS Number() says ${jsAnswer}`, () => {
      expect(num(input)).toBeNaN()
      // Asserted, so the row cannot quietly stop being a divergence.
      expect(Number(input)).toBe(jsAnswer)
    })
  }
})

describe('xpathNumberFromBytes — §4, the cases that agree', () => {
  const agreeing: readonly [string, number][] = [
    ['.5', 0.5],
    ['1.5', 1.5],
    ['-3', -3],
    ['  42  ', 42]
  ]

  for (const [input, expected] of agreeing) {
    it(`'${input}' is ${expected}, matching Number()`, () => {
      expect(num(input)).toBe(expected)
      expect(Number(input)).toBe(expected)
    })
  }
})

describe('xpathNumberFromBytes — the rest of the grammar', () => {
  it('accepts every XPath whitespace character around the number', () => {
    expect(num('\t\n\r 42 \r\n\t')).toBe(42)
  })

  it("accepts a trailing '.' with no fraction digits, and a leading '.' with them", () => {
    expect(num('1.')).toBe(1)
    expect(num('-.25')).toBe(-0.25)
  })

  it("rejects a bare '.', a bare '-', and '-.'", () => {
    expect(num('.')).toBeNaN()
    expect(num('-')).toBeNaN()
    expect(num('-.')).toBeNaN()
  })

  it('rejects a second sign, a second dot, and interior whitespace', () => {
    expect(num('--1')).toBeNaN()
    expect(num('1.2.3')).toBeNaN()
    expect(num('1 2')).toBeNaN()
  })

  it('rejects trailing junk after an otherwise valid number', () => {
    expect(num('12abc')).toBeNaN()
    expect(num('12,')).toBeNaN()
  })

  it('reads only the given range, not the whole buffer', () => {
    const bytes = new TextEncoder().encode('xx42yy')
    expect(xpathNumberFromBytes(bytes, 2, 4, ASCII_LAYOUT)).toBe(42)
    expect(xpathNumberFromBytes(bytes, 2, 5, ASCII_LAYOUT)).toBeNaN()
  })

  it('is exact for values within 15 significant digits and a ±22 exponent', () => {
    expect(num('123456789012345')).toBe(123456789012345)
    expect(num('0.1')).toBe(0.1)
    expect(num('3.14159265358979')).toBe(3.14159265358979)
    expect(num('0.000000000000000000001')).toBe(1e-21)
    expect(num('-18450.75')).toBe(-18450.75)
    // Leading zeros consume no precision.
    expect(num('000000000000000000.5')).toBe(0.5)
  })

  it('preserves the sign of zero, as XPath does', () => {
    expect(Object.is(num('-0'), -0)).toBe(true)
    expect(Object.is(num('0'), 0)).toBe(true)
  })
})

describe('xpathNumberFromBytes — UTF-16 layouts', () => {
  function utf16(text: string, endianness: 'utf-16le' | 'utf-16be'): Uint8Array {
    const bytes = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (endianness === 'utf-16le') {
        bytes[i * 2] = code & 0xff
        bytes[i * 2 + 1] = code >> 8
      } else {
        bytes[i * 2] = code >> 8
        bytes[i * 2 + 1] = code & 0xff
      }
    }
    return bytes
  }

  it('reads a number out of UTF-16LE and UTF-16BE bytes without decoding', () => {
    for (const encoding of ['utf-16le', 'utf-16be'] as const) {
      const bytes = utf16(' -12.5 ', encoding)
      expect(
        xpathNumberFromBytes(bytes, 0, bytes.length, numberByteLayout(encoding)),
        encoding
      ).toBe(-12.5)
    }
  })

  it('treats a non-ASCII UTF-16 unit as not-a-digit rather than as its low byte', () => {
    // U+FF11 is FULLWIDTH DIGIT ONE — low byte 0x11, high byte 0xff. A
    // stride-2 read that ignored the high byte would see 0x11 and call it
    // junk anyway; one that took the *low* byte of U+0031-like shapes
    // could confuse them. Asserted so the guard cannot be dropped.
    const bytes = utf16('１', 'utf-16le')
    expect(xpathNumberFromBytes(bytes, 0, bytes.length, numberByteLayout('utf-16le'))).toBeNaN()
  })

  it('an odd trailing byte makes the range not a number', () => {
    const bytes = utf16('42', 'utf-16le')
    expect(xpathNumberFromBytes(bytes, 0, bytes.length - 1, numberByteLayout('utf-16le'))).toBeNaN()
  })

  it('every other encoding gets the ASCII-transparent layout', () => {
    expect(numberByteLayout('utf-8')).toEqual(ASCII_LAYOUT)
    expect(numberByteLayout('windows-1252')).toEqual(ASCII_LAYOUT)
    expect(numberByteLayout('UTF-16LE').stride).toBe(2)
  })
})

describe('xpathNumberFromText — the query literal path', () => {
  it('answers exactly as the byte reader does', () => {
    expect(xpathNumberFromText('1e3')).toBeNaN()
    expect(xpathNumberFromText('  42  ')).toBe(42)
    expect(xpathNumberFromText('-3.5')).toBe(-3.5)
    expect(xpathNumberFromText('BMW')).toBeNaN()
  })
})

describe('bytesEqual', () => {
  it('compares the range against the needle, length first', () => {
    const bytes = new TextEncoder().encode('xxBMWxx')
    const needle = new TextEncoder().encode('BMW')
    expect(bytesEqual(bytes, 2, 5, needle)).toBe(true)
    expect(bytesEqual(bytes, 2, 4, needle)).toBe(false)
    expect(bytesEqual(bytes, 1, 4, needle)).toBe(false)
    expect(bytesEqual(bytes, 0, 0, new Uint8Array(0))).toBe(true)
  })
})
