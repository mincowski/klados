#!/usr/bin/env node
/**
 * R150 (`docs/plans/R145-csv.md` §8 and §10) — replaces §8's estimated table with
 * measured figures at several widths, and measures parse time at scale. Same one-off
 * spike-harness convention as `spike/m5-bench.ts` (not wired into `npm test`).
 *
 * Run with `--expose-gc` so RSS readings are post-collection:
 *
 *   npx tsx --expose-gc spike/csv-bench.ts <columns> <rows>
 *   npx tsx --expose-gc spike/csv-bench.ts 10 2000000
 *   npx tsx --expose-gc spike/csv-bench.ts 20 2000000
 *   npx tsx --expose-gc spike/csv-bench.ts 50 2000000
 *
 * `rows` is fixed (matching §8's own table, which holds row count constant across
 * widths and lets file size be *derived* from column count) rather than targeting a
 * fixed file size — an earlier version of this script targeted 200 MB directly and
 * silently changed row count as columns grew (3.6M rows at 10 columns, 715K at 50),
 * which produces a materially different, non-comparable NodeStore shape at each width.
 */
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { csvFormatModule } from '../src/formats/csv/index'
import { GrowableBytes } from '../src/core/growableBytes'

function gc(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any
  if (typeof g.gc === 'function') g.gc()
}

function rssMb(): number {
  gc()
  return process.memoryUsage().rss / 1024 / 1024
}

/** Builds a `columns`-wide, `rowCount`-row CSV — short numeric fields. Encodes each
 * chunk straight into a `GrowableBytes` rather than concatenating one giant JS string
 * (V8's string length cap is ~1 GB chars; a 50-column, 2M-row file's text would exceed
 * it — `RangeError: Invalid string length`, hit on the first version of this script).
 * Invariant 1 applies here too: never hold the whole generated document as one string. */
function generateCsv(columns: number, rowCount: number): Uint8Array {
  const encoder = new TextEncoder()
  const out = new GrowableBytes(Math.max(1024, rowCount * columns * 6))
  const header = Array.from({ length: columns }, (_, i) => `col${i}`).join(',') + '\n'
  out.pushBytes(encoder.encode(header), 0, header.length)

  const CHUNK_ROWS = 5000
  for (let start = 0; start < rowCount; start += CHUNK_ROWS) {
    let chunk = ''
    const end = Math.min(start + CHUNK_ROWS, rowCount)
    for (let row = start; row < end; row++) {
      const fields: string[] = []
      for (let c = 0; c < columns; c++) fields.push(String((row * columns + c) % 100000))
      chunk += fields.join(',') + '\n'
    }
    const bytes = encoder.encode(chunk)
    out.pushBytes(bytes, 0, bytes.length)
  }
  return out.toArray()
}

function run(): void {
  const columns = Number(process.argv[2] ?? 10)
  const rowCount = Number(process.argv[3] ?? 2_000_000)

  console.log(`Generating a ${columns}-column, ${rowCount.toLocaleString()}-row CSV...`)
  const genStart = process.hrtime.bigint()
  const source = generateCsv(columns, rowCount)
  const genMs = Number(process.hrtime.bigint() - genStart) / 1e6
  console.log(`  Generated ${(source.length / (1024 * 1024)).toFixed(1)} MB in ${genMs.toFixed(0)} ms.`)

  const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
  const beforeRss = rssMb()

  const store = new NodeStore(source, new Interner())
  const parseStart = process.hrtime.bigint()
  const result = csvFormatModule.parse(source, store, options)
  const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6
  const afterRss = rssMb()

  const rows = store.nodeCount - 2 // Document + Array
  const facets = store.attributeCount

  console.log(`\nParse: ${result.complete ? 'complete' : 'INCOMPLETE'}, ${result.diagnosticCount} diagnostics, ${parseMs.toFixed(0)} ms (${(source.length / 1024 / 1024 / (parseMs / 1000)).toFixed(1)} MB/s)`)
  console.log(`Nodes: ${store.nodeCount.toLocaleString()} (${rows.toLocaleString()} rows), facets: ${facets.toLocaleString()}`)
  console.log(`NodeStore.packedMemoryBytes: ${(store.packedMemoryBytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`Interner.packedMemoryBytes: ${(store.interner.packedMemoryBytes / 1024).toFixed(2)} KB (${store.interner.size} distinct names)`)
  console.log(`Process RSS: ${beforeRss.toFixed(0)} MB before parse -> ${afterRss.toFixed(0)} MB after (delta ${(afterRss - beforeRss).toFixed(0)} MB)`)
  console.log(`Store total vs. file: ${(store.packedMemoryBytes / source.length).toFixed(2)}x`)
}

run()
