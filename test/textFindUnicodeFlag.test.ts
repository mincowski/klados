/**
 * R241 (`docs/plans/R241-regex-unicode-flag.md` §7) — Find under the `u`
 * flag: one fold, Unicode simple case folding, in both modes.
 *
 * Fixtures are built from `\u{…}` escapes and guarded by code point, per
 * `docs/FINDINGS.md` (an editor or tool that normalizes text would otherwise
 * make a test pass on characters it no longer contains).
 */
import { describe, expect, it } from 'vitest'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import {
  chooseFindPath,
  compileFindPattern,
  decodedTextMatches,
  findAll,
  holdsAsciiFoldTargets,
  knownAsciiFoldTargets,
  mayHoldAsciiFoldTargets,
  rewriteHarmlessEscapes,
  type TextFindOptions
} from '../src/core/textFind'

const CI_PLAIN: TextFindOptions = { caseSensitive: false, regex: false }
const CI_REGEX: TextFindOptions = { caseSensitive: false, regex: true }
const CS_PLAIN: TextFindOptions = { caseSensitive: true, regex: false }
const CS_REGEX: TextFindOptions = { caseSensitive: true, regex: true }

function utf8Document(text: string): { bytes: Uint8Array; rowIndex: Int32Array } {
  const bytes = new TextEncoder().encode(text)
  return { bytes, rowIndex: buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [0x20]) }
}

function find(text: string, needle: string, options: TextFindOptions): number[][] {
  const { bytes, rowIndex } = utf8Document(text)
  const result = findAll(bytes, rowIndex, 'utf-8', needle, options)
  return Array.from(result.starts, (start, i) => [start, result.ends[i]!])
}

/** Every code point that case mapping touches: the set R239 §6.4 measured. */
function caseCodePoints(): string[] {
  const chars: string[] = []
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const c = String.fromCodePoint(cp)
    if (c.toLowerCase() !== c || c.toUpperCase() !== c) chars.push(c)
  }
  return chars
}

describe('R241 — plain and regex mode agree on every pair (criterion 1)', () => {
  const chars = caseCodePoints()
  const text = chars.join(' ')

  it('covers the set R239 §6.4 measured, KELVIN SIGN and LONG S among it', () => {
    expect(chars.length).toBe(3037)
    expect(chars).toContain('\u{212A}')
    expect(chars).toContain('\u{017F}')
  })

  it('every case code point finds the same matches in both modes', () => {
    const disagreements: string[] = []
    for (const c of chars) {
      const plain = find(text, c, CI_PLAIN)
      const regex = find(text, c, CI_REGEX)
      if (JSON.stringify(plain) !== JSON.stringify(regex)) {
        disagreements.push(`U+${c.codePointAt(0)!.toString(16).toUpperCase()}`)
      }
    }
    expect(disagreements).toEqual([])
  })

  it('k, K, s and S find KELVIN SIGN and LONG S in both modes', () => {
    const doc = 'k K \u{212A} s S \u{017F}'
    for (const needle of ['k', 'K']) {
      expect(find(doc, needle, CI_PLAIN), needle).toEqual(find(doc, needle, CI_REGEX))
      expect(find(doc, needle, CI_PLAIN).length, needle).toBe(3)
    }
    for (const needle of ['s', 'S']) {
      expect(find(doc, needle, CI_PLAIN), needle).toEqual(find(doc, needle, CI_REGEX))
      expect(find(doc, needle, CI_PLAIN).length, needle).toBe(3)
    }
  })
})

describe('R241 — path choice (criterion 10)', () => {
  // The plan expected `decoded` here. Measured in the renderer that cost 12×
  // the byte path, so §3's refinement applies: the byte path unless the
  // document can hold U+212A or U+017F (`byte-checked`).
  it('a case-insensitive ASCII needle holding k or s is checked against the document', () => {
    expect(chooseFindPath('status', CI_PLAIN)).toBe('byte-checked')
    expect(chooseFindPath('KEY', CI_PLAIN)).toBe('byte-checked')
    expect(chooseFindPath('s', CI_PLAIN)).toBe('byte-checked')
  })

  it('every other plain ASCII needle keeps the byte path', () => {
    expect(chooseFindPath('status', CS_PLAIN)).toBe('byte')
    expect(chooseFindPath('price', CI_PLAIN)).toBe('byte')
  })

  it('a regex or a non-ASCII needle takes the decoded path', () => {
    expect(chooseFindPath('status', CI_REGEX)).toBe('decoded')
    expect(chooseFindPath('caf\u{00E9}', CI_PLAIN)).toBe('decoded')
  })
})

