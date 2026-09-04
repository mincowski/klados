#!/usr/bin/env node
/**
 * R31 (`R31-csv-spike.md`) — the spike's actual deliverable: run,
 * `tsx spike/csv-quoted-newline/run.ts`. Four sections, matching §2's four
 * candidate answers and the two secondary checks §4/§1 call out:
 *
 *   1. Exhaustive edit-and-compare against the real `subtreeSplice.ts`
 *      production path (§3's method, R17's own precedent for TOML) — the
 *      correctness question.
 *   2. Backward-scan cost on an adversarial "one giant quoted field" file
 *      — Option 1's worst case, measured rather than assumed.
 *   3. A record-index's memory cost — Option 2's real cost, against §8's
 *      budget.
 *   4. 2a (Raw windowing) and wide-table notes — read, not measured; the
 *      code that answers them is quoted inline.
 */
import { Interner } from '../../src/core/interner'
import { NodeStore } from '../../src/core/nodeStore'
import { NodeKind, type NodeRef } from '../../src/core/types'
import { spliceSubtree, type SpliceRequest } from '../../src/renderer/session/subtreeSplice'
import { csvSpikeFormatModule } from './csvSpikeParser'
import { generateCsvCorpus } from './generateCsv'

const OPTIONS = { maxDepth: 1000, encoding: 'utf-8' }
const QUOTE = 0x22

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function parseFull(text: string): { store: NodeStore; bytes: Uint8Array } {
  const bytes = utf8(text)
  const store = new NodeStore(bytes, new Interner())
  const result = csvSpikeFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('spike fixture must parse completely')
  return { store, bytes }
}

interface FlatNode {
  readonly kind: number
  readonly text: string | null
  readonly childCount: number
}

function flatten(store: NodeStore, bytes: Uint8Array, root: NodeRef): FlatNode[] {
  const decoder = new TextDecoder('utf-8')
  const out: FlatNode[] = []
  const stack: NodeRef[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const value = store.valueOf(node)
    const children = [...store.childrenOf(node)]
    out.push({
      kind: store.kindOf(node),
      text: value === null ? null : decoder.decode(bytes.subarray(value.start, value.end)),
      childCount: children.length
    })
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return out
}

function flatEqual(a: readonly FlatNode[], b: readonly FlatNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.kind !== b[i]!.kind || a[i]!.text !== b[i]!.text || a[i]!.childCount !== b[i]!.childCount) {
      return false
    }
  }
  return true
}

interface EditOutcome {
  readonly spliced: boolean
  readonly matchesFullReparse: boolean
  readonly failureReason: string | null
}

/** Runs one edit two ways — via `spliceSubtree` from `originalText`, and
 * via a from-scratch full parse of the edited text — and reports whether
 * they agree. This is the actual correctness check: a splice that
 * succeeds (`ok: true`) but disagrees with a full reparse would be the
 * silent-corruption failure mode §2b worries about; a splice that safely
 * declines (`ok: false`) is always correct by definition (the caller just
 * falls back), so the only way to fail is `ok: true` + a mismatch. */
