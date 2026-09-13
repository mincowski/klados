/**
 * R72 §6 / R76 (`R72-path-query.md`) — the measured case-fold
 * divergence between Find's byte and decoded paths, against the real
 * fixture (`test/fixtures/confusables.xml`) rather than a reimplementation.
 *
 * The fixture's own header warns that authoring it by typing the
 * characters silently fails — U+212B and U+2126 are canonical singletons
 * an NFC-normalising step replaces with U+00C5/U+03A9, and the file would
 * then measure no divergence at all while looking correct. So the first
 * thing this file does is assert every expected codepoint is actually
 * present, before trusting any match count below it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findAll, isAsciiOnly } from '../src/core/textFind'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'

const fixturePath = join(__dirname, 'fixtures', 'confusables.xml')
const bytes = new Uint8Array(readFileSync(fixturePath))
const text = new TextDecoder('utf-8').decode(bytes)
const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [0x20])

describe('confusables.xml carries the exact codepoints it claims to (guards against silent NFC normalisation)', () => {
  const expected: readonly [string, number][] = [
    ['MICRO SIGN', 0x00b5],
    ['GREEK SMALL LETTER MU', 0x03bc],
    ['LATIN CAPITAL LETTER A WITH RING ABOVE', 0x00c5],
    ['ANGSTROM SIGN', 0x212b], // canonical singleton — the one NFC destroys
    ['GREEK CAPITAL LETTER OMEGA', 0x03a9],
    ['OHM SIGN', 0x2126], // canonical singleton — the other one NFC destroys
    ['LATIN SMALL LETTER SHARP S', 0x00df],
    ['LATIN CAPITAL LETTER SHARP S', 0x1e9e],
    ['LATIN CAPITAL LETTER I WITH DOT ABOVE', 0x0130],
    ['CYRILLIC SMALL LETTER A', 0x0430]
  ]

  for (const [name, codepoint] of expected) {
    it(`contains ${name} (U+${codepoint.toString(16).toUpperCase()})`, () => {
      expect(text).toContain(String.fromCodePoint(codepoint))
    })
  }
})

function matchCount(needle: string, caseSensitive: boolean, regex: boolean): number {
  return findAll(bytes, rowIndex, 'utf-8', needle, { caseSensitive, regex }).starts.length
}

// R72 §6's own measured table, reproduced against the real fixture and the
// real findAll rather than assumed still true, and **updated by R204**: the
// angstrom and ohm rows no longer diverge, because NFC collapses a canonical
// singleton and both modes now see U+212B as U+00C5 and U+2126 as U+03A9.
// That is the improvement `docs/plans/R202-unicode-comparison.md` § 7
// predicted, and the reason it insisted R204 land before R205.
//
// The two rows that still diverge do so for a reason NFC cannot touch: µ/μ
// and ß/ẞ are *compatibility* relationships, not canonical ones, and D-082
// rejected NFKC for equating characters that are not the same character.
//
// The ASCII control is unaffected across every column — the assertion that
// would fail if the fold were ever made fuzzier "to fix" one of the other
// rows, and the one that pins R204's needle gate.
describe('the measured divergence table (R72 §6, R204)', () => {
  const cases: readonly {
    needle: string
    plain: number
    regexCount: number
    caseSensitive: number
  }[] = [
    // Compatibility, not canonical — NFC leaves these alone, by design.
    { needle: 'µ', plain: 1, regexCount: 2, caseSensitive: 1 }, // µ vs μ
    { needle: 'ß', plain: 2, regexCount: 1, caseSensitive: 1 }, // ß vs ẞ
    // Canonical singletons — R204 resolved both, in every mode including
    // case-sensitive, since canonical equivalence has nothing to do with case.
    { needle: 'Å', plain: 2, regexCount: 2, caseSensitive: 2 }, // Å vs Å(U+212B)
    { needle: 'Ω', plain: 2, regexCount: 2, caseSensitive: 2 }, // Ω vs Ω(U+2126)
    { needle: 'unit', plain: 7, regexCount: 7, caseSensitive: 7 } // ASCII control
  ]

  for (const { needle, plain, regexCount, caseSensitive } of cases) {
    it(`"${needle}" — plain ${plain}, regex ${regexCount}, case-sensitive ${caseSensitive}`, () => {
      expect(matchCount(needle, false, false)).toBe(plain)
      expect(matchCount(needle, false, true)).toBe(regexCount)
      expect(matchCount(needle, true, false)).toBe(caseSensitive)
      expect(matchCount(needle, true, true)).toBe(caseSensitive)
    })
  }

  it('every divergent pair in this table has a non-ASCII needle (the condition the footnote keys on)', () => {
    for (const { needle } of cases) {
      if (needle === 'unit') continue
      expect(isAsciiOnly(needle)).toBe(false)
    }
  })
})

// R76: the length-changing case mapping — a case neither path can express,
// not a disagreement between them (both simply fail to match).
describe('R76 — a length-changing case mapping matches on neither path', () => {
  it('İ (U+0130) does not match "i" on either the plain or regex path, case-insensitive', () => {
    expect(matchCount('i', false, false)).toBeGreaterThan(0) // "Ivan" etc. — sanity: "i" does match *something*
    // But the dotted-capital-I character itself, searched for directly,
    // case-insensitively, against its own lowercase form:
    expect(matchCount('İ'.toLowerCase(), false, false)).toBe(0) // 'i̇' (2 code units) never matches İ
    expect(matchCount('İ'.toLowerCase(), false, true)).toBe(0)
  })
})
