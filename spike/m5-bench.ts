/**
 * M5-PLAN.md H10's measurement pass. Same one-off-harness convention as
 * `spike/m2-e10-measure.ts`, `spike/m3-bench.ts` and `spike/m4-bench.ts` —
 * not wired into `npm test`, run against the real gitignored fixtures in
 * `spike/fixtures/`.
 *
 * **Each section is its own process invocation, not a shared run** — a
 * consolidated single-process version was tried first and rejected: later
 * sections' "before" RSS kept climbing from earlier sections' allocations
 * that `--expose-gc`'s `global.gc()` doesn't reliably return to the OS
 * (still-live closures, V8 heap fragmentation), so a fixture measured
 * second or third read as costing far more than it actually did in
 * isolation. Each section run as its own process is what the actual
 * open/parse/Transform pipeline experiences anyway (a fresh worker per
 * job, per `parseClient.ts`/`transformClient.ts`'s own doc comments), so
 * this also matches production shape more closely than one long-lived
 * process would.
 *
 * Run with `--expose-gc` so each RSS reading is post-collection:
 *
 *   npx tsx --expose-gc spike/m5-bench.ts h2c-main before spike/fixtures/cars-200mb.xml
 *   npx tsx --expose-gc spike/m5-bench.ts h2c-worker spike/fixtures/cars-200mb.xml
 *   npx tsx --expose-gc spike/m5-bench.ts h9 spike/fixtures/cars-200mb.xml
 *   npx tsx --expose-gc spike/m5-bench.ts h4
 */
import { readFile, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { NodeStore } from '../src/core/nodeStore'
import { Interner } from '../src/core/interner'
import { xmlFormatModule as xmlFormat } from '../src/formats/xml/index'
import { jsonFormatModule as jsonFormat } from '../src/formats/json/index'
import { buildRowIndex, buildLineIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { computeMemoryBudget } from '../src/renderer/components/StatusBar/memoryBudget'
import { SourceBuffer } from '../src/core/buffer'

const readFileAsync = promisify(readFile)

function gc(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any
  if (typeof g.gc === 'function') g.gc()
}
function rssMb(): number {
  gc()
  return process.memoryUsage().rss / 1024 / 1024
}

async function h2cMain(mode: 'before' | 'after', file: string): Promise<void> {
  const start = rssMb()
  const buffer = await readFileAsync(file)
  const afterRead = rssMb()
  const out =
    mode === 'before' || !(buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength)
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      : buffer.buffer
  const afterSlice = rssMb()
  console.log(
    `${file} (${mode}): start ${start.toFixed(1)} MB, after read ${afterRead.toFixed(1)} MB, after slice/skip ${afterSlice.toFixed(1)} MB (${out.byteLength} bytes)`
  )
}

function h2cWorker(file: string): void {
  const start = rssMb()
  const raw = readFileSync(file)
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const afterRead = rssMb()

  const interner = new Interner()
  const store = new NodeStore(bytes, interner)
  const result = xmlFormat.parse(bytes, store, { maxDepth: 5000, encoding: 'utf-8' })
  if (!result.complete) throw new Error('parse incomplete')
  const afterParse = rssMb()

  const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, xmlFormat.capabilities.rowBreakBytes)
  buildLineIndex(bytes, rowIndex)
  buildNameIndex(store, interner.size)
  const afterIndexes = rssMb()

  store.exportBuffers()
  interner.exportBuffers()
  const afterExport = rssMb()

  const fileMb = bytes.length / 1024 / 1024
  console.log(`${file} (${fileMb.toFixed(1)} MB)`)
  console.log(
    `  start ${start.toFixed(1)}  read ${afterRead.toFixed(1)}  parse ${afterParse.toFixed(1)}  indexes ${afterIndexes.toFixed(1)}  export ${afterExport.toFixed(1)} MB`
  )
  console.log(
    `  peak - start: ${(afterExport - start).toFixed(1)} MB (${((afterExport - start) / fileMb).toFixed(2)}x file size)`
  )
}

function h9(file: string): void {
  const before = rssMb()
  const raw = readFileSync(file)
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const interner = new Interner()
  const store = new NodeStore(bytes, interner)
  xmlFormat.parse(bytes, store, { maxDepth: 5000, encoding: 'utf-8' })
  const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, xmlFormat.capabilities.rowBreakBytes)
  const lineIndex = buildLineIndex(bytes, rowIndex)
  const nameIndex = buildNameIndex(store, interner.size)
  const sourceBuffer = new SourceBuffer(bytes, 'utf-8', 0)
  const after = rssMb()
  const budget = computeMemoryBudget({ store, sourceBuffer, rowIndex, lineIndex, nameIndex } as never)
  const actualDeltaMb = after - before
  const computedMb = budget.totalBytes / 1024 / 1024
  console.log(
    `${file}: computed ${computedMb.toFixed(1)} MB, actual RSS delta ${actualDeltaMb.toFixed(1)} MB (${((computedMb / actualDeltaMb) * 100).toFixed(1)}%)`
  )
}

function h4(): void {
  const targetMb = 200
  const n = Math.round((targetMb * 1024 * 1024) / 55)
  const parts: string[] = ['[']
  for (let i = 0; i < n; i++) parts.push(`{"id":${i},"name":"item${i}","value":${i * 1.5}},`)
  parts.push('{"id":0}]')
  const text = parts.join('')
  parts.length = 0
  const bytes = new TextEncoder().encode(text)
  const inputMb = bytes.length / 1024 / 1024

  const before = rssMb()
  const output = jsonFormat.format!(bytes, { indent: '  ', newline: '\n' })
  const after = rssMb()

  console.log(`input ${inputMb.toFixed(1)} MB, output ${(output.length / 1024 / 1024).toFixed(1)} MB`)
  console.log(
    `RSS delta: ${(after - before).toFixed(1)} MB (${((after - before) / inputMb).toFixed(2)}x input) — against M0a's naive ~9-11x`
  )
}

async function main(): Promise<void> {
  const [section, ...rest] = process.argv.slice(2)
  if (section === 'h2c-main') await h2cMain(rest[0] as 'before' | 'after', rest[1]!)
  else if (section === 'h2c-worker') h2cWorker(rest[0]!)
  else if (section === 'h9') h9(rest[0]!)
  else if (section === 'h4') h4()
  else {
    console.error('usage: spike/m5-bench.ts <h2c-main|h2c-worker|h9|h4> [args...]')
    process.exit(1)
  }
}

void main()
