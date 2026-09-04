import { snapToCharBoundary } from './buffer'

/**
 * A row is not a line: it ends at `\n` or after `maxRowBytes`, whichever
 * comes first. This gives the Raw View a uniform virtualization unit even
 * over a single-line minified file (CONCEPT.md §3.1).
 */
export const DEFAULT_MAX_ROW_BYTES = 512

const NEWLINE = 0x0a
const BACKWARD_SCAN_LIMIT = 16
/** How far past `rowStart + maxRowBytes` a cut can still land, because
 * `snapToCharBoundary` advances over UTF-8 continuation bytes — at most 3,
 * rounded up to 4. Used by `incrementalRowIndex` to bound how far back an
 * edit can reach; see its own comment. */
const SNAP_SLACK = 4

/** How much of the file the row-count estimate samples (D0.3). */
const SAMPLE_SIZE = 256 * 1024
/** Extrapolation margin — measured ~0.91× (10% over) on every fixture tried. */
const SAMPLE_MARGIN = 1.1
/** A view within this fraction of its backing capacity is returned as a
 * `subarray` rather than copied — see `GrowableInt32.toArray`. */
const COPY_THRESHOLD = 0.15

/**
 * Estimates row count by running the real cutting rule over a leading
 * sample and extrapolating, rather than assuming every row is `maxRowBytes`
 * long (D0.3). The naive assumption is 19× under on pretty-printed input —
 * true only of minified files — and drives a growable array through enough
 * doublings that the transient peak during `buildRowIndex` was measured at
 * 2.7× the final result on a 200 MB fixture. Clamped to
 * `[bytes.length / maxRowBytes, bytes.length / 16]`: the lower bound is the
 * old estimate, a true structural floor; the upper bound caps the damage if
 * the sample is unrepresentative of the rest of the file.
 */
export function estimateRowCount(
  bytes: Uint8Array,
  maxRowBytes: number,
  breakBytes: readonly number[]
): number {
  const sampleSize = Math.min(SAMPLE_SIZE, bytes.length)
  const sample = bytes.subarray(0, sampleSize)
  const sampleRows = buildRowIndexUncapped(sample, maxRowBytes, breakBytes).length
  const scale = sampleSize === 0 ? 1 : bytes.length / sampleSize
  const estimate = Math.ceil(sampleRows * scale * SAMPLE_MARGIN)
  const lower = Math.ceil(bytes.length / maxRowBytes)
  const upper = Math.ceil(bytes.length / 16)
  return Math.min(Math.max(estimate, lower, 1), Math.max(upper, 1))
}

/**
 * Growable accumulator over a plain Int32Array, doubling capacity like
 * NodeStore's own arrays — a JS `number[]` boxes every push (8 bytes/slot
 * plus growth churn), which measured at 2.6× the size of the final result on
 * a 200 MB fixture (C2).
 */
class GrowableInt32 {
  private arr: Int32Array
  private len = 0

  constructor(initialCapacity: number) {
    this.arr = new Int32Array(Math.max(1, initialCapacity))
  }

  push(value: number): void {
    if (this.len >= this.arr.length) {
      const grown = new Int32Array(this.arr.length * 2)
      grown.set(this.arr)
      this.arr = grown
    }
    this.arr[this.len] = value
    this.len++
  }

  /**
   * A view within `COPY_THRESHOLD` of capacity is returned as a `subarray`
   * rather than `slice`d — both are transferable, and avoiding the copy
   * halves the transient peak when the estimate was close (D0.3). Further
   * from capacity (the estimate was wrong in the other direction), slicing
   * still trims the slack to a tight array.
   */
  toArray(): Int32Array {
    if (this.arr.length - this.len <= this.arr.length * COPY_THRESHOLD) {
      return this.arr.subarray(0, this.len)
    }
    return this.arr.slice(0, this.len)
  }
}

export function buildRowIndex(
  bytes: Uint8Array,
  maxRowBytes: number,
  breakBytes: readonly number[]
): Int32Array {
  const estimatedRows = estimateRowCount(bytes, maxRowBytes, breakBytes)
  return buildRowIndexUncapped(bytes, maxRowBytes, breakBytes, estimatedRows)
}

