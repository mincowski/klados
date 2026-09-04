import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import {
  collectColumns,
  collectGroupMembers,
  type GridColumn
} from '../src/renderer/components/Detail/gridColumns'
import {
  estimateExportBytes,
  exportGrid,
  GRID_EXPORT_CONFIRM_ROWS
} from '../src/renderer/components/Detail/gridExport'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  xmlFormatModule.parse(bytes, store, xmlOptions)
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

const ROOT = 0

function setup(text: string): {
  store: NodeStore
  source: SourceBuffer
  members: number[]
  columns: readonly GridColumn[]
  indices: number[]
} {
  const { store, source } = parseXml(text)
  const garage = store.firstChildOf(ROOT)
  const carNameId = store.nameIdOf(store.firstChildOf(garage))
  const members = collectGroupMembers(store, garage, carNameId)
  const columns = collectColumns(store, members).columns
  const indices = members.map((_, i) => i)
  return { store, source, members, columns, indices }
}

describe('exportGrid (M2-PLAN.md E8)', () => {
  it('CSV: header row plus one row per member, comma-delimited', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><name>Golf</name><year>2019</year></car>' +
        '<car><name>Polo</name><year>2015</year></car></garage>'
    )
    const csv = exportGrid(store, source, members, indices, columns, 'csv')
    expect(csv).toBe('name,year\r\nGolf,2019\r\nPolo,2015')
  })

  it('TSV: tab-delimited', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><name>Golf</name><year>2019</year></car></garage>'
    )
    const tsv = exportGrid(store, source, members, indices, columns, 'tsv')
    expect(tsv).toBe('name\tyear\r\nGolf\t2019')
  })

  it('Markdown: a pipe table with a separator row', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><name>Golf</name><year>2019</year></car></garage>'
    )
    const md = exportGrid(store, source, members, indices, columns, 'markdown')
    expect(md).toBe('| name | year |\n| --- | --- |\n| Golf | 2019 |')
  })

  it('CSV quotes a field containing the delimiter, doubling embedded quotes', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><name>Golf, 2-door "GTI"</name></car></garage>'
    )
    const csv = exportGrid(store, source, members, indices, columns, 'csv')
    expect(csv).toBe('name\r\n"Golf, 2-door ""GTI"""')
  })

  it('CSV quotes a field containing an embedded newline', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><name>line1\nline2</name></car></garage>'
    )
    const csv = exportGrid(store, source, members, indices, columns, 'csv')
    expect(csv).toContain('"line1\nline2"')
  })

  it('TSV does not quote a field merely containing a comma', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><name>Golf, GTI</name></car></garage>'
    )
    const tsv = exportGrid(store, source, members, indices, columns, 'tsv')
    expect(tsv).toBe('name\r\nGolf, GTI')
  })

  it('Markdown escapes a literal pipe in a cell', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><name>Golf | GTI</name></car></garage>'
    )
    const md = exportGrid(store, source, members, indices, columns, 'markdown')
    expect(md).toContain('Golf \\| GTI')
  })

  it('exports the displayed order, not necessarily document order', () => {
    const { store, source, members, columns } = setup(
      '<garage><car><name>Golf</name></car><car><name>Polo</name></car></garage>'
    )
    const reversed = exportGrid(store, source, members, [1, 0], columns, 'csv')
    expect(reversed).toBe('name\r\nPolo\r\nGolf')
  })

  it('copies derived summaries as displayed (v1 rule) — knowingly imperfect', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><engine><type>diesel</type><kw>110</kw></engine></car></garage>'
    )
    const csv = exportGrid(store, source, members, indices, columns, 'csv')
    expect(csv).toBe('engine\r\ndiesel · 110')
  })
})

