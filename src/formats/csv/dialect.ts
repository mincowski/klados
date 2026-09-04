/**
 * CSV dialect sniffing (R145, `docs/plans/R145-csv.md` §4). Bytes in, dialect out — no
 * parser, no tree, testable on its own.
 *
 * The one thing that silently corrupts everything if it is wrong, so it is a single,
 * narrow, heavily-tested question: **which byte is the field delimiter?**
 *
 * Chosen by **consistency, not frequency**: for each candidate, count fields per row over
 * the sniffed head and take the delimiter whose per-row field count is most consistent.
 * Frequency alone picks `,` for a semicolon-delimited file whose fields contain decimal
 * commas — a real dialect (German-locale spreadsheet exports) that a frequency count
 * cannot tell apart from the delimiter itself.
 */

export const COMMA = 0x2c // ,
export const SEMICOLON = 0x3b // ;
export const TAB = 0x09
export const PIPE = 0x7c // |
export const QUOTE = 0x22 // "
const LF = 0x0a
const CR = 0x0d

/** Priority order used only to break an exact tie between two candidates that are
 * equally consistent — arbitrary but deterministic, comma first since it is by far the
 * most common dialect when nothing else distinguishes the candidates. */
const CANDIDATES: readonly number[] = [COMMA, SEMICOLON, TAB, PIPE]

/** Never sniff more than this many bytes — invariant 1: no full decode, no JS string of
 * the document, and dialect only ever needs the shape of the first few rows. */
export const SNIFF_BUDGET_BYTES = 64 * 1024

export interface CsvDialect {
  /** The field delimiter byte. Always one of `CANDIDATES`. */
  readonly delimiter: number
  /** `"` with `""` as the escape (RFC 4180) — not sniffed, there is only one quote
   * convention this parser supports (§4: backslash escapes are out of scope for v1). */
  readonly quote: number
}

/**
 * Counts fields per logical row over `head`, quote-aware so a delimiter or newline
 * inside a quoted field is never mistaken for a row/field boundary. `head` need not end
 * on a row boundary — sniffing only ever sees a byte budget, not the whole file — so a
 * row left open by a trailing quote, or with no trailing newline at all, is dropped
 * rather than counted, since a boundary cut mid-row would otherwise skew the very
 * consistency this function measures.
 */
function fieldCountsPerRow(head: Uint8Array, delimiter: number): number[] {
  const counts: number[] = []
  let fields = 1
  let inQuotes = false
  let sawContent = false
  let i = 0

  while (i < head.length) {
    const b = head[i]!
    if (inQuotes) {
      if (b === QUOTE) {
        if (head[i + 1] === QUOTE) {
          i += 2
          continue
        }
        inQuotes = false
      }
      i++
      continue
    }
    if (b === QUOTE) {
      inQuotes = true
      sawContent = true
      i++
      continue
    }
    if (b === delimiter) {
      fields++
      sawContent = true
      i++
      continue
    }
    if (b === LF || b === CR) {
      counts.push(fields)
      fields = 1
      sawContent = false
      i++
      if (b === CR && head[i] === LF) i++
      continue
    }
    sawContent = true
    i++
  }

  // The final row: only counted if it looks complete — closed quoting and some
  // content — since an open quote or a bare byte run at the truncation boundary is a
  // row `head` cut off mid-way, not a real one-line row.
  if (sawContent && !inQuotes) counts.push(fields)

  return counts
}

/** The most frequent value in `counts`, and how many rows had it. Ties keep whichever
 * value was encountered first — deterministic, and irrelevant here since only the
 * frequency (not which count won it) feeds the delimiter comparison. */
function modeOf(counts: readonly number[]): { value: number; occurrences: number } {
  const tally = new Map<number, number>()
  let best = 0
  let bestCount = 0
  for (const c of counts) {
    const next = (tally.get(c) ?? 0) + 1
    tally.set(c, next)
    if (next > bestCount) {
      bestCount = next
      best = c
    }
  }
  return { value: best, occurrences: bestCount }
}

/**
 * Sniffs the delimiter from the first `SNIFF_BUDGET_BYTES` of the source. `source` may
 * be the whole document or an already-truncated head; either way only the first
 * `SNIFF_BUDGET_BYTES` are read. `start` skips a BOM or other prefix the caller has
 * already accounted for.
 *
 * A candidate whose modal field count is 1 never actually delimits anything in the
 * sniffed head and is excluded — otherwise a delimiter absent from the whole file would
 * "win" on perfect consistency (every row trivially reports 1 field) over a real
 * delimiter whose count merely varies. If every candidate is excluded this way the file
 * has no delimiter at all — a valid one-column CSV (§9: "no delimiter found anywhere" is
 * not an error) — and `COMMA` is returned as an arbitrary default that will never be
 * exercised.
 */
export function sniffDialect(source: Uint8Array, start = 0): CsvDialect {
  const end = Math.min(source.length, start + SNIFF_BUDGET_BYTES)
  const head = source.subarray(start, end)

  let bestDelimiter = COMMA
  let bestScore = -1

  for (const delimiter of CANDIDATES) {
    const counts = fieldCountsPerRow(head, delimiter)
    if (counts.length === 0) continue
    const { value: modal, occurrences } = modeOf(counts)
    if (modal < 2) continue // never actually splits a row into more than one field
    const score = occurrences / counts.length
    if (score > bestScore) {
      bestScore = score
      bestDelimiter = delimiter
    }
  }

  return { delimiter: bestDelimiter, quote: QUOTE }
}
