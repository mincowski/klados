import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import {
  NodeKind,
  type FormatOptions,
  type ParseOptions,
  type ParseResult
} from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const defaultOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseJson(
  text: string,
  options: ParseOptions = defaultOptions
): { store: NodeStore; source: Uint8Array; result: ParseResult } {
  const source = utf8(text)
  const store = new NodeStore(source, new Interner())
  const result = jsonFormatModule.parse(source, store, options)
  return { store, source, result }
}

describe('jsonFormatModule.detect', () => {
  it('matches a .json filename strongly', () => {
    expect(jsonFormatModule.detect(utf8('{}'), 'data.json')).toBeGreaterThan(0.5)
  })

  it('sniffs a leading { or [', () => {
    expect(jsonFormatModule.detect(utf8('  {"a":1}'), null)).toBeGreaterThan(0.5)
    expect(jsonFormatModule.detect(utf8('[1,2]'), null)).toBeGreaterThan(0.5)
  })

  it('rejects content starting with neither', () => {
    expect(jsonFormatModule.detect(utf8('hello'), null)).toBe(0)
  })
})

describe('jsonFormatModule.detectEncoding', () => {
  it('always returns null (BOM handles the rest)', () => {
    expect(jsonFormatModule.detectEncoding(utf8('{}'))).toBeNull()
  })
})

describe('JSON parser — scalar folding (CONCEPT.md §3.2 / B8)', () => {
  it('folds a scalar property value into the Property itself: 5 nodes, not 7', () => {
    const { store, result } = parseJson('{"a": 1, "b": {"c": 2}}')
    expect(result.complete).toBe(true)
    // Document, Object, Property a, Property b, Object, Property c = 6
    // (the outer Document node is always present; B8's own worked example
    // counts 5 starting from the outer Object.)
    expect(store.nodeCount).toBe(6)

    const doc = 0
    const outerObject = store.firstChildOf(doc)
    expect(store.kindOf(outerObject)).toBe(NodeKind.Object)

    const propA = store.firstChildOf(outerObject)
    expect(store.kindOf(propA)).toBe(NodeKind.Property)
    expect(store.nameOf(propA)).toBe('a')
    expect(store.valueOf(propA)).not.toBeNull()
    // no child under propA — the value folded into it
    expect(store.firstChildOf(propA)).toBe(-1)

    const propB = store.nextSiblingOf(propA)
    expect(store.nameOf(propB)).toBe('b')
    const innerObject = store.firstChildOf(propB)
    expect(store.kindOf(innerObject)).toBe(NodeKind.Object)
    expect(store.valueOf(propB)).toBeNull() // composite value, no scalar on propB itself

    const propC = store.firstChildOf(innerObject)
    expect(store.nameOf(propC)).toBe('c')
    expect(store.valueOf(propC)).not.toBeNull()
  })

  it('does not fold array elements: scalars become unnamed Scalar nodes', () => {
    const { store } = parseJson('[1,2,3]')
    const doc = 0
    const array = store.firstChildOf(doc)
    expect(store.kindOf(array)).toBe(NodeKind.Array)
    const children = Array.from(store.childrenOf(array))
    expect(children.length).toBe(3)
    for (const c of children) {
      expect(store.kindOf(c)).toBe(NodeKind.Scalar)
      expect(store.nameOf(c)).toBeNull()
      expect(store.valueOf(c)).not.toBeNull()
    }
  })

  it('value spans include the surrounding quotes for strings', () => {
    const { store, source } = parseJson('{"a": "hi"}')
    const doc = 0
    const object = store.firstChildOf(doc)
    const propA = store.firstChildOf(object)
    const span = store.valueOf(propA)!
    const decoded = new TextDecoder().decode(source.subarray(span.start, span.end))
    expect(decoded).toBe('"hi"')
  })

  it('an object nested inside an array element is not folded (no property to fold into)', () => {
    const { store } = parseJson('[{"a":1}]')
    const doc = 0
    const array = store.firstChildOf(doc)
    const element = store.firstChildOf(array)
    expect(store.kindOf(element)).toBe(NodeKind.Object)
    expect(store.nameOf(element)).toBeNull()
  })
})

