#!/usr/bin/env node
/**
 * R150 (`docs/plans/R145-csv.md` §10) — R31's own section 1, re-run against the *real*
 * CSV parser (`src/formats/csv/index.ts`) instead of the stand-in `csvSpikeParser.ts`
 * R31 used. R31 validated the splice *mechanism* (`subtreeSplice.ts`'s generic
 * `bytesConsumed !== newSpanEnd` safety net) against a parser built only to exercise
 * quoted-newline shapes; this exercises the parser that actually ships, including its
 * facet-based field model (§2) and header-naming (§3/R147), which the stand-in never
 * modeled at all — a spliced row's facets must still point at the *same* header bytes
 * a full reparse would use.
 *
 * Run: `npx tsx spike/csv-quoted-newline/run-real-parser.ts`
 */
import { Interner } from '../../src/core/interner'
import { NodeStore } from '../../src/core/nodeStore'
import type { NodeRef } from '../../src/core/types'
import { spliceSubtree, type SpliceRequest } from '../../src/renderer/session/subtreeSplice'
import { csvFormatModule } from '../../src/formats/csv/index'
import { generateCsvCorpus } from './generateCsv'

const OPTIONS = { maxDepth: 1000, encoding: 'utf-8' }

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function parseFull(text: string): { store: NodeStore; bytes: Uint8Array } {
  const bytes = utf8(text)
  const store = new NodeStore(bytes, new Interner())
  const result = csvFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('spike fixture must parse completely')
  return { store, bytes }
}

interface FlatNode {
  readonly kind: number
  readonly text: string | null
  readonly childCount: number
  /** `name=value` per facet, in order — the part R31's own `flatten` never needed to
   * compare, since the stand-in parser did not model fields as facets. */
  readonly attrs: readonly string[]
}

function flatten(store: NodeStore, bytes: Uint8Array, root: NodeRef): FlatNode[] {
  const decoder = new TextDecoder('utf-8')
  const decode = (start: number, end: number): string => decoder.decode(bytes.subarray(start, end))
  const out: FlatNode[] = []
  const stack: NodeRef[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const value = store.valueOf(node)
    const children = [...store.childrenOf(node)]
    const attrs = [...store.attributesOf(node)].map(
      (a) => `${store.textOf(a.nameId)}=${decode(a.valueStart, a.valueEnd)}`
    )
    out.push({
      kind: store.kindOf(node),
      text: value === null ? null : decode(value.start, value.end),
      childCount: children.length,
      attrs
    })
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return out
}

function flatEqual(a: readonly FlatNode[], b: readonly FlatNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.kind !== y.kind || x.text !== y.text || x.childCount !== y.childCount) return false
    if (x.attrs.length !== y.attrs.length) return false
    for (let k = 0; k < x.attrs.length; k++) if (x.attrs[k] !== y.attrs[k]) return false
  }
  return true
}

interface EditOutcome {
  readonly spliced: boolean
  readonly matchesFullReparse: boolean
  readonly failureReason: string | null
}

function tryEditAndCompare(
  originalText: string,
  editStart: number,
  editEnd: number,
  replacement: string
): EditOutcome {
  const { store: oldStore } = parseFull(originalText)
  const newText = originalText.slice(0, editStart) + replacement + originalText.slice(editEnd)
  const newBytes = utf8(newText)
  const delta = replacement.length - (editEnd - editStart)

  const request: SpliceRequest = {
    format: csvFormatModule,
    oldStore,
    newBytes,
    interner: oldStore.interner,
    dirtyStart: editStart,
    dirtyEnd: editEnd,
    delta,
    options: OPTIONS
  }
  const outcome = spliceSubtree(request)
  if (!outcome.ok) return { spliced: false, matchesFullReparse: true, failureReason: outcome.reason }

  const { store: freshStore } = parseFull(newText)
  const matches = flatEqual(flatten(outcome.store, newBytes, 0), flatten(freshStore, newBytes, 0))
  return { spliced: true, matchesFullReparse: matches, failureReason: matches ? null : 'MISMATCH' }
}

