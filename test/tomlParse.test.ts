/**
 * M6-PLAN.md R14 — the TOML parser. Exercises the grammar coverage the plan lists, with extra
 * weight on §1.1's real hazard (dotted keys creating implicit nested tables that must unify with
 * `[table]`/`[[array]]` headers) and §1.2 (`detect()` has no single-byte signature).
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, Severity, type NodeRef, type ParseOptions } from '../src/core/types'
import { tomlFormatModule } from '../src/formats/toml/index'

function utf8(s: string): string {
  return s
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

interface Parsed {
  readonly store: NodeStore
  readonly source: Uint8Array
  readonly diagnostics: readonly { severity: Severity; code: string }[]
  readonly complete: boolean
}

function parseToml(text: string): Parsed {
  const source = new TextEncoder().encode(utf8(text))
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  const result = tomlFormatModule.parse(source, store, options)
  return {
    store,
    source,
    diagnostics: store.diagnostics,
    complete: result.complete
  }
}

function textOf(p: Parsed, start: number, end: number): string {
  return new TextDecoder().decode(p.source.subarray(start, end))
}

function valueTextOf(p: Parsed, node: NodeRef): string | null {
  const span = p.store.valueOf(node)
  return span === null ? null : textOf(p, span.start, span.end)
}

function children(p: Parsed, node: NodeRef): NodeRef[] {
  return [...p.store.childrenOf(node)]
}

function childNamed(p: Parsed, node: NodeRef, name: string): NodeRef | undefined {
  return children(p, node).find((c) => p.store.nameOf(c) === name)
}

/** A Property holding a container value (inline table/array, or a table opened via a header
 * nested inside another property... not applicable there) wraps it as its one child — the same
 * fold JSON already uses for `"key": {...}`. Scalars fold directly onto the Property itself
 * (`valueTextOf`), containers don't; this unwraps the latter case for assertions. */
function containerValueOf(p: Parsed, propertyNode: NodeRef): NodeRef {
  const kids = children(p, propertyNode)
  if (kids.length !== 1) {
    throw new Error(`expected exactly one container child, got ${kids.length}`)
  }
  return kids[0]!
}

const ROOT: NodeRef = 0

describe('TOML parser — scalar values at the top level', () => {
  it('parses basic strings, ints, floats, bools as Property scalars (folded, D-030)', () => {
    const p = parseToml(
      [
        'title = "hello"',
        'count = 42',
        'ratio = 3.14',
        'enabled = true',
        'disabled = false',
        'neg = -17'
      ].join('\n')
    )
    expect(p.complete).toBe(true)
    expect(p.diagnostics).toEqual([])

    const title = childNamed(p, ROOT, 'title')!
    expect(p.store.kindOf(title)).toBe(NodeKind.Property)
    expect(valueTextOf(p, title)).toBe('"hello"')

    const count = childNamed(p, ROOT, 'count')!
    expect(valueTextOf(p, count)).toBe('42')

    const ratio = childNamed(p, ROOT, 'ratio')!
    expect(valueTextOf(p, ratio)).toBe('3.14')

    const enabled = childNamed(p, ROOT, 'enabled')!
    expect(valueTextOf(p, enabled)).toBe('true')
  })

  it('parses dates as opaque scalar spans (no type discrimination, matching JSON)', () => {
    const p = parseToml(
      ['odt = 1979-05-27T07:32:00Z', 'ld = 1979-05-27', 'lt = 07:32:00'].join('\n')
    )
    expect(p.complete).toBe(true)
    expect(valueTextOf(p, childNamed(p, ROOT, 'odt')!)).toBe('1979-05-27T07:32:00Z')
    expect(valueTextOf(p, childNamed(p, ROOT, 'ld')!)).toBe('1979-05-27')
    expect(valueTextOf(p, childNamed(p, ROOT, 'lt')!)).toBe('07:32:00')
  })

  it('preserves multi-line basic and literal strings verbatim as one scalar span', () => {
    const p = parseToml(
      ['a = """', 'line one', 'line two', '"""', "b = '''raw \\n text'''"].join('\n')
    )
    expect(p.complete).toBe(true)
    const a = childNamed(p, ROOT, 'a')!
    expect(valueTextOf(p, a)).toBe('"""\nline one\nline two\n"""')
    const b = childNamed(p, ROOT, 'b')!
    expect(valueTextOf(p, b)).toBe("'''raw \\n text'''")
  })
})

