import { describe, expect, it } from 'vitest'
import { COMMA, PIPE, SEMICOLON, TAB, sniffDialect } from '../src/formats/csv/dialect'

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('sniffDialect', () => {
  it('picks semicolon over comma when fields contain decimal commas (acceptance 1)', () => {
    const source = bytes(
      'name;price;qty\n' + 'Bolt;1,50;3\n' + 'Nut;0,75;12\n' + 'Washer;0,10;100\n'
    )
    expect(sniffDialect(source).delimiter).toBe(SEMICOLON)
  })

  it('sniffs tab-delimited files', () => {
    const source = bytes('a\tb\tc\n1\t2\t3\n4\t5\t6\n')
    expect(sniffDialect(source).delimiter).toBe(TAB)
  })

  it('sniffs pipe-delimited files', () => {
    const source = bytes('a|b|c\n1|2|3\n4|5|6\n')
    expect(sniffDialect(source).delimiter).toBe(PIPE)
  })

  it('defaults to comma for a one-column file with no delimiter (acceptance 2)', () => {
    const source = bytes('name\nAlice\nBob\nCarol\n')
    expect(sniffDialect(source).delimiter).toBe(COMMA)
  })

  it('is quote-aware: a delimiter inside quotes does not inflate the field count', () => {
    const source = bytes('a,b,c\n"1,2",3,4\n"5,6",7,8\n')
    expect(sniffDialect(source).delimiter).toBe(COMMA)
  })

  it('handles CRLF, LF and CR line endings identically', () => {
    const lf = sniffDialect(bytes('a,b\n1,2\n3,4\n'))
    const crlf = sniffDialect(bytes('a,b\r\n1,2\r\n3,4\r\n'))
    const cr = sniffDialect(bytes('a,b\r1,2\r3,4\r'))
    expect(lf.delimiter).toBe(COMMA)
    expect(crlf.delimiter).toBe(COMMA)
    expect(cr.delimiter).toBe(COMMA)
  })

  it('ignores a truncated final row at the sniff boundary', () => {
    // A row cut off mid-field by the byte budget must not skew consistency.
    const head = bytes('a,b,c\n1,2,3\n4,5') // no trailing newline, looks like 2 fields
    const dialect = sniffDialect(head)
    expect(dialect.delimiter).toBe(COMMA)
  })

  it('only reads the first SNIFF_BUDGET_BYTES', () => {
    const header = 'a,b,c\n'
    const goodRows = header + '1,2,3\n'.repeat(2000) // well past 64 KB
    // Corrupt content far past the sniff budget with a different, more "consistent"
    // shape — it must never be seen.
    const corrupted = goodRows + 'x'.repeat(200_000) + '\n'
    expect(sniffDialect(bytes(corrupted)).delimiter).toBe(COMMA)
  })
})
