/**
 * R204 (`docs/plans/R202-unicode-comparison.md` § 5) — Find matches across
 * NFC and NFD, and reports the right **byte offset** when it does.
 *
 * The offset is the whole risk of this round, so it is what gets asserted.
 * A match count proves the normalization worked and says nothing about
 * whether the highlight lands on the text: `String.prototype.normalize`
 * returns a string with no index correspondence, and NFC changes lengths, so
 * every match found in a normalized window has to be mapped back through an
 * index built alongside it. R17's span bugs were invisible to every
 * tree-shape assertion for exactly this reason.
 *
 * Fixtures are authored from escapes with codepoint guards, per
 * `docs/FINDINGS.md`.
 */
import { describe, expect, it } from 'vitest'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { findAll, normalizeWindowForSearch, originalIndexOf } from '../src/core/textFind'

const COMPOSED = '\u00E9' // \u00E9
const DECOMPOSED = 'e\u0301' // e + combining acute
const ANGSTROM = '\u212B' // canonical singleton -> U+00C5
const A_RING = '\u00C5'
const HANGUL_JAMO = '\u1100\u1161' // L + V, composes to U+AC00
const HANGUL_SYLLABLE = '\uAC00'

function rowsOf(text: string): { bytes: Uint8Array; rowIndex: Int32Array } {
  const bytes = new TextEncoder().encode(text)
  return { bytes, rowIndex: buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [0x20]) }
}

function find(
  text: string,
  needle: string,
  options: { caseSensitive?: boolean; regex?: boolean } = {}
): { starts: number[]; ends: number[] } {
  const { bytes, rowIndex } = rowsOf(text)
  const result = findAll(bytes, rowIndex, 'utf-8', needle, {
    caseSensitive: options.caseSensitive ?? false,
    regex: options.regex ?? false
  })
  return { starts: [...result.starts], ends: [...result.ends] }
}

describe('R204 \u2014 fixture guards', () => {
  it('carries the exact codepoints it claims to', () => {
    expect(COMPOSED.codePointAt(0)).toBe(0x00e9)
    expect([...DECOMPOSED].map((c) => c.codePointAt(0))).toEqual([0x65, 0x0301])
    expect(ANGSTROM.codePointAt(0)).toBe(0x212b)
    expect(A_RING.codePointAt(0)).toBe(0x00c5)
    expect([...HANGUL_JAMO].map((c) => c.codePointAt(0))).toEqual([0x1100, 0x1161])
    expect(HANGUL_SYLLABLE.codePointAt(0)).toBe(0xac00)
    // The relationships under test, asserted rather than assumed.
    expect(DECOMPOSED.normalize('NFC')).toBe(COMPOSED)
    expect(ANGSTROM.normalize('NFC')).toBe(A_RING)
    expect(HANGUL_JAMO.normalize('NFC')).toBe(HANGUL_SYLLABLE)
  })
})