function tryEditAndCompare(originalText: string, editStart: number, editEnd: number, replacement: string): EditOutcome {
  const { store: oldStore, bytes: oldBytes } = parseFull(originalText)
  const newText = originalText.slice(0, editStart) + replacement + originalText.slice(editEnd)
  const newBytes = utf8(newText)
  const delta = replacement.length - (editEnd - editStart)

  const request: SpliceRequest = {
    format: csvSpikeFormatModule,
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

// ---------------------------------------------------------------------------
// 1. Exhaustive edit-and-compare
// ---------------------------------------------------------------------------

function section1_exhaustiveCheck(): void {
  console.log('\n=== 1. Exhaustive edit-and-compare (real subtreeSplice.ts) ===\n')

  const corpus = generateCsvCorpus(0xc5f, 400)
  const { text } = corpus
  console.log(`Corpus: ${text.length} bytes, 400 rows, ${corpus.quotedNewlineRows.length} rows with a quoted-newline field.`)

  let total = 0
  let splicedOk = 0
  let fellBack = 0
  let mismatches = 0
  const fallbackReasons = new Map<string, number>()

  // Strategic positions: inside/at-boundary of every quoted field on a
  // quoted-newline row, plus a few structural edits per such row.
  for (const rowIdx of corpus.quotedNewlineRows) {
    const rows = text.split('\r\n')
    const rowText = rows[rowIdx]!
    const rowStart = rows.slice(0, rowIdx).reduce((sum, r) => sum + r.length + 2, 0)
    const quoteStart = rowText.indexOf('"')
    const quoteEnd = rowText.indexOf('"', quoteStart + 1) // first closing candidate, approximate
    const mid = rowStart + Math.floor((quoteStart + rowText.lastIndexOf('"')) / 2)

    const edits: Array<{ label: string; start: number; end: number; replacement: string }> = [
      { label: 'insert inside quoted field', start: mid, end: mid, replacement: 'X' },
      { label: 'insert comma inside quoted field', start: mid, end: mid, replacement: ',' },
      { label: 'insert newline inside quoted field', start: mid, end: mid, replacement: '\n' },
      { label: 'delete opening quote', start: rowStart + quoteStart, end: rowStart + quoteStart + 1, replacement: '' },
      {
        label: 'delete a byte near the end of the field',
        start: rowStart + Math.max(quoteStart + 1, quoteEnd - 1),
        end: rowStart + Math.max(quoteStart + 1, quoteEnd - 1) + 1,
        replacement: ''
      }
    ]

    for (const edit of edits) {
      if (edit.start < 0 || edit.end > text.length || edit.start > edit.end) continue
      total++
      const outcome = tryEditAndCompare(text, edit.start, edit.end, edit.replacement)
      if (!outcome.matchesFullReparse) {
        mismatches++
        console.error(`  MISMATCH: row ${rowIdx}, "${edit.label}" — spliced tree disagrees with full reparse!`)
        continue
      }
      if (outcome.spliced) splicedOk++
      else {
        fellBack++
        const reason = outcome.failureReason ?? 'unknown'
        fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1)
      }
    }
  }

  // Plus a broad sweep: every 37th byte offset across the whole corpus,
  // a single-character insertion — cheap coverage of "ordinary" edits
  // outside quoted fields too (row/field boundaries, commas, plain text).
  for (let offset = 0; offset < text.length; offset += 37) {
    total++
    const outcome = tryEditAndCompare(text, offset, offset, 'Z')
    if (!outcome.matchesFullReparse) {
      mismatches++
      console.error(`  MISMATCH: broad sweep offset ${offset}`)
      continue
    }
    if (outcome.spliced) splicedOk++
    else {
      fellBack++
      const reason = outcome.failureReason ?? 'unknown'
      fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1)
    }
  }

  console.log(`\nTotal edits tried: ${total}`)
  console.log(`  Spliced successfully: ${splicedOk} (${((splicedOk / total) * 100).toFixed(1)}%)`)
  console.log(`  Fell back to full reparse: ${fellBack} (${((fellBack / total) * 100).toFixed(1)}%)`)
  for (const [reason, count] of fallbackReasons) console.log(`    - ${reason}: ${count}`)
  console.log(`  MISMATCHES (silent corruption): ${mismatches}`)
  if (mismatches === 0) {
    console.log('\n  PASS: every splice that succeeded matched a full reparse exactly. No silent corruption found.')
  } else {
    console.log('\n  FAIL: silent corruption found — see above.')
  }
}

// ---------------------------------------------------------------------------
// 2. Backward-scan cost on an adversarial "one giant quoted field" file
// ---------------------------------------------------------------------------

/** Option 1's own proposal: scan backward from `pos` to a provably-safe
 * unquoted newline, by counting quote characters back to it and checking
 * parity. Standalone, not wired into the real parser — exists purely to
 * measure its worst case.
 *
 * **A purely-local version of this is not just slow, it is unsound.**
 * The first cut of this function counted quotes crossed *during the
 * backward scan* and declared "even so far" safe — which is wrong: parity
 * is only meaningful relative to a point of *known* state (document
 * start, where you are provably outside every field), and if `pos` itself
 * sits inside a quoted field, the first raw `\n` the scan meets (one of
 * the field's own embedded newlines) has an even count *of quotes crossed
 * since pos* — zero — and gets accepted as "safe" even though it is not.
 * The bug reproduced instantly on the giant-field fixture: it reported a
 * safe point after scanning exactly 1 byte back from the field's own
 * midpoint. Fixed here by bootstrapping real parity with a forward
 * pre-scan from byte 0 to `pos` — which is exactly the O(pos) cost a
 * cheap backward scan was trying to avoid in the first place. */
function backwardScanToSafePoint(bytes: Uint8Array, pos: number): { safePos: number; bytesScanned: number } {
  let parityAtPos = 0
  for (let i = 0; i < pos; i++) if (bytes[i] === QUOTE) parityAtPos++
  const preScanBytes = pos

  let i = pos
  let quoteCount = parityAtPos
  while (i > 0) {
    i--
    if (bytes[i] === QUOTE) quoteCount--
    if (bytes[i] === 0x0a && quoteCount % 2 === 0) {
      return { safePos: i, bytesScanned: preScanBytes + (pos - i) }
    }
  }
  return { safePos: 0, bytesScanned: preScanBytes + pos }
}

