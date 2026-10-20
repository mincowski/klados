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
 * 3. A case mapping that changes length still does not match — R76,
 *    `R72-path-query.md` §6b. The cause moved with R205: it used to be
 *    `indexOfCaseInsensitive` comparing a slice of fixed width, and it is now
 *    the regex engine, which folds `i` upward to `I` rather than folding
 *    `İ` (U+0130) down to the two code units `'İ'.toLowerCase()` produces.
 *    `/İ/i` misses `i̇` for the same reason, so this was never a property
 *    of the old implementation. Measured: 91 single characters in
 *    U+0020–U+2FFF change length under `toLowerCase`. Under `u` (R241) the
 *    fold is Unicode simple case folding, one code point to one, so `ß`
 *    still does not find `ss`; it does find `ẞ` U+1E9E now, which before
 *    R241 it did not.
 *
 * **Case-insensitivity is one algorithm on the decoded path and another on
 * the byte path, and that no longer produces disagreements users can reach.**
 * R205 deleted `indexOfCaseInsensitive` and made plain case-insensitive
 * search a literal regex, so plain and `.*` modes now fold identically **by
 * construction** rather than by two implementations agreeing. The byte path
 * still ASCII-folds, and it only ever runs for an all-ASCII needle. Without
 * `u`, ASCII folding and the engine's agreed on every case for such a needle
 * (D-082). **Under `u` they do not**: `k` and `s` also fold to U+212A KELVIN
 * SIGN and U+017F LONG S, so a case-insensitive needle holding either letter
 * keeps the byte path only where the document cannot contain those two
 * (`FindPath`'s `byte-checked`, R241 §3).
 *
 * What survives is not a path difference but a Unicode one. R204 made both
 * modes see canonical equivalence, so `Å` U+00C5 and the angstrom sign
 * U+212B now match each other everywhere. `µ`/`μ` match through case folding
 * (U+00B5 folds to U+03BC), not through normalization: D-082 rejected NFKC
 * for equating characters that are not the same character. R241 turned on
 * `u` in both modes (`docs/plans/R241-regex-unicode-flag.md`), which also
 * recovers `ß`/`ẞ`, the loss `docs/plans/R202-unicode-comparison.md` § 7
 * accepted, and the astral scripts (Deseret, Osage, Adlam, …) that the
 * engine's code-unit fold never folded.
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
 * falls out of encoding (see module comment), not a user-facing setting.
 *
 * R241 (`docs/plans/R241-regex-unicode-flag.md` §3): under `u`, `k` and `s`
 * fold to U+212A KELVIN SIGN and U+017F LONG S, which the byte path's ASCII
 * fold cannot reach. A case-insensitive needle holding either letter is
 * `byte-checked`: wherever the document can hold either code point it takes
 * the decoded path, so it folds through the same engine regex mode uses and
 * the two modes agree by construction. */
export function chooseFindPath(needle: string, options: TextFindOptions): FindPath {
  if (options.regex || !isAsciiOnly(needle)) return 'decoded'
  return !options.caseSensitive && /[ks]/i.test(needle) ? 'byte-checked' : 'byte'
}

/**
 * `'byte-checked'`: the byte path is exact **unless the document holds
 * U+212A or U+017F**, in which case the decoded path is. R241 §3 first sent
 * every such needle to the decoded path; measured in the renderer, a plain
 * `status` over 200 MB then took 7,628 ms against the byte path's 625 (12×,
 * against a 1.25× budget), so §3's planned refinement applies: decide by
 * whether the document can contain either code point.
 * `mayHoldAsciiFoldTargets` answers that.
 */
export type FindPath = 'byte' | 'byte-checked' | 'decoded'

/** U+212A KELVIN SIGN and U+017F LONG S in UTF-8: the only non-ASCII code
 * points an ASCII letter folds to under `u`. */
const KELVIN_SIGN_UTF8 = [0xe2, 0x84, 0xaa] as const
const LONG_S_UTF8 = [0xc5, 0xbf] as const

function sequenceStartsIn(
  bytes: Uint8Array,
  sequence: readonly number[],
  from: number,
  to: number
): boolean {
  // `indexOf` on a view of `[from, to)` only: on the whole buffer it would
  // scan past `to` to the end, so a chunked scan became quadratic (measured,
  // 13.9 s for one plain `status` over 200 MB before this bound).
  const range = bytes.subarray(from, to)
  let at = range.indexOf(sequence[0]!)
  while (at !== -1) {
    let whole = true
    for (let i = 1; i < sequence.length; i++) {
      if (bytes[from + at + i] !== sequence[i]) {
        whole = false
        break
      }
    }
    if (whole) return true
    at = range.indexOf(sequence[0]!, at + 1)
  }
  return false
}

/** Whether U+212A or U+017F, in UTF-8, **starts** in `[from, to)`; a sequence
 * may run past `to`, so consecutive ranges miss none (R241 §3). */
export function holdsAsciiFoldTargets(bytes: Uint8Array, from: number, to: number): boolean {
  return (
    sequenceStartsIn(bytes, KELVIN_SIGN_UTF8, from, to) ||
    sequenceStartsIn(bytes, LONG_S_UTF8, from, to)
  )
}

/** Per byte buffer. An edit builds a new `SourceBuffer` around new bytes, so
 * an answer never outlives the text it was computed for. */
const asciiFoldTargetScans = new WeakMap<Uint8Array, boolean>()

function isUtf8Encoding(encoding: string): boolean {
  const normalized = encoding.toLowerCase()
  return normalized === 'utf-8' || normalized === 'utf8'
}

/**
 * Whether the document can contain U+212A or U+017F, when that is known
 * without a scan; `null` when a UTF-8 document has not been scanned yet.
 *
 * - **Single-byte code pages: never.** None of the 28 Klados decodes maps any
 *   byte to either code point (R241 §2.5, measured).
 * - **Other multi-byte encodings: assumed so.** GB18030 can encode both, and
 *   these documents are rare enough not to scan.
 */
export function knownAsciiFoldTargets(bytes: Uint8Array, encoding: string): boolean | null {
  if (isSingleByteEncoding(encoding)) return false
  if (!isUtf8Encoding(encoding)) return true
  return asciiFoldTargetScans.get(bytes) ?? null
}

/** Records a completed scan of `bytes`, for `knownAsciiFoldTargets`. */
export function recordAsciiFoldTargets(bytes: Uint8Array, present: boolean): void {
  asciiFoldTargetScans.set(bytes, present)
}

/** `knownAsciiFoldTargets`, scanning the whole buffer at once when it is not
 * known. For `findAll`; the search store scans chunk by chunk instead. */
export function mayHoldAsciiFoldTargets(bytes: Uint8Array, encoding: string): boolean {
  const known = knownAsciiFoldTargets(bytes, encoding)
  if (known !== null) return known
  const present = holdsAsciiFoldTargets(bytes, 0, bytes.length)
  recordAsciiFoldTargets(bytes, present)
  return present
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

export interface DecodedText {
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

// ---------------------------------------------------------------------------
// R204 — canonical equivalence on the decoded path.

/**
 * A decoded window rewritten into NFC, plus what is needed to map an index in
 * it back to the original string (`docs/plans/R202-unicode-comparison.md`
 * § 5).
 *
 * `segments` is `null` when the rewrite was the identity — the overwhelmingly
 * common case, since a window that is already NFC (all-ASCII text, CJK,
 * ordinary composed Latin) needs no mapping at all.
 *
 * **The map is piecewise, not per character.** § 5 specified "an `Int32Array`
 * from normalized position back to original", and a dense array is both
 * 245 KB a window and the single largest cost in building it — filling
 * 65,536 entries one at a time. It is also almost entirely redundant:
 * normalization changes a handful of places in a window and leaves long runs
 * untouched, and within an untouched run the mapping is `original = base +
 * delta`. So this records one entry per run instead, and `originalIndexOf`
 * binary-searches it. Typically a few thousand entries at most, and a
 * `12 KB` allocation rather than `245 KB`.
 */
export interface NormalizedWindow {
  readonly text: string
  readonly segments: NormalizationSegments | null
}

/**
 * Contiguous runs, ascending in both coordinate spaces: run `k` starts at
 * `outStarts[k]` in the normalized text and at `origStarts[k]` in the
 * original, and ends where run `k + 1` begins.
 */
interface NormalizationSegments {
  readonly outStarts: Int32Array
  readonly origStarts: Int32Array
  readonly originalLength: number
}

/**
 * A code point that must never start a new normalization piece, because NFC
 * may compose it onto whatever precedes it.
 *
 * Two families, and both are needed:
 *
 * - **Marks** (`\p{M}`) — every character with a non-zero canonical combining
 *   class is a Mark, and those are exactly the characters NFC composes onto a
 *   base. Unicode property escapes give the real table for free; this is what
 *   `Intl.Segmenter` would have been used for, at 14 ms a window against the
 *   0.05–1.5 ms this costs (§ 8's measurements, which rejected it).
 * - **Hangul V and T jamo** — *not* Marks (they are Letters), but NFC composes
 *   `L + V [+ T]` into a syllable, so a piece starting at a V would compose
 *   differently on its own than in context. These are the only non-Mark code
 *   points with `NFC_Quick_Check=Maybe`.
 *
 * Memoized by code point: a window has far fewer distinct code points than
 * characters, so the regex runs a few hundred times rather than tens of
 * thousands.
 */
const MARK = /\p{M}/u
const composesLeftCache = new Map<number, boolean>()

function composesLeft(codePoint: number): boolean {
  const cached = composesLeftCache.get(codePoint)
  if (cached !== undefined) return cached
  const value =
    // Hangul Jamo V/T, Extended-A (V), Extended-B (T).
    (codePoint >= 0x1160 && codePoint <= 0x11ff) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) ||
    MARK.test(String.fromCodePoint(codePoint))
  composesLeftCache.set(codePoint, value)
  return value
}

/**
 * What NFC does to a lone starter — `null` when it does nothing, which is
 * true of every code point but the ~20 canonical singletons (U+212B ANGSTROM
 * → U+00C5, U+2126 OHM → U+03A9) and a few that decompose to more than one
 * character (U+0344, whose NFC is U+0308 U+0301).
 *
 * Memoized because it is the difference between one `normalize` call per
 * *character* and one per distinct code point. Most of a window is lone
 * starters, and measured on this machine the un-memoized version cost 9.3 ms
 * a window where the whole build now costs ~1.5 ms.
 */
const singletonCache = new Map<number, string | null>()

function normalizedStarter(codePoint: number): string | null {
  const cached = singletonCache.get(codePoint)
  if (cached !== undefined) return cached
  const ch = String.fromCodePoint(codePoint)
  const composed = ch.normalize('NFC')
  const value = composed === ch ? null : composed
  singletonCache.set(codePoint, value)
  return value
}

/** The identity — no normalization was needed, or none was wanted. */
export function identityWindow(text: string): NormalizedWindow {
  return { text, segments: null }
}

/**
 * Rewrites `text` to NFC and records what is needed to map back.
 *
 * **The gate comes first and carries the common case.** `text.normalize('NFC')`
 * on a 64 KB window costs ~0.05 ms and answers "is there anything to do at
 * all" — for every window already in NFC it returns the identity and nothing
 * else is allocated. A hand-rolled scan for combining marks was measured at
 * four times the cost, so this deliberately does not "optimize" the gate into
 * a loop (§ 9).
 *
 * **When there is work, it is done piece by piece, and a piece is a starter
 * plus whatever composes onto it.** Splitting anywhere else would be wrong;
 * splitting only at ASCII boundaries — which is what § 5 proposed — would be
 * correct but would leave a long non-ASCII run with no interior mapping, so a
 * match inside a CJK or Greek passage would report the run's start. Adjacent
 * pieces NFC leaves alone are coalesced into one run, so the segment list
 * stays short and the mapping inside a run stays exact.
 *
 * The whole construction is asserted against `text.normalize('NFC')` over a
 * corpus rather than against expected outputs, because a boundary rule that
 * is subtly wrong produces text that looks right and matches at the wrong
 * offset.
 */
export function normalizeWindowForSearch(text: string): NormalizedWindow {
  const whole = text.normalize('NFC')
  if (whole === text) return identityWindow(text)

  const out: string[] = []
  const outStarts: number[] = []
  const origStarts: number[] = []
  let outLength = 0
  // The open identity run: original `[runStart, runEnd)` copied verbatim.
  let runStart = 0
  let runEnd = 0

  const flushRun = (): void => {
    if (runEnd === runStart) return
    outStarts.push(outLength)
    origStarts.push(runStart)
    out.push(text.slice(runStart, runEnd))
    outLength += runEnd - runStart
    runStart = runEnd
  }

  let i = 0
  while (i < text.length) {
    const start = i
    const starter = text.codePointAt(i)!
    i += starter > 0xffff ? 2 : 1
    const afterStarter = i
    while (i < text.length) {
      const cp = text.codePointAt(i)!
      if (!composesLeft(cp)) break
      i += cp > 0xffff ? 2 : 1
    }

    // A lone starter answers from the memo instead of normalizing a
    // one-character string. This is the hot path.
    const composed =
      i === afterStarter ? normalizedStarter(starter) : normalizedPiece(text, start, i)
    if (composed === null) {
      runEnd = i // still inside the identity run
      continue
    }

    flushRun()
    outStarts.push(outLength)
    origStarts.push(start)
    out.push(composed)
    outLength += composed.length
    runStart = i
    runEnd = i
  }
  flushRun()

  const built = out.join('')
  // Dev-only: the split rule is an optimization of whole-string
  // normalization, so it must produce exactly that. A mismatch means a
  // boundary rule is wrong, which would otherwise surface as a highlight in
  // the wrong place rather than as a failure.
  if (import.meta.env?.DEV && built !== whole) {
    throw new Error('normalizeWindowForSearch: piecewise NFC disagreed with whole-string NFC')
  }
  return {
    text: built,
    segments: {
      outStarts: Int32Array.from(outStarts),
      origStarts: Int32Array.from(origStarts),
      originalLength: text.length
    }
  }
}

/**
 * A base plus its combining marks, memoized by the piece's own text.
 *
 * The distinct base-plus-mark combinations in any real document are bounded
 * by its script — Latin with acutes and diaereses is a few dozen — while the
 * *occurrences* are one per character. Measured on a fully decomposed 64 KB
 * window: 20,169 pieces, of which a handful are distinct, and caching them
 * took the build from 6.2 ms to well under half that.
 *
 * Bounded so a pathological document (every character carrying a different
 * stack of marks) cannot grow it without limit; past the cap it simply stops
 * memoizing rather than evicting, which keeps the hot entries that are
 * already there.
 */
const PIECE_CACHE_LIMIT = 4096
const pieceCache = new Map<string, string | null>()

/** `null` when NFC leaves `text[start, end)` alone. */
function normalizedPiece(text: string, start: number, end: number): string | null {
  const piece = text.slice(start, end)
  const cached = pieceCache.get(piece)
  if (cached !== undefined) return cached
  const composed = piece.normalize('NFC')
  const value = composed === piece ? null : composed
  if (pieceCache.size < PIECE_CACHE_LIMIT) pieceCache.set(piece, value)
  return value
}

/**
 * Where index `index` in the normalized text came from in the original.
 *
 * Exact inside an identity run, which is nearly all of a window. Inside a run
 * NFC actually rewrote — one character's worth of text — an index past its
 * first is clamped to the run's own end: a match boundary lands on a run
 * boundary in every ordinary case, because the composed character is atomic
 * in the normalized text, and clamping keeps the answer inside the character
 * rather than drifting past it.
 */
export function originalIndexOf(window: NormalizedWindow, index: number): number {
  const segments = window.segments
  if (segments === null) return index
  const { outStarts, origStarts, originalLength } = segments
  let lo = 0
  let hi = outStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (outStarts[mid]! <= index) lo = mid
    else hi = mid - 1
  }
  const origEnd = lo + 1 < origStarts.length ? origStarts[lo + 1]! : originalLength
  return Math.min(origStarts[lo]! + (index - outStarts[lo]!), origEnd)
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

/**
 * R205 — every character the regex grammar gives a meaning to, escaped so a
 * plain needle is matched literally.
 *
 * Plain case-insensitive search **is** a regex now (see `decodedTextMatches`),
 * so the two modes cannot disagree: there is one folding algorithm, the
 * engine's, rather than two implementations that happen to differ at 154
 * measured code points (D-082).
 */
function escapeForRegex(needle: string): string {
  return needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `{ index, length }` matches within `text`, in ascending order, string
 * (UTF-16) coordinates — not yet mapped to bytes.
 *
 * R239: exported because regex mode runs this one call in a worker
 * (`regexFind.worker.ts`), on the text `prepareDecodedWindow` produced. It is
 * the only part of the decoded path that can run unboundedly long. */
export function decodedTextMatches(
  text: string,
  needle: string,
  options: TextFindOptions
): Array<{ index: number; length: number }> {
  const matches: Array<{ index: number; length: number }> = []
  if (options.regex) {
    const compiled = compileFindPattern(needle, options.caseSensitive)
    // Find compiles the pattern before it searches and never gets here with
    // an invalid one (R241 §4); a direct caller still gets no matches.
    if (!compiled.ok) return []
    const regex = compiled.regex
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      assertAdvanced(matches, match.index)
      matches.push({ index: match.index, length: match[0].length })
      // Zero-length matches (e.g. `a*`) must still advance, or exec loops
      // forever, and by a whole code point (R241 §6).
      regex.lastIndex =
        match[0].length > 0 ? match.index + match[0].length : nextCodePointIndex(text, match.index)
    }
    return matches
  }

  if (needle.length === 0) return []

  // Case-sensitive stays `indexOf`: it is exact, it is faster than any
  // regex, and it cannot disagree with a case-sensitive regex about what a
  // literal means.
  if (options.caseSensitive) {
    let from = 0
    while (from <= text.length - needle.length) {
      const idx = text.indexOf(needle, from)
      if (idx === -1) break
      matches.push({ index: idx, length: needle.length })
      from = idx + 1 // overlapping matches allowed, same as the byte path
    }
    return matches
  }

  // R205: case-insensitive plain search is the engine's own fold, applied to
  // an escaped literal. This replaces `indexOfCaseInsensitive`, which sliced
  // and lowercased the text **at every position** — measured at 366.2 ms
  // against 35.5 ms for this, over 200 passes on a 64 KB window, for an
  // identical 2427 matches.
  //
  // A match's length comes from the match itself, not from `needle.length`:
  // the engine can fold a character to one of a different width, and
  // `MatchSet` already documents that a decoded-path match's byte length
  // varies.
  //
  // R241: `giu`, the same fold regex mode uses (§5). The escaped literal
  // always compiles under `u` (§2.2, and a test keeps it so).
  const literal = new RegExp(escapeForRegex(needle), 'giu')
  let literalMatch: RegExpExecArray | null
  while ((literalMatch = literal.exec(text)) !== null) {
    assertAdvanced(matches, literalMatch.index)
    matches.push({ index: literalMatch.index, length: literalMatch[0].length })
    // **Advance by one code point, not by the match length.** The regex
    // branch above advances by the match and this one must not: the plain
    // path has always allowed overlapping matches ("same as the byte path"),
    // and advancing by the match would silently drop `aa` in `aaa` from two
    // matches to one. One code point, not one code unit: under `u` the engine
    // moves a `lastIndex` inside a surrogate pair back to its start, and
    // `😀` over `😀😀` would match at 0 forever (R241 §2.3).
    literal.lastIndex = nextCodePointIndex(text, literalMatch.index)
  }
  return matches
}

/** One code point past `index`: two code units at a high surrogate followed
 * by a low one, otherwise one (R241 §6). */
function nextCodePointIndex(text: string, index: number): number {
  const unit = text.charCodeAt(index)
  if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return index + 2
  }
  return index + 1
}

/** Development only (R241 §6): each match starts after the previous one. A
 * loop that stops advancing then throws in a test instead of hanging the test
 * runner, where no timeout can fire because the loop never yields.
 * `import.meta.env` is absent under `tsx` (the CLI), hence the `?.`. */
function assertAdvanced(matches: ReadonlyArray<{ index: number }>, index: number): void {
  if (import.meta.env?.DEV !== true) return
  const previous = matches[matches.length - 1]
  if (previous !== undefined && index <= previous.index) {
    throw new Error(`Find stopped advancing: a match at ${index} after one at ${previous.index}`)
  }
}

/**
 * R241 §4a (`docs/plans/R241-regex-unicode-flag.md`): `\` followed by a
 * character that is neither ASCII alphanumeric nor one of
 * `^ $ \ . * + ? ( ) [ ] { } | /` becomes the `\x` (or, past ASCII, `\u{…}`)
 * escape of that character. Under `u` an identity escape of punctuation
 * (`\-`, `\:`, `\#`) is a syntax error; this keeps what users type "to be
 * safe", as PCRE, Python and .NET allow, meaning what it meant before `u`.
 *
 * `\xHH` is a literal both inside and outside a class, so no class tracking
 * is needed. One left-to-right pass that consumes `\` together with the
 * character after it, so `\\-` stays an escaped backslash and a `-`.
 */
export function rewriteHarmlessEscapes(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] !== '\\' || i + 1 >= pattern.length) {
      out += pattern[i]
      i += 1
      continue
    }
    const codePoint = pattern.codePointAt(i + 1)!
    const char = String.fromCodePoint(codePoint)
    if (/[A-Za-z0-9^$\\.*+?()[\]{}|/]/.test(char)) out += `\\${char}`
    else if (codePoint <= 0x7f) out += `\\x${codePoint.toString(16).padStart(2, '0')}`
    else out += `\\u{${codePoint.toString(16)}}`
    i += 1 + char.length
  }
  return out
}

