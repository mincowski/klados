/**
 * Text find over the byte buffer (M4-PLAN.md G2, CONCEPT.md §6.2): "Operates
 * on the byte buffer, not a tree walk — a substring search over `Uint8Array`
 * with the needle encoded once. Results are an `Int32Array` of byte offsets,
 * resolved to nodes only when displayed."
 *
 * Two paths, chosen by encoding rather than invented:
 *
 * - **All-ASCII needle, no regex → the byte path.** An all-ASCII needle
 *   encodes identically in every encoding this application accepts — UTF-16
 *   is refused at parse with a Fatal diagnostic (`parse.worker.ts`), so
 *   every document that opens is ASCII-compatible. Boyer–Moore–Horspool
 *   over `Uint8Array`, case-folded in the comparison when requested.
 * - **Non-ASCII needle, or regex → the decoded path.** `TextEncoder` only
 *   emits UTF-8, which is why the byte path cannot be extended past ASCII —
 *   there is no web API that encodes `"café"` to windows-1252. Decodes a
 *   sliding window of rows (~64 KB, via the row index that already exists)
 *   with `TextDecoder(encoding)`, one-row overlap between windows so a
 *   match spanning a row boundary is fully contained in at least one of
 *   them.
 *
 * Neither path ever calls `decoder.decode(allBytes)` — invariant 1. The
 * decoded path's own bound is `DECODED_WINDOW_BYTES` regardless of document
 * size, the same discipline the Raw View's window uses (D-031).
 *
 * **Three limits, written down rather than discovered:**
 *
 * 1. The decoded path cannot find a match longer than one window minus one
 *    row (~63 KB).
 * 2. Regex `^`/`$` anchor to the decoded window, not to document lines.
 * 3. `indexOfCaseInsensitive` (below) cannot match a case mapping that
 *    changes length — R76, `R72-path-query.md` §6b. It compares
 *    `text.slice(i, i + needle.length).toLowerCase()` against a needle of
 *    fixed length, so the slice width can never track a mapping like
 *    `'İ'.toLowerCase()` (`'i̇'`, 1 code unit → 2). Measured: 91 single
 *    characters in U+0020–U+2FFF change length under `toLowerCase`. Not a
 *    disagreement between the two paths (limit 4, below) — a case neither
 *    path can express, invisible today because nothing exercises it.
 *    Accepted as a documented limit rather than rewritten: see D-082 for
 *    why a length-tolerant comparison isn't a small change once the actual
 *    fold-divergence problem (limit 4) is considered alongside it.
 *
 * **A fourth, cross-path difference, not a limit of either path alone:
 * case-insensitivity is not the same algorithm on both paths.** The byte
 * path ASCII-folds (`A-Z` <-> `a-z` only) in the comparison. The decoded
 * path lowercases with `String.prototype.toLowerCase()` — the platform's
 * own Unicode casing rules, which occasionally disagree with ASCII folding.
 * Measured (not a Turkish-locale claim — `toLowerCase` is locale-independent,
 * so that rule never actually applies here): a plain search for `µ`
 * (micro sign, U+00B5) misses `μ` (Greek mu, U+03BC) that a regex search
 * for the same needle finds, and — in the opposite direction — a plain
 * search for `Å` (U+00C5) finds the look-alike angstrom sign (U+212B) that
 * a regex search misses. This is a real behavioral difference between the
 * two paths, not a bug in either, and it is accepted as-is (D-082) —
 * surfaced in the UI as a footnote (G5/R72 §6), not left to be discovered
 * as a surprise.
 */

export interface MatchSet {
  /** Ascending byte offsets where a match starts. */
  readonly starts: Int32Array
  /** Byte offset one past where the corresponding match ends —
   * `ends[i] - starts[i]` is the match's byte length, which varies on the
   * decoded path (regex, and case-folding that changes length) even though
   * it is constant on the byte path. */
  readonly ends: Int32Array
}

export const EMPTY_MATCH_SET: MatchSet = { starts: new Int32Array(0), ends: new Int32Array(0) }

export interface TextFindOptions {
  readonly caseSensitive: boolean
  readonly regex: boolean
}

/** ~64 KB — large enough that a match spanning it is a pathological case
 * (documented above as a real limit), small enough to decode well within a
 * single scheduler slice (G3). Windows are built from whole rows, so this
 * is a target, not an exact size. */