function buildRowIndexUncapped(
  bytes: Uint8Array,
  maxRowBytes: number,
  breakBytes: readonly number[],
  estimatedRows: number = Math.ceil(bytes.length / maxRowBytes) + 1
): Int32Array {
  const starts = new GrowableInt32(estimatedRows)
  starts.push(0)
  let rowStart = 0
  let i = 0

  while (i < bytes.length) {
    const hardLimit = rowStart + maxRowBytes

    if (bytes[i] === NEWLINE) {
      i++
      if (i < bytes.length) starts.push(i)
      rowStart = i
      continue
    }

    if (i >= hardLimit) {
      const cut = findBreak(bytes, rowStart, hardLimit, breakBytes)
      const snapped = snapToCharBoundary(bytes, cut)
      starts.push(snapped)
      rowStart = snapped
      i = snapped
      continue
    }

    i++
  }

  return starts.toArray()
}

/**
 * Scans backward up to `BACKWARD_SCAN_LIMIT` bytes from `hardLimit` for a
 * preferred break byte, cutting just after it if found; otherwise cuts at
 * `hardLimit`. Never scans before `rowStart` — a row shorter than the scan
 * window must not merge into the previous row's break search.
 */
function findBreak(
  bytes: Uint8Array,
  rowStart: number,
  hardLimit: number,
  breakBytes: readonly number[]
): number {
  const earliest = Math.max(rowStart, hardLimit - BACKWARD_SCAN_LIMIT)
  for (let i = hardLimit - 1; i >= earliest; i--) {
    if (breakBytes.includes(bytes[i]!)) return i + 1
  }
  return hardLimit
}

/**
 * The offset where the row starting at `rowStart` ends and the next one
 * begins, or `null` if `rowStart`'s row runs to EOF (no further row).
 * Factored out of `buildRowIndexUncapped`'s loop body so
 * `incrementalRowIndex` can re-run the same per-row cutting rule from an
 * arbitrary offset instead of the whole document — the two must never
 * diverge, since an incremental result is required to be element-for-
 * element identical to a full rebuild.
 */
function nextRowStart(
  bytes: Uint8Array,
  rowStart: number,
  maxRowBytes: number,
  breakBytes: readonly number[]
): number | null {
  const hardLimit = rowStart + maxRowBytes
  for (let i = rowStart; i < bytes.length; i++) {
    if (bytes[i] === NEWLINE) {
      const next = i + 1
      return next < bytes.length ? next : null
    }
    if (i >= hardLimit) {
      const cut = findBreak(bytes, rowStart, hardLimit, breakBytes)
      return snapToCharBoundary(bytes, cut)
    }
  }
  return null
}

/**
 * M5-PLAN.md H2b — an edit's `[dirtyStart, dirtyEnd)` (old coordinates) and
 * net `delta` are already known by the time a splice reparse runs; rows
 * entirely before `dirtyStart` are byte-identical in `newBytes` and rows
 * entirely after `dirtyEnd` are byte-identical shifted by `delta` (D-036's
 * correction addendum — `buildRowIndex` was ~60% of the whole reparse
 * block). Only the row containing `dirtyStart` onward needs re-scanning,
 * and only until the re-scan produces a row start that lines up with an
 * old row start again — from that point on, both sequences read identical
 * forward bytes from an identical row-relative position, so by
 * `nextRowStart`'s determinism they can never diverge again.
 *
 * Falls back to scanning to EOF (no old rows reused) if realignment never
 * happens — correct either way, just without the saving. That is expected
 * for an edit that inserts or deletes a newline near the very end of the
 * document; it is still exact, per the row-count-changing cases this task
 * exists to handle (`fold` alone gets these wrong, per `deltaList.ts`'s own
 * doc comment — this function does not use `fold`).
 *
 * **A second, broader case degrades the same way: a document with no
 * newlines at all** (a minified single-line file — the case this row
 * index format exists for in the first place, per this file's own top
 * comment). Every row boundary there is a hard `maxRowBytes` cut whose
 * position depends only on distance since the previous cut, not on any
 * absolute byte content to re-anchor against — so an edit shifts every
 * downstream cut's phase, and realignment can fail all the way to EOF for
 * every edit, every time. Still exact (this is the same fallback as
 * above, just reached far more often for this file shape), but the
 * saving this function exists for does not apply to it — a splice on a
 * genuinely minified large file re-scans close to the whole row index on
 * every edit, same as before H2b.
 */
