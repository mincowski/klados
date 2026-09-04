/**
 * M6-PLAN.md R16 — the TOML formatter. Invariant-tested against a generated
 * corpus (M0-PLAN B12's rule), plus named cases for the specific scope this
 * formatter deliberately draws (see `toml/index.ts`'s own doc comment on
 * `format()`: inline table/array contents are copied verbatim, never
 * re-laid-out).
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { FormatOptions, ParseOptions } from '../src/core/types'
import { tomlFormatModule } from '../src/formats/toml/index'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const dec = new TextDecoder()
const PARSE_OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const FORMAT_OPTIONS: FormatOptions = { indent: '  ', newline: '\n' }

function format(source: Uint8Array): Uint8Array {
  return tomlFormatModule.format!(source, FORMAT_OPTIONS)
}

/** A structural snapshot of a parse — kind/name/value per node, in store
 * order — independent of byte offsets, so it can compare a document against
 * its own reformatted output even though every offset shifted. */
function structuralSnapshot(source: Uint8Array): unknown[] {
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  tomlFormatModule.parse(source, store, PARSE_OPTIONS)
  const out: unknown[] = []
  for (let i = 0; i < store.nodeCount; i++) {
    const value = store.valueOf(i)
    out.push({
      kind: store.kindOf(i),
      name: store.nameOf(i),
      value: value === null ? null : dec.decode(source.subarray(value.start, value.end))
    })
  }
  return out
}

