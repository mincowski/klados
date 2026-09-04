/**
 * M5c-PLAN.md J1 — the byte↔UTF-16-unit correspondence for a Raw View
 * window, built **once per window slice** instead of re-derived per call.
 *
 * `rawOffsets.ts`'s `localUnitsToByteOffset`/`byteOffsetToLocalUnits` are
 * correct but O(window): each walks the window's text one code point at a
 * time from position 0. `30f1737` made every hot path (a decoration
 * rebuild's two calls per mark, a scroll handler's per-event conversions)
 * call one of them directly, which is O(marks × window) per rebuild —
 * measured at up to 2 479 ms at 90% into a 1 MB window (`M5c-PLAN.md`
 * §1.1). This module is the missing data structure: build the mapping once
 * per re-slice, then answer each conversion in O(1) (the identity/UTF-16
 * cases) or O(K) (a bounded walk from the nearest checkpoint).
 *
 * `rawOffsets.ts`'s two functions stay as the reference implementation and
 * this module's own test oracle — they should no longer be called from any
 * per-frame path.
 */

const CHECKPOINT_STRIDE = 1024

/** A window's absolute start plus the decoded text and offset map built for
 * it — the one snapshot every hot-path site needs, so a re-slice / mount
 * effect can build it once and every consumer reads the same cached text
 * rather than each calling `view.state.doc.toString()` itself. */
export interface RawWindowSnapshot {
  readonly start: number
  readonly text: string
  readonly map: RawOffsetMap
}

export interface RawOffsetMap {
  /** `true` when `toBytes`/`toUnits` are both the identity function — every
   * ASCII-only UTF-8 window, and every legacy single-byte encoding
   * (windows-1252 and its relatives decode exactly one UTF-16 unit per
   * input byte, regardless of which byte values are present). */
  readonly ascii: boolean
  toBytes(localUnits: number): number
  toUnits(localBytes: number): number
}

function utf8ByteLengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function identityMap(text: string): RawOffsetMap {
  const length = text.length
  return {
    ascii: true,
    toBytes: (localUnits) => Math.max(0, Math.min(length, localUnits)),
    toUnits: (localBytes) => Math.max(0, Math.min(length, localBytes))
  }
}

function utf16Map(text: string): RawOffsetMap {
  const length = text.length
  return {
    ascii: false,
    toBytes: (localUnits) => Math.max(0, localUnits) * 2,
    toUnits: (localBytes) => Math.max(0, Math.min(length, Math.floor(localBytes / 2)))
  }
}

/** One byte scan (Uint8Array) or one char-code scan (string) over the
 * window, whichever the caller already has on hand — both are a single
 * O(window) pass, same cost either way, just avoiding forcing a decode (or
 * a re-scan of bytes already available) purely to answer this question. */
function hasNonAsciiByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i]! >= 0x80) return true
  }
  return false
}

function hasNonAsciiChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) return true
  }
  return false
}

/** Checkpoints every `CHECKPOINT_STRIDE` UTF-16 units: parallel
 * `Int32Array`s of (unit offset, byte offset) pairs, built with one forward
 * pass over the window's code points. `toBytes`/`toUnits` binary-search
 * this array, then walk at most one stride's worth of code points from the
 * nearest checkpoint — bounded work per call instead of a walk from 0. */
function checkpointMap(text: string): RawOffsetMap {
  const length = text.length
  const capacity = Math.floor(length / CHECKPOINT_STRIDE) + 2
  const checkpointUnits = new Int32Array(capacity)
  const checkpointBytes = new Int32Array(capacity)
  let count = 1 // index 0 is the implicit (0, 0) checkpoint, already zeroed
  let units = 0
  let bytes = 0
  let nextThreshold = CHECKPOINT_STRIDE
  while (units < length) {
    const codePoint = text.codePointAt(units)!
    bytes += utf8ByteLengthOfCodePoint(codePoint)
    units += codePoint > 0xffff ? 2 : 1
    if (units >= nextThreshold && count < capacity) {
      checkpointUnits[count] = units
      checkpointBytes[count] = bytes
      count++
      nextThreshold = units + CHECKPOINT_STRIDE
    }
  }

  function binarySearchLE(arr: Int32Array, limit: number, target: number): number {
    let lo = 0
    let hi = limit - 1
    let answer = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid]! <= target) {
        answer = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return answer
  }

  function toBytes(localUnits: number): number {
    if (localUnits <= 0) return 0
    const idx = binarySearchLE(checkpointUnits, count, localUnits)
    let u = checkpointUnits[idx]!
    let b = checkpointBytes[idx]!
    while (u < localUnits && u < length) {
      const codePoint = text.codePointAt(u)!
      b += utf8ByteLengthOfCodePoint(codePoint)
      u += codePoint > 0xffff ? 2 : 1
    }
    return b
  }

  function toUnits(localBytes: number): number {
    if (localBytes <= 0) return 0
    const idx = binarySearchLE(checkpointBytes, count, localBytes)
    let u = checkpointUnits[idx]!
    let b = checkpointBytes[idx]!
    while (u < length) {
      const codePoint = text.codePointAt(u)!
      const charBytes = utf8ByteLengthOfCodePoint(codePoint)
      if (b + charBytes > localBytes) break
      b += charBytes
      u += codePoint > 0xffff ? 2 : 1
    }
    return Math.min(length, u)
  }

  return { ascii: false, toBytes, toUnits }
}

/**
 * Builds the offset map for one window slice. `bytes`, when given, is the
 * window's raw byte range (e.g. `sourceBuffer.bytes.subarray(start, end)`)
 * — the ASCII fast path scans it instead of `text` when available, since
 * some callers (a re-slice) have it for free. Callers that only have the
 * decoded text (`rawEdit.ts`, measuring against `update.startState`, which
 * has no corresponding byte range once prior edits have diverged from
 * `sourceBuffer`) omit it and the scan falls back to `text`.
 */
export function buildOffsetMap(text: string, encoding: string, bytes?: Uint8Array): RawOffsetMap {
  const enc = encoding.toLowerCase()
  if (enc === 'utf-16le' || enc === 'utf-16be') return utf16Map(text)
  if (enc !== 'utf-8') return identityMap(text)

  const hasNonAscii = bytes !== undefined ? hasNonAsciiByte(bytes) : hasNonAsciiChar(text)
  return hasNonAscii ? checkpointMap(text) : identityMap(text)
}
