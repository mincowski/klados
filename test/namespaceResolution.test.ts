/**
 * R134–R135 — XML namespace resolution: per-name for the common case
 * (`NodeStore.resolvedNameIdOf`), the R135 rebinding fallback, and the
 * capability gate that keeps a colon in a JSON key from ever being split.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { NodeRef, ParseOptions } from '../src/core/types'
import { NodeKind } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { runParseJob, type ParseJobRequest } from '../src/worker/parse.worker'
import { rehydrateParseResult } from '../src/core/parseClient'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): NodeStore {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(
    bytes,
    new Interner(undefined, xmlFormatModule.capabilities.hasNamespaces)
  )
  const result = xmlFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return store
}

function parseJson(text: string): NodeStore {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(
    bytes,
    new Interner(undefined, jsonFormatModule.capabilities.hasNamespaces)
  )
  const result = jsonFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return store
}

/** Every Element child of `node`, in document order. */
function elementChildren(store: NodeStore, node: NodeRef): NodeRef[] {
  return [...store.childrenOf(node)].filter((c) => store.kindOf(c) === NodeKind.Element)
}

/** Node 0 is always the Document node (`NodeKind.Document`), never the
 * document's own root element — every fixture below is one root element
 * wrapping the shape under test, so this is the one common entry point. */
function rootElement(store: NodeStore): NodeRef {
  return elementChildren(store, 0)[0]!
}

describe('R134 — resolution that costs per name, not per node', () => {
  it('two sections using different prefixes for one namespace resolve to the same id', () => {
    const store = parseXml(
      '<root>' +
        '<a:price xmlns:a="urn:x">1</a:price>' +
        '<b:price xmlns:b="urn:x">2</b:price>' +
        '</root>'
    )
    const [first, second] = elementChildren(store, rootElement(store))
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(store.resolvedNameIdOf(first!)).toBe(store.resolvedNameIdOf(second!))
    // And they are genuinely different raw names, so this is a real merge,
    // not a coincidence of identical spelling.
    expect(store.nameIdOf(first!)).not.toBe(store.nameIdOf(second!))
  })

  it('an unprefixed name with no default namespace in scope resolves to itself', () => {
    const store = parseXml('<root><price>1</price></root>')
    const [price] = elementChildren(store, rootElement(store))
    expect(store.resolvedNameIdOf(price!)).toBe(store.nameIdOf(price!))
  })

  it('an unprefixed element inherits the default namespace, matching an explicit prefix bound to the same URI', () => {
    const store = parseXml(
      '<a><r1 xmlns="urn:x"><price>1</price></r1><r2 xmlns:p="urn:x"><p:price>2</p:price></r2></a>'
    )
    const [r1, r2] = elementChildren(store, rootElement(store))
    const [price1] = elementChildren(store, r1!)
    const [price2] = elementChildren(store, r2!)
    expect(store.resolvedNameIdOf(price1!)).toBe(store.resolvedNameIdOf(price2!))
  })

  it('a namespace-free document resolves every element to itself, and reports no rebinding', () => {
    const store = parseXml('<cars><car><price>1</price></car><car><price>2</price></car></cars>')
    const cars = elementChildren(store, rootElement(store))
    expect(cars).toHaveLength(2)
    for (const car of cars) {
      expect(store.resolvedNameIdOf(car)).toBe(store.nameIdOf(car))
    }
    expect(store.hasNamespaceRebinding).toBe(false)
  })

  it('the interner splits prefix/local for a resolved XML document', () => {
    const store = parseXml('<root><a:price xmlns:a="urn:x">1</a:price></root>')
    const [price] = elementChildren(store, rootElement(store))
    const nameId = store.nameIdOf(price!)
    expect(store.interner.prefixOf(nameId)).toBe('a')
    expect(store.interner.localNameOf(nameId)).toBe('price')
  })
})

