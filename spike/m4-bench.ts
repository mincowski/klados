#!/usr/bin/env node
/**
 * M4-PLAN.md G10 — the measurement pass. Standalone (`npx tsx
 * spike/m4-bench.ts`), same "spike/, not test/" placement as M0a/D15/F10's
 * own harnesses: wall-clock cost against the large gitignored fixtures
 * (`spike/fixtures/`), not correctness — `test/textFind.test.ts`,
 * `test/nameIndex.test.ts` and `test/pathEvaluate.test.ts` already own that.
 *
 * Measures, in order: text find latency (byte path and decoded path,
 * separately — they are not the same algorithm), name index build
 * time/memory as a line item against §8's budget table, name index
 * invalidation cost after a subtree splice, path evaluation cost for each
 * step type including `//name` against a naive full scan, and the longest
 * synchronous slice G3's scheduler produces while chunking a search over
 * the largest fixture.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { detectEncoding as detectEncodingFromBom } from '../src/core/encoding'
import { Interner } from '../src/core/interner'
import { buildNameIndex, nameIndexMemoryBytes, nodesByNameId } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { FormatModule, ParseOptions } from '../src/core/types'
import { selectFormat } from '../src/formats/registry'
import { evaluatePath } from '../src/core/path/evaluate'
import { parsePath } from '../src/core/path/parse'
import { findAsciiInRange, findAll } from '../src/core/textFind'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { applyPatch, type Patch } from '../src/renderer/session/documentEdits'
import { spliceSubtree } from '../src/renderer/session/subtreeSplice'
import { runChunkedJob } from '../src/renderer/session/searchJob'

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

async function timeMsAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = process.hrtime.bigint()
  const result = await fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  return { result, ms }
}

interface LoadedFixture {
  readonly path: string
  readonly name: string
  readonly bytes: Uint8Array
  readonly format: FormatModule
  readonly options: ParseOptions
  readonly encoding: string
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
    options: { maxDepth: 10_000, encoding },
    encoding
  }
}

interface ParsedFixture extends LoadedFixture {
  readonly store: NodeStore
  readonly source: SourceBuffer
  readonly rowIndex: Int32Array
}

function parseFixture(fixture: LoadedFixture): ParsedFixture | null {
  const store = new NodeStore(fixture.bytes, new Interner())
  const result = fixture.format.parse(fixture.bytes, store, fixture.options)
  if (!result.complete) return null
  const rowIndex = buildRowIndex(fixture.bytes, DEFAULT_MAX_ROW_BYTES, fixture.format.capabilities.rowBreakBytes)
  return { ...fixture, store, source: new SourceBuffer(fixture.bytes, fixture.encoding, 0), rowIndex }
}

const XML_FIXTURES = [
  'cars-10mb.xml',
  'cars-50mb.xml',
  'cars-100mb.xml',
  'cars-200mb.xml',
  'cars-500mb.xml'
]

// --- 1. Text find latency: byte path vs. decoded path ---------------------

function benchTextFind(fixtureName: string): void {
  const loaded = loadFixture(fixtureName)
  if (loaded === null) {
    console.log(`  ${fixtureName}: not present, skipped`)
    return
  }
  const parsed = parseFixture(loaded)
  if (parsed === null) {
    console.log(`  ${fixtureName}: did not parse completely, skipped`)
    return
  }

  const needle = 'mileage'

  const byte = timeMs(() =>
    findAsciiInRange(parsed.bytes, needle, true, 0, parsed.bytes.length)
  )
  // Force the decoded path with the identical needle via regex mode — an
  // apples-to-apples comparison of the two algorithms over the same
  // fixture and match count, not a different needle confusing the numbers.
  const decoded = timeMs(() =>
    findAll(parsed.bytes, parsed.rowIndex, parsed.encoding, needle, {
      caseSensitive: true,
      regex: true
    })
  )

  console.log(
    `  ${fixtureName.padEnd(16)} ${fmtBytes(parsed.bytes.length).padStart(9)}  byte-path ${fmtMs(byte.ms).padStart(9)} (${byte.result.starts.length.toLocaleString()} matches)  decoded-path ${fmtMs(decoded.ms).padStart(9)} (${decoded.result.starts.length.toLocaleString()} matches)`
  )
}

// --- 2 & 3. Name index build time/memory, and invalidation cost -----------

function benchNameIndex(fixtureName: string): void {
  const loaded = loadFixture(fixtureName)
  if (loaded === null) {
    console.log(`  ${fixtureName}: not present, skipped`)
    return
  }
  const parsed = parseFixture(loaded)
  if (parsed === null) {
    console.log(`  ${fixtureName}: did not parse completely, skipped`)
    return
  }

  const build = timeMs(() => buildNameIndex(parsed.store, parsed.store.interner.size))
  const memBytes = nameIndexMemoryBytes(build.result)
  const packedBytes = parsed.store.packedMemoryBytes

  console.log(
    `  ${fixtureName.padEnd(16)} ${fmtBytes(parsed.bytes.length).padStart(9)}  build ${fmtMs(build.ms).padStart(9)}  memory ${fmtBytes(memBytes).padStart(9)}  (${((memBytes / packedBytes) * 100).toFixed(1)}% of node+attr store)`
  )

  // Invalidation: apply a representative small edit, splice, then rebuild
  // the name index against the *spliced* store — the "rebuild, not patch"
  // choice documented in documentSession.ts / M4-RESULTS.md. Reported here
  // as the actual cost that choice pays, not a guess.
  const leaf = firstLeafWithValue(parsed.store, 0, 6)
  if (leaf === null) {
    console.log(`    (no representative leaf found for invalidation bench, skipped)`)
    return
  }
  const value = parsed.store.valueOf(leaf)!
  const oldLength = value.end - value.start
  const replacement = new TextEncoder().encode('X'.repeat(oldLength + 1))
  const patch: Patch = { start: value.start, end: value.end, replacement }
  const newBytes = applyPatch(parsed.bytes, patch)
  const delta = replacement.length - oldLength

  const spliceResult = spliceSubtree({
    format: parsed.format,
    oldStore: parsed.store,
    newBytes,
    interner: parsed.store.interner,
    dirtyStart: value.start,
    dirtyEnd: value.end,
    delta,
    options: parsed.options
  })
  if (!spliceResult.ok) {
    console.log(`    (splice refused: ${spliceResult.reason}, invalidation bench skipped)`)
    return
  }
  const rebuild = timeMs(() =>
    buildNameIndex(spliceResult.store, spliceResult.store.interner.size)
  )
  console.log(
    `    invalidation (rebuild after 1 splice): ${fmtMs(rebuild.ms)}`
  )
}

function firstLeafWithValue(
  store: NodeStore,
  root: number,
  targetDepth: number
): number | null {
  let node = root
  for (let depth = 0; depth < targetDepth; depth++) {
    const child = store.firstChildOf(node)
    if (child === -1) return store.valueOf(node) !== null ? node : null
    node = child
  }
  return store.valueOf(node) !== null ? node : null
}

// --- 4. Path evaluation per step type, //name vs. a full scan -------------

function benchPathEvaluation(fixtureName: string): void {
  const loaded = loadFixture(fixtureName)
  if (loaded === null) {
    console.log(`  ${fixtureName}: not present, skipped`)
    return
  }
  const parsed = parseFixture(loaded)
  if (parsed === null) {
    console.log(`  ${fixtureName}: did not parse completely, skipped`)
    return
  }
  const nameIndex = buildNameIndex(parsed.store, parsed.store.interner.size)

  function run(query: string): { count: number; ms: number } {
    const path = parsePath(query, (name) => parsed.store.interner.lookup(name))
    if (!path.ok) throw new Error(`bench query failed to parse: ${path.diagnostic.message}`)
    const { result, ms } = timeMs(() =>
      evaluatePath(parsed.store, nameIndex, parsed.source, path.path)
    )
    return { count: result.length, ms }
  }

  const child = run('garage/cars')
  const descendant = run('//mileage')
  // A *scoped* descendant query — within one car's own subtree, not the
  // whole document — is the shape the index is actually built for
  // (M4-PLAN.md G1: "this is the step the name index exists for"). Left
  // unscoped, `//mileage` from the root has almost nothing to prune.
  const scopedDescendant = run('garage/cars/elements/car[1]//type')
  const positional = run('garage/cars/elements/car[1]')
  const facet = run('garage/cars/elements/car[@color="red"]')

  // Naive full-scan baseline for //mileage — every node, string-compare
  // its name — the thing G1's index exists to make unnecessary.
  const mileageId = (() => {
    for (let id = 0; id < parsed.store.interner.size; id++) {
      if (parsed.store.textOf(id) === 'mileage') return id
    }
    return -1
  })()
  const scan = timeMs(() => {
    let count = 0
    for (let node = 0; node < parsed.store.nodeCount; node++) {
      if (parsed.store.nameIdOf(node) === mileageId) count++
    }
    return count
  })
  const indexResultCount = mileageId === -1 ? 0 : nodesByNameId(nameIndex, mileageId).length

  // The scoped case's own baseline: a bounded walk of just the one car's
  // subtree (what an index-free implementation would have to do), not a
  // full-document scan — the fair comparison for "does scoping help".
  const carRef = 1 // node ref of the first <car> — Document(0)/garage(1)/cars(2)/elements(3)/car(4)
  const scopedScan = timeMs(() => {
    let count = 0
    const carEnd = parsed.store.nextSiblingOf(carRef)
    const end = carEnd === -1 ? parsed.store.nodeCount : carEnd
    for (let node = carRef; node < end; node++) {
      if (parsed.store.nameOf(node) === 'type') count++
    }
    return count
  })

  console.log(`  ${fixtureName} (${fmtBytes(parsed.bytes.length)}, ${parsed.store.nodeCount.toLocaleString()} nodes):`)
  console.log(`    child step (garage/cars):                       ${fmtMs(child.ms).padStart(9)}  (${child.count} node)`)
  console.log(`    descendant step (//mileage), unscoped, indexed: ${fmtMs(descendant.ms).padStart(9)}  (${descendant.count.toLocaleString()} nodes)`)
  console.log(`    descendant step, SCOPED to one car, indexed:    ${fmtMs(scopedDescendant.ms).padStart(9)}  (${scopedDescendant.count} node)`)
  console.log(`    scoped baseline (bounded walk of one car):      ${fmtMs(scopedScan.ms).padStart(9)}  (${scopedScan.result} node)`)
  console.log(`    positional predicate ([1]):                     ${fmtMs(positional.ms).padStart(9)}  (${positional.count} node)`)
  console.log(`    facet predicate (@color="red"):                  ${fmtMs(facet.ms).padStart(9)}  (${facet.count.toLocaleString()} nodes)`)
  console.log(`    //mileage via full scan (baseline):             ${fmtMs(scan.ms).padStart(9)}  (${scan.result.toLocaleString()} nodes, index found ${indexResultCount.toLocaleString()})`)
  console.log(
    `    unscoped index vs. full scan: ${(scan.ms / Math.max(descendant.ms, 0.001)).toFixed(2)}x   scoped index vs. bounded walk: ${(scopedScan.ms / Math.max(scopedDescendant.ms, 0.001)).toFixed(2)}x`
  )
}

// --- 5. Longest synchronous slice during a chunked search job -------------

async function benchSchedulerSliceBound(fixtureName: string): Promise<void> {
  const loaded = loadFixture(fixtureName)
  if (loaded === null) {
    console.log(`  ${fixtureName}: not present, skipped`)
    return
  }
  const parsed = parseFixture(loaded)
  if (parsed === null) {
    console.log(`  ${fixtureName}: did not parse completely, skipped`)
    return
  }

  const bytes = parsed.bytes
  const CHUNK = 1024 * 1024
  let sliceStarts = 0
  let longestSlice = 0
  const sliceDurations: number[] = []

  const { ms: totalMs } = await timeMsAsync(
    () =>
      new Promise<void>((resolveJob) => {
        let lastSliceStart = process.hrtime.bigint()
        const job = runChunkedJob(
          0,
          (cursor) => {
            if (cursor === 0 || sliceStarts === 0) lastSliceStart = process.hrtime.bigint()
            if (cursor >= bytes.length) return { done: true, value: null }
            const to = Math.min(cursor + CHUNK, bytes.length)
            findAsciiInRange(bytes, 'mileage', true, cursor, to)
            return { done: false, state: to }
          },
          {
            onProgress: () => {
              sliceStarts++
              const now = process.hrtime.bigint()
              const sliceMs = Number(now - lastSliceStart) / 1e6
              sliceDurations.push(sliceMs)
              if (sliceMs > longestSlice) longestSlice = sliceMs
              lastSliceStart = now
            }
          }
        )
        job.result.then(() => resolveJob())
      })
  )

  const avg = sliceDurations.length > 0 ? sliceDurations.reduce((a, b) => a + b, 0) / sliceDurations.length : 0
  console.log(
    `  ${fixtureName.padEnd(16)} total ${fmtMs(totalMs).padStart(9)}  slices ${String(sliceStarts).padStart(5)}  longest-slice ${fmtMs(longestSlice).padStart(8)}  avg-slice ${fmtMs(avg).padStart(8)}`
  )
}

async function main(): Promise<void> {
  console.log('=== 1. Text find latency — byte path vs. decoded path ===\n')
  for (const name of XML_FIXTURES) benchTextFind(name)
  console.log()

  console.log('=== 2 & 3. Name index build time/memory, and invalidation cost ===\n')
  for (const name of XML_FIXTURES) benchNameIndex(name)
  console.log()

  console.log('=== 4. Path evaluation per step type, //name vs. a full scan ===\n')
  for (const name of ['cars-10mb.xml', 'cars-100mb.xml', 'cars-200mb.xml']) {
    benchPathEvaluation(name)
  }
  console.log()

  console.log('=== 5. G3 scheduler — longest synchronous slice during a chunked search ===\n')
  for (const name of ['cars-100mb.xml', 'cars-500mb.xml']) {
    // eslint-disable-next-line no-await-in-loop
    await benchSchedulerSliceBound(name)
  }
}

main()
