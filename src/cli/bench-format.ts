#!/usr/bin/env node
/**
 * `npm run bench:format -- <file> [<file>...]` — per-stage timing and
 * memory for a single Transform (M5g-PLAN.md §3.1): the `format()` call
 * itself, then every reparse stage `applyTransform` triggers afterwards
 * (parse, row index, line index, name index), plus total time, peak RSS,
 * output size delta, and whether the output was byte-identical to the
 * input (the no-op case O1 exists to short-circuit).
 *
 * Follows `src/cli/inspect.ts`'s CLI shape (a plain `main()` over
 * `process.argv`) and `spike/m5-bench.ts`'s per-stage RSS convention. Run
 * with `--expose-gc` so each reading is post-collection:
 *
 *   npx tsx --expose-gc src/cli/bench-format.ts spike/fixtures/cars-10mb.xml
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { SourceBuffer } from '../core/buffer'
import { bomLengthAt, detectEncoding as detectEncodingFromBom } from '../core/encoding'
import { Interner } from '../core/interner'
import { buildNameIndex } from '../core/nameIndex'
import { NodeStore } from '../core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../core/rowIndex'
import type { ParseOptions } from '../core/types'
import { selectFormat, supportedExtensionsList } from '../formats/registry'
import { computeMemoryBudget } from '../renderer/components/StatusBar/memoryBudget'

const MAX_DEPTH = 10_000
const HEAD_BYTES = 4096

function gc(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any
  if (typeof g.gc === 'function') g.gc()
}

function rssMb(): number {
  gc()
  return process.memoryUsage().rss / 1024 / 1024
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function benchOne(filePath: string): void {
  const startRss = rssMb()
  const raw = new Uint8Array(readFileSync(filePath))
  const bomLength = bomLengthAt(raw)
  const head = raw.subarray(0, Math.min(HEAD_BYTES, raw.length))
  const filename = basename(filePath)

  const formatModule = selectFormat(head, filename)
  if (formatModule === null) {
    console.error(
      `Could not detect a format for ${filename}. Supported extensions: ${supportedExtensionsList()}.`
    )
    process.exitCode = 1
    return
  }
  if (formatModule.format === undefined) {
    console.error(`${formatModule.capabilities.displayName} has no format() to bench`)
    process.exitCode = 1
    return
  }

  const declared = formatModule.detectEncoding(head)
  const encoding = detectEncodingFromBom(raw, declared)

  console.log(`\n${filePath} (${fmtBytes(raw.length)}, ${formatModule.capabilities.displayName})`)

  const formatStart = process.hrtime.bigint()
  const output = formatModule.format(raw, { indent: '  ', newline: '\n' })
  const formatMs = Number(process.hrtime.bigint() - formatStart) / 1e6
  const afterFormatRss = rssMb()

  const identical = bytesEqual(raw, output)

  const interner = new Interner()
  const store = new NodeStore(output, interner)
  const options: ParseOptions = { maxDepth: MAX_DEPTH, encoding }

  const parseStart = process.hrtime.bigint()
  const parseResult = formatModule.parse(output, store, options)
  const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6

  const rowIndexStart = process.hrtime.bigint()
  const rowIndex = buildRowIndex(
    output,
    DEFAULT_MAX_ROW_BYTES,
    formatModule.capabilities.rowBreakBytes
  )
  const rowIndexMs = Number(process.hrtime.bigint() - rowIndexStart) / 1e6

  const lineIndexStart = process.hrtime.bigint()
  const lineIndex = buildLineIndex(output, rowIndex)
  const lineIndexMs = Number(process.hrtime.bigint() - lineIndexStart) / 1e6

  const nameIndexStart = process.hrtime.bigint()
  const nameIndex = buildNameIndex(store, interner.size)
  const nameIndexMs = Number(process.hrtime.bigint() - nameIndexStart) / 1e6

  const reparseMs = parseMs + rowIndexMs + lineIndexMs + nameIndexMs
  const totalMs = formatMs + reparseMs
  const peakRss = rssMb()

  const sourceBuffer = new SourceBuffer(output, encoding, bomLength)
  // M5h-PLAN.md R18, §5: `undoBytes`/`undoEntryCount` were missing from this
  // literal — `as never` is what let that compile, so `computeMemoryBudget`
  // read `undefined` for both and `totalBytes` (which sums them in) came out
  // `NaN`. The app itself is unaffected (`documentSession.ts` always
  // initialises `undoBytes: 0`); only this CLI's own report was wrong.
  const budget = computeMemoryBudget({
    store,
    sourceBuffer,
    rowIndex,
    lineIndex,
    nameIndex,
    undoBytes: 0,
    undoEntryCount: 0
  } as never)

  const throughputMbS = raw.length / 1024 / 1024 / (formatMs / 1000)

  console.log(`  identical to input   ${identical}`)
  console.log(`  output size          ${fmtBytes(output.length)} (input ${fmtBytes(raw.length)})`)
  console.log(
    `  format()             ${formatMs.toFixed(1)} ms  (${throughputMbS.toFixed(1)} MB/s)`
  )
  console.log(`  reparse: parse       ${parseMs.toFixed(1)} ms  (complete=${parseResult.complete})`)
  console.log(`  reparse: rowIndex    ${rowIndexMs.toFixed(1)} ms`)
  console.log(`  reparse: lineIndex   ${lineIndexMs.toFixed(1)} ms`)
  console.log(`  reparse: nameIndex   ${nameIndexMs.toFixed(1)} ms`)
  console.log(`  reparse: total       ${reparseMs.toFixed(1)} ms`)
  console.log(`  total                ${totalMs.toFixed(1)} ms`)
  console.log(
    `  peak RSS             ${peakRss.toFixed(1)} MB (start ${startRss.toFixed(1)} MB, after format() ${afterFormatRss.toFixed(1)} MB)`
  )
  console.log(`  computed memory      ${fmtBytes(budget.totalBytes)}`)
}

function main(): void {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('Usage: npm run bench:format -- <file> [<file>...]')
    process.exitCode = 1
    return
  }
  for (const file of files) benchOne(file)
}

main()