describe('R204 \u2014 normalizeWindowForSearch equals whole-string NFC', () => {
  // Acceptance 4, and the assertion the plan insisted on: the piecewise
  // split is an *optimization* of `text.normalize('NFC')`, so the test is
  // equality with that, not a sample of expected outputs. A boundary rule
  // that is subtly wrong produces text that looks right and matches at the
  // wrong offset.
  const corpus: readonly [string, string][] = [
    ['empty', ''],
    ['all ASCII', 'the quick brown fox jumps over the lazy dog 0123456789'],
    ['already composed', `caf${COMPOSED} na${'\u00EF'}ve`],
    ['fully decomposed', `cafe\u0301 nai\u0308ve`],
    ['mixed', `plain caf${COMPOSED} and cafe\u0301 together`],
    ['canonical singletons', `${ANGSTROM} and \u2126`],
    ['CJK, which NFC leaves alone', '\u4E2D\u6587\u6D4B\u8BD5\u5185\u5BB9'],
    ['Hangul jamo', `${HANGUL_JAMO} and ${HANGUL_SYLLABLE}`],
    ['astral', '\u{20000}\u{20001} tail'],
    ['astral with a following mark', '\u{1d400}\u0301x'],
    ['mark at the very start', '\u0301abc'],
    ['stacked marks', 'e\u0323\u0301x'], // dot below then acute \u2014 canonical ordering
    ['stacked marks, reversed', 'e\u0301\u0323x'],
    ['mark after a space', 'a \u0301 b'],
    ['long decomposed run', 'e\u0301'.repeat(500)],
    ['non-ASCII run with no marks', '\u0391\u0392\u0393\u03A9 \u0430\u0431\u0432']
  ]

  for (const [label, text] of corpus) {
    it(label, () => {
      const built = normalizeWindowForSearch(text)
      expect(built.text).toBe(text.normalize('NFC'))
    })
  }

  it('returns the identity, and no map, for a window already in NFC', () => {
    // Acceptance 5's condition at this level: the apparatus is skipped
    // entirely, which is the difference between a fix and a regression on a
    // 200 MB all-ASCII document.
    const ascii = 'nothing here needs composing'
    const result = normalizeWindowForSearch(ascii)
    expect(result.segments).toBe(null)
    expect(result.text).toBe(ascii)
    expect(normalizeWindowForSearch('\u4E2D\u6587').segments).toBe(null)
    // Identity means identity: every index maps to itself, with no lookup.
    expect(originalIndexOf(result, 7)).toBe(7)
  })

  it('maps every output position back to the original, one past the end included', () => {
    const text = `ab cafe\u0301 cd`
    const result = normalizeWindowForSearch(text)
    expect(result.segments).not.toBe(null)
    // The prefix before the decomposed character maps identically...
    for (let i = 0; i < 3; i++) expect(originalIndexOf(result, i)).toBe(i)
    // ...and the suffix after it is shifted by exactly the one code unit NFC
    // removed.
    const tail = result.text.indexOf(' cd')
    expect(originalIndexOf(result, tail)).toBe(text.indexOf(' cd'))
    // One past the end resolves to the original's end, so a match ending at
    // the very end of a window maps.
    expect(originalIndexOf(result, result.text.length)).toBe(text.length)
  })
})

describe('R204 \u2014 Find reports the correct byte offset across spellings', () => {
  it('a composed needle finds a decomposed occurrence, at its real byte offset', () => {
    // Acceptance 3. `<p>` is 3 bytes, so the match starts at byte 3 and the
    // decomposed `e` + U+0301 occupies 3 bytes (1 + 2).
    const text = `<p>caf${DECOMPOSED}</p>`
    const { starts, ends } = find(text, `caf${COMPOSED}`)
    expect(starts).toEqual([3])
    expect(ends).toEqual([9])
    // Proven against the bytes themselves rather than against arithmetic.
    const bytes = new TextEncoder().encode(text)
    expect(new TextDecoder().decode(bytes.subarray(3, 9))).toBe(`caf${DECOMPOSED}`)
  })

  it('a decomposed needle finds a composed occurrence, at its real byte offset', () => {
    const text = `<p>caf${COMPOSED}</p>`
    const { starts, ends } = find(text, `caf${DECOMPOSED}`)
    expect(starts).toEqual([3])
    const bytes = new TextEncoder().encode(text)
    expect(new TextDecoder().decode(bytes.subarray(starts[0]!, ends[0]!))).toBe(`caf${COMPOSED}`)
  })

  it('finds both spellings in one document, each at its own offset', () => {
    const text = `<a>caf${COMPOSED}</a><b>cafe\u0301</b>`
    const { starts, ends } = find(text, `caf${COMPOSED}`)
    expect(starts).toHaveLength(2)
    const bytes = new TextEncoder().encode(text)
    expect(new TextDecoder().decode(bytes.subarray(starts[0]!, ends[0]!))).toBe(`caf${COMPOSED}`)
    expect(new TextDecoder().decode(bytes.subarray(starts[1]!, ends[1]!))).toBe(`cafe\u0301`)
  })

  it('offsets stay right when decomposed text precedes the match', () => {
    // The case a naive implementation gets wrong: each of the twenty
    // decomposed characters before the match loses a code unit to NFC, so an
    // index taken from the normalized text and used unmapped lands twenty
    // characters short. The needle is non-ASCII so this actually goes through
    // the normalizing path \u2014 an ASCII needle would take the byte path and
    // prove nothing.
    const prefix = 'e\u0301'.repeat(20)
    const text = `${prefix}caf${COMPOSED}`
    const { starts, ends } = find(text, `caf${COMPOSED}`)
    expect(starts).toHaveLength(1)
    const bytes = new TextEncoder().encode(text)
    expect(new TextDecoder().decode(bytes.subarray(starts[0]!, ends[0]!))).toBe(`caf${COMPOSED}`)
    // And the offset is the real one, not the normalized-string index.
    expect(starts[0]).toBe(new TextEncoder().encode(prefix).length)
  })

  it('resolves a canonical singleton in both directions', () => {
    expect(find(`x${ANGSTROM}y`, A_RING).starts).toHaveLength(1)
    expect(find(`x${A_RING}y`, ANGSTROM).starts).toHaveLength(1)
  })

  it('leaves an ASCII needle exactly as permissive as it was', () => {
    // The needle gate. `cafe` matches the decomposed spelling character for
    // character today; normalizing the window would compose it away and the
    // match would disappear. NFC can never add an ASCII character back.
    expect(find(`caf${DECOMPOSED}`, 'cafe').starts).toEqual([0])
    expect(find(`caf${COMPOSED}`, 'cafe').starts).toEqual([])
  })

  it('leaves an ASCII regex counting characters the way it always did', () => {
    // `.` sees two characters in the decomposed spelling and one in the
    // composed. Normalizing for an ASCII pattern would silently change what
    // an existing regex matches, which is worse than neutral.
    expect(find('e\u0301', '^e.$', { regex: true }).starts).toEqual([0])
  })

  it('still finds a match that spans a window boundary', () => {
    // Windows overlap by one row; the map is per window, so a match claimed
    // by the next window must still map through that window's own map.
    const filler = 'x'.repeat(200_000)
    const text = `${filler} caf${DECOMPOSED} ${filler}`
    const { starts, ends } = find(text, `caf${COMPOSED}`)
    expect(starts).toHaveLength(1)
    const bytes = new TextEncoder().encode(text)
    expect(new TextDecoder().decode(bytes.subarray(starts[0]!, ends[0]!))).toBe(`caf${DECOMPOSED}`)
  })
})

