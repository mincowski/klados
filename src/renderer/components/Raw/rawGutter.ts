/**
 * Absolute line numbers in the Raw View's gutter (CONCEPT.md §3.1, §4.4).
 *
 * CodeMirror numbers lines within the document it holds, and the document it
 * holds is a ~1 MB *window* — so its own numbering restarts at 1 at every
 * window crossing. That is why D10 shipped without a gutter. `formatNumber`
 * is the extension's own hook for exactly this: the window-local number is
 * offset by the line the window starts on, giving the real number.
 *
 * The base is a rank query over the row index (`core/rowIndex.ts`), not a
 * second index — every line start is already a row start. It is cached per
 * origin because `formatNumber` runs once per *rendered line*, and only the
 * origin changes between those calls.
 *
 * Off entirely when the document has no meaningful lines: a minified file is
 * one line, and a gutter reading "1" beside every row is worse than no gutter.
 * §4.3 draws the same distinction for the Detail view's source-range fact.
 */
import { lineNumbers } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { lineAtOffset, type LineIndex } from '../../../core/rowIndex'
import type { SourceBuffer } from '../../../core/buffer'
import { hasMeaningfulLines } from '../Detail/detailModel'

/**
 * R41: `getSourceBuffer`/`getRowIndex`/`getLineIndex` are live getters —
 * a same-document reparse (`Raw.tsx`'s live-update effect) can replace all
 * three without recreating this `EditorView`, and numbering against a stale
 * `rowIndex` after an edit added or removed lines would silently misnumber
 * every line past the edit. The `hasMeaningfulLines` on/off decision itself
 * is still taken once, at construction — a document flipping between
 * minified and structured mid-session is exotic enough not to warrant a
 * third `Compartment` alongside `wrapCompartment`/`readOnlyCompartment`.
 */
export function rawLineNumbersExtension(
  getSourceBuffer: () => SourceBuffer,
  getRowIndex: () => Int32Array,
  getLineIndex: () => LineIndex,
  getWindowStart: () => number
): Extension {
  const initialSourceBuffer = getSourceBuffer()
  if (!hasMeaningfulLines(getLineIndex(), initialSourceBuffer.byteLength)) return []

  let cachedOrigin = -1
  let cachedRowIndex: Int32Array | null = null
  let cachedLineIndex: LineIndex | null = null
  let cachedBaseLine = 1

  function baseLineFor(origin: number): number {
    const rowIndex = getRowIndex()
    const lineIndex = getLineIndex()
    if (origin !== cachedOrigin || rowIndex !== cachedRowIndex || lineIndex !== cachedLineIndex) {
      cachedOrigin = origin
      cachedRowIndex = rowIndex
      cachedLineIndex = lineIndex
      cachedBaseLine = lineAtOffset(getSourceBuffer().bytes, rowIndex, lineIndex, origin)
    }
    return cachedBaseLine
  }

  return lineNumbers({
    // `localLine` is 1-based within the window, and the window's first line
    // is whatever line its origin falls on — which is why this adds
    // `localLine - 1` rather than `localLine`. A window starting mid-line
    // (its origin is a row boundary, not necessarily a line boundary)
    // correctly numbers that partial first line as the line it continues.
    formatNumber: (localLine) => String(baseLineFor(getWindowStart()) + localLine - 1)
  })
}
