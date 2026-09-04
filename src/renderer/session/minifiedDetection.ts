/**
 * M5-PLAN.md H8 — a heuristic on mean row length, driving the Format-on-
 * open *offer* only. **Not** soft wrap, which `wrapPolicy.ts` decides
 * separately and per window (that file's own top comment: a document can
 * need wrap locally without being pathological overall, and needs it
 * whether or not this offer is accepted) — this module must never be
 * consulted from there.
 *
 * The row index (`core/rowIndex.ts`) already gives mean bytes/row for
 * nothing: `byteLength / rowCount` is one division over data collected
 * during parsing, no extra scan.
 *
 * R21-notifications.md §4: moved here from
 * `components/DocumentStatus/minifiedDetection.ts` when the alert strip
 * was deleted — this is logic, not presentation, and outlived the
 * component that used to be its only caller.
 */

/** Above this many bytes per row on average, a document reads as
 * minified rather than merely having some long lines here and there.
 * Not derived from a measurement — pretty-printed source in this
 * project's own fixtures runs well under 100 bytes/row; a document
 * whose rows are consistently being cut by `DEFAULT_MAX_ROW_BYTES`
 * (512, `rowIndex.ts`) rather than by real newlines sits at or near
 * that cap, so a threshold well below it still separates the two
 * cases cleanly. */
export const MINIFIED_MEAN_ROW_BYTES_THRESHOLD = 200

export function isPathologicallyMinified(
  rowCount: number,
  byteLength: number,
  threshold: number = MINIFIED_MEAN_ROW_BYTES_THRESHOLD
): boolean {
  if (rowCount <= 0 || byteLength <= 0) return false
  return byteLength / rowCount > threshold
}