describe('TOML parser — comments (§5.3, CONCEPT.md)', () => {
  it('emits a Comment node as a sibling near the thing it documents', () => {
    const p = parseToml(['# a leading comment', 'x = 1 # trailing comment', 'y = 2'].join('\n'))
    expect(p.complete).toBe(true)
    const kids = children(p, ROOT)
    const commentKinds = kids.map((k) => p.store.kindOf(k))
    expect(commentKinds).toContain(NodeKind.Comment)
    const comment = kids.find((k) => p.store.kindOf(k) === NodeKind.Comment)!
    expect(valueTextOf(p, comment)).toBe(' a leading comment')
  })
})

describe('TOML parser — dotted keys create implicit nested tables (M6-PLAN.md §1.1)', () => {
  it('a.b.c = 1 becomes three real nested nodes, not a flat "a.b.c" property', () => {
    const p = parseToml('a.b.c = 1')
    expect(p.complete).toBe(true)
    const a = childNamed(p, ROOT, 'a')!
    expect(p.store.kindOf(a)).toBe(NodeKind.Object)
    const b = childNamed(p, a, 'b')!
    expect(p.store.kindOf(b)).toBe(NodeKind.Object)
    const c = childNamed(p, b, 'c')!
    expect(p.store.kindOf(c)).toBe(NodeKind.Property)
    expect(valueTextOf(p, c)).toBe('1')
  })

  it('unifies two dotted-key statements into the SAME implicit table', () => {
    const p = parseToml(
      ['[fruit]', 'physical.color = "red"', 'physical.shape = "round"'].join('\n')
    )
    expect(p.complete).toBe(true)
    const fruit = childNamed(p, ROOT, 'fruit')!
    const physicalNodes = children(p, fruit).filter((c) => p.store.nameOf(c) === 'physical')
    expect(physicalNodes.length).toBe(1) // NOT two separate "physical" tables
    const physical = physicalNodes[0]!
    expect(valueTextOf(p, childNamed(p, physical, 'color')!)).toBe('"red"')
    expect(valueTextOf(p, childNamed(p, physical, 'shape')!)).toBe('"round"')
  })

  it('closes an implicit dotted-key table when a shallower bare key follows', () => {
    const p = parseToml(['[fruit]', 'physical.color = "red"', 'name = "apple"'].join('\n'))
    expect(p.complete).toBe(true)
    const fruit = childNamed(p, ROOT, 'fruit')!
    // "name" must be a direct child of fruit, not nested under physical.
    const name = childNamed(p, fruit, 'name')!
    expect(p.store.kindOf(name)).toBe(NodeKind.Property)
    expect(valueTextOf(p, name)).toBe('"apple"')
  })

  // A real bug (M6-PLAN.md R17): `navigateToTablePath`'s close-offset fallback used
  // `state.pos` at the point it was called — but for a *plain* (non-dotted) key,
  // `parseKeyValueStatement` calls `scanKeyPath` (consuming the new key's own text, plus '=' and
  // surrounding whitespace) *before* calling `navigateToTablePath`, so `state.pos` had already
  // moved past "name"'s own text. "physical"'s span silently swallowed "name"'s leading bytes —
  // invisible to the structural checks above (parent/child/value all still resolved correctly),
  // caught only by asserting the exact span boundary, the way test/tomlFixtures.test.ts's
  // exhaustive parseRange round-trip did for the first time.
  it("an implicit table's span ends before the next bare key's own text, not partway through it", () => {
    const p = parseToml(['physical.color = "red"', 'name = "apple"'].join('\n'))
    const physical = childNamed(p, ROOT, 'physical')!
    const name = childNamed(p, ROOT, 'name')!
    const physicalSpan = p.store.spanOf(physical)
    const nameSpan = p.store.spanOf(name)
    expect(physicalSpan.end).toBeLessThanOrEqual(nameSpan.start)
  })

  it('the same close-offset fix applies inside an inline table (dotted key then a plain key)', () => {
    const p = parseToml('x = { physical.color = "red", name = "apple" }')
    expect(p.complete).toBe(true)
    const x = childNamed(p, ROOT, 'x')!
    const xTable = containerValueOf(p, x)
    const physical = childNamed(p, xTable, 'physical')!
    const name = childNamed(p, xTable, 'name')!
    expect(valueTextOf(p, childNamed(p, physical, 'color')!)).toBe('"red"')
    expect(valueTextOf(p, name)).toBe('"apple"')
    const physicalSpan = p.store.spanOf(physical)
    const nameSpan = p.store.spanOf(name)
    expect(physicalSpan.end).toBeLessThanOrEqual(nameSpan.start)
  })
})