export const DECODED_WINDOW_BYTES = 64 * 1024

export function isAsciiOnly(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false
  }
  return true
}

/** Which path `findAll`/G3's chunked job should take for this needle —
 * falls out of encoding (see module comment), not a user-facing setting. */
export function chooseFindPath(needle: string, options: TextFindOptions): 'byte' | 'decoded' {
  return !options.regex && isAsciiOnly(needle) ? 'byte' : 'decoded'
}

function asciiFold(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 32 : byte
}

/**
 * Boyer–Moore–Horspool over `bytes`, restricted to match **starts** in
 * `[from, to)` — a match may extend past `to` up to the real end of
 * `bytes`, which is what makes this safe to call chunk-by-chunk (G3) over
 * consecutive, non-overlapping `[from, to)` ranges without ever splitting a
 * real match at a chunk boundary. Every occurrence is found, including
 * overlapping ones (`i += 1` on a match rather than the full Horspool
 * shift) — find-all, not find-first.
 */
export function findAsciiInRange(
  bytes: Uint8Array,
  needle: string,
  caseSensitive: boolean,
  from: number,
  to: number
): MatchSet {
  const needleBytes = new TextEncoder().encode(needle)
  const m = needleBytes.length
  if (m === 0 || to <= from) return EMPTY_MATCH_SET

  const last = m - 1
  const shift = new Int32Array(256).fill(m)
  for (let i = 0; i < last; i++) {
    shift[caseSensitive ? needleBytes[i]! : asciiFold(needleBytes[i]!)] = last - i
  }

  const starts: number[] = []
  const searchEnd = bytes.length - m
  const boundedTo = Math.min(to, searchEnd + 1)
  let i = Math.max(from, 0)

  while (i < boundedTo) {
    let j = last
    while (j >= 0) {
      const byte = caseSensitive ? bytes[i + j]! : asciiFold(bytes[i + j]!)
      const needleByte = caseSensitive ? needleBytes[j]! : asciiFold(needleBytes[j]!)
      if (byte !== needleByte) break
      j--
    }
    if (j < 0) {
      starts.push(i)
      i += 1
      continue
    }
    const badByte = caseSensitive ? bytes[i + last]! : asciiFold(bytes[i + last]!)
    i += shift[badByte]!
  }

  const startsArr = Int32Array.from(starts)
  const ends = new Int32Array(startsArr.length)
  for (let k = 0; k < startsArr.length; k++) ends[k] = startsArr[k]! + m
  return { starts: startsArr, ends }
}

// ---------------------------------------------------------------------------
// The decoded path.

export interface DecodedWindow {
  readonly startRow: number
  /** Exclusive. */
  readonly endRow: number
}

/**
 * Groups consecutive rows into ~`targetBytes` windows, each overlapping the
 * previous by exactly one row (that row's byte range is identical whichever
 * window it's read from) — the fix for a match spanning a row boundary.
 * Window boundaries are always row boundaries, and rows never split a
 * multi-byte character (`rowIndex.ts`'s `snapToCharBoundary`), so decoding
 * each row independently and concatenating is byte-for-byte the same text
 * `TextDecoder` would produce decoding the window's bytes in one call.
 */
export function decodedWindowsFor(
  rowIndex: Int32Array,
  targetBytes: number = DECODED_WINDOW_BYTES
): readonly DecodedWindow[] {
  const rowCount = rowIndex.length
  if (rowCount === 0) return []

  const windows: DecodedWindow[] = []
  let startRow = 0
  while (startRow < rowCount) {
    const startByte = rowIndex[startRow]!
    // Always at least 2 rows (when the document has that many left) — a
    // window of exactly 1 row would make the *next* window's one-row
    // overlap identical to this one (`endRow - 1 === startRow`), producing
    // the same window forever with no forward progress. Forcing a second
    // row guarantees `endRow > startRow + 1`, so the overlap always
    // advances — the single huge row (>= targetBytes on its own, otherwise
    // unreachable at the DEFAULT_MAX_ROW_BYTES=512 vs. ~64 KB window sizes
    // this ships with, but not guaranteed by this function's own contract
    // for an arbitrary `targetBytes`) still gets a real trailing-row
    // overlap instead of losing the guarantee a match spanning its
    // boundary needs.
    let endRow = startRow + 1
    while (
      endRow < rowCount &&
      (endRow === startRow + 1 || rowIndex[endRow]! - startByte < targetBytes)
    ) {
      endRow++
    }
    windows.push({ startRow, endRow })
    if (endRow >= rowCount) break
    startRow = endRow - 1 // one-row overlap: this window's last row is the next window's first
  }
  return windows
}

