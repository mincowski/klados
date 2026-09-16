/**
 * R214 (`docs/plans/R214-filter-pass.md` § 4): the quick filter's byte
 * prefilter. Before a row's cells are decoded, its **value bytes** are searched
 * for the needle; a row whose bytes cannot produce a match is skipped, and every
 * other row goes through the unchanged exact check in `gridFilter.ts`. The exact
 * check stays the only thing that decides a match — this module only ever
 * removes rows, so the filter's result is identical **provided it never removes
 * a row that would have matched**. Everything below is about that proviso.
 *
 * **Displayed text is not the bytes**, in exactly these ways (`gridCell.ts`):
 *
 * - **Separators** join parts: ` · ` (a composite's summary), `, ` (repeated
 *   scalars), ` ` (mixed content). So the needle is split on space and comma and
 *   only its longest run is searched for — a run contains no separator, so it
 *   lies inside one part's bytes. (` · ` is non-ASCII; see the next point.)
 * - **Only ASCII needles are prefiltered.** A non-ASCII needle makes the filter
 *   NFC-normalize every cell (R202), and NFC maps several non-ASCII code points to
 *   ASCII (`;` from U+037E, `` ` `` from U+1FEF); not worth proving safe for a case
 *   typed rarely. Such a needle takes today's path, unchanged.
 * - **`toLowerCase` maps exactly two non-ASCII code points to ASCII**: U+0130 to
 *   `i̇` and U+212A KELVIN SIGN to `k` — checked over every code point, not
 *   recalled. A run containing `i` or `k` is not prefiltered in a document whose
 *   bytes contain that character (`scanLowering`: once per buffer, in slices,
 *   and only for such a run).
 * - **Generated counts** — `3 items`, `1 field` — exist in no byte. A run that is
 *   all digits, or a substring of `items`/`fields`, keeps every row that could
 *   show a count (`mayShowGeneratedCount`) as a candidate.
 * - **Removed text** — stripped JSON quotes, the 120-character cell bound, trimmed
 *   whitespace — only makes the display a subset of the bytes: a false candidate,
 *   never a missed row. Safe as it is.
 * - **Markup is not searched.** Only attribute values of the row and the own value
 *   spans of nodes in its subtree, so a needle spelled like a tag name does not
 *   make every row a candidate.
 *
 * The differential test (`test/gridPrefilter.test.ts`) generates documents in all
 * four formats and asserts a prefiltered pass equals a plain one.
 */
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { mayShowGeneratedCount } from './gridCell'

export interface PrefilterToken {
  /** The run to search for, ASCII lower-case. */
  readonly bytes: Uint8Array
  /** The run could also match a generated count. */
  readonly generated: boolean
}

export interface Lowering {
  /** U+0130, UTF-8 `C4 B0`. */
  readonly dottedCapitalI: boolean
  /** U+212A, UTF-8 `E2 84 AA`. */
  readonly kelvinSign: boolean
}

interface LoweringScan {
  position: number
  dottedCapitalI: boolean
  kelvinSign: boolean
}

const loweringByBuffer = new WeakMap<SourceBuffer, LoweringScan>()

/** Bytes scanned between deadline checks. The scan is `indexOf` in native code;
 * measured on the 200 MB fixture, the whole document in one piece took
 * **211 ms** — a frozen window on the first filter of every document. */
const LOWERING_CHUNK_BYTES = 8 * 1024 * 1024

function containsSequence(
  bytes: Uint8Array,
  sequence: readonly number[],
  from: number,
  to: number
): boolean {
  const first = sequence[0]!
  for (let i = bytes.indexOf(first, from); i !== -1 && i < to; i = bytes.indexOf(first, i + 1)) {
    let j = 1
    while (j < sequence.length && bytes[i + j] === sequence[j]) j++
    if (j === sequence.length) return true
  }
  return false
}

/**
 * Whether the document holds either code point that lower-cases to ASCII —
 * scanned once per buffer, in chunks, until `deadline` (a `performance.now()`
 * value). `null` while unfinished; progress is kept for the next call, by this
 * pass or a later one. A match is found by its start position and may read past
 * the chunk's end, so none is split between chunks.
 */