describe('R134 — a namespace-free document parses measurably unchanged', () => {
  it('a namespace-capable interner costs no more than a plain one on a document with zero declarations (R110 shape)', () => {
    let xml = '<cars>'
    const n = 50_000
    for (let i = 0; i < n; i++) xml += `<car><price>${i}</price><year>2020</year></car>`
    xml += '</cars>'
    const bytes = new TextEncoder().encode(xml)

    function timeParse(namespaces: boolean): number {
      const store = new NodeStore(bytes, new Interner(undefined, namespaces))
      const start = performance.now()
      const result = xmlFormatModule.parse(bytes, store, OPTIONS)
      const elapsed = performance.now() - start
      if (!result.complete) throw new Error('fixture must parse completely')
      return elapsed
    }

    // Warm up the JIT identically for both shapes before the timed runs.
    timeParse(false)
    timeParse(true)

    // **R185: interleaved, not grouped.** This used to time three plain runs and
    // then three namespaced ones, which leaves the two shapes measuring
    // *different windows of time* on a machine whose load varies. A burst of
    // contention landing in the second half inflates only `namespaced`, and the
    // `Math.min` of three consecutive runs cannot filter out a burst that spans
    // all three.
    //
    // That is what CI observed: `plain` came in at 232 ms — squarely in line
    // with an idle local machine — while `namespaced` hit 800 ms in the same
    // run, a 3.45× ratio against a 3× ceiling. Uniform slowness would have
    // inflated both.
    //
    // Interleaving makes each shape sample the same stretch of wall clock, so
    // contention hits both and the ratio survives it. The ceiling is unchanged.
    // **Paired, and compared as a ratio per pair.** Timing the two shapes
    // back to back and dividing within the pair is what cancels contention:
    // a burst that slows one run almost always slows its neighbour, so it
    // divides out instead of landing on whichever shape happened to be
    // measured while it lasted.
    const ratios: number[] = []
    const plainRuns: number[] = []
    const namespacedRuns: number[] = []
    for (let run = 0; run < 5; run++) {
      const p = timeParse(false)
      const n = timeParse(true)
      plainRuns.push(p)
      namespacedRuns.push(n)
      ratios.push(n / p)
    }
    // The median, not the mean: one pair straddling a GC pause should not move
    // the verdict, and with five pairs the median needs three of them to agree.
    const ratio = [...ratios].sort((a, b) => a - b)[2]!
    const plain = Math.min(...plainRuns)
    const namespaced = Math.min(...namespacedRuns)

    // Generous ratio, not a tight budget — the point is "no per-node
    // resolution work leaked into the declaration-free fast path," not a
    // precise number CI hardware variance would make flaky.
    //
    // R153 (`docs/plans/R151-ci-matrix.md` §4): 2× was not generous enough.
    // CI measured 2.024 — `expected 650.3867979999995 to be less than
    // 642.3825140000008`, i.e. over by 1.2% — on a contended shared runner.
    // R141 raised the *timeout* wrapped around this test, in
    // `vitest.config.ts`, and never revisited the *ratio* inside it.
    //
    // Raising a performance ceiling is exactly the move that hides a real
    // regression, so the justification is what a regression looks like, not
    // that the run was close: per-node namespace work on a 150,000-node
    // document costs a *multiple*, not 2%. 3× still fails loudly for the
    // defect this guards and stops failing for runner noise. The additive
    // arm is unchanged — it only governs the small-input case.
    //
    // **R185: the ceiling was not raised again — it was tightened, and the
    // measurements are why.**
    //
    // It failed once more on `macos-latest` at 3.45×, and the obvious move —
    // 3× to 4× — is the one R153's own note above warns against. So the ratio
    // was measured instead. Twelve consecutive samples of the old grouped
    // shape, on an idle machine:
    //
    //     0.960  0.983  0.985  0.991  0.991  0.992
    //     0.994  0.997  1.002  1.006  1.024  1.025
    //
    // **Every one within ±4% of parity**, so there is no per-node cost hiding
    // under the generous ratio and the fast path is genuinely clean.
    //
    // **Then the guard itself was measured, by injecting a per-node cost into
    // the namespaced path and asking what the ceiling actually catches:**
    //
    //     injected cost   old (min/min, 3×)   new (paired median, 1.5×)
    //     none            0.983  passes            0.984  passes
    //     20×             1.075  passes            1.069  passes
    //     100×            1.391  passes            1.419  passes
    //     400×            2.747  **passes**        2.805  **fails — caught**
    //     1000×           5.206  fails             5.481  fails
    //
    // That is the cost of R153's raise, stated plainly: everything between
    // parity and 3× was a blind spot, and **a parse taking 2.7× as long sat
    // inside it** — a regression far larger than the one the assertion exists
    // to catch, passing silently.
    //
    // R153 raised the number to stop the flakes. This round removes the flakes'
    // *cause* instead, and that is what makes a tighter ceiling safe rather
    // than reckless: pairing and dividing within the pair cancels the
    // contention, so the noise the ceiling had to clear is gone.
    //
    // **1.5× on the paired median**, well clear of the ±4% the measurements
    // show and well under the 2.7× that used to pass. The additive arm is kept
    // for the small-input case, where a few milliseconds of noise dominates any
    // ratio.
    //
    // Rejected: Vitest's `retry`. It would have greened this and R152 in one
    // line, and it would have hidden R152's missing wait completely.
    //
    // Rejected: skipping this on CI. A performance guard that runs only where
    // nobody looks is R47's buried lint signal in a new place.
    expect(ratio, `paired ratios: ${ratios.map((r) => r.toFixed(3)).join(', ')}`).toBeLessThan(1.5)
    // The absolute arm, unchanged in spirit: on a small input a few
    // milliseconds of noise swamps any ratio, so a tiny absolute difference is
    // always acceptable regardless of what the ratio says.
    expect(namespaced).toBeLessThan(Math.max(plain * 1.5, plain + 20))
    // Explicit timeout, not the 5 s default: this parses a 50,000-element
    // document eight times (two warm-ups plus three timed runs per shape).
    // The assertion above is a deliberately generous *ratio* — wall-clock
    // time is not what it measures — so a default sized for ordinary unit
    // tests turns a slower runner into a red build. It timed out on CI while
    // passing locally.
  }, 60_000)
})