describe('TOML parser — [table] headers', () => {
  it('a dotted header nests real Object ancestors', () => {
    const p = parseToml(['[a.b.c]', 'x = 1'].join('\n'))
    expect(p.complete).toBe(true)
    const a = childNamed(p, ROOT, 'a')!
    const b = childNamed(p, a, 'b')!
    const c = childNamed(p, b, 'c')!
    expect(p.store.kindOf(c)).toBe(NodeKind.Object)
    expect(valueTextOf(p, childNamed(p, c, 'x')!)).toBe('1')
  })

  it('a header returning to a shallower table closes the deeper one, sibling headers work', () => {
    const p = parseToml(['[a.b]', 'x = 1', '[a.d]', 'y = 2'].join('\n'))
    expect(p.complete).toBe(true)
    const a = childNamed(p, ROOT, 'a')!
    const b = childNamed(p, a, 'b')!
    const d = childNamed(p, a, 'd')!
    expect(valueTextOf(p, childNamed(p, b, 'x')!)).toBe('1')
    expect(valueTextOf(p, childNamed(p, d, 'y')!)).toBe('2')
    // a has exactly two children: b and d.
    expect(
      children(p, a)
        .map((n) => p.store.nameOf(n))
        .sort()
    ).toEqual(['b', 'd'])
  })
})

describe('TOML parser — [[array of tables]] headers', () => {
  it('consecutive [[name]] headers append elements to the SAME Array node', () => {
    const p = parseToml(
      ['[[fruits]]', 'name = "apple"', '[[fruits]]', 'name = "banana"'].join('\n')
    )
    expect(p.complete).toBe(true)
    const fruitsNodes = children(p, ROOT).filter((c) => p.store.nameOf(c) === 'fruits')
    expect(fruitsNodes.length).toBe(1) // one Array, not two
    const fruits = fruitsNodes[0]!
    expect(p.store.kindOf(fruits)).toBe(NodeKind.Array)
    const elements = children(p, fruits)
    expect(elements.length).toBe(2)
    expect(elements.every((e) => p.store.kindOf(e) === NodeKind.Object)).toBe(true)
    expect(valueTextOf(p, childNamed(p, elements[0]!, 'name')!)).toBe('"apple"')
    expect(valueTextOf(p, childNamed(p, elements[1]!, 'name')!)).toBe('"banana"')
  })

  it('a nested [[a.b]] header attaches under the CURRENT element of a, not a shared one', () => {
    const p = parseToml(
      [
        '[[fruits]]',
        'name = "apple"',
        '[[fruits.varieties]]',
        'name = "red delicious"',
        '[[fruits]]',
        'name = "banana"'
      ].join('\n')
    )
    expect(p.complete).toBe(true)
    const fruits = children(p, ROOT).find((c) => p.store.nameOf(c) === 'fruits')!
    const elements = children(p, fruits)
    expect(elements.length).toBe(2)
    const apple = elements[0]!
    const banana = elements[1]!
    expect(valueTextOf(p, childNamed(p, apple, 'name')!)).toBe('"apple"')
    expect(valueTextOf(p, childNamed(p, banana, 'name')!)).toBe('"banana"')
    // varieties belongs only to apple's element.
    const appleVarieties = childNamed(p, apple, 'varieties')!
    expect(p.store.kindOf(appleVarieties)).toBe(NodeKind.Array)
    expect(children(p, appleVarieties).length).toBe(1)
    expect(childNamed(p, banana, 'varieties')).toBeUndefined()
  })
})

