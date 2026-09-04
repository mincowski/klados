/**
 * B12 — the invariant suite that protects the architecture. Runs against
 * every fixture, for both parsers. Written during B8 and extended through
 * B9, per the plan's instruction to hold both parsers to these invariants
 * while they are being built rather than afterwards.
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type {
  AncestorView,
  FormatModule,
  NodeRef,
  ParseOptions,
  ParseResult
} from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { xmlFormatModule } from '../src/formats/xml/index'

const FIXTURES_DIR = resolve(__dirname, '../spike/fixtures')
const LARGE_THRESHOLD_BYTES = 50 * 1024 * 1024
const RUN_LARGE = process.env['KLADOS_TEST_LARGE'] === '1'
const LONG_TIMEOUT = 120_000

/**
 * R48c (`R47-repo-hygiene.md`): test 5 below is a *full* `format.parse`
 * per iteration, unlike test 4 (one `parseRange` per iteration — bounded by
 * the sampled subtree, not the file) or test 6 (corrupts 100 bytes but
 * parses once). Even the smallest fixture in the default (non-`test:large`)
 * corpus, `cars-10mb.xml`, made this file alone ~85 s of the node project's
 * ~90 s default runtime — the "unusable in a tight loop" the plan names.
 * The fixture stays in the default corpus (every *other* invariant here is
 * cheap and worth running against it); only this one test's own sample
 * count shrinks for a default run, at full strength under `test:large`.
 */
const TRUNCATION_FUZZ_SAMPLES = RUN_LARGE ? 200 : 20

interface Fixture {
  name: string
  format: FormatModule
}

const ALL_FIXTURES: Fixture[] = [
  { name: 'cars-10mb.xml', format: xmlFormatModule },
  { name: 'cars-50mb.xml', format: xmlFormatModule },
  { name: 'cars-100mb.xml', format: xmlFormatModule },
  { name: 'cars-200mb.xml', format: xmlFormatModule },
  { name: 'cars-500mb.xml', format: xmlFormatModule },
  { name: 'cars-100mb.json', format: jsonFormatModule },
  { name: 'cars-100mb.min.json', format: jsonFormatModule },
  { name: 'deep-10k.json', format: jsonFormatModule },
  { name: 'deep-1m.json', format: jsonFormatModule }
]

function fixturePath(name: string): string {
  return resolve(FIXTURES_DIR, name)
}

function fixtureExists(name: string): boolean {
  try {
    statSync(fixturePath(name))
    return true
  } catch {
    return false
  }
}

const FIXTURES = ALL_FIXTURES.filter((f) => {
  if (!fixtureExists(f.name)) return false
  if (RUN_LARGE) return true
  return statSync(fixturePath(f.name)).size <= LARGE_THRESHOLD_BYTES
})

if (FIXTURES.length === 0) {
  it.skip('no fixtures found — run `npm run fixtures:generate` or check spike/fixtures/', () => {})
}

// Deep nesting fixtures need a bound well below their depth so the Fatal
// diagnostic fires quickly rather than building a million stack frames.
const DEFAULT_OPTIONS: ParseOptions = { maxDepth: 10_000, encoding: 'utf-8' }

function parseFixture(
  bytes: Uint8Array,
  format: FormatModule
): { store: NodeStore; result: ParseResult } {
  const store = new NodeStore(bytes, new Interner())
  const result = format.parse(bytes, store, DEFAULT_OPTIONS)
  return { store, result }
}

// mulberry32 — deterministic, matching the spike's fixture generator so a
// failing seed is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A pre-order flattening of (kind, name, childCount) per node — bijective
 * with the tree's shape, but as a flat array rather than a nested object.
 * Deeply nested fixtures (deep-1m.json) make a *nested* comparison object
 * dangerous even with an iterative builder: `expect().toEqual()` walks the
 * result with its own recursive deep-equality check, which blows the call
 * stack regardless of how the object was constructed. A flat array sidesteps
 * that entirely — comparing it is one shallow loop, however deep the tree.
 */