describe('R135 — the rebinding fallback, pay-per-use', () => {
  it('one prefix bound to two URIs resolves two same-prefix names in different subtrees to different ids', () => {
    const store = parseXml(
      '<root>' +
        '<a xmlns:p="urn:one"><p:x>1</p:x></a>' +
        '<b xmlns:p="urn:two"><p:x>2</p:x></b>' +
        '</root>'
    )
    expect(store.hasNamespaceRebinding).toBe(true)
    const [a, b] = elementChildren(store, rootElement(store))
    const [x1] = elementChildren(store, a!)
    const [x2] = elementChildren(store, b!)
    // Same raw spelling "p:x" — one interned nameId for both occurrences.
    expect(store.nameIdOf(x1!)).toBe(store.nameIdOf(x2!))
    // But different resolved ids, since "p" means something different in
    // each subtree.
    expect(store.resolvedNameIdOf(x1!)).not.toBe(store.resolvedNameIdOf(x2!))
  })

  it('a document with no rebinding never flips hasNamespaceRebinding, even with several distinct prefixes', () => {
    const store = parseXml('<root xmlns:a="urn:a" xmlns:b="urn:b"><a:x>1</a:x><b:y>2</b:y></root>')
    expect(store.hasNamespaceRebinding).toBe(false)
  })

  it('the same prefix bound to the same URI twice (redeclared, not rebound) is not rebinding', () => {
    const store = parseXml(
      '<root><a xmlns:p="urn:same"><p:x/></a><b xmlns:p="urn:same"><p:x/></b></root>'
    )
    expect(store.hasNamespaceRebinding).toBe(false)
  })
})

describe('R134/R136 — namespace resolution survives the real worker round trip', () => {
  it('resolvedNameIdOf still merges two prefixes for one URI after runParseJob + rehydrateParseResult', () => {
    // The actual production path: `runParseJob` (worker side, real parse
    // through `NodeStore`) then `rehydrateParseResult` (main-thread side,
    // `NodeStore.fromBuffers`) — not a directly-constructed store, which is
    // what every other test in this file uses and which does not exercise
    // `exportNamespaceState`/`importNamespaceState` at all. Found in review:
    // without threading namespace state through that round trip,
    // `resolvedNameIdOf` on the store the real app actually queries would
    // silently fall back to the raw `nameIdOf` for every document, and
    // every test above would still pass.
    const text =
      '<root><a:price xmlns:a="urn:x">1</a:price><b:price xmlns:b="urn:x">2</b:price></root>'
    const bytes = new TextEncoder().encode(text)
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 1,
      bytes: bytes.buffer as ArrayBuffer,
      filename: 'ns.xml'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`parse failed: ${response.message}`)
    expect(response.hasNamespaces).toBe(true)

    const result = rehydrateParseResult(response)
    const root = result.store.firstChildOf(0)
    const [first, second] = [...result.store.childrenOf(root)]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(result.store.resolvedNameIdOf(first!)).toBe(result.store.resolvedNameIdOf(second!))
    expect(result.store.namespaceUriOf(first!)).toBe('urn:x')
  })
})

describe('R134 — the colon scan is capability-gated', () => {
  it('a JSON key containing a colon is not split, because jsonFormatModule.capabilities.hasNamespaces is false', () => {
    expect(jsonFormatModule.capabilities.hasNamespaces).toBe(false)
    const store = parseJson('{"12:30": "meeting"}')
    // Document -> root Object -> the one Property, "12:30".
    const rootObject = [...store.childrenOf(0)][0]!
    const [prop] = [...store.childrenOf(rootObject)]
    expect(prop).toBeDefined()
    expect(store.nameOf(prop!)).toBe('12:30')
    expect(store.resolvedNameIdOf(prop!)).toBe(store.nameIdOf(prop!))
    // The interner itself never even allocated a split table.
    expect(store.interner.splitsNamespaces).toBe(false)
    expect(store.interner.prefixOf(store.nameIdOf(prop!))).toBeNull()
  })
})
