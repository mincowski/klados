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
import { NodeKind } from '../src/core/types'
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

/** The generated corpus — gigabytes, ignored wholesale by `spike/.gitignore`,
 * rebuilt by `npm run fixtures:generate`. Tests skip cleanly when absent. */
const GENERATED_FIXTURES_DIR = resolve(__dirname, '../spike/fixtures')
/** R189: committed fixtures, small enough to live in the repository — the home
 * `crlf/small.json` and `toml/` already use. A tracked file cannot go in the
 * generated directory, which is ignored in its entirety. */
const COMMITTED_FIXTURES_DIR = resolve(__dirname, 'fixtures')
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

/**
 * R188 (`docs/plans/R187-large-suite-honesty.md` §6) — **a budget in bytes
 * parsed, not in samples.**
 *
 * Test 5 is a full `format.parse` per iteration over a random prefix, so its
 * cost is `samples × fixture size × ~0.5` (cuts are uniform, so the average
 * prefix is half the file). A flat 200 samples ignores the size entirely, and
 * under `test:large` **every large fixture blew `LONG_TIMEOUT`**: 122 s to
 * 179 s against a 120 s budget, eight tests, ~25 minutes for this file alone.
 *
 * **The rate had to be measured in the loop, not in isolation — and the first
 * attempt at this budget got that wrong.** One parse of a 98% prefix, timed in
 * a fresh process, runs at ~79 MB/s (514 MB of `cars-500mb.xml` in 6.51 s).
 * Sizing the budget from that number produced a floor of 8 samples, which
 * promptly timed out at 136 s.
 *
 * In the loop each iteration allocates a **fresh `NodeStore` and `Interner`**
 * for a prefix averaging half the file, so allocation and GC dominate and the
 * sustained rate is five to eleven times lower. Measured from a real
 * `test:large` run:
 *
 *     fixture              samples   MB parsed   duration   MB/s
 *     cars-10mb.xml            79        414      28.1s     14.7
 *     cars-50mb.xml            15        393      30.4s     12.9
 *     cars-100mb.xml            8        419      29.4s     14.3
 *     cars-200mb.xml            8        839      59.9s     14.0
 *     cars-500mb.xml            8       2097     136.7s     15.3  ← timed out
 *     cars-100mb.json           8        419      60.2s      7.0
 *     cars-100mb.min.json       8        419      60.6s      6.9
 *
 * **~14 MB/s for XML and ~7 MB/s for JSON.** The budget below is sized from the
 * JSON figure, the slower of the two.
 *
 * **Raising `LONG_TIMEOUT` was rejected.** The fuzz's value is coverage of the
 * offset space, and 200 samples of a 500 MB file is not ten times the
 * information of 20 — the offsets come from the same distribution either way.
 * It is the same coverage at ten times the cost.
 *
 * **The floor is 2, not 8**, because on the largest fixtures the floor is what
 * binds and it has to be affordable rather than comfortable. A 500 MB fixture
 * exists to prove size handling, not offset coverage; the small fixtures carry
 * the coverage, at 200 samples each for a fraction of a second.
 *
 * At 300 MB and a floor of 2 the worst case is `cars-100mb.json` at ~37 s and
 * `cars-500mb.xml` at ~34 s, both well inside `LONG_TIMEOUT` with room for a
 * loaded machine. Verified by a full `test:large` run, not projected.
 */
/**
 * **The budget binds only under `test:large`.** A default run keeps the flat 20
 * it has had since R48c, unchanged.
 *
 * A first version applied a 40 MB budget in both modes, which quietly took
 * `cars-10mb.xml` from 20 samples to 7 — a 65% cut to everyday coverage,
 * arriving as a side effect of a fix for a different mode, and showing up only
 * as a suite that had got suspiciously faster. The default run was not the
 * thing that was broken.
 */
const FUZZ_BYTE_BUDGET = RUN_LARGE ? 300 * 1024 * 1024 : Number.POSITIVE_INFINITY
const FUZZ_MIN_SAMPLES = 2

/** How many truncation samples `size` bytes can afford. Each sample parses
 * about half the file, so the budget divides by `size / 2`. */
function truncationSamplesFor(size: number): number {
  const perSample = Math.max(1, size / 2)
  const affordable = Math.floor(FUZZ_BYTE_BUDGET / perSample)
  return Math.max(FUZZ_MIN_SAMPLES, Math.min(TRUNCATION_FUZZ_SAMPLES, affordable))
}

