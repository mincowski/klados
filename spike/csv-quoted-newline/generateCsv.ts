/**
 * R31 — a generated CSV corpus with exactly the shapes §3 asks for: quoted
 * newlines, escaped quotes (`""`), ragged rows (different field counts per
 * row), and a field with thousands of embedded newlines. Deterministic
 * (mulberry32, the same generator `test/invariants.test.ts` uses) so a
 * failing case is reproducible.
 */

// mulberry32 — copied rather than imported: it's a ~6-line utility already
// duplicated between `test/invariants.test.ts` and the M0a spike, not a
// shared module in this codebase.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomWord(rnd: () => number, maxLen: number): string {
  const len = 1 + Math.floor(rnd() * maxLen)
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(rnd() * 26))
  return s
}

function quoteField(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

export interface CsvCorpus {
  readonly text: string
  /** Row indexes (0-based) that contain at least one field with a raw
   * embedded newline — the cases §2b is actually worried about. */
  readonly quotedNewlineRows: readonly number[]
}

/**
 * `rowCount` ordinary-ish rows, each 2-6 fields, with a mix of: plain
 * fields, quoted fields with no special content, quoted fields containing
 * a raw newline (1-3 lines), quoted fields containing escaped quotes, and
 * occasional ragged rows (fewer or more fields than "usual"). One row
 * (`giantFieldRow`, if `includeGiantField`) has a single field containing
 * `giantFieldLines` embedded newlines — the "field with thousands of
 * newlines" §3 asks for.
 */
export function generateCsvCorpus(
  seed: number,
  rowCount: number,
  options: { readonly includeGiantField?: boolean; readonly giantFieldLines?: number } = {}
): CsvCorpus {
  const rnd = mulberry32(seed)
  const lines: string[] = []
  const quotedNewlineRows: number[] = []
  const giantFieldRow = options.includeGiantField ? Math.floor(rowCount / 2) : -1

  for (let r = 0; r < rowCount; r++) {
    if (r === giantFieldRow) {
      const giantLines = options.giantFieldLines ?? 3000
      const parts: string[] = []
      for (let i = 0; i < giantLines; i++) parts.push(randomWord(rnd, 8))
      lines.push(`${quoteField(parts.join('\n'))},${randomWord(rnd, 6)}`)
      quotedNewlineRows.push(r)
      continue
    }

    const fieldCount = 2 + Math.floor(rnd() * 5) // 2-6, "ragged" across rows
    const fields: string[] = []
    let rowHasQuotedNewline = false
    for (let f = 0; f < fieldCount; f++) {
      const kind = rnd()
      if (kind < 0.5) {
        fields.push(randomWord(rnd, 10))
      } else if (kind < 0.75) {
        // A quoted field with an escaped quote, no newline.
        fields.push(quoteField(`${randomWord(rnd, 5)}"${randomWord(rnd, 5)}`))
      } else {
        // A quoted field spanning 2-4 physical lines.
        const embeddedLines = 2 + Math.floor(rnd() * 3)
        const parts: string[] = []
        for (let i = 0; i < embeddedLines; i++) parts.push(randomWord(rnd, 8))
        fields.push(quoteField(parts.join('\n')))
        rowHasQuotedNewline = true
      }
    }
    if (rowHasQuotedNewline) quotedNewlineRows.push(r)
    lines.push(fields.join(','))
  }

  return { text: lines.join('\r\n') + '\r\n', quotedNewlineRows }
}
