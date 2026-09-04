#!/usr/bin/env node
/**
 * M3-PLAN.md F10 — the measurement pass. Standalone (`tsx spike/m3-bench.ts`),
 * same "spike/, not test/" placement as the harnesses M0a/D15 built:
 * this measures wall-clock cost against the large gitignored fixtures
 * (`spike/fixtures/`), not correctness — `test/subtreeSplice.test.ts` and
 * friends already own that.
 *
 * Measures, in order: subtree reparse latency vs. a full reparse baseline
 * (§13's oldest open question), patch-application cost at each size,
 * `deltaList.ts`'s `shiftedOffset` per-call cost synthetically (nothing in
 * the live app calls it on a real read path — see the report this feeds),
 * and the round-trip invariant against every fixture this milestone
 * touches, both formats.
 */
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { detectEncoding as detectEncodingFromBom } from '../src/core/encoding'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { FormatModule, NodeRef, ParseOptions } from '../src/core/types'
import { selectFormat } from '../src/formats/registry'
import { applyPatch, type Patch } from '../src/renderer/session/documentEdits'
import { spliceSubtree } from '../src/renderer/session/subtreeSplice'
import { recordDelta, shiftedOffset, EMPTY_DELTA_LIST, type DeltaList } from '../src/core/deltaList'