export function incrementalRowIndex(
  oldRowIndex: Int32Array,
  newBytes: Uint8Array,
  dirtyStart: number,
  dirtyEnd: number,
  delta: number,
  maxRowBytes: number,
  breakBytes: readonly number[]
): Int32Array {
  if (oldRowIndex.length === 0) return buildRowIndex(newBytes, maxRowBytes, breakBytes)

  // **Not `rowAt(oldRowIndex, dirtyStart)`** — the row *containing* the edit
  // is not the first row the edit can change. A row starting at `S` decides
  // where it ends by scanning forward for a newline and, failing that,
  // calling `findBreak`, which scans *backward* from `S + maxRowBytes` for a
  // break byte; `snapToCharBoundary` can then advance a few bytes further.
  // So a row's own cut depends on bytes as far ahead as `S + maxRowBytes +
  // 3`, which means the *preceding* row's end — and therefore the containing
  // row's start — moves whenever the edit lands inside that window.
  //
  // Backing up to the row containing `dirtyStart - maxRowBytes - 4` is the
  // provable bound: any row whose dependency window can reach `dirtyStart`
  // starts at or after that offset. It costs at most one or two extra
  // re-scanned rows and nothing else.
  //
  // Found by differential fuzzing against `buildRowIndex` (6 mismatches in
  // 7,500 random edits, all of them documents with hard `maxRowBytes` cuts —
  // an edit landing in the previous row's backward-scan window produced a
  // row index that disagreed with a full rebuild, which is the exact
  // "element-for-element identical" guarantee this function exists to keep).
  const scanFloor = Math.max(0, dirtyStart - maxRowBytes - SNAP_SLACK)
  const firstAffectedRow = rowAt(oldRowIndex, scanFloor)
  const scanStart = oldRowIndex[firstAffectedRow]!

  // Smallest old-index k with oldRowIndex[k] >= dirtyEnd — the earliest an
  // old row could possibly still be valid verbatim (shifted).
  let k = rowAt(oldRowIndex, dirtyEnd)
  if (oldRowIndex[k]! < dirtyEnd) k++

  // Only the re-scanned segment itself grows through `GrowableInt32`'s
  // push/double — it is expected to be a handful of rows near the edit.
  // The unaffected prefix and tail, which can be the entire multi-million-
  // row document, are bulk-copied with `.set()`/a flat loop below instead:
  // pushing each of those elements one at a time was measured to cost as
  // much as the full rebuild this function exists to avoid, because
  // `GrowableInt32`'s per-push bounds check and doubling copies dominate
  // once the "affected" region is actually the whole array.
  const affected = new GrowableInt32(64)
  affected.push(scanStart)

  let rowStart = scanStart
  // Index into `oldRowIndex` where the reusable, delta-shifted tail begins,
  // or -1 if the scan ran to EOF without realigning (the whole remainder
  // was re-scanned, so there is no old tail to reuse).
  let tailStart = -1
  for (;;) {
    const next = nextRowStart(newBytes, rowStart, maxRowBytes, breakBytes)
    if (next === null) break

    const oldCandidate = next - delta
    if (oldCandidate >= dirtyEnd) {
      while (k < oldRowIndex.length && oldRowIndex[k]! < oldCandidate) k++
      if (k < oldRowIndex.length && oldRowIndex[k] === oldCandidate) {
        tailStart = k
        break
      }
    }
    affected.push(next)
    rowStart = next
  }

  const affectedArr = affected.toArray()
  const tailCount = tailStart === -1 ? 0 : oldRowIndex.length - tailStart
  const total = new Int32Array(firstAffectedRow + affectedArr.length + tailCount)
  total.set(oldRowIndex.subarray(0, firstAffectedRow), 0)
  total.set(affectedArr, firstAffectedRow)
  const tailBase = firstAffectedRow + affectedArr.length
  for (let i = 0; i < tailCount; i++) total[tailBase + i] = oldRowIndex[tailStart + i]! + delta
  return total
}

