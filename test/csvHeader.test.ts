import { describe, expect, it } from 'vitest'
import { detectHeader } from '../src/formats/csv/header'
import { sniffDialect, type CsvDialect } from '../src/formats/csv/dialect'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

interface FieldSpan {
  readonly start: number
  readonly end: number
}

/** Scans row 1 by hand (mirrors `index.ts`'s own unquoted-happy-path use) so tests can
 * pass real header spans without depending on the parser module. */
function scanHeaderRow(
  source: Uint8Array,
  dialect: CsvDialect
): { header: FieldSpan[]; end: number } {
  const header: FieldSpan[] = []
  let fieldStart = 0
  let i = 0
  while (i < source.length) {
    const b = source[i]!
    if (b === dialect.delimiter) {
      header.push({ start: fieldStart, end: i })
      i++
      fieldStart = i
      continue
    }
    if (b === 0x0a || b === 0x0d) {
      header.push({ start: fieldStart, end: i })
      i++
      if (source[i - 1] === 0x0d && source[i] === 0x0a) i++
      return { header, end: i }
    }
    i++
  }
  header.push({ start: fieldStart, end: i })
  return { header, end: i }
}

function detect(text: string): boolean {
  const source = utf8(text)
  const dialect = sniffDialect(source)
  const { header, end } = scanHeaderRow(source, dialect)
  return detectHeader(source, dialect, header, end)
}

describe('detectHeader', () => {
  it('detects a real header above a numeric column', () => {
    expect(detect('name,age,city\nAlice,30,NYC\nBob,25,LA\nCarol,40,SF\n')).toBe(true)
  })

  it('does not detect a header when row 1 looks exactly like the data (all-numeric)', () => {
    expect(detect('1,2,3\n4,5,6\n7,8,9\n10,11,12\n')).toBe(false)
  })

  it('defaults to true when there is only a header row and no data to compare', () => {
    expect(detect('name,age,city\n')).toBe(true)
  })

  it('defaults to true for an all-text table (ambiguous, no numeric contrast)', () => {
    expect(detect('name,city\nAlice,NYC\nBob,LA\nCarol,SF\n')).toBe(true)
  })

  it('detects a header when only some columns are numeric', () => {
    expect(detect('id,name,score\n1,Alice,9.5\n2,Bob,7.25\n3,Carol,8.0\n')).toBe(true)
  })
})
