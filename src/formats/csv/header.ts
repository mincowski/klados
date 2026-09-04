/**
 * Has-header detection (R147, `docs/plans/R145-csv.md` §3). Bytes in, boolean out — the
 * same standalone shape as `dialect.ts`, and the companion to the probe recorded there:
 * §3 asks *whether a column can be named when the file has no header row at all*, and
 * the probe (`docs/plans/R145-csv.md`'s R147 results) found that it cannot without a
 * `core/types.ts` change — an empty attribute name span interns to the *same* id
 * regardless of which field it names, so `collectColumns`'s per-row `findField` treats
 * every headerless column after the first as "already seen" and silently drops it
 * (confirmed with a real `NodeStore`/`Interner`/`collectColumns` round trip: 3 distinct
 * columns collapsed to 1). Option (c) was already rejected by the plan. That leaves
 * option (a) — always treat row 1 as the header — as the only one buildable without
 * touching the contract, which `src/formats/csv/index.ts` does unconditionally.
 *
 * This module's job is narrower than "does the file have a header": it decides whether
 * that assumption is *doing real work* — silently reinterpreting a genuine data row as
 * column names — so `index.ts` can disclose it via a diagnostic instead of leaving it
 * unremarked. A classic type-mismatch heuristic (the same shape as Python's
 * `csv.Sniffer.has_header`): a column is evidence of a header when its header-row field
 * is not numeric but every sampled data-row field in that column is. One such column is
 * enough; nothing here claims certainty for an all-text or all-numeric table, where a
 * header is genuinely indistinguishable from data by type alone.
 */
import type { CsvDialect } from './dialect'

const LF = 0x0a
const CR = 0x0d

/** Small — this only ever needs the header plus a handful of data rows. */
const SNIFF_BUDGET_BYTES = 8 * 1024
const SAMPLE_ROWS = 5

const NUMERIC_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

interface FieldSpan {
  readonly start: number
  readonly end: number
}

/** Quote-aware row scan, returning field spans rather than just counts (`dialect.ts`'s
 * `fieldCountsPerRow` only needs counts; this needs the text). Stops at the first
 * newline/EOF; a row left open by a trailing quote or cut off at the byte budget is
 * still returned as-is — sampling tolerates a ragged last row, it does not need to
 * reject it the way dialect sniffing's consistency measure does. */
function scanRow(
  head: Uint8Array,
  delimiter: number,
  quote: number,
  pos: number
): { fields: FieldSpan[]; next: number } | null {
  if (pos >= head.length) return null
  const fields: FieldSpan[] = []
  let fieldStart = pos
  let inQuotes = false
  let i = pos

  const pushField = (end: number): void => {
    fields.push({ start: fieldStart, end })
  }

  while (i < head.length) {
    const b = head[i]!
    if (inQuotes) {
      if (b === quote) {
        if (head[i + 1] === quote) {
          i += 2
          continue
        }
        inQuotes = false
      }
      i++
      continue
    }
    if (b === quote) {
      inQuotes = true
      i++
      continue
    }
    if (b === delimiter) {
      pushField(i)
      i++
      fieldStart = i
      continue
    }
    if (b === LF || b === CR) {
      pushField(i)
      i++
      if (b === CR && head[i] === LF) i++
      return { fields, next: i }
    }
    i++
  }
  pushField(i)
  return { fields, next: i }
}

function fieldText(head: Uint8Array, span: FieldSpan): string {
  return new TextDecoder('utf-8', { fatal: false })
    .decode(head.subarray(span.start, span.end))
    .trim()
}

function looksNumeric(text: string): boolean {
  return text.length > 0 && NUMERIC_PATTERN.test(text)
}

/**
 * `header` is the already-scanned header row's field spans (into `source`, absolute
 * offsets — `index.ts` passes what it already has, so this never rescans row 1). Samples
 * up to `SAMPLE_ROWS` rows immediately following `headerEnd` for the type comparison.
 *
 * Returns `true` when there is no contrary evidence — including when there are no data
 * rows to sample at all, or every column is ambiguous — which is what makes "always
 * treat row 1 as the header" (§3(a)) the right unconditional default: this function only
 * ever *adds* a disclosure, it never blocks parsing.
 */
export function detectHeader(
  source: Uint8Array,
  dialect: CsvDialect,
  header: readonly FieldSpan[],
  headerEnd: number
): boolean {
  const budget = Math.min(source.length, headerEnd + SNIFF_BUDGET_BYTES)
  const head = source.subarray(0, budget)

  const headerIsNumeric = header.map((f) => looksNumeric(fieldText(head, f)))
  const allNumericSoFar = header.map(() => true)
  const sampleCounts = header.map(() => 0)
  let sampledAnyRow = false

  let pos = headerEnd
  for (let row = 0; row < SAMPLE_ROWS; row++) {
    const scanned = scanRow(head, dialect.delimiter, dialect.quote, pos)
    if (scanned === null) break
    sampledAnyRow = true
    for (let c = 0; c < header.length && c < scanned.fields.length; c++) {
      sampleCounts[c]!++
      if (!looksNumeric(fieldText(head, scanned.fields[c]!))) allNumericSoFar[c] = false
    }
    pos = scanned.next
  }

  // Strong positive evidence: a column whose header field is text but whose sampled
  // data is consistently numeric — a real header label above a numeric column.
  for (let c = 0; c < header.length; c++) {
    if (sampleCounts[c]! > 0 && !headerIsNumeric[c] && allNumericSoFar[c]) return true
  }

  // Strong negative evidence: nothing distinguishes row 1 from the rows sampled after
  // it — every column is numeric in both, so "row 1 is a header" has no support beyond
  // its position. A genuine text header (labels) never matches this.
  if (sampledAnyRow && header.every((_, c) => headerIsNumeric[c])) return false

  // Ambiguous — no data to compare against, or a non-numeric header with no numeric
  // column to contrast it against (ordinary for an all-text table). Defaulting to
  // "assume a header" costs nothing extra: `index.ts` already treats row 1 as the
  // header unconditionally, so this only controls whether that gets disclosed.
  return true
}