export function rowAt(index: Int32Array, offset: number): number {
  let lo = 0
  let hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (index[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ---------------------------------------------------------------------------
// Line numbers
//
// A row is not a line (§3.1), but the row index already contains every line
// start, so no second index is needed. The builder above pushes the next row
// start at `i + 1` the moment it sees `\n`, which makes the newline always the
// last byte of its row — so:
//
//     row r begins a new line  <=>  bytes[rowIndex[r] - 1] === '\n'
//
// That test is exact, not approximate. A hard `maxRowBytes` cut can never land
// immediately after a newline, because the loop tests every byte for `\n`
// before it tests the byte cap, and `snapToCharBoundary` only advances over
// UTF-8 continuation bytes (0x80–0xBF), never over 0x0A.
//
// What the row index cannot answer in O(1) is the *cumulative* count — the
// rank. A second `Int32Array` of line starts would answer it, at the cost of
// roughly doubling the index: 29.7 MB on `cars-200mb.xml`, whose ~27-byte
// lines make every row a line. Sparse checkpoints answer the same question for
// 30 KB, because the residual is a bounded forward scan over the row index.

/** Rows between checkpoints. Larger is less memory and a longer residual scan;
 * 1024 costs 30 KB on a 200 MB document and scans at most 1024 byte
 * comparisons, which is microseconds and happens once per viewport rather than
 * once per rendered row. A tunable, like `maxRowBytes` — see §13. */
export const DEFAULT_LINE_CHECKPOINT_STRIDE = 1024

export interface LineIndex {
  /** `checkpoints[k]` is the number of newlines before `rowIndex[k * stride]`. */
  readonly checkpoints: Int32Array
  readonly stride: number
  /**
   * Addressable lines: one more than the number of rows that start a line.
   * A document ending in a newline does not get a trailing empty line here,
   * because `buildRowIndex` pushes no row start at EOF — there is no row to
   * put a number against, so counting one would be a number the gutter can
   * never render.
   */
  readonly lineCount: number
}

/**
 * Built from the row index, in one pass over it — the bytes are touched only
 * at row starts, one comparison each, so this is cheap enough to run
 * unconditionally alongside `buildRowIndex` rather than on demand.
 */
export function buildLineIndex(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  stride: number = DEFAULT_LINE_CHECKPOINT_STRIDE
): LineIndex {
  const checkpoints = new Int32Array(Math.floor((rowIndex.length - 1) / stride) + 1)
  let lines = 0
  for (let r = 1; r < rowIndex.length; r++) {
    if (bytes[rowIndex[r]! - 1] === NEWLINE) lines++
    if (r % stride === 0) checkpoints[r / stride] = lines
  }
  return { checkpoints, stride, lineCount: lines + 1 }
}

/** Newlines before the start of `row` — the rank query the checkpoints exist
 * for. Resolves a checkpoint, then scans at most `stride` row starts. */
function newlinesBeforeRow(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  line: LineIndex,
  row: number
): number {
  const block = Math.floor(row / line.stride)
  let count = line.checkpoints[block] ?? 0
  for (let r = block * line.stride + 1; r <= row; r++) {
    if (bytes[rowIndex[r]! - 1] === NEWLINE) count++
  }
  return count
}

/** 1-based line number containing `offset`. The newline that ends a line
 * belongs to the line it terminates, which falls out of the row rule: a
 * newline is the last byte of its own row. */
export function lineAtOffset(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  line: LineIndex,
  offset: number
): number {
  return newlinesBeforeRow(bytes, rowIndex, line, rowAt(rowIndex, offset)) + 1
}

/**
 * Byte offset where 1-based `lineNumber` starts, clamped into the document.
 * The inverse of `lineAtOffset`, over the same structure — §7's `:` mode needs
 * this direction and the Detail header needs the other.
 */
export function offsetOfLine(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  line: LineIndex,
  lineNumber: number
): number {
  const target = lineNumber - 1
  if (target <= 0 || rowIndex.length === 0) return rowIndex[0] ?? 0

  // Smallest block whose checkpoint has already reached `target`; scanning
  // starts from the one before it, where the count is still short of it.
  const { checkpoints, stride } = line
  let lo = 0
  let hi = checkpoints.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (checkpoints[mid]! >= target) hi = mid
    else lo = mid + 1
  }
  const block = (checkpoints[lo] ?? 0) >= target ? Math.max(0, lo - 1) : lo

  let count = checkpoints[block] ?? 0
  for (let r = block * stride + 1; r < rowIndex.length; r++) {
    if (bytes[rowIndex[r]! - 1] === NEWLINE) {
      count++
      if (count === target) return rowIndex[r]!
    }
  }
  return rowIndex[rowIndex.length - 1]!
}
