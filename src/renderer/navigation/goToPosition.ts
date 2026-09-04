/**
 * The palette's `:` mode — go to a line or byte offset (M1-PLAN.md D5/D14,
 * CONCEPT.md §7: "a line number, or a byte offset in documents without
 * meaningful lines"). Which one `input` means depends on the same
 * question D9's source-range fact answers: a document with real lines
 * (`hasMeaningfulLines`) takes a 1-based line number, resolved through the
 * row index the same way D9 resolves a line number *from* an offset, just
 * in reverse; a minified document — no meaningful lines, so no useful
 * notion of "line 42" — takes a raw byte offset instead.
 */
import type { Offset } from '../../core/types'
import { offsetOfLine, type LineIndex } from '../../core/rowIndex'
import { hasMeaningfulLines } from '../components/Detail/detailModel'

export interface GoToPosition {
  readonly offset: Offset
  readonly kind: 'line' | 'byte'
}

/** `null` for anything that isn't a bare non-negative integer — the
 * palette shows that as "not a valid position" rather than guessing. */
export function parseGoToPosition(
  bytes: Uint8Array,
  rowIndex: Int32Array,
  line: LineIndex,
  byteLength: number,
  input: string
): GoToPosition | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const n = Number(trimmed)
  if (!Number.isSafeInteger(n) || n < 0) return null

  if (hasMeaningfulLines(line, byteLength)) {
    // `offsetOfLine`, not `rowIndex[n - 1]`: a row is not a line, and
    // indexing the row index treats them as the same thing. They agree only
    // while every line is under the byte cap — one longer line and ":100"
    // silently lands on row 100, which is some earlier line entirely.
    return { offset: offsetOfLine(bytes, rowIndex, line, n), kind: 'line' }
  }
  return { offset: Math.max(0, Math.min(byteLength, n)), kind: 'byte' }
}
