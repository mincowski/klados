import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, type ParseOptions } from '../src/core/types'
import { csvFormatModule } from '../src/formats/csv/index'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const defaultOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseCsv(text: string): {
  store: NodeStore
  source: Uint8Array
  result: ReturnType<typeof csvFormatModule.parse>
} {
  const source = utf8(text)
  const store = new NodeStore(source, new Interner())
  const result = csvFormatModule.parse(source, store, defaultOptions)
  return { store, source, result }
}

function fieldValue(
  store: NodeStore,
  source: Uint8Array,
  row: number,
  columnIndex: number
): string {
  const attrs = [...store.attributesOf(row)]
  const attr = attrs[columnIndex]!
  return new TextDecoder().decode(source.subarray(attr.valueStart, attr.valueEnd))
}

describe('csvFormatModule node model (§2)', () => {
  it('produces Document -> Array -> Object rows, fields as facets', () => {
    const { store } = parseCsv('a,b,c\n1,2,3\n4,5,6\n')
    const doc = 0
    expect(store.kindOf(doc)).toBe(NodeKind.Document)
    const arr = store.firstChildOf(doc)
    expect(store.kindOf(arr)).toBe(NodeKind.Array)
    const row1 = store.firstChildOf(arr)
    expect(store.kindOf(row1)).toBe(NodeKind.Object)
    expect(store.firstChildOf(row1)).toBe(-1) // no child nodes, only facets
    const row2 = store.nextSiblingOf(row1)
    expect(store.kindOf(row2)).toBe(NodeKind.Object)
    expect(store.nextSiblingOf(row2)).toBe(-1)
  })

  it('a 2,000-row file produces exactly 2,001 nodes and rows*columns facets (acceptance 5, reduced N)', () => {
    const rows = 2000
    const cols = 4
    let text = 'c0,c1,c2,c3\n'
    for (let r = 0; r < rows; r++) text += `${r},${r + 1},${r + 2},${r + 3}\n`
    const { store } = parseCsv(text)
    // Document + Array + rows
    expect(store.nodeCount).toBe(2 + rows)
    let attrCount = 0
    const arr = store.firstChildOf(0)
    for (let row = store.firstChildOf(arr); row !== -1; row = store.nextSiblingOf(row)) {
      attrCount += [...store.attributesOf(row)].length
    }
    expect(attrCount).toBe(rows * cols)
  })

  it('header bytes are interned once per column (acceptance 6)', () => {
    const rows = 500
    let text = 'name,age,city\n'
    for (let r = 0; r < rows; r++) text += `p${r},${r},town\n`
    const source = utf8(text)
    const interner = new Interner()
    const store = new NodeStore(source, interner)
    csvFormatModule.parse(source, store, defaultOptions)
    // 3 column names, one interned id each — field values are spans, never interned.
    expect(interner.size).toBe(3)
  })
})

describe('csvFormatModule — quoting and escapes (acceptance 3)', () => {
  it('round-trips a field containing the delimiter, a doubled quote, and an embedded CRLF, with exact byte spans', () => {
    const text = 'a,b\n"x,y""z",tail\r\n"multi\r\nline",end\n'
    const { store, source } = parseCsv(text)
    const arr = store.firstChildOf(0)
    const row1 = store.firstChildOf(arr)
    const attrs = [...store.attributesOf(row1)]
    expect(attrs.length).toBe(2)
    const field0 = new TextDecoder().decode(
      source.subarray(attrs[0]!.valueStart, attrs[0]!.valueEnd)
    )
    expect(field0).toBe('x,y""z') // quotes excluded from span, doubled-quote left undecoded
    const field1 = new TextDecoder().decode(
      source.subarray(attrs[1]!.valueStart, attrs[1]!.valueEnd)
    )
    expect(field1).toBe('tail')

    const row2 = store.nextSiblingOf(row1)
    const attrs2 = [...store.attributesOf(row2)]
    const multi = new TextDecoder().decode(
      source.subarray(attrs2[0]!.valueStart, attrs2[0]!.valueEnd)
    )
    expect(multi).toBe('multi\r\nline')
  })

  it('closes an unterminated quote at EOF and emits an Error, keeping the partial tree', () => {
    const { store, result } = parseCsv('a,b\n"unterminated,x')
    expect(result.diagnosticCount).toBeGreaterThan(0)
    const arr = store.firstChildOf(0)
    const row1 = store.firstChildOf(arr)
    expect(row1).not.toBe(-1)
  })
})