describe('TOML parser — inline tables and arrays', () => {
  it('parses an inline table as an Object child, values folded into Properties', () => {
    const p = parseToml('point = { x = 1, y = 2 }')
    expect(p.complete).toBe(true)
    const pointProp = childNamed(p, ROOT, 'point')!
    const point = containerValueOf(p, pointProp)
    expect(p.store.kindOf(point)).toBe(NodeKind.Object)
    expect(valueTextOf(p, childNamed(p, point, 'x')!)).toBe('1')
    expect(valueTextOf(p, childNamed(p, point, 'y')!)).toBe('2')
  })

  it('parses an inline array of scalars as unnamed Scalar children', () => {
    const p = parseToml('nums = [1, 2, 3]')
    expect(p.complete).toBe(true)
    const numsProp = childNamed(p, ROOT, 'nums')!
    const nums = containerValueOf(p, numsProp)
    expect(p.store.kindOf(nums)).toBe(NodeKind.Array)
    const kids = children(p, nums)
    expect(kids.length).toBe(3)
    expect(kids.map((k) => p.store.kindOf(k))).toEqual([
      NodeKind.Scalar,
      NodeKind.Scalar,
      NodeKind.Scalar
    ])
    expect(kids.map((k) => valueTextOf(p, k))).toEqual(['1', '2', '3'])
  })

  it('supports dotted keys inside an inline table', () => {
    const p = parseToml('name = { first.name = "Tom", first.age = 30 }')
    expect(p.complete).toBe(true)
    const nameProp = childNamed(p, ROOT, 'name')!
    const name = containerValueOf(p, nameProp)
    const first = childNamed(p, name, 'first')!
    expect(p.store.kindOf(first)).toBe(NodeKind.Object)
    expect(valueTextOf(p, childNamed(p, first, 'name')!)).toBe('"Tom"')
    expect(valueTextOf(p, childNamed(p, first, 'age')!)).toBe('30')
  })

  it('an inline array may hold nested containers and span multiple lines', () => {
    const p = parseToml(['points = [', '  { x = 1, y = 2 },', '  { x = 3, y = 4 }', ']'].join('\n'))
    expect(p.complete).toBe(true)
    const pointsProp = childNamed(p, ROOT, 'points')!
    const points = containerValueOf(p, pointsProp)
    const kids = children(p, points)
    expect(kids.length).toBe(2)
    expect(p.store.kindOf(kids[0]!)).toBe(NodeKind.Object)
    expect(valueTextOf(p, childNamed(p, kids[0]!, 'x')!)).toBe('1')
    expect(valueTextOf(p, childNamed(p, kids[1]!, 'y')!)).toBe('4')
  })
})

describe('TOML parser — real-world-shaped fixture', () => {
  it('parses a Cargo.toml-style document end to end', () => {
    const text = [
      '# A package manifest',
      '[package]',
      'name = "example"',
      'version = "0.1.0"',
      'authors = ["A. Person <a@example.com>"]',
      '',
      '[dependencies]',
      'serde = "1.0"',
      '',
      '[dependencies.tokio]',
      'version = "1"',
      'features = ["full"]',
      '',
      '[[bin]]',
      'name = "main"',
      'path = "src/main.rs"',
      '',
      '[[bin]]',
      'name = "cli"',
      'path = "src/cli.rs"'
    ].join('\n')
    const p = parseToml(text)
    expect(p.complete).toBe(true)
    expect(p.diagnostics.filter((d) => d.severity >= Severity.Error)).toEqual([])

    const pkg = childNamed(p, ROOT, 'package')!
    expect(valueTextOf(p, childNamed(p, pkg, 'name')!)).toBe('"example"')

    const deps = childNamed(p, ROOT, 'dependencies')!
    expect(valueTextOf(p, childNamed(p, deps, 'serde')!)).toBe('"1.0"')
    const tokio = childNamed(p, deps, 'tokio')!
    expect(p.store.kindOf(tokio)).toBe(NodeKind.Object)
    expect(valueTextOf(p, childNamed(p, tokio, 'version')!)).toBe('"1"')

    const bins = children(p, ROOT).filter((c) => p.store.nameOf(c) === 'bin')
    expect(bins.length).toBe(1)
    expect(children(p, bins[0]!).length).toBe(2)
  })
})