describe('JSON parser — structure', () => {
  it('parses an empty object and empty array', () => {
    const { store: s1 } = parseJson('{}')
    expect(store_childrenLen(s1)).toBe(0)
    const { store: s2 } = parseJson('[]')
    expect(store_childrenLen(s2)).toBe(0)

    function store_childrenLen(store: NodeStore): number {
      const doc = 0
      const root = store.firstChildOf(doc)
      return Array.from(store.childrenOf(root)).length
    }
  })

  it('parses a bare top-level scalar', () => {
    const { store } = parseJson('42')
    const doc = 0
    const scalar = store.firstChildOf(doc)
    expect(store.kindOf(scalar)).toBe(NodeKind.Scalar)
    expect(store.valueOf(scalar)).not.toBeNull()
  })

  it('handles nested arrays', () => {
    const { store } = parseJson('[[1,2],[3]]')
    const doc = 0
    const outer = store.firstChildOf(doc)
    const children = Array.from(store.childrenOf(outer))
    expect(children.length).toBe(2)
    expect(store.kindOf(children[0]!)).toBe(NodeKind.Array)
    expect(Array.from(store.childrenOf(children[0]!)).length).toBe(2)
  })
})

describe('JSON parser — diagnostics and malformed input', () => {
  it('emits a diagnostic and does not throw on a truncated document', () => {
    const { result } = parseJson('{"a": {"b": 1')
    expect(result.diagnosticCount).toBeGreaterThan(0)
    expect(result.complete).toBe(false)
  })

  // Regression: EOF reached with a property's key parsed but no value
  // started yet (`ExpectColon`/`ExpectValue`) left that Property node open
  // on the store's own stack when the enclosing object closed around it —
  // `closeNode` then desynced against the wrong innermost node. Threw in
  // dev builds ("does not match innermost open node"); would have silently
  // corrupted spans/parentage in production. Caught via D6's document
  // session tests opening a truncated `{"a":` file.
  it('emits a diagnostic and does not throw when EOF hits before a value starts', () => {
    for (const text of ['{"a":', '{"a"', '{"a": ']) {
      expect(() => {
        const { result, store } = parseJson(text)
        expect(result.complete).toBe(false)
        expect(store.diagnosticCount).toBeGreaterThan(0)
      }).not.toThrow()
    }
  })

  it('emits a Fatal diagnostic and does not crash past maxDepth', () => {
    const depth = 5000
    const text = '['.repeat(depth) + '0' + ']'.repeat(depth)
    const { store, result } = parseJson(text, { maxDepth: 1000, encoding: 'utf-8' })
    expect(result.complete).toBe(false)
    const fatal = store.diagnostics.find((d) => d.severity === 2)
    expect(fatal).toBeDefined()
  })

  it('deep-10k parses successfully; deep-1m produces a Fatal diagnostic and does not crash', () => {
    const shallow = '['.repeat(10_000) + '0' + ']'.repeat(10_000)
    const shallowResult = parseJson(shallow, { maxDepth: 200_000, encoding: 'utf-8' })
    expect(shallowResult.result.complete).toBe(true)

    const deepChunks: string[] = []
    const CHUNK = 100_000
    for (let written = 0; written < 1_000_000; written += CHUNK) deepChunks.push('['.repeat(CHUNK))
    const deep = deepChunks.join('') + '0' + ']'.repeat(1_000_000)
    expect(() => {
      const deepResult = parseJson(deep, { maxDepth: 200_000, encoding: 'utf-8' })
      expect(deepResult.result.complete).toBe(false)
      expect(deepResult.store.diagnosticCount).toBeGreaterThan(0)
    }).not.toThrow()
  }, 20_000)

  it('recovers from a missing comma well enough to keep parsing', () => {
    const { result } = parseJson('{"a": 1 "b": 2}')
    expect(result.diagnosticCount).toBeGreaterThan(0)
  })
})

describe('JSON parser — format()', () => {
  it('round-trips format() output through parse() to an identical tree shape', () => {
    const text = '{"a":1,"b":{"c":[1,2,3]},"d":"hi"}'
    const source = utf8(text)
    const formatted = jsonFormatModule.format!(source, { indent: '  ', newline: '\n' })

    const before = parseJson(text)
    const after = (() => {
      const store = new NodeStore(formatted, new Interner())
      const result = jsonFormatModule.parse(formatted, store, defaultOptions)
      return { store, result }
    })()

    expect(after.result.complete).toBe(true)
    expect(shape(before.store)).toEqual(shape(after.store))

    function shape(store: NodeStore): unknown {
      const walk = (node: number): unknown => ({
        kind: store.kindOf(node),
        name: store.nameOf(node),
        children: Array.from(store.childrenOf(node)).map(walk)
      })
      return walk(0)
    }
  })
})

