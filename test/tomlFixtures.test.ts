/**
 * M6-PLAN.md R17 — the committed fixtures under test/fixtures/toml/, exercised end to end: a
 * clean parse (zero diagnostics, complete tree), idempotent/structurally-stable formatting, and
 * — the same real production path test/subtreeSplice.test.ts already validates for hand-written
 * snippets — a splice-and-reparse round trip on a real, larger document rather than a synthetic
 * one. This is the "does the architecture actually hold up on a real file" check the generated
 * corpus in test/tomlParse.test.ts and test/tomlFormat.test.ts can't give by construction (a
 * generator only ever produces what its own rules think to produce).
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import {
  NodeKind,
  type AncestorView,
  type FormatOptions,
  type NodeRef,
  type ParseOptions
} from '../src/core/types'
import { tomlFormatModule } from '../src/formats/toml/index'

const NO_REF = -1

/** Root-first ancestor chain of `node` — the same shape
 * `subtreeSplice.ts`'s own `ancestorChain` builds, inlined here rather than
 * imported (that module's helper isn't exported for test use). */
function ancestorChain(store: NodeStore, node: NodeRef): NodeRef[] {
  const chain: NodeRef[] = []
  for (let p = store.parentOf(node); p !== NO_REF; p = store.parentOf(p)) chain.push(p)
  chain.reverse()
  return chain
}

function buildAncestorView(store: NodeStore, chain: readonly NodeRef[]): AncestorView {
  return {
    length: chain.length,
    kindAt: (i) => store.kindOf(chain[i]!),
    spanStartAt: (i) => store.spanOf(chain[i]!).start,
    spanEndAt: (i) => store.spanOf(chain[i]!).end,
    // TOML has no attributes (hasAttributes: false) — nothing to yield.
    attributesAt: (): Iterable<{ name: string; value: string }> => []
  }
}

const FIXTURES_DIR = join(__dirname, 'fixtures', 'toml')
const PARSE_OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const FORMAT_OPTIONS: FormatOptions = { indent: '  ', newline: '\n' }
const dec = new TextDecoder()

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.toml'))
}

function parseFixture(name: string): { source: Uint8Array; store: NodeStore; complete: boolean } {
  const source = readFileSync(join(FIXTURES_DIR, name))
  const store = new NodeStore(source, new Interner())
  const result = tomlFormatModule.parse(source, store, PARSE_OPTIONS)
  return { source, store, complete: result.complete }
}

describe('TOML fixtures (M6-PLAN.md R17)', () => {
  const names = fixtureNames()

  it('at least the two committed fixtures exist', () => {
    expect(names).toEqual(expect.arrayContaining(['grammar-coverage.toml', 'cargo-style.toml']))
  })

  it.each(fixtureNames())('%s parses cleanly: zero diagnostics, a complete tree', (name) => {
    const { store, complete } = parseFixture(name)
    expect(store.diagnostics, name).toEqual([])
    expect(complete, name).toBe(true)
  })

  it.each(fixtureNames())('%s: detect() recognizes it by content alone (no filename)', (name) => {
    const { source } = parseFixture(name)
    const confidence = tomlFormatModule.detect(source.subarray(0, 4096), null)
    expect(confidence, name).toBeGreaterThan(0.5)
  })

  it.each(fixtureNames())('%s: format() is idempotent and structurally lossless', (name) => {
    const { source } = parseFixture(name)
    const once = tomlFormatModule.format!(source, FORMAT_OPTIONS)
    const twice = tomlFormatModule.format!(once, FORMAT_OPTIONS)
    expect(dec.decode(twice), name).toBe(dec.decode(once))

    const before = new NodeStore(source, new Interner())
    tomlFormatModule.parse(source, before, PARSE_OPTIONS)
    const after = new NodeStore(once, new Interner())
    tomlFormatModule.parse(once, after, PARSE_OPTIONS)
    expect(after.nodeCount, name).toBe(before.nodeCount)
    for (let i = 0; i < before.nodeCount; i++) {
      expect(after.kindOf(i), `${name} node ${i}`).toBe(before.kindOf(i))
      expect(after.nameOf(i), `${name} node ${i}`).toBe(before.nameOf(i))
    }
  })

  it.each(fixtureNames())(
    '%s: every node round-trips through resumeContextFor + parseRange',
    (name) => {
      // The same shape test/subtreeSplice.test.ts's own helpers use, inlined
      // here rather than imported (that file's helpers are format-agnostic
      // but scoped to its own describe blocks) — for every node in a real
      // fixture, reparsing that exact node's own span via parseRange must
      // reproduce the same subtree parse() itself already produced. Property
      // nodes are skipped: findSpliceNode (subtreeSplice.ts) always escalates
      // past a Property to its parent, so a Property is never itself a real
      // splice target — resumeContextFor/parseRange were never meant to
      // handle one directly, only ever as an *ancestor* of one.
      const { source, store } = parseFixture(name)
      for (let i = 0; i < store.nodeCount; i++) {
        if (store.kindOf(i) === NodeKind.Property) continue
        const span = store.spanOf(i)
        const ancestors = buildAncestorView(store, ancestorChain(store, i))
        const context = tomlFormatModule.resumeContextFor(ancestors)
        const sink = new NodeStore(source, new Interner())
        const result = tomlFormatModule.parseRange(
          source,
          span.start,
          span.end,
          sink,
          context,
          PARSE_OPTIONS
        )
        expect(result.complete, `${name} node ${i} (${store.kindOf(i)})`).toBe(true)
        expect(sink.diagnostics, `${name} node ${i}`).toEqual([])
      }
    }
  )
})