export type CompiledFindPattern =
  | { readonly ok: true; readonly regex: RegExp }
  /** `reason` is the engine's, without its `Invalid regular expression:
   * /…/flags: ` prefix, which would repeat the rewritten pattern. */
  | { readonly ok: false; readonly reason: string }

/** A regex-mode Find pattern as Find compiles it (R241): §4a's rewrite, then
 * `u`, with `i` unless case-sensitive. Compiled once before a search starts,
 * so an invalid pattern is a state Find can show (§4), not an empty result. */
export function compileFindPattern(needle: string, caseSensitive: boolean): CompiledFindPattern {
  const source = rewriteHarmlessEscapes(needle)
  const flags = caseSensitive ? 'gu' : 'giu'
  try {
    return { ok: true, regex: new RegExp(source, flags) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const prefix = `Invalid regular expression: /${source}/${flags}: `
    return {
      ok: false,
      reason: message.startsWith(prefix) ? message.slice(prefix.length) : message
    }
  }
}

/**
 * One window, decoded and made ready to match against: everything
 * `findDecodedInWindow` does before `decodedTextMatches`, kept so the matches
 * can be mapped back to bytes afterwards by `mapWindowMatches`.
 *
 * R239 split `findDecodedInWindow` here so regex mode can run the match
 * itself in a worker. `text` and `needle` are exactly what that worker is
 * given: the normalized window and the normalized needle, never the raw
 * decoded text, so the worker's indices are in the same coordinates
 * `mapWindowMatches` maps from.
 */
export interface PreparedWindow {
  readonly window: DecodedWindow
  /** What to match against: the window after R204's normalization. */
  readonly text: string
  /** What to match: the needle after R204's normalization. */
  readonly needle: string
  readonly decoded: DecodedText
  readonly normalized: NormalizedWindow
}

export function prepareDecodedWindow(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  encoding: string,
  needle: string,
  window: DecodedWindow,
  bytesLength: number
): PreparedWindow {
  const decoded = decodeWindow(bytes, rowIndex, encoding, window, bytesLength)

  // R204. Normalization is applied only for a needle that is not pure ASCII,
  // and that is a correctness rule as much as a cost one — the same rule
  // `chooseFindPath` already applies one level up, and the one `gridFilter`
  // applies to the quick filter.
  //
  // NFC composes. Normalizing the *window* for an ASCII needle can only
  // remove matches: `cafe` matches a decomposed `cafe` + U+0301 character for
  // character today, and would stop once the window is composed. Nothing in
  // NFC produces an ASCII character that was not already there. For a regex
  // it would be worse than neutral — `.` counts one character against a
  // composed `é` and two against a decomposed one, so normalizing would
  // silently change what an existing ASCII pattern matches.
  const normalize = !isAsciiOnly(needle)
  const normalized: NormalizedWindow = normalize
    ? normalizeWindowForSearch(decoded.text)
    : identityWindow(decoded.text)
  return {
    window,
    text: normalized.text,
    needle: normalize ? needle.normalize('NFC') : needle,
    decoded,
    normalized
  }
}

/**
 * Matches owned by the window — a match belongs to the window whose byte
 * range its **start** falls the earliest inside, so consecutive windows'
 * results tile the byte space with no gaps and no duplicates despite their
 * one-row overlap. Every window's own decoded text has full context to
 * either side of any match it owns, since the overlap row is present
 * (whole) in both the window that gives it up and the one that claims it.
 *
 * `matches` are in `prepared.text`'s coordinates, as `decodedTextMatches`
 * returns them.
 */
export function mapWindowMatches(
  prepared: PreparedWindow,
  matches: ReadonlyArray<{ readonly index: number; readonly length: number }>,
  rowIndex: Int32Array,
  encoding: string
): MatchSet {
  if (matches.length === 0) return EMPTY_MATCH_SET
  const { window, decoded, normalized } = prepared
  const toOriginal = (index: number): number => originalIndexOf(normalized, index)

  const isLastWindow = window.endRow >= rowIndex.length
  // The handoff boundary: this window's last row is the next window's
  // first — matches starting at or after it belong to the next window,
  // which has full trailing context for them and this one may not.
  const upperBoundExclusive = isLastWindow ? Infinity : rowIndex[window.endRow - 1]!

  const starts: number[] = []
  const ends: number[] = []
  for (const match of matches) {
    const start = byteOffsetOf(decoded, window, rowIndex, toOriginal(match.index), encoding)
    if (start >= upperBoundExclusive) continue
    const end = byteOffsetOf(
      decoded,
      window,
      rowIndex,
      toOriginal(match.index + match.length),
      encoding
    )
    starts.push(start)
    ends.push(end)
  }
  return { starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
}

/** The matches `window` owns, matched on this thread: `prepareDecodedWindow`,
 * `decodedTextMatches`, `mapWindowMatches`. Plain Find runs this; regex mode
 * runs the same three steps with the middle one in a worker, and this stays
 * the reference that path is tested against. */
export function findDecodedInWindow(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  encoding: string,
  needle: string,
  options: TextFindOptions,
  window: DecodedWindow,
  bytesLength: number
): MatchSet {
  const prepared = prepareDecodedWindow(bytes, rowIndex, encoding, needle, window, bytesLength)
  const matches = decodedTextMatches(prepared.text, prepared.needle, options)
  return mapWindowMatches(prepared, matches, rowIndex, encoding)
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
  const path = chooseFindPath(needle, options)
  if (path === 'byte' || (path === 'byte-checked' && !mayHoldAsciiFoldTargets(bytes, encoding))) {
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
