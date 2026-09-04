#!/usr/bin/env node
/**
 * `npm run inspect -- <file>` — parses a file and reports on it. This is how
 * M0 is demonstrated and how performance regressions get noticed before
 * there is any UI.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { bomLengthAt, detectEncoding as detectEncodingFromBom } from '../core/encoding'
import { Interner } from '../core/interner'
import { NodeStore } from '../core/nodeStore'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../core/rowIndex'
import { NodeKind, type NodeRef, type ParseOptions } from '../core/types'
import { selectFormat, supportedExtensionsList } from '../formats/registry'

const KIND_NAMES: Record<number, string> = {
  [NodeKind.Document]: 'Document',
  [NodeKind.Element]: 'Element',
  [NodeKind.Object]: 'Object',
  [NodeKind.Array]: 'Array',
  [NodeKind.Property]: 'Property',
  [NodeKind.Scalar]: 'Scalar',
  [NodeKind.Text]: 'Text',
  [NodeKind.CData]: 'CData',
  [NodeKind.Comment]: 'Comment',
  [NodeKind.ProcessingInstruction]: 'ProcessingInstruction',
  [NodeKind.DocType]: 'DocType'
}

const HEAD_BYTES = 4096
const TREE_DEPTH = 3
const SIBLINGS_SHOWN = 10
const VALUE_PREVIEW_BYTES = 40
const MAX_DEPTH = 10_000

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function valuePreview(
  decoder: TextDecoder,
  source: Uint8Array,
  start: number,
  end: number
): string {
  const truncated = end - start > VALUE_PREVIEW_BYTES
  const slice = source.subarray(start, truncated ? start + VALUE_PREVIEW_BYTES : end)
  const text = decoder.decode(slice).replace(/\n/g, '\\n')
  return truncated ? `${text}…` : text
}

function printTree(
  store: NodeStore,
  decoder: TextDecoder,
  source: Uint8Array,
  node: NodeRef,
  depth: number,
  indent: string
): void {
  if (depth >= TREE_DEPTH) return

  const kind = KIND_NAMES[store.kindOf(node)] ?? `kind(${store.kindOf(node)})`
  const name = store.nameOf(node)
  const value = store.valueOf(node)
  const parts = [kind]
  if (name !== null) parts.push(`name=${name}`)
  if (value !== null) parts.push(`value="${valuePreview(decoder, source, value.start, value.end)}"`)
  console.log(`${indent}${parts.join(' ')}`)

  if (depth + 1 >= TREE_DEPTH) return
  const children = Array.from(store.childrenOf(node))
  const shown = children.slice(0, SIBLINGS_SHOWN)
  for (const child of shown) {
    printTree(store, decoder, source, child, depth + 1, `${indent}  `)
  }
  if (children.length > shown.length) {
    console.log(`${indent}  … and ${children.length - shown.length} more`)
  }
}

function main(): void {
  const filePath = process.argv[2]
  if (filePath === undefined) {
    console.error('Usage: npm run inspect -- <file>')
    process.exitCode = 1
    return
  }

  const raw = new Uint8Array(readFileSync(filePath))
  // Spans must stay absolute in the buffer as read from disk (C1) — parse
  // `raw` itself, never a BOM-stripped subarray of it. `bomLengthAt` is only
  // for reporting; the parsers skip the BOM in place.
  const bomLength = bomLengthAt(raw)
  const head = raw.subarray(0, Math.min(HEAD_BYTES, raw.length))
  const filename = basename(filePath)

  const format = selectFormat(head, filename)
  if (format === null) {
    console.error(
      `Could not detect a format for ${filename}. Supported extensions: ${supportedExtensionsList()}.`
    )
    process.exitCode = 1
    return
  }

  const declared = format.detectEncoding(head)
  const encoding = detectEncodingFromBom(raw, declared)

  const interner = new Interner()
  const store = new NodeStore(raw, interner)
  const options: ParseOptions = { maxDepth: MAX_DEPTH, encoding }

  const start = process.hrtime.bigint()
  const result = format.parse(raw, store, options)
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6

  const rowIndexStart = process.hrtime.bigint()
  const rowIndex = buildRowIndex(raw, DEFAULT_MAX_ROW_BYTES, format.capabilities.rowBreakBytes)
  const rowIndexMs = Number(process.hrtime.bigint() - rowIndexStart) / 1e6

  console.log(`file            ${filePath}`)
  console.log(`format          ${format.capabilities.displayName}`)
  console.log(`encoding        ${encoding}${bomLength > 0 ? ' (BOM present)' : ''}`)
  console.log(`size            ${fmtBytes(raw.length)}`)
  console.log(`parse time      ${elapsedMs.toFixed(1)} ms`)
  console.log(`complete        ${result.complete}`)
  console.log(`nodes           ${store.nodeCount.toLocaleString('en-US')}`)
  console.log(`attributes      ${store.attributeCount.toLocaleString('en-US')}`)
  console.log(`interned names  ${interner.size.toLocaleString('en-US')}`)
  console.log(
    `rows            ${rowIndex.length.toLocaleString('en-US')} (${fmtBytes(rowIndex.byteLength)}, built in ${rowIndexMs.toFixed(1)} ms)`
  )
  console.log(
    `store memory    ${fmtBytes(store.packedMemoryBytes + rowIndex.byteLength)} packed incl. row index, ${fmtBytes(store.estimatedMemoryBytes)} node/attribute arrays allocated`
  )
  console.log(`diagnostics     ${store.diagnosticCount}`)
  console.log()
  console.log(`tree (first ${TREE_DEPTH} levels):`)

  const decoder = new TextDecoder(encoding.startsWith('utf-16') ? encoding : 'utf-8')
  for (const child of store.childrenOf(0)) {
    printTree(store, decoder, raw, child, 0, '  ')
  }
}

main()