// M5-PLAN.md H5 — byte-level re-emission, minify as the same traversal with
// a different whitespace policy, and the acceptance criteria stated
// verbatim: "format-then-minify... returns to the original minified bytes;
// minify-then-format is stable under repetition... every numeric and string
// literal is byte-identical across a format round trip."
describe('JSON parser — format()/minify (M5-PLAN.md H5)', () => {
  const PRETTY: FormatOptions = { indent: '  ', newline: '\n' }
  const MINIFY: FormatOptions = { indent: '', newline: '\n' }

  function format(text: string, options: FormatOptions = PRETTY): string {
    return new TextDecoder().decode(jsonFormatModule.format!(utf8(text), options))
  }

  // Canonical minified fixtures — zero whitespace anywhere, which is what
  // this minifier itself produces, so round-tripping through it is a
  // meaningful identity check rather than an arbitrary comparison.
  const MINIFIED_FIXTURES = [
    '{"a":1,"b":{"c":[1,2,3]},"d":"hi"}',
    '[]',
    '{}',
    '[1,2,3]',
    '{"nested":{"deeply":{"so":[1,[2,[3,{}]]]}}}',
    '{"a":"with \\"escaped\\" quotes and \\\\backslash"}',
    '{"unicode":"caf\\u00e9 日本語"}',
    '{"empty_string":"","empty_obj":{},"empty_arr":[]}'
  ]

  it('format-then-minify returns to the original minified bytes', () => {
    for (const fixture of MINIFIED_FIXTURES) {
      const pretty = format(fixture, PRETTY)
      const reminified = format(pretty, MINIFY)
      expect(reminified, fixture).toBe(fixture)
    }
  })

  it('minify-then-format is stable under repetition (formatting twice changes nothing)', () => {
    for (const fixture of MINIFIED_FIXTURES) {
      const minified = format(fixture, MINIFY)
      const formattedOnce = format(minified, PRETTY)
      const formattedTwice = format(formattedOnce, PRETTY)
      expect(formattedTwice).toBe(formattedOnce)

      const minifiedOnce = format(fixture, MINIFY)
      const minifiedTwice = format(minifiedOnce, MINIFY)
      expect(minifiedTwice).toBe(minifiedOnce)
    }
  })

  it('minify produces zero whitespace between tokens, no trailing newline', () => {
    const minified = jsonFormatModule.format!(utf8('{ "a" : 1 , "b" : [ 1 , 2 ] }'), MINIFY)
    expect(new TextDecoder().decode(minified)).toBe('{"a":1,"b":[1,2]}')
  })

  it('every numeric and string literal survives a format round trip byte-identically', () => {
    const awkward = [
      '1e400', // overflows a JS double — must never round-trip through Number
      '1.0', // would become "1" through Number(...).toString()
      '-0', // would become "0" through Number(...).toString()
      '12345678901234567890123456789', // far past 2^53, precision loss through Number
      '0.000000000000000000001',
      '-1.5e-300',
      '3.141592653589793238462643383279'
    ]
    for (const literal of awkward) {
      const text = `{"n":${literal}}`
      const pretty = format(text, PRETTY)
      expect(pretty, literal).toContain(literal)
      const minified = format(text, MINIFY)
      expect(minified, literal).toContain(literal)
    }

    const strings = [
      '"plain"',
      '"with \\"escaped\\" quotes"',
      '"tab\\ttab"',
      '"unicode escape \\u00e9\\u65e5"',
      '"literal unicode café 日本"'
    ]
    for (const stringLiteral of strings) {
      const text = `{"s":${stringLiteral}}`
      const pretty = format(text, PRETTY)
      expect(pretty, stringLiteral).toContain(stringLiteral)
      const minified = format(text, MINIFY)
      expect(minified, stringLiteral).toContain(stringLiteral)
    }
  })

  it('formats an already-pretty document idempotently', () => {
    const text = '{"a":1,"b":{"c":[1,2,3]},"d":"hi"}'
    const once = format(text, PRETTY)
    const twice = format(once, PRETTY)
    expect(twice).toBe(once)
  })

  // Regression: format() started scanning at offset 0 regardless of a BOM,
  // so a BOM byte reached the value-dispatch switch as if it were the
  // start of a token, matched no scalar-starting byte, and was silently
  // dropped via scanLiteral's malformed-input fallback — corrupting both
  // the BOM and the alignment of everything after it.
  it('preserves a BOM verbatim and formats/minifies the content after it correctly', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const body = utf8('{"a":1,"b":2}')
    const withBom = new Uint8Array(bom.length + body.length)
    withBom.set(bom, 0)
    withBom.set(body, bom.length)

    const pretty = jsonFormatModule.format!(withBom, PRETTY)
    expect(Array.from(pretty.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(pretty.subarray(3))).toBe('{\n  "a": 1,\n  "b": 2\n}\n')

    const minified = jsonFormatModule.format!(withBom, MINIFY)
    expect(Array.from(minified.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(minified.subarray(3))).toBe('{"a":1,"b":2}')
  })
})

// M5h-PLAN.md R18, §4: checking whether JSON's own formatter shares XML's
// stack-overflow defect found the same shape here too — `formatValue`/
// `formatContainer`/`formatObjectBody`/`formatArrayBody` were mutually
// recursive over document structure with no depth bound, overflowing at
// depth 5 000 (confirmed via the exact `{"a":` × depth nesting this table
// exercises), well inside `DEFAULT_MAX_DEPTH`. Rewritten as one explicit
// frame stack, mirroring `stepObject`/`stepArray`'s own shape.
describe('jsonFormatModule.format — deep nesting does not overflow the stack (M5h-PLAN.md R18)', () => {
  function deepObjects(depth: number): string {
    return '{"a":'.repeat(depth) + '1' + '}'.repeat(depth)
  }

  function deepArrays(depth: number): string {
    return '['.repeat(depth) + '1' + ']'.repeat(depth)
  }

  it.each([100, 1000, 5000, 9000])(
    'depth %i nested objects: format() does not throw and re-parses to the same tree',
    (depth) => {
      const text = deepObjects(depth)
      const source = utf8(text)
      const deepOptions: ParseOptions = { maxDepth: depth + 10, encoding: 'utf-8' }

      let formatted: Uint8Array
      expect(() => {
        formatted = jsonFormatModule.format!(source, { indent: '  ', newline: '\n' })
      }).not.toThrow()

      const before = parseJson(text, deepOptions)
      const store = new NodeStore(formatted!, new Interner())
      const afterResult = jsonFormatModule.parse(formatted!, store, deepOptions)

      expect(before.result.complete).toBe(true)
      expect(afterResult.complete).toBe(true)
      expect(store.nodeCount).toBe(before.store.nodeCount)
    }
  )

  it.each([100, 1000, 5000, 9000])(
    'depth %i nested arrays: format() does not throw and re-parses to the same tree',
    (depth) => {
      const text = deepArrays(depth)
      const source = utf8(text)
      const deepOptions: ParseOptions = { maxDepth: depth + 10, encoding: 'utf-8' }

      let formatted: Uint8Array
      expect(() => {
        formatted = jsonFormatModule.format!(source, { indent: '  ', newline: '\n' })
      }).not.toThrow()

      const before = parseJson(text, deepOptions)
      const store = new NodeStore(formatted!, new Interner())
      const afterResult = jsonFormatModule.parse(formatted!, store, deepOptions)

      expect(before.result.complete).toBe(true)
      expect(afterResult.complete).toBe(true)
      expect(store.nodeCount).toBe(before.store.nodeCount)
    }
  )

  // Depth 20 000 alone, past DEFAULT_MAX_DEPTH — a lighter "does not
  // throw" check only, not a full structural round trip: at this depth,
  // pretty-printed indentation makes the *output* itself hundreds of MB
  // (indentation grows with depth at every one of 20 000 levels), too slow
  // for a per-test structural comparison to be worth its own assertion —
  // the throw/no-throw question is what this depth exists to answer.
  it('depth 20000 (past DEFAULT_MAX_DEPTH) does not throw, pretty or minified', () => {
    expect(() =>
      jsonFormatModule.format!(utf8(deepObjects(20_000)), { indent: '  ', newline: '\n' })
    ).not.toThrow()
    expect(() =>
      jsonFormatModule.format!(utf8(deepObjects(20_000)), { indent: '', newline: '\n' })
    ).not.toThrow()
  })
})