// Export builds the whole result as one JS string, and a JS string is UTF-16
// — measured at ~8 s and ~97 MB on cars-200mb.xml, from a button with no
// warning. Above the threshold the UI asks first (§11.2's soft-cap shape).
describe('export size guard (M2 review)', () => {
  const DOC =
    '<garage><car><name>Golf</name><year>2019</year></car>' +
    '<car><name>Polo</name><year>2015</year></car>' +
    '<car><name>Panda</name><year>2011</year></car></garage>'

  it('estimates output size without building the string', () => {
    const { store, source, members, columns, indices } = setup(DOC)
    const estimated = estimateExportBytes(store, source, members, indices, columns)
    const actual = exportGrid(store, source, members, indices, columns, 'csv').length * 2

    // A sampled estimate, not an exact count — within 2x either way is all
    // it needs to be for a "this will cost about N" confirmation.
    expect(estimated).toBeGreaterThan(actual / 2)
    expect(estimated).toBeLessThan(actual * 2)
  })

  it('scales with row count', () => {
    const { store, source, members, columns } = setup(DOC)
    const one = estimateExportBytes(store, source, members, [0], columns)
    const three = estimateExportBytes(store, source, members, [0, 1, 2], columns)
    expect(three).toBeGreaterThan(one * 2)
  })

  it('an empty selection estimates nothing', () => {
    const { store, source, members, columns } = setup(DOC)
    expect(estimateExportBytes(store, source, members, [], columns)).toBe(0)
  })

  it('the confirmation threshold is a real bound, not disabled', () => {
    expect(GRID_EXPORT_CONFIRM_ROWS).toBeGreaterThan(0)
    expect(Number.isFinite(GRID_EXPORT_CONFIRM_ROWS)).toBe(true)
  })
})

// R39 (`R39-grid-followups.md`, D-068): a presence-marker cell used to
// collapse into the same blank field as a genuinely `Absent` one. Every
// fixture's "absent" rows carry an unrelated field (`name`) so they still
// qualify as group members (`collectGroupMembers` requires `hasChildren`) —
// only `sunroof` itself is missing on them.
describe('exportGrid — presence markers (R39)', () => {
  it('a genuinely boolean-shaped column exports true/false', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><sunroof/><name>Golf</name></car><car><name>Polo</name></car></garage>'
    )
    const csv = exportGrid(store, source, members, indices, columns, 'csv')
    expect(csv).toBe('sunroof,name\r\ntrue,Golf\r\nfalse,Polo')
  })

  it('markdown renders the marker as ✓ and absent as empty', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><sunroof/><name>Golf</name></car><car><name>Polo</name></car></garage>'
    )
    const md = exportGrid(store, source, members, indices, columns, 'markdown')
    expect(md).toBe('| sunroof | name |\n| --- | --- |\n| ✓ | Golf |\n|  | Polo |')
  })

  it('the same column with one row given real text declines boolean classification', () => {
    const { store, source, members, columns, indices } = setup(
      '<garage><car><sunroof/><name>Golf</name></car>' +
        '<car><name>Polo</name></car>' +
        '<car><sunroof>tinted</sunroof><name>Panda</name></car></garage>'
    )
    const csv = exportGrid(store, source, members, indices, columns, 'csv')
    // marker row -> 'true', absent row -> '' (not boolean-shaped, since one
    // row has real text), text row -> the text itself.
    expect(csv).toBe('sunroof,name\r\ntrue,Golf\r\n,Polo\r\ntinted,Panda')
  })

  it('exact classification holds even when the marker rows sit past a plausible sample window', () => {
    const cars: string[] = []
    for (let i = 0; i < 5010; i++) cars.push('<car><name>x</name></car>')
    cars.push('<car><sunroof/><name>x</name></car>')
    const { store, source, members, columns, indices } = setup(`<garage>${cars.join('')}</garage>`)
    const csv = exportGrid(store, source, members, indices, columns, 'csv')
    const lines = csv.split('\r\n')
    // `name` appears first (present on row 1), `sunroof` only from row
    // 5011 on — first-appearance column order, `gridColumns.ts`'s own rule.
    expect(lines[0]).toBe('name,sunroof')
    // A sampled classifier (e.g. `isNumericColumn`'s 200-row/5000-scan
    // sample) would have already committed to "not boolean" before row
    // 5011 revealed the marker — this asserts the exact answer instead.
    expect(lines.slice(1, 5011).every((l) => l === 'x,false')).toBe(true)
    expect(lines[5011]).toBe('x,true')
  })
})