describe('R241 §3 — whether a document can hold U+212A or U+017F', () => {
  const encode = (s: string): Uint8Array => new TextEncoder().encode(s)

  it('finds either sequence, including one that starts at the end of a range', () => {
    const kelvin = encode('ab\u{212A}')
    expect([...kelvin.slice(2)]).toEqual([0xe2, 0x84, 0xaa])
    expect(holdsAsciiFoldTargets(kelvin, 0, kelvin.length)).toBe(true)
    // Starts at 2, the last start in [0, 3): found, though it runs past 3.
    expect(holdsAsciiFoldTargets(kelvin, 0, 3)).toBe(true)
    expect(holdsAsciiFoldTargets(kelvin, 0, 2)).toBe(false)
    expect(holdsAsciiFoldTargets(encode('x\u{017F}'), 0, 3)).toBe(true)
  })

  it('does not take a lone lead byte, or other characters sharing one, for either', () => {
    // U+2122 TRADE MARK SIGN is E2 84 A2; U+0141 is C5 81.
    expect(holdsAsciiFoldTargets(encode('\u{2122} \u{0141}'), 0, 6)).toBe(false)
  })

  it('knows single-byte code pages cannot, and assumes other multi-byte ones can', () => {
    const bytes = encode('status')
    expect(knownAsciiFoldTargets(bytes, 'windows-1252')).toBe(false)
    expect(knownAsciiFoldTargets(bytes, 'iso-8859-2')).toBe(false)
    expect(knownAsciiFoldTargets(bytes, 'shift_jis')).toBe(true)
    expect(knownAsciiFoldTargets(bytes, 'gb18030')).toBe(true)
  })

  it('scans a UTF-8 buffer once and remembers it, per buffer', () => {
    const plain = encode('status')
    const holding = encode('\u{017F}tatus')
    expect(knownAsciiFoldTargets(plain, 'utf-8')).toBeNull()
    expect(mayHoldAsciiFoldTargets(plain, 'utf-8')).toBe(false)
    expect(knownAsciiFoldTargets(plain, 'utf-8')).toBe(false)
    expect(mayHoldAsciiFoldTargets(holding, 'utf-8')).toBe(true)
    expect(knownAsciiFoldTargets(holding, 'utf-8')).toBe(true)
    // A new buffer with the same text is a new question (an edit builds one).
    expect(knownAsciiFoldTargets(encode('status'), 'utf-8')).toBeNull()
  })

  it('findAll finds LONG S for "s" through the check, and plain ASCII without it', () => {
    expect(find('status \u{017F}tatus', 'status', CI_PLAIN)).toEqual([
      [0, 6],
      [7, 14]
    ])
    expect(find('status STATUS', 'status', CI_PLAIN)).toEqual([
      [0, 6],
      [7, 13]
    ])
  })
})

describe('R241 — \\p{Lu}+ under u (criterion 3)', () => {
  it('finds precomposed ÄÖÜ as one match of six bytes', () => {
    const precomposed = '\u{00C4}\u{00D6}\u{00DC}'
    expect([...precomposed].map((c) => c.codePointAt(0))).toEqual([0xc4, 0xd6, 0xdc])
    expect(find(precomposed, '\\p{Lu}+', CS_REGEX)).toEqual([[0, 6]])
  })

  it('finds the decomposed spelling as three matches, by design', () => {
    // R241 §2.4: the pattern is ASCII, so R204 does not normalize the window
    // (D-097: an ASCII needle pays for none of it), and a combining mark is
    // not `\p{Lu}`. Existing behaviour for ASCII patterns, not R241's to
    // change.
    const decomposed = 'A\u{0308}O\u{0308}U\u{0308}'
    expect(find(decomposed, '\\p{Lu}+', CS_REGEX)).toEqual([
      [0, 1],
      [3, 4],
      [6, 7]
    ])
  })
})

describe('R241 — every advance steps by code point (criteria 4 and 5)', () => {
  const EMOJI = '\u{1F600}'

  it('a zero-length match over an astral character never splits it', () => {
    const text = `a${EMOJI}b`
    expect(decodedTextMatches(text, 'x*', CS_REGEX).map((m) => m.index)).toEqual([0, 1, 3, 4])
    const bytes = new TextEncoder().encode(text)
    const starts = find(text, 'x*', CS_REGEX).map(([start]) => start!)
    expect(starts).toEqual([0, 1, 5, 6])
    for (const start of starts) {
      // Never inside a UTF-8 sequence: not a continuation byte.
      if (start < bytes.length) expect(bytes[start]! & 0xc0).not.toBe(0x80)
    }
  })

  it('a case-insensitive plain search for an emoji finds both and returns', () => {
    expect(decodedTextMatches(`${EMOJI}${EMOJI}`, EMOJI, CI_PLAIN)).toEqual([
      { index: 0, length: 2 },
      { index: 2, length: 2 }
    ])
    expect(find(`${EMOJI} ${EMOJI}`, EMOJI, CI_PLAIN)).toEqual([
      [0, 4],
      [5, 9]
    ])
  })

  it('overlapping plain matches are still all found', () => {
    expect(decodedTextMatches('aaa', 'aa', CI_PLAIN).map((m) => m.index)).toEqual([0, 1])
  })
})

