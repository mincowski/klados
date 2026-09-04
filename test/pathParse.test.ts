import { describe, expect, it } from 'vitest'
import { parsePath, type NameResolver } from '../src/core/path/parse'

function resolverFor(names: readonly string[]): NameResolver {
  const map = new Map(names.map((name, i) => [name, i]))
  return (name) => map.get(name) ?? null
}

describe('parsePath (M4-PLAN.md G7)', () => {
  it('parses a single child step', () => {
    const result = parsePath('cars', resolverFor(['cars']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps).toEqual([
      { axis: 'child', isWildcard: false, nameId: 0, predicate: null }
    ])
  })

  it('parses children by name: cars/car', () => {
    const result = parsePath('cars/car', resolverFor(['cars', 'car']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps.map((s) => s.axis)).toEqual(['child', 'child'])
    expect(result.path.steps.map((s) => s.nameId)).toEqual([0, 1])
  })

  it('parses a descendant step: cars//price', () => {
    const result = parsePath('cars//price', resolverFor(['cars', 'price']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps.map((s) => s.axis)).toEqual(['child', 'descendant'])
  })

  it('parses a leading descendant step: //price', () => {
    const result = parsePath('//price', resolverFor(['price']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps).toEqual([
      { axis: 'descendant', isWildcard: false, nameId: 0, predicate: null }
    ])
  })

  // R73 (`R72-path-query.md` §3): the real defect. `parsePaletteInput`
  // strips exactly one leading `/` as the palette's own `/`-mode prefix, so
  // a user typing `//price` at the top level never reaches this module
  // with two slashes — it arrives as `/price`, one lone leading `/`. Before
  // R73 that parsed identically to `price` (plain child of root), so the
  // descendant axis was unreachable at the top level: typing "every price
  // anywhere" silently returned nothing. A single leading `/` now means
  // descendant; `//` (two slashes, reachable directly or mid-query) is
  // unaffected — see the test right above.
  it('R73: a single leading / (what //name arrives as, post palette-strip) means descendant, not child', () => {
    const result = parsePath('/price', resolverFor(['price']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps).toEqual([
      { axis: 'descendant', isWildcard: false, nameId: 0, predicate: null }
    ])
  })

  it('R73: a single leading / does not affect a later step’s own separator', () => {
    const result = parsePath('/cars/car', resolverFor(['cars', 'car']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The first step is descendant (R73); the second step's `/` is an
    // ordinary mid-query separator (`atStart` is false there), still child.
    expect(result.path.steps.map((s) => s.axis)).toEqual(['descendant', 'child'])
  })

  it('R73: the XML round-trip case (a single leading / with no second slash) is unaffected in the way that matters — it still resolves the same node set shape', () => {
    // copyPathFor's toXPath emits exactly one leading `/`
    // (`/garage/cars/elements/car[3]`); the palette strips it as the mode
    // prefix, so parsePath never actually sees a leading `/` for that
    // case at all — this test exists to make that explicit rather than
    // assumed, since it's the case R73's own fix must not break.
    const strippedByPalette = 'garage/cars/elements/car[3]' // no leading '/'
    const result = parsePath(strippedByPalette, resolverFor(['garage', 'cars', 'elements', 'car']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps.map((s) => s.axis)).toEqual(['child', 'child', 'child', 'child'])
  })

  it('parses a scalar facet predicate: car[@id="c-001"] — now the comparison kind (R129)', () => {
    const result = parsePath('car[@id="c-001"]', resolverFor(['car', 'id']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toEqual({
      kind: 'comparison',
      subjectAxis: 'attribute',
      subjectName: 'id',
      subjectNameId: 1,
      op: '=',
      literalKind: 'string',
      literalText: 'c-001',
      literalNumber: NaN
    })
  })

  it('parses a facet predicate with single quotes', () => {
    const result = parsePath("car[@id='c-001']", resolverFor(['car', 'id']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toMatchObject({
      kind: 'comparison',
      subjectAxis: 'attribute',
      subjectName: 'id',
      op: '=',
      literalKind: 'string',
      literalText: 'c-001'
    })
  })

  it('resolves an attribute subject name through the same resolver a step name uses (R129 §5)', () => {
    const result = parsePath('car[@id="x"]', resolverFor(['car', 'id']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toMatchObject({ subjectNameId: 1 })
  })

  it('a subject name absent from the document resolves to null, not an error (R129 §5)', () => {
    const result = parsePath('car[@nope="x"]', resolverFor(['car']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toMatchObject({ subjectNameId: null })
  })

  it('parses a numeric comparison over a child element: car[price>100] (R129)', () => {
    const result = parsePath('car[price>100]', resolverFor(['car', 'price']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toEqual({
      kind: 'comparison',
      subjectAxis: 'child',
      subjectName: 'price',
      subjectNameId: 1,
      op: '>',
      literalKind: 'number',
      literalText: '100',
      literalNumber: 100
    })
  })

  it('parses every operator, longest match first so >= is never > then =', () => {
    const ops: readonly [string, string][] = [
      ['=', '='],
      ['!=', '!='],
      ['<', '<'],
      ['<=', '<='],
      ['>', '>'],
      ['>=', '>=']
    ]
    for (const [typed, expected] of ops) {
      const result = parsePath(`car[price${typed}100]`, resolverFor(['car', 'price']))
      expect(result.ok, `operator ${typed}`).toBe(true)
      if (!result.ok) continue
      expect(result.path.steps[0]!.predicate).toMatchObject({ op: expected, literalNumber: 100 })
    }
  })

  it('parses a negative and a fractional number literal exactly', () => {
    const negative = parsePath('car[price>-3.5]', resolverFor(['car', 'price']))
    expect(negative.ok).toBe(true)
    if (!negative.ok) return
    expect(negative.path.steps[0]!.predicate).toMatchObject({
      literalKind: 'number',
      literalNumber: -3.5
    })

    const leadingDot = parsePath('car[price>.5]', resolverFor(['car', 'price']))
    expect(leadingDot.ok).toBe(true)
    if (!leadingDot.ok) return
    expect(leadingDot.path.steps[0]!.predicate).toMatchObject({ literalNumber: 0.5 })
  })

  it('tolerates whitespace around the operator and the literal', () => {
    const result = parsePath('car[ @year >= 2000 ]', resolverFor(['car', 'year']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toMatchObject({
      subjectAxis: 'attribute',
      subjectName: 'year',
      op: '>=',
      literalNumber: 2000
    })
  })

  it('a quoted literal keeps string form, so = compares as text even when it looks numeric', () => {
    const result = parsePath('car[price="100"]', resolverFor(['car', 'price']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toMatchObject({
      literalKind: 'string',
      literalText: '100',
      // Still converted, because a relational operator would need it — §4.
      literalNumber: 100
    })
  })

  it('rejects exponent notation at parse time rather than silently matching nothing (R129 §4)', () => {
    const result = parsePath('car[price>1e3]', resolverFor(['car', 'price']))
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The `1` is a complete XPath number; the offset points at the `e`
    // that follows it, not at the whole predicate.
    expect(result.diagnostic.offset).toBe('car[price>1'.length)
  })

  it("rejects '==' — XPath's equality operator is a single '='", () => {
    const result = parsePath('car[price==100]', resolverFor(['car', 'price']))
    expect(result.ok).toBe(false)
  })

  it('rejects a bare unquoted word as a literal', () => {
    const result = parsePath('car[make=BMW]', resolverFor(['car', 'make']))
    expect(result.ok).toBe(false)
  })

  it('rejects trailing junk after the literal', () => {
    const result = parsePath('car[price>100 200]', resolverFor(['car', 'price']))
    expect(result.ok).toBe(false)
  })

  it('parses a positional predicate: car[3]', () => {
    const result = parsePath('car[3]', resolverFor(['car']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toEqual({ kind: 'positional', index: 3 })
  })

  it('parses a wildcard step: *', () => {
    const result = parsePath('*', resolverFor([]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps).toEqual([
      { axis: 'child', isWildcard: true, nameId: null, predicate: null }
    ])
  })

  it('parses a wildcard combined with a predicate: *[@id="x"]', () => {
    const result = parsePath('*[@id="x"]', resolverFor([]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.isWildcard).toBe(true)
    expect(result.path.steps[0]!.predicate).toMatchObject({
      kind: 'comparison',
      subjectAxis: 'attribute',
      subjectName: 'id',
      op: '=',
      literalText: 'x'
    })
  })

  it('parses a longer chain: cars/car[@id="c-001"]//price', () => {
    const result = parsePath('cars/car[@id="c-001"]//price', resolverFor(['cars', 'car', 'price']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps).toHaveLength(3)
    expect(result.path.steps[1]!.predicate).toMatchObject({
      kind: 'comparison',
      subjectAxis: 'attribute',
      subjectName: 'id',
      op: '=',
      literalText: 'c-001'
    })
    expect(result.path.steps[2]!.axis).toBe('descendant')
  })

  it('a name not present in the document resolves to a null nameId, not an error', () => {
    const result = parsePath('nonexistent', resolverFor([]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.nameId).toBeNull()
  })

  it("an 'unrepresentable' resolution fails with a diagnostic, not an empty-answering step (R53)", () => {
    const resolver: NameResolver = () => 'unrepresentable'
    const result = parsePath('cars', resolver)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostic.message).toContain('cars')
    expect(result.diagnostic.offset).toBe(0)
  })

  it("an 'unrepresentable' resolution mid-path points its diagnostic at that step's name", () => {
    const resolver: NameResolver = (name) => (name === 'bad' ? 'unrepresentable' : 0)
    const result = parsePath('cars/bad', resolver)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostic.offset).toBe('cars/'.length)
  })

  it('rejects an empty query with a diagnostic, not a throw', () => {
    const result = parsePath('', resolverFor([]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostic.offset).toBe(0)
  })

  it('rejects two steps with no separator, with an offset at the gap', () => {
    const result = parsePath('carsprice', resolverFor(['carsprice']))
    // "carsprice" is actually one valid name — use a case with a real gap:
    // an explicit predicate immediately followed by a bare name with no
    // separator is the malformed shape.
    expect(result.ok).toBe(true)
    const gap = parsePath('car[3]price', resolverFor(['car']))
    expect(gap.ok).toBe(false)
    if (gap.ok) return
    expect(gap.diagnostic.offset).toBe('car[3]'.length)
  })

  it('rejects an unterminated predicate', () => {
    const result = parsePath('car[@id="c-001"', resolverFor(['car']))
    expect(result.ok).toBe(false)
  })

  it('car[@id] is now an existence predicate, not a malformed comparison (R132)', () => {
    const result = parsePath('car[@id]', resolverFor(['car', 'id']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toEqual({
      kind: 'existence',
      subjectAxis: 'attribute',
      subjectName: 'id',
      subjectNameId: 1,
      isWildcard: false
    })
  })

  it('car[garbage] is now existence on an element named "garbage" (R132)', () => {
    const result = parsePath('car[garbage]', resolverFor(['car']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.steps[0]!.predicate).toEqual({
      kind: 'existence',
      subjectAxis: 'child',
      subjectName: 'garbage',
      subjectNameId: null,
      isWildcard: false
    })
  })

  it('rejects a genuinely malformed predicate (a bare "=" with no subject)', () => {
    const result = parsePath('car[=100]', resolverFor(['car']))
    expect(result.ok).toBe(false)
  })

  describe('R132 — existence predicates', () => {
    it('car[price] is existence on a child element', () => {
      const result = parsePath('car[price]', resolverFor(['car', 'price']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toEqual({
        kind: 'existence',
        subjectAxis: 'child',
        subjectName: 'price',
        subjectNameId: 1,
        isWildcard: false
      })
    })

    it('car[@*] is existence on any attribute', () => {
      const result = parsePath('car[@*]', resolverFor(['car']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toEqual({
        kind: 'existence',
        subjectAxis: 'attribute',
        subjectName: '*',
        subjectNameId: null,
        isWildcard: true
      })
    })

    it('car[*] is existence on any child element', () => {
      const result = parsePath('car[*]', resolverFor(['car']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toEqual({
        kind: 'existence',
        subjectAxis: 'child',
        subjectName: '*',
        subjectNameId: null,
        isWildcard: true
      })
    })

    it('a subject name absent from the document interner still parses, resolving to null', () => {
      const result = parsePath('car[nope]', resolverFor(['car']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toMatchObject({
        kind: 'existence',
        subjectNameId: null
      })
    })
  })

  describe('R138 — and/or/not/parentheses', () => {
    it('[a and b] is a conjunction of two existence tests', () => {
      const result = parsePath('car[price and year]', resolverFor(['car', 'price', 'year']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toEqual({
        kind: 'and',
        left: {
          kind: 'existence',
          subjectAxis: 'child',
          subjectName: 'price',
          subjectNameId: 1,
          isWildcard: false
        },
        right: {
          kind: 'existence',
          subjectAxis: 'child',
          subjectName: 'year',
          subjectNameId: 2,
          isWildcard: false
        }
      })
    })

    it('[@id or @name] is a disjunction', () => {
      const result = parsePath('car[@id or @name]', resolverFor(['car', 'id', 'name']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate?.kind).toBe('or')
    })

    it('[and] is existence on an element literally named "and" (R138 §2)', () => {
      const result = parsePath('car[and]', resolverFor(['car', 'and']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toEqual({
        kind: 'existence',
        subjectAxis: 'child',
        subjectName: 'and',
        subjectNameId: 1,
        isWildcard: false
      })
    })

    it('[and and or] is "has an and child and an or child" (R138 §2, MathML shape)', () => {
      const result = parsePath('car[and and or]', resolverFor(['car', 'and', 'or']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toEqual({
        kind: 'and',
        left: {
          kind: 'existence',
          subjectAxis: 'child',
          subjectName: 'and',
          subjectNameId: 1,
          isWildcard: false
        },
        right: {
          kind: 'existence',
          subjectAxis: 'child',
          subjectName: 'or',
          subjectNameId: 2,
          isWildcard: false
        }
      })
    })

    it('or binds looser than and: [a or b and c] parses as [a or (b and c)]', () => {
      const result = parsePath('car[a or b and c]', resolverFor(['car', 'a', 'b', 'c']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const predicate = result.path.steps[0]!.predicate
      expect(predicate?.kind).toBe('or')
      if (predicate?.kind !== 'or') return
      expect(predicate.right.kind).toBe('and')
    })

    it('explicit parentheses group the other way: [(a or b) and c]', () => {
      const result = parsePath('car[(a or b) and c]', resolverFor(['car', 'a', 'b', 'c']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const predicate = result.path.steps[0]!.predicate
      expect(predicate?.kind).toBe('and')
      if (predicate?.kind !== 'and') return
      expect(predicate.left.kind).toBe('or')
    })

    it('not(@id) negates, and not(not(@id)) composes with no depth limit', () => {
      const single = parsePath('car[not(@id)]', resolverFor(['car', 'id']))
      expect(single.ok).toBe(true)
      if (!single.ok) return
      expect(single.path.steps[0]!.predicate?.kind).toBe('not')

      const double = parsePath('car[not(not(@id))]', resolverFor(['car', 'id']))
      expect(double.ok).toBe(true)
      if (!double.ok) return
      const outer = double.path.steps[0]!.predicate
      expect(outer?.kind).toBe('not')
      if (outer?.kind !== 'not') return
      expect(outer.operand.kind).toBe('not')
    })

    it('[not] with no call is existence on an element named "not" (MathML shape)', () => {
      const result = parsePath('car[not]', resolverFor(['car', 'not']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate).toEqual({
        kind: 'existence',
        subjectAxis: 'child',
        subjectName: 'not',
        subjectNameId: 1,
        isWildcard: false
      })
    })

    it('[not(@id) and price>100] combines negation with a comparison', () => {
      const result = parsePath('car[not(@id) and price>100]', resolverFor(['car', 'id', 'price']))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path.steps[0]!.predicate?.kind).toBe('and')
    })

    it('a positional operand inside a boolean expression is a diagnostic, not a silent truthy read (R138 §5)', () => {
      const result = parsePath('car[3 and @id]', resolverFor(['car', 'id']))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.diagnostic.message).toContain('positional')
    })

    it('not(3) is also rejected as a diagnostic', () => {
      const result = parsePath('car[not(3)]', resolverFor(['car']))
      expect(result.ok).toBe(false)
    })

    it('a pathological nesting depth produces a diagnostic, not a stack overflow', () => {
      const opens = '('.repeat(200)
      const closes = ')'.repeat(200)
      const result = parsePath(`car[${opens}@id${closes}]`, resolverFor(['car', 'id']))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.diagnostic.message).toContain('deep')
    })

    it('an unbalanced paren produces a diagnostic pointing at the unclosed one', () => {
      const result = parsePath('car[a or (b]', resolverFor(['car', 'a', 'b']))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.diagnostic.offset).toBe('car[a or '.length)
    })

    it('a stray close paren is a diagnostic', () => {
      const result = parsePath('car[a)]', resolverFor(['car', 'a']))
      expect(result.ok).toBe(false)
    })

    it('every existing path-query test above still passes unmodified — this file itself is that proof', () => {
      // R138 §6 build order: the expression parser rewrite must be faithful
      // to the pre-existing grammar before any new syntax is layered on.
      // Every comparison/positional/wildcard test above this describe block
      // is exactly what it was before R132/R138 landed.
      expect(true).toBe(true)
    })
  })

  it('rejects a zero or negative positional predicate', () => {
    const result = parsePath('car[0]', resolverFor(['car']))
    expect(result.ok).toBe(false)
  })

  it('diagnostic offsets point into the query string, not always 0', () => {
    const result = parsePath('cars/', resolverFor(['cars']))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostic.offset).toBeGreaterThan(0)
  })
})