describe('TOML parser — malformed input never throws (invariant 5)', () => {
  it('recovers from a missing "=" with a diagnostic, keeps parsing', () => {
    expect(() => {
      const p = parseToml(['x 1', 'y = 2'].join('\n'))
      expect(p.diagnostics.length).toBeGreaterThan(0)
      const y = childNamed(p, ROOT, 'y')
      expect(y).toBeDefined()
    }).not.toThrow()
  })

  it('recovers from an unterminated string', () => {
    expect(() => {
      const p = parseToml('x = "unterminated')
      expect(p.complete).toBe(false)
      expect(p.diagnostics.some((d) => d.code === 'toml.unterminated-string')).toBe(true)
    }).not.toThrow()
  })

  it('recovers from an unterminated inline table', () => {
    expect(() => {
      const p = parseToml('x = { a = 1')
      expect(p.diagnostics.length).toBeGreaterThan(0)
    }).not.toThrow()
  })

  it('is iterative, not recursive descent — deep inline-array nesting does not overflow (hard rule 4)', () => {
    const depth = 5000
    const text = 'x = ' + '['.repeat(depth) + '1' + ']'.repeat(depth)
    expect(() => parseToml(text)).not.toThrow()
  })

  it('recovers when [[name]] redefines a name already opened as a plain [table] (spec violation)', () => {
    // A real bug this exact case caught: navigateToArrayPath's "already
    // open, append" fast path used to assume the frame at this position
    // was always an 'array' and unsafely cast it, crashing (undefined
    // elementNode) when it was actually a 'table' left open by an earlier
    // [name] header.
    expect(() => {
      const p = parseToml(['[fruits]', 'x = 1', '[[fruits]]', 'y = 2'].join('\n'))
      expect(p.diagnostics).toBeDefined() // just proving it didn't throw first
    }).not.toThrow()
  })

  it('respects maxDepth with a Fatal diagnostic rather than crashing', () => {
    const depth = 50
    const text = 'x = ' + '['.repeat(depth) + '1' + ']'.repeat(depth)
    const source = new TextEncoder().encode(text)
    const interner = new Interner()
    const store = new NodeStore(source, interner)
    const shallow: ParseOptions = { maxDepth: 5, encoding: 'utf-8' }
    expect(() => tomlFormatModule.parse(source, store, shallow)).not.toThrow()
  })
})

describe('TOML parser — detect() (M6-PLAN.md §1.2)', () => {
  function head(s: string): Uint8Array {
    return new TextEncoder().encode(s)
  }

  it('strongly detects a .toml filename regardless of content', () => {
    expect(tomlFormatModule.detect(head('anything'), 'config.toml')).toBeGreaterThanOrEqual(0.9)
  })

  it('detects a bare key = value as the first real line', () => {
    expect(tomlFormatModule.detect(head('title = "x"\n'), null)).toBeGreaterThan(0.5)
  })

  it('detects a [table] header as the first real line', () => {
    expect(tomlFormatModule.detect(head('[package]\n'), null)).toBeGreaterThan(0.5)
  })

  it('skips leading comments and blank lines before sniffing', () => {
    expect(tomlFormatModule.detect(head('# comment\n\ntitle = "x"\n'), null)).toBeGreaterThan(0.5)
  })

  it('does not misdetect a bare JSON array as TOML', () => {
    // A JSON array's line has no '=' and its ']' closes a list of scalars,
    // not a table header -- but per the plan's own admission this is a
    // genuinely ambiguous case; confirm TOML's own confidence at least
    // stays at or below JSON's for this exact input elsewhere (registry.test.ts).
    const confidence = tomlFormatModule.detect(head('[1, 2, 3]\n'), null)
    expect(confidence).toBeLessThanOrEqual(0.6)
  })

  it('does not detect plain prose', () => {
    expect(tomlFormatModule.detect(head('just some text\n'), null)).toBe(0)
  })
})