interface DecodedText {
  readonly text: string
  /** `checkpoints[i]` is the UTF-16 length of `rowTexts[0..i)` concatenated
   * — where row `startRow + i`'s own decoded text begins within `text`. */
  readonly checkpoints: readonly number[]
  readonly rowTexts: readonly string[]
}

function decodeWindow(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  encoding: string,
  window: DecodedWindow,
  bytesLength: number
): DecodedText {
  const decoder = new TextDecoder(encoding)
  const rowTexts: string[] = []
  const checkpoints: number[] = [0]
  let cumulative = 0
  for (let r = window.startRow; r < window.endRow; r++) {
    const rowStart = rowIndex[r]!
    const rowEnd = r + 1 < rowIndex.length ? rowIndex[r + 1]! : bytesLength
    const rowText = decoder.decode(bytes.subarray(rowStart, rowEnd))
    rowTexts.push(rowText)
    cumulative += rowText.length
    checkpoints.push(cumulative)
  }
  return { text: rowTexts.join(''), checkpoints, rowTexts }
}

/** Greatest row index `k` (relative to the window) with `checkpoints[k] <=
 * stringIndex` — the row a decoded-string offset falls in. */
function rowForStringIndex(checkpoints: readonly number[], stringIndex: number): number {
  let lo = 0
  let hi = checkpoints.length - 2 // checkpoints has one more entry than rows
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (checkpoints[mid]! <= stringIndex) lo = mid
    else hi = mid - 1
  }
  return lo
}

const utf8Encoder = new TextEncoder()

/** Legacy single-byte code pages `TextDecoder` recognizes — one decoded
 * character is exactly one byte for every one of these, so a string index
 * *is* the byte offset with no re-encoding needed at all (and none is
 * possible: `TextEncoder` only ever emits UTF-8 — see the module comment).
 * Matched by prefix so labels/aliases (`windows-1252`, `windows-1250`, …)
 * all match without enumerating every one individually. */
const SINGLE_BYTE_ENCODING_PREFIXES = [
  'windows-125',
  'windows-874',
  'iso-8859-',
  'ibm866',
  'koi8-',
  'macintosh',
  'x-mac-cyrillic'
]