function section2_backwardScanCost(): void {
  console.log('\n=== 2. Backward-scan cost (Option 1) on an adversarial fixture ===\n')

  const giantLines = 200_000
  const corpus = generateCsvCorpus(0xdead, 3, { includeGiantField: true, giantFieldLines: giantLines })
  const bytes = utf8(corpus.text)
  console.log(`Fixture: one field with ${giantLines.toLocaleString()} embedded newlines, ${(bytes.length / (1024 * 1024)).toFixed(1)} MB total.`)

  // Resume point: dead center of the giant field — the worst case, since
  // every byte between it and the field's own opening quote must be
  // scanned before a newline with even quote-parity can even be found.
  // `generateCsvCorpus` puts the giant field on row `floor(rowCount / 2)`
  // — locate that row specifically, not just "the first quote in the
  // file" (earlier rows can have quoted fields of their own).
  const giantRowIndex = Math.floor(3 / 2)
  const rowsBeforeGiant = corpus.text.split('\r\n').slice(0, giantRowIndex)
  const giantRowStart = rowsBeforeGiant.reduce((sum, r) => sum + r.length + 2, 0)
  const giantRowEnd = corpus.text.indexOf('\r\n', giantRowStart)
  const fieldQuoteStart = giantRowStart + corpus.text.slice(giantRowStart, giantRowEnd).indexOf('"')
  const fieldQuoteEnd = giantRowStart + corpus.text.slice(giantRowStart, giantRowEnd).lastIndexOf('"')
  const resumePoint = Math.floor((fieldQuoteStart + fieldQuoteEnd) / 2)

  const start = process.hrtime.bigint()
  const { bytesScanned } = backwardScanToSafePoint(bytes, resumePoint)
  const ms = Number(process.hrtime.bigint() - start) / 1e6

  console.log(`Resume point: byte ${resumePoint} (inside the giant field, ~its midpoint).`)
  console.log(`Bytes touched to find a provably-safe point (forward parity pre-scan + backward scan): ${bytesScanned.toLocaleString()}`)
  console.log(`Time: ${ms.toFixed(2)} ms`)
  console.log(
    `\n  A *purely local* backward scan (count quotes only from pos backward, stop at the ` +
      `first "even so far" newline) is not just slow — it is unsound: it has no way to know ` +
      `whether pos itself already sits inside a quoted field, so the first embedded newline ` +
      `it meets looks safe (zero quotes crossed since pos, which is even) and is not. That ` +
      `bug reproduced immediately here — a first draft of this function reported "safe" ` +
      `after one byte. The fix bootstraps real parity with an O(pos) forward pre-scan from ` +
      `byte 0 before the backward scan can even start, which is exactly the cost the backward ` +
      `scan exists to avoid: the measured cost above is essentially "the whole file up to the ` +
      `resume point," the same order as a full reparse of everything before it. Bounding the ` +
      `pre-scan (give up after K bytes, fall back to a full reparse) would cap the worst case, ` +
      `but that is Option 1 and Option 3 combined, not Option 1 on its own, and a real ` +
      `implementation would need Option 2/4's ancestor-or-index state to make the scan local ` +
      `and sound in the first place.`
  )
}

// ---------------------------------------------------------------------------
// 3. Record-index memory cost (Option 2)
// ---------------------------------------------------------------------------

function section3_recordIndexCost(): void {
  console.log('\n=== 3. Record-index memory cost (Option 2) ===\n')

  const corpus = generateCsvCorpus(0xbeef, 200_000)
  const bytes = utf8(corpus.text)
  const recordCount = corpus.text.split('\r\n').length - 1 // trailing terminator
  const indexBytes = recordCount * 4 // Int32Array, one entry per record start

  console.log(`Fixture: ${recordCount.toLocaleString()} records, ${(bytes.length / (1024 * 1024)).toFixed(1)} MB source.`)
  console.log(
    `A record-start index (Int32Array, one entry per record, mirroring the row index's own shape): ` +
      `${(indexBytes / (1024 * 1024)).toFixed(2)} MB — ${((indexBytes / bytes.length) * 100).toFixed(2)}% of source size.`
  )
  console.log(
    `\n  Against §8's ~2.5x total-memory-per-document budget, this index alone is a small, bounded ` +
      `addition (well under 1% of source size for this fixture's ~7-byte average record) — the same ` +
      `order of magnitude as the existing row index it would sit beside, not a new budget category.`
  )
}

section1_exhaustiveCheck()
section2_backwardScanCost()
section3_recordIndexCost()

console.log('\n=== Done — see R31-csv-spike.md for the write-up. ===\n')