describe('R205 — plain case-insensitive search is a literal regex', () => {
  // These all use a non-ASCII needle on purpose: an ASCII needle takes the
  // byte path, which R205 did not touch.
  const E = 'é'

  it('treats every regex metacharacter in the needle as a literal', () => {
    // The whole risk of making plain search a regex. Each of these would be
    // a pattern rather than a character if the escape were missing.
    const BACKSLASH = String.fromCharCode(92)
    for (const meta of [
      '.',
      '*',
      '+',
      '?',
      '^',
      '$',
      '{',
      '}',
      '(',
      ')',
      '|',
      '[',
      ']',
      BACKSLASH
    ]) {
      const needle = `a${meta}${E}`
      expect(find(`x${needle}y`, needle).starts, meta).toHaveLength(1)
      // And it must not match the same text with a different character where
      // the metacharacter is.
      expect(find(`xaZ${E}y`, needle).starts, meta).toHaveLength(0)
    }
  })

  it('keeps overlapping matches, which advancing by the match length would drop', () => {
    // `decodedTextMatches`' regex branch advances `lastIndex` by the match;
    // this one must advance by one. The plain path has always allowed
    // overlaps, "same as the byte path", and losing them would be a silent
    // change in the count.
    expect(find(`${E}aaa`, `${E}a`).starts).toHaveLength(1)
    expect(find(`aaaa${E}`, `aa`).starts.length).toBeGreaterThan(1)
    expect(find(`${E}${E}${E}`, `${E}${E}`).starts).toHaveLength(2)
  })

  it('folds case through the engine, the same way .* mode does', () => {
    const plain = find(`CAFÉ caf${E}`, `caf${E}`).starts
    const regex = find(`CAFÉ caf${E}`, `caf${E}`, { regex: true }).starts
    expect(plain).toEqual(regex)
    expect(plain).toHaveLength(2)
  })

  it('case-sensitive plain search still takes the indexOf path, and stays exact', () => {
    expect(find(`CAFÉ caf${E}`, `caf${E}`, { caseSensitive: true }).starts).toHaveLength(1)
  })

  it('an empty needle finds nothing rather than everything', () => {
    expect(find(`caf${E}`, '').starts).toHaveLength(0)
  })
})