function isSingleByteEncoding(encoding: string): boolean {
  const normalized = encoding.toLowerCase()
  if (normalized === 'ascii' || normalized === 'us-ascii') return true
  return SINGLE_BYTE_ENCODING_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * Exact for UTF-8 and for every single-byte code page — never approximated
 * for either (a wrong-by-a-few-bytes offset produces a highlight that
 * drifts and a node resolution that is occasionally wrong). `stringIndex`
 * is resolved to its row, then:
 *
 * - **Single-byte encoding**: the string index within the row *is* the
 *   byte offset — one character, one byte, always.
 * - **UTF-8**: the row's own decoded prefix up to that point is re-encoded
 *   to get its exact byte length — a ≤row-size (≤512 byte) `TextEncoder`
 *   call, cheap regardless of window or document size.
 * - **Any other encoding** (a legacy multi-byte code page — Shift-JIS,
 *   GB18030, Big5 — none of which `TextEncoder` can produce): falls back
 *   to the UTF-8 re-encoding above as an approximation, not an exact
 *   answer. There is no web-standard API that encodes back to one of
 *   these; an exact fix needs an incremental decode-and-measure walk
 *   instead of re-encoding, which is real, scoped follow-up work, not
 *   silently pretended away here.
 */
function byteOffsetOf(
  decoded: DecodedText,
  window: DecodedWindow,
  rowIndex: Int32Array,
  stringIndex: number,
  encoding: string
): number {
  const row = rowForStringIndex(decoded.checkpoints, stringIndex)
  const withinRow = stringIndex - decoded.checkpoints[row]!
  if (isSingleByteEncoding(encoding)) {
    return rowIndex[window.startRow + row]! + withinRow
  }
  const prefix = decoded.rowTexts[row]!.slice(0, withinRow)
  return rowIndex[window.startRow + row]! + utf8Encoder.encode(prefix).length
}

/** R76 (`R72-path-query.md` §6b, module comment's limit 3): the slice
 * compared against `needleLower` is always exactly `needle.length` code
 * units wide, so a character whose lowercase mapping changes length (`İ`
 * U+0130 → `i̇`, 1 → 2 code units) can never match, regardless of needle —
 * not a disagreement with the regex path, a case neither path expresses. */
function indexOfCaseInsensitive(text: string, needle: string, from: number): number {
  const needleLower = needle.toLowerCase()
  const needleLen = needle.length
  const limit = text.length - needleLen
  for (let i = from; i <= limit; i++) {
    if (text.slice(i, i + needleLen).toLowerCase() === needleLower) return i
  }
  return -1
}

/** `{ index, length }` matches within `text`, in ascending order, string
 * (UTF-16) coordinates — not yet mapped to bytes. */
function decodedTextMatches(
  text: string,
  needle: string,
  options: TextFindOptions
): Array<{ index: number; length: number }> {
  const matches: Array<{ index: number; length: number }> = []
  if (options.regex) {
    let regex: RegExp
    try {
      regex = new RegExp(needle, options.caseSensitive ? 'g' : 'gi')
    } catch {
      return []
    }
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      matches.push({ index: match.index, length: match[0].length })
      // Zero-length matches (e.g. `a*`) must still advance, or exec loops forever.
      regex.lastIndex = match.index + Math.max(match[0].length, 1)
    }
    return matches
  }

  if (needle.length === 0) return []
  let from = 0
  while (from <= text.length - needle.length) {
    const idx = options.caseSensitive
      ? text.indexOf(needle, from)
      : indexOfCaseInsensitive(text, needle, from)
    if (idx === -1) break
    matches.push({ index: idx, length: needle.length })
    from = idx + 1 // overlapping matches allowed, same as the byte path
  }
  return matches
}

/**
 * Matches owned by `window` — a match belongs to the window whose byte
 * range its **start** falls the earliest inside, so consecutive windows'
 * results tile the byte space with no gaps and no duplicates despite their
 * one-row overlap. Every window's own decoded text has full context to
 * either side of any match it owns, since the overlap row is present
 * (whole) in both the window that gives it up and the one that claims it.
 */
export function findDecodedInWindow(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  encoding: string,
  needle: string,
  options: TextFindOptions,
  window: DecodedWindow,
  bytesLength: number
): MatchSet {
  const decoded = decodeWindow(bytes, rowIndex, encoding, window, bytesLength)
  const matches = decodedTextMatches(decoded.text, needle, options)
  if (matches.length === 0) return EMPTY_MATCH_SET

  const isLastWindow = window.endRow >= rowIndex.length
  // The handoff boundary: this window's last row is the next window's
  // first — matches starting at or after it belong to the next window,
  // which has full trailing context for them and this one may not.
  const upperBoundExclusive = isLastWindow ? Infinity : rowIndex[window.endRow - 1]!

  const starts: number[] = []
  const ends: number[] = []
  for (const match of matches) {
    const start = byteOffsetOf(decoded, window, rowIndex, match.index, encoding)
    if (start >= upperBoundExclusive) continue
    const end = byteOffsetOf(decoded, window, rowIndex, match.index + match.length, encoding)
    starts.push(start)
    ends.push(end)
  }
  return { starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
}

/**
 * Whole-document convenience — runs every chunk/window synchronously, with
 * no yielding. Fine for tests and small documents; G3's scheduler is what
 * calls the range/window-scoped functions above chunk-by-chunk for a real
 * document, so the UI thread is never blocked by this doing it all at once.
 */
export function findAll(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  encoding: string,
  needle: string,
  options: TextFindOptions
): MatchSet {
  if (chooseFindPath(needle, options) === 'byte') {
    return findAsciiInRange(bytes, needle, options.caseSensitive, 0, bytes.length)
  }

  const windows = decodedWindowsFor(rowIndex)
  const starts: number[] = []
  const ends: number[] = []
  for (const window of windows) {
    const result = findDecodedInWindow(
      bytes,
      rowIndex,
      encoding,
      needle,
      options,
      window,
      bytes.length
    )
    for (let i = 0; i < result.starts.length; i++) {
      starts.push(result.starts[i]!)
      ends.push(result.ends[i]!)
    }
  }
  return { starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
}
