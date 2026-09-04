#!/usr/bin/env -S npx tsx
/**
 * M2 E10's own measurement: detection (E1) + column collection (E3) cost
 * on the real fixtures, plus peak RSS through a single read (M1-RESULTS.md
 * flagged its own harness holding the file's bytes twice as a known
 * artifact — this reads once via `readFileSync`, the same as the CLI
 * inspect harness, so the RSS figure isn't inflated by the harness itself).
 *
 * Usage: npx tsx spike/m2-e10-measure.ts <file> [file...]
 *
 * Not wired into `npm test` — a one-off measurement script, same
 * convention as `spike/codemirror-harness` and `src/cli/inspect.ts`.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { NodeRef, ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { detectGrid } from '../src/renderer/components/Detail/gridDetection'
import { collectColumns, collectGroupMembers } from '../src/renderer/components/Detail/gridColumns'
import {
  isTransparentWrapper,
  resolveWrapperTarget
} from '../src/renderer/components/Detail/transparentWrapper'

const MAX_DEPTH = 10_000

function fmtMs(n: number): string {
  return `${n.toFixed(1)} ms`
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function measure(filePath: string): void {
  const raw = new Uint8Array(readFileSync(filePath))
  const filename = basename(filePath)

  const interner = new Interner()
  const store = new NodeStore(raw, interner)
  const options: ParseOptions = { maxDepth: MAX_DEPTH, encoding: 'utf-8' }

  const parseStart = process.hrtime.bigint()
  xmlFormatModule.parse(raw, store, options)
  const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6

  const ROOT: NodeRef = 0

  // Descend through garage/cars/elements exactly as Detail.tsx does (E2),
  // landing on the node whose children are the repeating <car> elements.
  const wrapStart = process.hrtime.bigint()
  const { destination: elements, skipped } = resolveWrapperTarget(store, ROOT)
  const wrapMs = Number(process.hrtime.bigint() - wrapStart) / 1e6

  const detectStart = process.hrtime.bigint()
  const detection = detectGrid(store, elements)
  const detectMs = Number(process.hrtime.bigint() - detectStart) / 1e6

  if (detection.grid === null) {
    console.log(`${filename}: no grid detected at the wrapper-resolved node — skipping`)
    return
  }

  const membersStart = process.hrtime.bigint()
  const members = collectGroupMembers(store, elements, detection.grid.nameId)
  const membersMs = Number(process.hrtime.bigint() - membersStart) / 1e6

  const columnsStart = process.hrtime.bigint()
  const { columns, overflow } = collectColumns(store, members)
  const columnsMs = Number(process.hrtime.bigint() - columnsStart) / 1e6

  const rss = process.memoryUsage().rss

  console.log(`--- ${filename} (${fmtMB(raw.length)}) ---`)
  console.log(`parse                  ${fmtMs(parseMs)}`)
  console.log(
    `wrapper descent (E2)   ${fmtMs(wrapMs)}  (${skipped.length} hops, all still transparent: ${skipped.every((n) => isTransparentWrapper(store, n))})`
  )
  console.log(
    `detectGrid (E1)        ${fmtMs(detectMs)}  (group: ${store.textOf(detection.grid.nameId)}, ${detection.grid.memberCount.toLocaleString('en-US')} members, ${detection.compositeChildCount.toLocaleString('en-US')} composite children scanned)`
  )
  console.log(`collectGroupMembers    ${fmtMs(membersMs)}  (${members.length.toLocaleString('en-US')} members)`)
  console.log(
    `collectColumns (E3)    ${fmtMs(columnsMs)}  (${columns.length} columns, ${overflow.length} overflow)`
  )
  console.log(`peak RSS after all of the above   ${fmtMB(rss)}`)
  console.log()
}

function main(): void {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('Usage: npx tsx spike/m2-e10-measure.ts <file> [file...]')
    process.exitCode = 1
    return
  }
  for (const file of files) measure(file)
}

main()