function run(): void {
  console.log('=== R150: exhaustive edit-and-compare against the real CSV parser ===\n')

  const corpus = generateCsvCorpus(0xc5f, 400)
  const { text } = corpus
  console.log(
    `Corpus: ${text.length} bytes, 400 rows (row 0 is the header, per R147), ` +
      `${corpus.quotedNewlineRows.length} rows with a quoted-newline field.`
  )

  let total = 0
  let splicedOk = 0
  let fellBack = 0
  let mismatches = 0
  const fallbackReasons = new Map<string, number>()

  const record = (outcome: EditOutcome, label: string): void => {
    total++
    if (!outcome.matchesFullReparse) {
      mismatches++
      console.error(`  MISMATCH: ${label} — spliced tree disagrees with full reparse!`)
      return
    }
    if (outcome.spliced) splicedOk++
    else {
      fellBack++
      const reason = outcome.failureReason ?? 'unknown'
      fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1)
    }
  }

  for (const rowIdx of corpus.quotedNewlineRows) {
    if (rowIdx === 0) continue // row 0 is the header, not a spliceable record
    const rows = text.split('\r\n')
    const rowText = rows[rowIdx]!
    const rowStart = rows.slice(0, rowIdx).reduce((sum, r) => sum + r.length + 2, 0)
    const quoteStart = rowText.indexOf('"')
    const quoteEnd = rowText.indexOf('"', quoteStart + 1)
    const mid = rowStart + Math.floor((quoteStart + rowText.lastIndexOf('"')) / 2)

    const edits: Array<{ label: string; start: number; end: number; replacement: string }> = [
      { label: `row ${rowIdx}: insert inside quoted field`, start: mid, end: mid, replacement: 'X' },
      {
        label: `row ${rowIdx}: insert comma inside quoted field`,
        start: mid,
        end: mid,
        replacement: ','
      },
      {
        label: `row ${rowIdx}: insert newline inside quoted field`,
        start: mid,
        end: mid,
        replacement: '\n'
      },
      {
        label: `row ${rowIdx}: delete opening quote`,
        start: rowStart + quoteStart,
        end: rowStart + quoteStart + 1,
        replacement: ''
      },
      {
        label: `row ${rowIdx}: delete a byte near the end of the field`,
        start: rowStart + Math.max(quoteStart + 1, quoteEnd - 1),
        end: rowStart + Math.max(quoteStart + 1, quoteEnd - 1) + 1,
        replacement: ''
      }
    ]

    for (const edit of edits) {
      if (edit.start < 0 || edit.end > text.length || edit.start > edit.end) continue
      record(tryEditAndCompare(text, edit.start, edit.end, edit.replacement), edit.label)
    }
  }

  // Broad sweep, header row excluded (splicing the header is out of
  // parseRange's guarantee — a single row — so it always falls back, which
  // is a different, already-covered code path, not this exercise's target).
  const headerEnd = text.indexOf('\r\n') + 2
  for (let offset = headerEnd; offset < text.length; offset += 37) {
    record(tryEditAndCompare(text, offset, offset, 'Z'), `broad sweep offset ${offset}`)
  }

  console.log(`\nTotal edits tried: ${total}`)
  console.log(`  Spliced successfully: ${splicedOk} (${((splicedOk / total) * 100).toFixed(1)}%)`)
  console.log(`  Fell back to full reparse: ${fellBack} (${((fellBack / total) * 100).toFixed(1)}%)`)
  for (const [reason, count] of fallbackReasons) console.log(`    - ${reason}: ${count}`)
  console.log(`  MISMATCHES (silent corruption): ${mismatches}`)
  if (mismatches === 0) {
    console.log(
      '\n  PASS: every splice that succeeded against the real CSV parser matched a full ' +
        'reparse exactly (including facet name/value spans). No silent corruption found.'
    )
    process.exitCode = 0
  } else {
    console.log('\n  FAIL: silent corruption found — see above.')
    process.exitCode = 1
  }
}

run()