const FIXTURES_DIR = resolve(__dirname, 'fixtures')

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1)} ms`
}

function timeMs<T>(fn: () => T): { result: T; ms: number } {
  const start = process.hrtime.bigint()
  const result = fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  return { result, ms }
}

interface LoadedFixture {
  readonly path: string
  readonly name: string
  readonly bytes: Uint8Array
  readonly format: FormatModule
  readonly options: ParseOptions
}

function loadFixture(name: string): LoadedFixture | null {
  const path = resolve(FIXTURES_DIR, name)
  let raw: Uint8Array
  try {
    raw = new Uint8Array(readFileSync(path))
  } catch {
    return null
  }
  const head = raw.subarray(0, Math.min(4096, raw.length))
  const format = selectFormat(head, name)
  if (format === null) return null
  const declared = format.detectEncoding(head)
  const encoding = detectEncodingFromBom(raw, declared)
  return {
    path,
    name,
    bytes: raw,
    format,
    options: { maxDepth: 10_000, encoding }
  }
}

/** A leaf node reasonably deep in the tree — not the first child (too
 * shallow to be representative), not a search for "the deepest" (this is
 * about typical editing, not a worst case). Walks down through the first
 * child at each level until the depth cap or a childless node. */
function pickDeepLeaf(store: NodeStore, root: NodeRef, targetDepth: number): NodeRef {
  let node = root
  for (let depth = 0; depth < targetDepth; depth++) {
    const child = store.firstChildOf(node)
    if (child === -1) break
    node = child
  }
  return node
}

// --- 1 & 3: subtree reparse latency vs. full reparse, and patch cost -----

function benchSubtreeSplice(fixtureName: string): void {
  const fixture = loadFixture(fixtureName)
  if (fixture === null) {
    console.log(`  ${fixtureName}: not present, skipped`)
    return
  }

  const store = new NodeStore(fixture.bytes, new Interner())
  const parseResult = timeMs(() => fixture.format.parse(fixture.bytes, store, fixture.options))
  if (!parseResult.result.complete) {
    console.log(`  ${fixtureName}: fixture did not parse completely, skipped`)
    return
  }

  const leaf = pickDeepLeaf(store, 0, 6)
  const leafValue = store.valueOf(leaf)
  if (leafValue === null) {
    console.log(`  ${fixtureName}: no scalar value found at the sampled depth, skipped`)
    return
  }

  // A representative small edit: replace the leaf's value with something
  // one byte longer, the shape a single keystroke produces.
  const editStart = leafValue.start
  const editEnd = leafValue.end
  const oldValueLength = editEnd - editStart
  const replacement = new TextEncoder().encode('X'.repeat(oldValueLength + 1))
  const delta = replacement.length - oldValueLength

  // --- patch application cost (F1) ---
  const patch: Patch = { start: editStart, end: editEnd, replacement }
  const patchResult = timeMs(() => applyPatch(fixture.bytes, patch))
  const newBytes = patchResult.result

  // --- subtree splice ---
  const spliceResult = timeMs(() =>
    spliceSubtree({
      format: fixture.format,
      oldStore: store,
      newBytes,
      interner: store.interner,
      dirtyStart: editStart,
      dirtyEnd: editEnd,
      delta,
      options: fixture.options
    })
  )

  // --- full reparse baseline, same edited buffer ---
  const freshStore = new NodeStore(newBytes, new Interner())
  const fullResult = timeMs(() => fixture.format.parse(newBytes, freshStore, fixture.options))

  const spliceOk = spliceResult.result.ok
  console.log(
    `  ${fixtureName.padEnd(20)} ${fmtBytes(fixture.bytes.length).padStart(9)}  parse ${fmtMs(parseResult.ms).padStart(9)}  patch ${fmtMs(patchResult.ms).padStart(9)}  splice ${(spliceOk ? fmtMs(spliceResult.ms) : 'FAILED').padStart(9)}  full-reparse ${fmtMs(fullResult.ms).padStart(9)}  speedup ${spliceOk ? (fullResult.ms / spliceResult.ms).toFixed(0) + 'x' : 'n/a'}`
  )
}

// --- 2: deltaList shiftedOffset synthetic cost -----------------------------

function benchDeltaList(): void {
  for (const count of [10, 64, 200, 1000, 10_000]) {
    let list: DeltaList = EMPTY_DELTA_LIST
    for (let i = 0; i < count; i++) {
      list = recordDelta(list, i * 100, 1)
    }
    const iterations = 200_000
    const { ms } = timeMs(() => {
      let sum = 0
      for (let i = 0; i < iterations; i++) {
        sum += shiftedOffset(list, (i % count) * 100 + 50)
      }
      return sum
    })
    const perCallNs = (ms / iterations) * 1e6
    console.log(
      `  ${String(count).padStart(6)} deltas: ${iterations.toLocaleString()} calls in ${fmtMs(ms)} (${perCallNs.toFixed(0)} ns/call)`
    )
  }
}

// --- 4: round-trip invariant across every fixture -------------------------

function benchRoundTrip(fixtureName: string): void {
  const fixture = loadFixture(fixtureName)
  if (fixture === null) {
    console.log(`  ${fixtureName}: not present, skipped`)
    return
  }
  // Save writes `sourceBuffer.bytes` verbatim (F7) — no parse involved on
  // the write side at all. This is what actually exercises: that reading a
  // large file and handing the exact same bytes back out produces a
  // byte-identical result, at scale, not just for the small synthetic
  // buffers `test/documentSession.test.ts`'s own round-trip suite covers.
  const tmpPath = resolve(FIXTURES_DIR, `.roundtrip-${fixtureName}`)
  writeFileSync(tmpPath, fixture.bytes)
  const writtenBytes = readFileSync(tmpPath)
  const identical =
    writtenBytes.length === fixture.bytes.length &&
    Buffer.from(fixture.bytes).equals(writtenBytes)
  console.log(`  ${fixtureName.padEnd(20)} ${identical ? 'byte-identical' : 'MISMATCH'}`)
  try {
    statSync(tmpPath)
    unlinkSync(tmpPath)
  } catch {
    // best-effort cleanup
  }
}

function main(): void {
  console.log('=== 1 & 3. Subtree reparse latency vs. full reparse, and patch cost ===\n')
  for (const name of [
    'cars-10mb.xml',
    'cars-50mb.xml',
    'cars-100mb.xml',
    'cars-200mb.xml',
    'cars-500mb.xml'
  ]) {
    benchSubtreeSplice(name)
  }
  console.log()

  console.log('=== 2. deltaList.ts shiftedOffset — synthetic per-call cost ===\n')
  benchDeltaList()
  console.log()

  console.log('=== 4. Round-trip invariant — every fixture, byte comparison ===\n')
  for (const name of [
    'cars-10mb.xml',
    'cars-50mb.xml',
    'cars-100mb.xml',
    'cars-200mb.xml',
    'cars-500mb.xml',
    'cars-100mb.json',
    'cars-100mb.min.json',
    'deep-10k.json',
    'deep-1m.json'
  ]) {
    benchRoundTrip(name)
  }
}

main()