function diagnosticCount(source: Uint8Array): number {
  const store = new NodeStore(source, new Interner())
  tomlFormatModule.parse(source, store, PARSE_OPTIONS)
  return store.diagnostics.length
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Generates a bounded-depth, deliberately messy but well-formed TOML
 * document — dotted keys, headers, array-of-tables, inline containers,
 * comments, and irregular whitespace — so the invariants below are checked
 * against shapes no hand-picked example would think to cover. */
function genToml(rand: () => number): string {
  const names = ['a', 'b', 'name', 'x1']
  const name = (): string => names[Math.floor(rand() * names.length)]!
  const sp = (): string => (rand() < 0.5 ? '' : ' '.repeat(1 + Math.floor(rand() * 2)))

  function genScalar(): string {
    const r = rand()
    if (r < 0.3) return String(Math.floor(rand() * 1000) - 500)
    if (r < 0.5) return (rand() * 100).toFixed(2)
    if (r < 0.7) return rand() < 0.5 ? 'true' : 'false'
    if (r < 0.85) return `"str${Math.floor(rand() * 100)}"`
    return `'lit${Math.floor(rand() * 100)}'`
  }

  function genInlineArray(d: number): string {
    const n = Math.floor(rand() * 3)
    const items: string[] = []
    for (let i = 0; i < n; i++)
      items.push(d < 2 && rand() < 0.2 ? genInlineTable(d + 1) : genScalar())
    return `[${items.join(',' + sp())}]`
  }

  function genInlineTable(d: number): string {
    const n = 1 + Math.floor(rand() * 2)
    const items: string[] = []
    for (let i = 0; i < n; i++) {
      items.push(
        `${name()}${sp()}=${sp()}${d < 2 && rand() < 0.2 ? genInlineArray(d + 1) : genScalar()}`
      )
    }
    return `{${sp()}${items.join(',' + sp())}${sp()}}`
  }

  function genValue(): string {
    const r = rand()
    if (r < 0.6) return genScalar()
    if (r < 0.8) return genInlineArray(0)
    return genInlineTable(0)
  }

  function genKvLine(indent: string): string {
    const dotted = rand() < 0.3
    const key = dotted ? `${name()}.${name()}` : name()
    let line = `${indent}${key}${sp()}=${sp()}${genValue()}`
    if (rand() < 0.15) line += ` # c${Math.floor(rand() * 100)}`
    return line
  }

  const lines: string[] = []
  const usedTables = new Set<string>()
  const tableCount = 1 + Math.floor(rand() * 3)
  for (let t = 0; t < tableCount; t++) {
    if (rand() < 0.3) lines.push('') // blank line between sections
    let tableName = `${name()}${t}`
    while (usedTables.has(tableName)) tableName = `${name()}${t}_${Math.floor(rand() * 100)}`
    usedTables.add(tableName)
    const isArray = rand() < 0.3
    lines.push(isArray ? `[[${tableName}]]` : `[${tableName}]`)
    const kvCount = 1 + Math.floor(rand() * 3)
    for (let k = 0; k < kvCount; k++) lines.push(genKvLine(rand() < 0.3 ? '  ' : ''))
  }
  return lines.join('\n') + '\n'
}

describe('tomlFormatModule.capabilities', () => {
  it('canFormat is true (R16)', () => {
    expect(tomlFormatModule.capabilities.canFormat).toBe(true)
    expect(tomlFormatModule.format).toBeDefined()
  })
})

describe('tomlFormatModule.format — invariants (generated corpus)', () => {
  const SAMPLE_COUNT = 300
  const rand = mulberry32(20260811)
  const samples: string[] = []
  for (let i = 0; i < SAMPLE_COUNT; i++) samples.push(genToml(rand))

  it('only reformats well-formed input (sanity check on the generator itself)', () => {
    for (const s of samples) {
      expect(diagnosticCount(utf8(s)), `input: ${s}`).toBe(0)
    }
  })

  it('is idempotent: format(format(x)) === format(x)', () => {
    for (const s of samples) {
      const source = utf8(s)
      const once = format(source)
      const twice = format(once)
      expect(dec.decode(twice), `input: ${s}`).toBe(dec.decode(once))
    }
  })

  it('reparsing the formatted output yields a structurally identical tree', () => {
    for (const s of samples) {
      const source = utf8(s)
      const formatted = format(source)
      expect(structuralSnapshot(formatted), `input: ${s}`).toEqual(structuralSnapshot(source))
    }
  })

  it('never introduces a diagnostic that the original did not already have', () => {
    for (const s of samples) {
      const source = utf8(s)
      const formatted = format(source)
      expect(diagnosticCount(formatted), `input: ${s}`).toBe(0)
    }
  })
})

describe('tomlFormatModule.format — named acceptance cases', () => {
  it('normalizes spacing around = in a key=value statement', () => {
    expect(dec.decode(format(utf8('x=1\n')))).toBe('x = 1\n')
    expect(dec.decode(format(utf8('x   =   1\n')))).toBe('x = 1\n')
  })

  it('normalizes spacing in a table header', () => {
    expect(dec.decode(format(utf8('[  table  ]\nx = 1\n')))).toBe('[table]\nx = 1\n')
  })

  it('normalizes spacing in an array-of-tables header', () => {
    expect(dec.decode(format(utf8('[[ items ]]\nx = 1\n')))).toBe('[[items]]\nx = 1\n')
  })

  it('normalizes dotted-key spacing', () => {
    expect(dec.decode(format(utf8('a . b = 1\n')))).toBe('a.b = 1\n')
  })

  it('strips leading indentation from a top-level statement (canonical TOML has none)', () => {
    expect(dec.decode(format(utf8('   x = 1\n')))).toBe('x = 1\n')
  })

  it('preserves comments verbatim, with a normalized single space before a trailing one', () => {
    expect(dec.decode(format(utf8('x = 1   # note\n')))).toBe('x = 1 # note\n')
    expect(dec.decode(format(utf8('# a standalone comment\nx = 1\n')))).toBe(
      '# a standalone comment\nx = 1\n'
    )
  })

  it('preserves blank-line count between statements', () => {
    expect(dec.decode(format(utf8('x = 1\n\n\ny = 2\n')))).toBe('x = 1\n\n\ny = 2\n')
  })

  it('preserves key and table order exactly', () => {
    const input = '[b]\ny = 1\n\n[a]\nx = 1\n'
    expect(dec.decode(format(utf8(input)))).toBe(input)
  })

  it('a single-line inline table is reformatted with consistent internal spacing', () => {
    expect(dec.decode(format(utf8('x = {a=1,b=2}\n')))).toBe('x = { a = 1, b = 2 }\n')
    expect(dec.decode(format(utf8('x = { a = 1 , b = 2 }\n')))).toBe('x = { a = 1, b = 2 }\n')
  })

  it('a single-line inline array is reformatted with consistent internal spacing', () => {
    expect(dec.decode(format(utf8('x = [1,2,3]\n')))).toBe('x = [1, 2, 3]\n')
  })

  it('a nested inline container on one line is reformatted throughout, no recursion', () => {
    expect(dec.decode(format(utf8('x = {a={b=[1,2]}}\n')))).toBe('x = { a = { b = [1, 2] } }\n')
  })

  it('an empty inline table/array is reformatted without an inner space', () => {
    expect(dec.decode(format(utf8('x = {}\ny = []\n')))).toBe('x = {}\ny = []\n')
  })

  it('a multi-line inline array is copied verbatim, including any comment between elements', () => {
    const input = 'x = [\n  1, # one\n  2,\n]\n'
    expect(dec.decode(format(utf8(input)))).toBe(input)
  })

  it('a multi-line string value is copied verbatim, internal whitespace untouched', () => {
    const input = 'x = """\n  line one\n  line two\n"""\n'
    expect(dec.decode(format(utf8(input)))).toBe(input)
  })

  it('adds a final newline if the source is missing one', () => {
    expect(dec.decode(format(utf8('x = 1')))).toBe('x = 1\n')
  })

  it('is a no-op on an empty document', () => {
    expect(dec.decode(format(utf8('')))).toBe('')
  })

  it('preserves a BOM untouched', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('x = 1\n')])
    const out = format(withBom)
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(dec.decode(out.subarray(3))).toBe('x = 1\n')
  })

  it('honours a \\r\\n newline preference', () => {
    const out = format(utf8('x = 1\n\ny = 2\n'))
    const outCrlf = tomlFormatModule.format!(utf8('x = 1\n\ny = 2\n'), {
      indent: '  ',
      newline: '\r\n'
    })
    expect(dec.decode(out)).toBe('x = 1\n\ny = 2\n')
    expect(dec.decode(outCrlf)).toBe('x = 1\r\n\r\ny = 2\r\n')
  })
})