function flatShape(
  store: NodeStore,
  root: NodeRef
): Array<{ kind: number; name: string | null; childCount: number }> {
  const result: Array<{ kind: number; name: string | null; childCount: number }> = []
  const stack: NodeRef[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const children = Array.from(store.childrenOf(node))
    result.push({ kind: store.kindOf(node), name: store.nameOf(node), childCount: children.length })
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return result
}

const emptyAncestors: AncestorView = {
  length: 0,
  kindAt: () => {
    throw new Error('no ancestors')
  },
  spanStartAt: () => {
    throw new Error('no ancestors')
  },
  spanEndAt: () => {
    throw new Error('no ancestors')
  },
  attributesAt: () => []
}

describe.each(FIXTURES)('invariants — $name', ({ name, format }) => {
  const bytes = readFileSync(fixturePath(name))
  const { store, result: originalResult } = parseFixture(bytes, format)

  it(
    '1. span containment',
    () => {
      for (let node = 0; node < store.nodeCount; node++) {
        const span = store.spanOf(node)
        if (!(span.start < span.end)) {
          throw new Error(`node ${node}: span [${span.start}, ${span.end}) is not non-empty`)
        }

        const value = store.ownValueOf(node)
        if (value !== null) {
          if (value.start < span.start || value.end > span.end) {
            throw new Error(
              `node ${node}: value [${value.start}, ${value.end}) escapes its own span`
            )
          }
        }

        const parent = store.parentOf(node)
        if (parent !== -1) {
          const parentSpan = store.spanOf(parent)
          if (span.start < parentSpan.start || span.end > parentSpan.end) {
            throw new Error(`node ${node}: span escapes parent ${parent}'s span`)
          }
        }
      }
    },
    LONG_TIMEOUT
  )

  it(
    '2. sibling ordering',
    () => {
      for (let node = 0; node < store.nodeCount; node++) {
        let prev = -1
        for (const child of store.childrenOf(node)) {
          if (prev !== -1 && store.spanOf(prev).end > store.spanOf(child).start) {
            throw new Error(
              `siblings ${prev} and ${child} of node ${node} overlap or are out of order`
            )
          }
          prev = child
        }
      }
    },
    LONG_TIMEOUT
  )

  it(
    '3. link consistency',
    () => {
      const visited = new Uint8Array(store.nodeCount)
      let reachable = 0

      // Iterative pre-order walk — deep-1m.json nests far past any JS call
      // stack, which is exactly why the parsers themselves are iterative too.
      const stack: NodeRef[] = [0]
      while (stack.length > 0) {
        const node = stack.pop()!
        if (visited[node] !== 0) throw new Error(`node ${node} reached more than once`)
        visited[node] = 1
        reachable++

        let prev = -1
        const children: NodeRef[] = []
        for (const child of store.childrenOf(node)) {
          if (store.parentOf(child) !== node) {
            throw new Error(`child ${child}'s parent is not ${node}`)
          }
          if (store.prevSiblingOf(child) !== prev) {
            throw new Error(`child ${child}'s prevSibling does not match traversal order`)
          }
          if (prev !== -1 && store.nextSiblingOf(prev) !== child) {
            throw new Error(`node ${prev}'s nextSibling does not match traversal order`)
          }
          prev = child
          children.push(child)
        }
        if (prev !== -1 && store.nextSiblingOf(prev) !== -1) {
          throw new Error(`last child ${prev} of node ${node} has a dangling nextSibling`)
        }
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
      }

      expect(reachable).toBe(store.nodeCount)
    },
    LONG_TIMEOUT
  )

  it(
    '4. subtree reparse equivalence (100 random nodes)',
    () => {
      if (!originalResult.complete) {
        // deep-1m.json is intentionally incomplete (it exists to prove
        // maxDepth halts cleanly) — its "nodes" beyond the cutoff don't
        // correspond to well-formed subtrees, so there is nothing to
        // reparse-and-compare here. B12's invariant assumes a real tree.
        return
      }
      const rnd = mulberry32(0xc0ffee)
      const samples = Math.min(100, Math.max(0, store.nodeCount - 1))
      for (let i = 0; i < samples; i++) {
        const node = 1 + Math.floor(rnd() * (store.nodeCount - 1))
        const span = store.spanOf(node)

        const freshStore = new NodeStore(bytes, new Interner())
        const context = format.resumeContextFor(emptyAncestors)
        const result = format.parseRange!(
          bytes,
          span.start,
          span.end,
          freshStore,
          context,
          DEFAULT_OPTIONS
        )

        expect(result.complete).toBe(true)
        expect(flatShape(freshStore, 0)).toEqual(flatShape(store, node))
      }
    },
    LONG_TIMEOUT
  )

  it(
    `5. truncation fuzz (${TRUNCATION_FUZZ_SAMPLES} random offsets)`,
    async () => {
      const rnd = mulberry32(0xbadc0de)
      for (let i = 0; i < TRUNCATION_FUZZ_SAMPLES; i++) {
        const cut = 1 + Math.floor(rnd() * (bytes.length - 1))
        const truncated = bytes.subarray(0, cut)
        const truncatedStore = new NodeStore(truncated, new Interner())
        expect(() => format.parse(truncated, truncatedStore, DEFAULT_OPTIONS)).not.toThrow()
        // Yields every iteration so a run over a large fixture doesn't block
        // the event loop long enough to starve Vitest's own worker heartbeat.
        await new Promise((r) => setImmediate(r))
      }
    },
    LONG_TIMEOUT
  )

  it(
    '6. byte fuzz (100 corrupted bytes)',
    () => {
      const rnd = mulberry32(0xf00dbabe)
      const corrupted = Uint8Array.from(bytes)
      for (let i = 0; i < 100; i++) {
        const at = Math.floor(rnd() * corrupted.length)
        corrupted[at] = Math.floor(rnd() * 256)
      }
      const corruptedStore = new NodeStore(corrupted, new Interner())
      expect(() => format.parse(corrupted, corruptedStore, DEFAULT_OPTIONS)).not.toThrow()
    },
    LONG_TIMEOUT
  )

  it(
    '7. depth limit yields a Fatal diagnostic, never a crash',
    () => {
      const shallowOptions: ParseOptions = { maxDepth: 3, encoding: 'utf-8' }
      const shallowStore = new NodeStore(bytes, new Interner())
      let result: ParseResult | undefined
      expect(() => {
        result = format.parse(bytes, shallowStore, shallowOptions)
      }).not.toThrow()
      // Every fixture nests deeper than 3 levels, so this must report
      // incompleteness rather than silently truncating the tree.
      expect(result!.complete).toBe(false)
    },
    LONG_TIMEOUT
  )
})
