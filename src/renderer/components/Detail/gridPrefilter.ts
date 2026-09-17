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
 *   ASCII; not worth proving safe for a case typed rarely.
 * - **`toLowerCase` maps exactly two non-ASCII code points to ASCII**: U+0130 to
 *   `i̇` and U+212A KELVIN SIGN to `k` — checked over every code point, not
 *   recalled. For a run containing `i` or `k`, a row whose values contain that
 *   character stays a candidate. Checked per row, inside the same scan: a row can
 *   only show a lowered `i` or `k` that its own values hold.
 * - **Generated counts** — `3 items`, `1 field` — exist in no byte. A run that is
 *   all digits, or a substring of `items` or `fields`, is not prefiltered at all.
 *   Keeping it would need a second description of when a cell shows a count,
 *   beside the one in `gridCell.ts`; the two would drift (R214 § 9's review).
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

export interface PrefilterToken {
  /** The run to search for, ASCII lower-case. */
  readonly bytes: Uint8Array
  /** The run has an `i`: a value holding U+0130 (`C4 B0`) keeps its row. */
  readonly dottedCapitalI: boolean
  /** The run has a `k`: a value holding U+212A (`E2 84 AA`) keeps its row. */
  readonly kelvinSign: boolean
}

/**
 * The token a row's value bytes must contain for the row to be able to match
 * `needle` (already trimmed and folded the way `gridFilter.ts` folds it), or
 * `null` when no such condition can be stated and every row must be checked.
 */
export function prefilterTokenFor(needle: string, source: SourceBuffer): PrefilterToken | null {
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
  if (/^[0-9]+$/.test(run) || 'items'.includes(run) || 'fields'.includes(run)) return null

  return {
    bytes: new TextEncoder().encode(run),
    dottedCapitalI: run.includes('i'),
    kelvinSign: run.includes('k')
  }
}

function asciiLower(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 32 : byte
}

function spanMayMatch(
  bytes: Uint8Array,
  start: number,
  end: number,
  token: PrefilterToken
): boolean {
  const run = token.bytes
  const m = run.length
  const first = run[0]!
  for (let i = start; i < end; i++) {
    const byte = bytes[i]!
    if (byte >= 0x80) {
      if (token.dottedCapitalI && byte === 0xc4 && bytes[i + 1] === 0xb0) return true
      if (token.kelvinSign && byte === 0xe2 && bytes[i + 1] === 0x84 && bytes[i + 2] === 0xaa)
        return true
      continue
    }
    if (asciiLower(byte) !== first || i + m > end) continue
    let j = 1
    while (j < m && asciiLower(bytes[i + j]!) === run[j]) j++
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
    if (spanMayMatch(bytes, attr.valueStart, attr.valueEnd, token)) return true
  }
  const end = subtreeEnd(store, row)
  for (let n = row + 1; n < end; n++) {
    const value = store.ownValueOf(n)
    if (value !== null && spanMayMatch(bytes, value.start, value.end, token)) return true
  }
  return false
}
