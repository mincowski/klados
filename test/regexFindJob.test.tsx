/**
 * R239 (`docs/plans/R239-regex-find.md` §4, criteria 2 and 3): regex Find
 * through the real worker, in real Chromium.
 *
 * Criterion 3: the worker path returns exactly the in-thread path's
 * `starts`/`ends`, for every regex case `textFind.test.ts` has and for
 * non-ASCII needles over decomposed text from `textFindNormalization.test.ts`.
 * `findAll` is the reference: it runs the same three steps with the match on
 * this thread. The decomposed rows are the ones that would go red if the
 * worker were sent the raw decoded text instead of the normalized one.
 *
 * Fixtures are written from escapes, per `docs/FINDINGS.md`, and guarded.
 */
import { describe, expect, it } from 'vitest'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { findAll, type TextFindOptions } from '../src/core/textFind'
import {
  liveRegexFindWorkers,
  runRegexFindJob,
  type RegexFindValue
} from '../src/renderer/session/regexFindJob'

const COMPOSED = 'é'
const DECOMPOSED = 'é'
const ANGSTROM = 'Å'
const A_RING = 'Å'
const HANGUL_JAMO = '가'
const HANGUL_SYLLABLE = '가'

interface Row {
  readonly name: string
  readonly text: string
  readonly needle: string
  readonly options: TextFindOptions
  /** Row separators for `buildRowIndex`; the default is none. */
  readonly separators?: readonly number[]
}

const CS: TextFindOptions = { caseSensitive: true, regex: true }
const CI: TextFindOptions = { caseSensitive: false, regex: true }
const filler = 'x'.repeat(200_000)

const rows: readonly Row[] = [
  // textFind.test.ts
  { name: 'digits', text: 'a1 b22 c333', needle: '\\d+', options: CS },
  {
    name: 'many windows',
    text: Array.from({ length: 2000 }, (_, i) => (i % 37 === 0 ? 'needle' : `w${i}`)).join(' '),
    needle: 'needle',
    options: CS
  },
  { name: 'zero-length matches advance', text: 'baaab', needle: 'a*', options: CS },
  { name: 'case-insensitive', text: 'Cat cat CAT', needle: 'cat', options: CI },
  { name: 'invalid pattern finds nothing', text: 'a(b', needle: 'a(', options: CS },
  // textFindNormalization.test.ts, in regex mode
  { name: 'ASCII regex over a decomposed é', text: 'é', needle: '^e.$', options: CI },
  {
    name: 'composed needle, decomposed text',
    text: `caf${DECOMPOSED} and caf${COMPOSED}`,
    needle: `caf${COMPOSED}`,
    options: CI,
    separators: [0x20]
  },
  {
    name: 'case-folded across both spellings',
    text: `CAFÉ caf${DECOMPOSED}`,
    needle: `caf${COMPOSED}`,
    options: CI,
    separators: [0x20]
  },
  {
    name: 'canonical singleton',
    text: `${ANGSTROM}ngstr${COMPOSED}m ${A_RING}`,
    needle: A_RING,
    options: CS,
    separators: [0x20]
  },
  {
    name: 'Hangul jamo',
    text: `${HANGUL_JAMO} ${HANGUL_SYLLABLE}`,
    needle: HANGUL_SYLLABLE,
    options: CS,
    separators: [0x20]
  },
  {
    name: 'decomposed match across a window boundary',
    text: `${filler} caf${DECOMPOSED} ${filler}`,
    needle: `caf${COMPOSED}`,
    options: CI,
    separators: [0x20]
  }
]

function documentOf(row: Row): { bytes: Uint8Array; rowIndex: Int32Array } {
  const bytes = new TextEncoder().encode(row.text)
  return {
    bytes,
    rowIndex: buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [...(row.separators ?? [])])
  }
}

describe('R239 — the worker path matches the in-thread path (criterion 3)', () => {
  it('carries the code points it claims to', () => {
    expect([...DECOMPOSED].map((c) => c.codePointAt(0))).toEqual([0x65, 0x0301])
    expect(ANGSTROM.codePointAt(0)).toBe(0x212b)
    expect(DECOMPOSED.normalize('NFC')).toBe(COMPOSED)
    expect(ANGSTROM.normalize('NFC')).toBe(A_RING)
    expect(HANGUL_JAMO.normalize('NFC')).toBe(HANGUL_SYLLABLE)
  })

  for (const row of rows) {
    it(row.name, async () => {
      const { bytes, rowIndex } = documentOf(row)
      const reference = findAll(bytes, rowIndex, 'utf-8', row.needle, row.options)
      const value = await runRegexFindJob({
        bytes,
        rowIndex,
        encoding: 'utf-8',
        needle: row.needle,
        options: row.options
      }).result
      expect(value.timedOut).toBe(false)
      expect([...value.starts]).toEqual([...reference.starts])
      expect([...value.ends]).toEqual([...reference.ends])
      expect(liveRegexFindWorkers()).toBe(0)
    })
  }

  it('the decomposed rows find something, so their agreement is not two empty sets', () => {
    for (const row of rows.filter((r) => r.text.includes('́') && r.needle !== '^e.$')) {
      const { bytes, rowIndex } = documentOf(row)
      expect(
        findAll(bytes, rowIndex, 'utf-8', row.needle, row.options).starts.length,
        row.name
      ).toBeGreaterThan(0)
    }
  })
})

describe('R239 — a backtracking pattern stops at the deadline', () => {
  // `(a+)+$` against thirty `a` and a `b`: about 19 s on the renderer's main
  // thread (R239 §6). Earlier windows hold ordinary matches for it to keep.
  const lead = Array.from({ length: 40_000 }, () => 'b a b\n').join('')
  const text = `${lead}${'a'.repeat(30)}b\n`
  const bytes = new TextEncoder().encode(text)
  const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [0x0a])

  it('keeps the matches found before it and terminates the worker', async () => {
    const job = runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: '(a+)+$', options: CS },
      { deadlineMs: 300 }
    )
    const value: RegexFindValue = await job.result
    expect(value.timedOut).toBe(true)
    // `$` anchors to the end of a window (`textFind.ts`), and no window ends
    // in `a`, so nothing matches before the stuck one. The next test keeps
    // matches from earlier windows.
    expect(value.starts.length).toBe(0)
    expect(liveRegexFindWorkers()).toBe(0)
  })

  it('a pattern that also matches early keeps those matches', async () => {
    const job = runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'a b|(a+)+$', options: CS },
      { deadlineMs: 300 }
    )
    const value = await job.result
    expect(value.timedOut).toBe(true)
    // Every lead line holds `a b`. The 240 KB lead fills several windows
    // before the one with the stuck line, whose own matches are lost.
    expect(value.starts.length).toBeGreaterThan(0)
    expect(value.starts.length).toBeLessThan(40_000)
    expect(liveRegexFindWorkers()).toBe(0)
  })

  it('cancelling terminates the worker (criterion 2)', async () => {
    const job = runRegexFindJob({
      bytes,
      rowIndex,
      encoding: 'utf-8',
      needle: '(a+)+$',
      options: CS
    })
    const rejected = job.result.catch((reason: unknown) => reason)
    await expect.poll(() => liveRegexFindWorkers()).toBe(1)
    job.cancel()
    expect(liveRegexFindWorkers()).toBe(0)
    expect(((await rejected) as DOMException).name).toBe('AbortError')
  })
})