interface Fixture {
  name: string
  format: FormatModule
  /** R189: committed fixtures resolve against `test/fixtures/`; everything else
   * against the generated corpus. Absent means generated. */
  committed?: true
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
  { name: 'deep-1m.json', format: jsonFormatModule },
  // R189 (`docs/plans/R187-large-suite-honesty.md` §7) — **the fixture whose
  // absence is why R187 exists.**
  //
  // Censused before it was written: across every fixture above, the default
  // (non-`test:large`) corpus contained **zero `Property` nodes and zero
  // `Object` nodes** — `cars-10mb.xml` is Element/Comment, `deep-10k.json` is
  // Array/Scalar, `deep-1m.json` is Array and incomplete. The only fixture
  // carrying properties is `cars-100mb.json` at 72.6%, excluded by size.
  //
  // So invariant 4 had never once run against the node kind that breaks it, and
  // the failure sat in a command nobody could execute. Kilobytes, because its
  // value is the kinds it carries and not its size.
  { name: 'kinds/properties.json', format: jsonFormatModule, committed: true }
]

function fixturePath(fixture: Fixture): string {
  return resolve(
    fixture.committed === true ? COMMITTED_FIXTURES_DIR : GENERATED_FIXTURES_DIR,
    fixture.name
  )
}

function fixtureExists(fixture: Fixture): boolean {
  try {
    statSync(fixturePath(fixture))
    return true
  } catch {
    return false
  }
}

const FIXTURES = ALL_FIXTURES.filter((f) => {
  if (!fixtureExists(f)) return false
  if (RUN_LARGE) return true
  return statSync(fixturePath(f)).size <= LARGE_THRESHOLD_BYTES
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

describe.each(FIXTURES)('invariants — $name', (fixture) => {
  const { format } = fixture
  const bytes = readFileSync(fixturePath(fixture))
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
      // **R187: sample only nodes the product promises are reparseable alone.**
      //
      // `subtreeSplice.ts`'s `findSpliceNode` walks *up* past a `Property`
      // before ever calling `parseRange`, and says why: "its own span is never
      // independently reparseable. JSON's `parseRange` only knows how to parse
      // a bare *value*; a `"key":value` pair has no grammar production of its
      // own to reparse standalone. Every format's Property kind is exactly this
      // shape (D-030)."
      //
      // This invariant used to hand `parseRange` every kind, Property included,
      // and assert the property came back. It cannot: `"year": 2011` re-parses
      // to a bare `Scalar` with no name. **61 of 100 samples failed on
      // `cars-100mb.json`, every one of them a Property** — an invariant
      // asserting something the product documents as impossible.
      //
      // It went unnoticed because the default corpus had **zero Property nodes**
      // until R189 added one: `cars-10mb.xml` is Element/Comment,
      // `deep-10k.json` is Array/Scalar, and the only property-bearing fixture
      // was 100 MB and excluded by size, in a command that could not complete.
      //
      // The eligible count is taken exactly rather than by rejection alone, so a
      // fixture that is nearly all properties samples what it actually has
      // instead of silently sampling four nodes and passing.
      let eligibleCount = 0
      for (let n = 1; n < store.nodeCount; n++) {
        if (store.kindOf(n) !== NodeKind.Property) eligibleCount++
      }
      const rnd = mulberry32(0xc0ffee)
      const samples = Math.min(100, eligibleCount)
      const drawn: number[] = []
      // Generous, and bounded so a pathological fixture fails the assertion
      // below rather than spinning: at 99% properties, 100 draws need ~10,000.
      const maxDraws = 200_000
      for (let draw = 0; drawn.length < samples && draw < maxDraws; draw++) {
        const candidate = 1 + Math.floor(rnd() * (store.nodeCount - 1))
        if (store.kindOf(candidate) === NodeKind.Property) continue
        drawn.push(candidate)
      }
      expect(
        drawn.length,
        `sampled ${drawn.length} of ${samples} eligible nodes (${eligibleCount} non-Property of ${store.nodeCount - 1})`
      ).toBe(samples)

      for (const node of drawn) {
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

  const truncationSamples = truncationSamplesFor(bytes.length)

  it(
    `5. truncation fuzz (${truncationSamples} random offsets)`,
    async () => {
      const rnd = mulberry32(0xbadc0de)
      for (let i = 0; i < truncationSamples; i++) {
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
