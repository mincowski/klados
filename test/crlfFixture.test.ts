/**
 * R179 (`docs/plans/R179-crlf-caret-position.md`) — guards the CRLF fixture
 * against the repository's own line-ending policy.
 *
 * `.gitattributes` sets `* text=auto eol=lf` (R47), which normalizes every
 * tracked text file to LF on commit and on checkout. A fixture whose entire
 * purpose is that it contains CRLF is therefore one careless commit away from
 * being stored as LF — and the failure is silent in the worst way: the file is
 * still named `crlf/`, still parses, still looks right in a diff, and every test
 * built on it still passes while asserting nothing about CRLF at all.
 *
 * The `-text` exemption is what prevents that. This asserts the exemption is in
 * force *as checked out on this machine*, which is the only thing that matters
 * to the tests that consume it and the only check that catches the policy being
 * changed back. It runs on all three CI platforms, so a normalization that only
 * happens on one of them cannot hide.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const FIXTURE = 'test/fixtures/crlf/small.json'

/** Counts the three endings separately — `\r\n`, a `\n` with no `\r` before it,
 * and a `\r` with no `\n` after it. The last one matters because R179's defect
 * produces exactly that: a CR stranded by an edit placed inside the pair. */
function countEndings(bytes: Buffer): { crlf: number; bareLf: number; bareCr: number } {
  let crlf = 0
  let bareLf = 0
  let bareCr = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      if (i > 0 && bytes[i - 1] === 0x0d) crlf++
      else bareLf++
    } else if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) {
      bareCr++
    }
  }
  return { crlf, bareLf, bareCr }
}

describe('R179 — the CRLF fixture survives checkout as CRLF', () => {
  const bytes = readFileSync(FIXTURE)
  const endings = countEndings(bytes)

  it('every line ending is a CRLF pair', () => {
    // The assertion that fails if `.gitattributes`' `-text` exemption is ever
    // dropped: `eol=lf` would turn all eleven pairs into bare LFs.
    expect(endings.crlf).toBeGreaterThan(0)
    expect(endings.bareLf).toBe(0)
  })

  it('no line ending is half a pair', () => {
    // R179's defect signature. Not a normalization check — a check that the
    // fixture has not been re-saved by an editor that landed a caret inside a
    // CRLF, which is precisely how the original file was damaged.
    expect(endings.bareCr).toBe(0)
  })

  it('is valid JSON, so a parse failure means the content and not the endings', () => {
    expect(() => JSON.parse(bytes.toString('utf8'))).not.toThrow()
  })
})