describe('csvFormatModule — ragged rows (acceptance 8)', () => {
  it('a short row keeps the row and leaves missing fields absent, not empty', () => {
    const { store, result, source } = parseCsv('a,b,c\n1,2\n')
    // The row's own warning, plus R199's one summary for the file. Both:
    // the first answers *where*, the second answers *what*.
    expect(result.diagnosticCount).toBe(2)
    expect(store.diagnostics.map((d) => d.code)).toContain('csv.ragged-rows')
    const arr = store.firstChildOf(0)
    const row1 = store.firstChildOf(arr)
    const attrs = [...store.attributesOf(row1)]
    expect(attrs.length).toBe(2) // only a and b present, c is absent (not emitted at all)
    expect(fieldValue(store, source, row1, 0)).toBe('1')
    expect(fieldValue(store, source, row1, 1)).toBe('2')
  })

  it('a long row keeps the extra field(s) and warns', () => {
    const { store, result } = parseCsv('a,b\n1,2,3\n')
    expect(result.diagnosticCount).toBe(2)
    const arr = store.firstChildOf(0)
    const row1 = store.firstChildOf(arr)
    expect([...store.attributesOf(row1)].length).toBe(3)
  })

  it('the per-row message points at the Raw view, where the extras are readable', () => {
    // R199 acceptance 3. The grid cannot show a second unheadered extra —
    // nothing in the file names it — so the message must not leave a reader
    // believing the value was dropped. It was not: it is in the store, in
    // the bytes, and byte-identical on save.
    const { store } = parseCsv('a,b\n1,2,3,4\n')
    const longRow = store.diagnostics.find((d) => d.code === 'csv.long-row')!
    expect(longRow.message).toContain('Raw view')
  })

  it('summarizes the file once, naming the header width and the counts', () => {
    // R199 acceptance 2. The per-row entries are the flood; this is the
    // finding. R200 caps the former, which is what makes the latter legible.
    const rows = ['a,b,c']
    for (let i = 0; i < 400; i++) rows.push(i % 4 === 0 ? '1,2' : '1,2,3,4')
    const { store } = parseCsv(rows.join('\n') + '\n')

    const summary = store.diagnostics.filter((d) => d.code === 'csv.ragged-rows')
    expect(summary).toHaveLength(1)
    expect(summary[0]!.message).toContain('3 column(s)')
    expect(summary[0]!.message).toContain('300 row(s) have more fields')
    expect(summary[0]!.message).toContain('100 row(s) have fewer')
    // Anchored on the header row, whose width it reports.
    expect(summary[0]!.offset).toBe(0)
    expect(summary[0]!.length).toBe('a,b,c\n'.length)
  })

  it('every extra field reaches the store, however many there are', () => {
    // R199 acceptance 4, asserted **on the store** rather than on the grid.
    // This pins the claim that the collapse is a display projection, and
    // stops a later round "fixing" it by dropping fields at parse time.
    const { store, source } = parseCsv('a,b\n1,2,3,4,5\n')
    const row1 = store.firstChildOf(store.firstChildOf(0))
    const attrs = [...store.attributesOf(row1)]
    expect(attrs.length).toBe(5)
    expect(attrs.map((_, i) => fieldValue(store, source, row1, i))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5'
    ])
  })

  it('a one-column file with no delimiter parses with no diagnostic (acceptance 2)', () => {
    const { store, result } = parseCsv('name\nAlice\nBob\n')
    // No ragged row, so no summary either — the file is well formed.
    expect(result.diagnosticCount).toBe(0)
    const arr = store.firstChildOf(0)
    const row1 = store.firstChildOf(arr)
    expect([...store.attributesOf(row1)].length).toBe(1)
  })
})

describe('csvFormatModule — headerless files (§3, acceptance 7)', () => {
  it('discloses when row 1 was assumed to be a header with no supporting evidence', () => {
    const { result, store } = parseCsv('1,2,3\n4,5,6\n7,8,9\n10,11,12\n')
    expect(result.diagnosticCount).toBe(1)
    // Still opens with a populated grid: row 1's values become column names,
    // and rows 2-4 remain as records.
    const arr = store.firstChildOf(0)
    let rowCount = 0
    for (let row = store.firstChildOf(arr); row !== -1; row = store.nextSiblingOf(row)) rowCount++
    expect(rowCount).toBe(3)
  })

  it('emits no extra diagnostic for a real header row', () => {
    const { result } = parseCsv('name,age\nAlice,30\nBob,25\n')
    expect(result.diagnosticCount).toBe(0)
  })
})

describe('csvFormatModule.parseRange — incremental reparse', () => {
  it('reparsing a single row produces the same facets as a full parse', () => {
    const text = 'a,b,c\n1,2,3\n4,5,6\n7,8,9\n'
    const source = utf8(text)
    const full = new NodeStore(source, new Interner())
    csvFormatModule.parse(source, full, defaultOptions)
    const arr = full.firstChildOf(0)
    const row2 = full.nextSiblingOf(full.firstChildOf(arr))
    const span = full.spanOf(row2)

    const partial = new NodeStore(source, new Interner())
    const context = csvFormatModule.resumeContextFor({
      length: 0,
      kindAt: () => NodeKind.Array,
      spanStartAt: () => 0,
      spanEndAt: () => 0,
      attributesAt: () => []
    })
    const result = csvFormatModule.parseRange(
      source,
      span.start,
      span.end,
      partial,
      context,
      defaultOptions
    )
    expect(result.complete).toBe(true)
    expect(result.bytesConsumed).toBe(span.end)
    const reRow = 0 // parseRange opens exactly one node: the row itself
    const origAttrs = [...full.attributesOf(row2)]
    const newAttrs = [...partial.attributesOf(reRow)]
    expect(newAttrs.length).toBe(origAttrs.length)
    for (let i = 0; i < origAttrs.length; i++) {
      expect(newAttrs[i]!.valueStart).toBe(origAttrs[i]!.valueStart)
      expect(newAttrs[i]!.valueEnd).toBe(origAttrs[i]!.valueEnd)
    }
  })
})

describe('csvFormatModule.detect', () => {
  it('matches .csv/.tsv/.tab filenames strongly, and never sniffs content', () => {
    expect(csvFormatModule.detect(utf8('a,b,c\n1,2,3\n'), 'data.csv')).toBe(0.9)
    expect(csvFormatModule.detect(utf8('a\tb\n1\t2\n'), 'data.tsv')).toBe(0.9)
    expect(csvFormatModule.detect(utf8('a,b,c\n1,2,3\n'), 'data.tab')).toBe(0.9)
    expect(csvFormatModule.detect(utf8('a,b,c\n1,2,3\n'), null)).toBe(0)
    expect(csvFormatModule.detect(utf8('a,b,c\n1,2,3\n'), 'export.txt')).toBe(0)
  })
})