export function scanLowering(source: SourceBuffer, deadline: number): Lowering | null {
  let scan = loweringByBuffer.get(source)
  if (scan === undefined) {
    scan = { position: 0, dottedCapitalI: false, kelvinSign: false }
    loweringByBuffer.set(source, scan)
  }
  const bytes = source.bytes
  while (scan.position < bytes.length && !(scan.dottedCapitalI && scan.kelvinSign)) {
    const end = Math.min(bytes.length, scan.position + LOWERING_CHUNK_BYTES)
    scan.dottedCapitalI ||= containsSequence(bytes, [0xc4, 0xb0], scan.position, end)
    scan.kelvinSign ||= containsSequence(bytes, [0xe2, 0x84, 0xaa], scan.position, end)
    scan.position = end
    if (scan.position < bytes.length && performance.now() >= deadline) return null
  }
  return scan
}

/** A needle's prefilter, before the document's lowering characters are known. */
export interface PrefilterPlan {
  readonly token: PrefilterToken
  readonly run: string
  /** The run contains `i` or `k`, so `resolvePrefilter` needs `scanLowering`. */
  readonly needsLowering: boolean
}

/** The plan's token, or `null` when the document holds a character that makes
 * the run unsafe to search for. `lowering` may be `null` only for a plan that
 * does not need it. */
export function resolvePrefilter(
  plan: PrefilterPlan,
  lowering: Lowering | null
): PrefilterToken | null {
  if (!plan.needsLowering) return plan.token
  if (lowering === null) return null
  if (plan.run.includes('i') && lowering.dottedCapitalI) return null
  if (plan.run.includes('k') && lowering.kelvinSign) return null
  return plan.token
}

/** The token a row's value bytes must contain for the row to be able to match
 * `needle`, computed in one call — the document scan included. */
export function prefilterTokenFor(needle: string, source: SourceBuffer): PrefilterToken | null {
  const plan = prefilterPlanFor(needle, source)
  if (plan === null) return null
  return resolvePrefilter(plan, plan.needsLowering ? scanLowering(source, Infinity) : null)
}

/**
 * Everything about `needle`'s prefilter (already trimmed and folded the way
 * `gridFilter.ts` folds it) that does not need the document scanned, or `null`
 * when no condition can be stated and every row must be checked.
 */
export function prefilterPlanFor(needle: string, source: SourceBuffer): PrefilterPlan | null {
  if (needle.length === 0) return null
  for (let i = 0; i < needle.length; i++) if (needle.charCodeAt(i) > 0x7f) return null
  // The same fast-path condition `SourceBuffer` uses: bytes below 0x80 must be
  // those ASCII characters. UTF-16 and the stateful legacy encodings are not.
  const encoding = source.encoding.toLowerCase()
  if (
    encoding !== 'utf-8' &&
    encoding !== 'utf8' &&
    !encoding.startsWith('windows-') &&
    !encoding.startsWith('iso-8859-')
  )
    return null

  let run = ''
  for (const part of needle.split(/[ ,]+/)) if (part.length > run.length) run = part
  if (run.length === 0) return null

  return {
    token: {
      bytes: new TextEncoder().encode(run),
      generated: /^[0-9]+$/.test(run) || 'items'.includes(run) || 'fields'.includes(run)
    },
    run,
    needsLowering: run.includes('i') || run.includes('k')
  }
}

function asciiLower(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 32 : byte
}

function spanContains(bytes: Uint8Array, start: number, end: number, token: Uint8Array): boolean {
  const m = token.length
  const first = token[0]!
  const last = end - m
  for (let i = start; i <= last; i++) {
    if (asciiLower(bytes[i]!) !== first) continue
    let j = 1
    while (j < m && asciiLower(bytes[i + j]!) === token[j]) j++
    if (j === m) return true
  }
  return false
}

function subtreeEnd(store: NodeStore, node: NodeRef): NodeRef {
  for (let n = node; n !== -1; n = store.parentOf(n)) {
    const next = store.nextSiblingOf(n)
    if (next !== -1) return next
  }
  return store.nodeCount
}

/** `false` only when `row` provably cannot match — see the module comment. */
export function rowMayMatch(
  store: NodeStore,
  source: SourceBuffer,
  row: NodeRef,
  token: PrefilterToken
): boolean {
  const bytes = source.bytes
  for (const attr of store.attributesOf(row)) {
    if (spanContains(bytes, attr.valueStart, attr.valueEnd, token.bytes)) return true
  }
  const end = subtreeEnd(store, row)
  for (let n = row + 1; n < end; n++) {
    const value = store.ownValueOf(n)
    if (value !== null && spanContains(bytes, value.start, value.end, token.bytes)) return true
  }
  return token.generated && mayShowGeneratedCount(store, row)
}
