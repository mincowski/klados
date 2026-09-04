import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selectFormat } from '../src/formats/registry'
import { csvFormatModule } from '../src/formats/csv/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { tomlFormatModule } from '../src/formats/toml/index'
import { xmlFormatModule } from '../src/formats/xml/index'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function headOf(filePath: string): Uint8Array {
  return new Uint8Array(readFileSync(filePath)).subarray(0, 64 * 1024)
}

describe('selectFormat', () => {
  it('selects XML for a .xml filename', () => {
    expect(selectFormat(utf8('<a/>'), 'data.xml')).toBe(xmlFormatModule)
  })

  it('selects JSON for a .json filename', () => {
    expect(selectFormat(utf8('{}'), 'data.json')).toBe(jsonFormatModule)
  })

  it('selects XML for an extensionless file starting with <', () => {
    expect(selectFormat(utf8('<a/>'), null)).toBe(xmlFormatModule)
    expect(selectFormat(utf8('<a/>'), 'noext')).toBe(xmlFormatModule)
  })

  it('selects JSON for an extensionless file starting with { or [', () => {
    expect(selectFormat(utf8('{"a":1}'), null)).toBe(jsonFormatModule)
    expect(selectFormat(utf8('[1,2]'), null)).toBe(jsonFormatModule)
  })

  it('returns null for plain text', () => {
    expect(selectFormat(utf8('just some text'), null)).toBeNull()
    expect(selectFormat(utf8('just some text'), 'notes.txt')).toBeNull()
  })

  it('selects CSV for .csv/.tsv/.tab filenames', () => {
    expect(selectFormat(utf8('a,b\n1,2\n'), 'data.csv')).toBe(csvFormatModule)
    expect(selectFormat(utf8('a\tb\n1\t2\n'), 'data.tsv')).toBe(csvFormatModule)
    expect(selectFormat(utf8('a,b\n1,2\n'), 'data.tab')).toBe(csvFormatModule)
  })
})

describe('selectFormat — R148 §5: CSV is extension-only, never by content (acceptance 9)', () => {
  it('every existing fixture still resolves to its own format, unaffected by CSV registration', () => {
    expect(selectFormat(headOf('test/fixtures/confusables.xml'), 'confusables.xml')).toBe(
      xmlFormatModule
    )
    expect(selectFormat(headOf('test/fixtures/toml/cargo-style.toml'), 'cargo-style.toml')).toBe(
      tomlFormatModule
    )
    expect(
      selectFormat(headOf('test/fixtures/toml/grammar-coverage.toml'), 'grammar-coverage.toml')
    ).toBe(tomlFormatModule)
  })

  it('a comma-and-newline-shaped file with no recognized extension resolves to null, not CSV', () => {
    const tabular = utf8('name,age,city\nAlice,30,NYC\nBob,25,LA\nCarol,40,SF\n')
    expect(selectFormat(tabular, null)).toBeNull()
    expect(selectFormat(tabular, 'export.txt')).toBeNull()
    expect(selectFormat(tabular, 'export.dat')).toBeNull()
  })

  it('an XML file whose content happens to be comma-heavy still resolves to XML, not CSV', () => {
    const source = utf8('<row a="1,2,3" b="4,5,6"><cell>x,y,z</cell></row>')
    expect(selectFormat(source, 'data.xml')).toBe(xmlFormatModule)
  })

  it('a JSON file with tabular-looking string content still resolves to JSON, not CSV', () => {
    const source = utf8('{"csv": "a,b,c\\n1,2,3\\n"}')
    expect(selectFormat(source, 'data.json')).toBe(jsonFormatModule)
  })
})