describe('R241 — plain mode never reports an invalid pattern (criterion 7)', () => {
  it('every printable ASCII character compiles and finds itself', () => {
    for (let cp = 0x20; cp <= 0x7e; cp++) {
      const c = String.fromCharCode(cp)
      expect(() => decodedTextMatches(`x${c}y`, c, CI_PLAIN), c).not.toThrow()
      expect(decodedTextMatches(`x${c}y`, c, CI_PLAIN).length, c).toBeGreaterThan(0)
    }
  })

  it('non-ASCII needles, astral and lone surrogates included, compile', () => {
    for (const needle of ['caf\u{00E9}', '\u{65E5}\u{672C}', '\u{1F600}', '\uD800', '\uDC00']) {
      expect(() => decodedTextMatches(`x${needle}y`, needle, CI_PLAIN), needle).not.toThrow()
    }
  })
})

describe('R241 — astral scripts are found again, in both modes (criterion 15)', () => {
  const PAIRS: readonly (readonly [string, number, number])[] = [
    ['Deseret', 0x10400, 0x10428],
    ['Osage', 0x104b0, 0x104d8],
    ['Adlam', 0x1e900, 0x1e922]
  ]

  for (const [script, upper, lower] of PAIRS) {
    it(`${script}: U+${upper.toString(16).toUpperCase()} finds U+${lower.toString(16).toUpperCase()}`, () => {
      const needle = String.fromCodePoint(upper)
      const other = String.fromCodePoint(lower)
      expect(needle.codePointAt(0)).toBe(upper)
      expect(other.codePointAt(0)).toBe(lower)
      // The fold is real: the pair is a case pair.
      expect(needle.toLowerCase()).toBe(other)
      for (const options of [CI_PLAIN, CI_REGEX]) {
        expect(find(other, needle, options)).toEqual([[0, 4]])
        expect(find(needle, other, options)).toEqual([[0, 4]])
      }
    })
  }
})

describe('R241 §4a — harmless escapes keep their meaning (criterion 16)', () => {
  const SINGLE = [
    '\\-',
    '\\_',
    '\\:',
    '\\#',
    '\\@',
    '\\%',
    '\\=',
    '\\!',
    '\\,',
    '\\"',
    "\\'",
    '\\<',
    '\\>',
    '\\ ',
    '\\~',
    '\\`',
    '\\&',
    '\\;'
  ]
  const IN_CONTEXT = ['x\\-y', '\\d\\-\\d', '[\\:\\#]+', '\\.\\-']
  const IN_CLASS = ['[a\\-z]', '[\\-]', '[\\w\\-]+']
  const ALL = [...SINGLE, ...IN_CONTEXT, ...IN_CLASS, '\\\\-']
  const PROBE = 'x-y 1-2 a z w . _:#@%=!,"\'<> ~`&; .- \\- abc'

  function spans(regex: RegExp, text: string): string[] {
    return [...text.matchAll(regex)].map((m) => `${m.index}:${m[0].length}`)
  }

  it('lists §2.13’s 26 patterns', () => {
    expect(SINGLE.length).toBe(18)
    expect(ALL.length).toBe(26)
  })

  for (const pattern of ALL) {
    it(`${pattern} matches under u as it did without u`, () => {
      const compiled = compileFindPattern(pattern, true)
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) return
      const today = spans(new RegExp(pattern, 'g'), PROBE)
      expect(today.length, 'the probe holds what the pattern finds').toBeGreaterThan(0)
      expect(spans(compiled.regex, PROBE)).toEqual(today)
    })
  }

  it('22 of them throw under u without the rewrite', () => {
    const throwing = ALL.filter((p) => {
      try {
        new RegExp(p, 'gu')
        return false
      } catch {
        return true
      }
    })
    expect(throwing).toEqual([...SINGLE, ...IN_CONTEXT])
  })

  it('an escaped backslash is consumed with its escape, not misread', () => {
    expect(rewriteHarmlessEscapes('\\\\-')).toBe('\\\\-')
    expect(rewriteHarmlessEscapes('\\-')).toBe('\\x2d')
    expect(rewriteHarmlessEscapes('[a\\-z]')).toBe('[a\\x2dz]')
  })

  it('a non-ASCII identity escape becomes \\u{…}', () => {
    expect(rewriteHarmlessEscapes('\\\u{00E9}')).toBe('\\u{e9}')
    expect(rewriteHarmlessEscapes('\\\u{1F600}')).toBe('\\u{1f600}')
    const compiled = compileFindPattern('\\\u{1F600}', true)
    expect(compiled.ok && compiled.regex.test('\u{1F600}')).toBe(true)
  })

  it('what stays an error says why, as the engine words it', () => {
    const reasons: Record<string, string> = {
      'a(': 'Unterminated group',
      ']': 'Lone quantifier brackets',
      'a{': 'Incomplete quantifier',
      '[a-\\d]': 'Invalid character class',
      '\\k': 'Invalid named reference'
    }
    for (const [pattern, reason] of Object.entries(reasons)) {
      expect(compileFindPattern(pattern, false), pattern).toEqual({ ok: false, reason })
    }
  })
})
