/**
 * R179 (`docs/plans/R179-crlf-caret-position.md`) — the selection may never
 * rest between a `\r` and its `\n`.
 *
 * **Why the position exists at all.** R168 set
 * `EditorState.lineSeparator.of('\n')` so CodeMirror's document is byte-faithful
 * to the window; the default split (`/\r\n?|\n/`) discards the `\r` entirely,
 * which made every offset conversion undercount by the number of line breaks
 * before it. That fix was right. Its other half is this: with `\n` as the only
 * separator, a CRLF line's content **ends with the `\r`**, so `line.to` is the
 * position after the CR and before the LF — a legal, one-unit-wide document
 * position sitting in the middle of what the file means as a single terminator.
 *
 * Typing there splices between the two bytes. A user did exactly that:
 * `…"Frankfurt",` `\r` **`ds`** `\n` — the CR now ends a line by itself and the
 * LF starts the next one. Klados renders it unchanged, so the corruption is
 * invisible here and shows up in every other editor.
 *
 * **A transaction filter is the seam, because every way the selection moves is
 * a transaction** — native arrow motion, clicks, drag selection, programmatic
 * jumps from Locate in Source, and the selection CodeMirror derives after
 * native typing. R168 tried to enumerate the input paths instead and concluded
 * none reached the gap; measurement later found `ArrowRight`, `ArrowUp` and two
 * kinds of click all do. Filtering once covers the paths nobody enumerated,
 * which is R164's argument and R171's.
 *
 * **Not `atomicRanges`**, which R168 tried and found wrong for this: it biases
 * by direction of travel, so a range spanning a line break resolves to the
 * wrong side and a click jumps to the following line. **Not a replacing
 * decoration**, which changes what paints rather than which positions exist.
 * **Not a change to `lineSeparator`**, which is the R168 defect.
 */
import {
  EditorSelection,
  EditorState,
  type ChangeSet,
  type ChangeSpec,
  type Extension
} from '@codemirror/state'

/**
 * The slice of `Text` this module needs — narrowed so the rules below are
 * unit-testable against a plain object, with no `EditorState` and no DOM.
 * CodeMirror's `Text` satisfies it.
 *
 * **`sliceString` is only defined for `0 <= from <= to <= length`.** CodeMirror's
 * own `Text` happens to clamp out-of-range arguments and answer `''`, which
 * would make the bounds check below redundant *for that one implementation* —
 * but the point of narrowing to an interface is that this module does not
 * depend on which one it is given. Callers here keep the positions in range.
 */
export interface DocumentSlice {
  readonly length: number
  sliceString(from: number, to: number): string
}

/**
 * Whether `pos` sits between a `\r` and its `\n`.
 *
 * Position 0 and the end of the document are answered without reading out of
 * bounds — there is no character before the first position or after the last,
 * so neither can be inside a pair. **That check is about `DocumentSlice`'s
 * contract rather than about correctness against `Text`**: a mutation run
 * removing it stayed green, because CodeMirror's rope clamps and answers `''`,
 * which is already not a `\r`. It is kept as the interface's precondition and as
 * two fewer rope reads at the two most common boundary positions, and it is
 * recorded here as an equivalent mutation rather than left looking like an
 * untested branch.
 *
 * A line ending in a bare LF is untouched, and a mixed-ending document is judged
 * per position rather than per document, which is the only way to be right about
 * a file containing both.
 */
export function isInsideCrlfPair(doc: DocumentSlice, pos: number): boolean {
  if (pos <= 0 || pos >= doc.length) return false
  return doc.sliceString(pos - 1, pos) === '\r' && doc.sliceString(pos, pos + 1) === '\n'
}

/**
 * `pos`, moved back one unit if it is inside a CRLF pair.
 *
 * **Back, not forward, and that is the whole of the choice.** `pos - 1` is
 * where the rendered text ends, so it is the position the user visibly aimed at
 * in every measured path: `End` already lands there, a click at or past the end
 * of the line aims there, and `ArrowRight` from there was trying to cross the
 * line ending rather than enter it. Moving forward to `pos + 1` would put the
 * caret on the next line, which no input in the measured set was asking for.
 */
export function clampOutOfCrlfPair(doc: DocumentSlice, pos: number): number {
  return isInsideCrlfPair(doc, pos) ? pos - 1 : pos
}

/**
 * `selection` with every endpoint clamped out of a CRLF pair, or `null` when
 * nothing needed moving — the common case, which the caller uses to leave the
 * transaction untouched rather than rebuilding an identical one.
 *
 * **Both endpoints of every range**, not just the head: a drag can leave
 * `anchor` in the gap while `head` is elsewhere, and `changeByRange` produces
 * multiple ranges today independently of any future multi-cursor work.
 */
export function clampSelectionOutOfCrlfPairs(
  doc: DocumentSlice,
  selection: EditorSelection
): EditorSelection | null {
  let moved = false
  const ranges = selection.ranges.map((range) => {
    const anchor = clampOutOfCrlfPair(doc, range.anchor)
    const head = clampOutOfCrlfPair(doc, range.head)
    if (anchor === range.anchor && head === range.head) return range
    moved = true
    return EditorSelection.range(anchor, head)
  })
  return moved ? EditorSelection.create(ranges, selection.mainIndex) : null
}

/** A span of the document, as `Text.line`/`Text.lineAt` return one. */
export interface DocumentLine {
  readonly number: number
  readonly from: number
  readonly to: number
  readonly text: string
}

/** `DocumentSlice` plus the line lookups R181 needs. `Text` satisfies it. */
export interface DocumentLines extends DocumentSlice {
  readonly lines: number
  line(lineNumber: number): DocumentLine
  lineAt(pos: number): DocumentLine
}

/**
 * R180 — the range Backspace must remove when the caret sits at the start of a
 * line whose predecessor ended in CRLF, or `null` when this is an ordinary
 * Backspace that native behaviour should handle.
 *
 * Without it, Backspace deletes the `\n` alone and strands the `\r` inside the
 * joined line — `alpha\rbeta`, a lone CR in the middle of a line, silently and
 * durably, because invariant 6 writes the buffer back verbatim.
 *
 * R179 stops the caret *resting* inside the pair; this is the other defect,
 * which starts from a position either side of a **complete** pair and removes
 * one unit of it.
 */
export function crlfBackspaceRange(
  doc: DocumentSlice,
  pos: number
): { from: number; to: number } | null {
  if (pos < 2) return null
  return doc.sliceString(pos - 2, pos) === '\r\n' ? { from: pos - 2, to: pos } : null
}

/**
 * R180 — the range Delete must remove when the caret sits just before a CRLF,
 * or `null` for an ordinary Delete.
 *
 * Without it, Delete removes the `\r` alone and converts that one line ending
 * from CRLF to LF — the same silent, durable corruption in the other direction.
 * With R179 in place this is exactly where the caret lands at the visible end of
 * a CRLF line, so it is the common case rather than an edge one.
 */
export function crlfDeleteRange(
  doc: DocumentSlice,
  pos: number
): { from: number; to: number } | null {
  if (pos + 2 > doc.length) return null
  return doc.sliceString(pos, pos + 2) === '\r\n' ? { from: pos, to: pos + 2 } : null
}

/**
 * R181 — the line ending line `lineNumber` carries, or `undefined` if it has
 * none.
 *
 * The last line of a document has no ending by definition; every other line's
 * ending is a CRLF exactly when its text ends with the retained `\r` (R168), and
 * an LF otherwise.
 */
export function lineEndingOf(doc: DocumentLines, lineNumber: number): string | undefined {
  if (lineNumber < 1 || lineNumber >= doc.lines) return undefined
  return doc.line(lineNumber).text.endsWith('\r') ? '\r\n' : '\n'
}

/**
 * R181 — the line ending Enter should insert at `pos`.
 *
 * ```
 * insert = endingOf(current) ?? endingOf(current - 1) ?? '\n'
 * ```
 *
 * **Every case is O(1)** — one line lookup, or two. That is the point of the
 * rule rather than a detail of it. The alternative considered was a document
 * majority, measured at ~820 MB/s: 244 ms at the 200 MB ceiling, so it would
 * have had to be computed once and cached, and that cache would need
 * invalidating on every edit. No scan, no cache, no invalidation, and no
 * question about whether the window or the whole file is the right population.
 *
 * Each clause earns its place:
 *
 * - **The line being split** answers it whenever the caret is anywhere but the
 *   final line, which is nearly always. Splitting a CRLF line yields two.
 * - **The line before** covers the last line, which has no ending of its own.
 *   Not a rare case: a document ending in a trailing newline has an empty final
 *   line, so *pressing Enter at the end of a file* lands here every time — the
 *   single most common Enter in the editor, which a majority would have had to
 *   be computed to answer.
 * - **`\n`** covers a document with no line break at all, where there is
 *   nothing to imitate and no majority to consult either.
 *
 * The rule preserves a mixed file's local structure rather than healing it
 * toward a dominant ending — the more conservative of the two, and the one
 * consistent with invariant 6's posture of writing back what was there.
 *
 * **"Always `\n`" is not among the options because it is the defect**: it is
 * what the code did, and it is the mechanism by which editing a CRLF file
 * steadily converted it to a mixed one.
 */
export function lineBreakAt(doc: DocumentLines, pos: number): string {
  const current = doc.lineAt(pos).number
  return lineEndingOf(doc, current) ?? lineEndingOf(doc, current - 1) ?? '\n'
}

/**
 * Corrections for any change that *inserts* at a CRLF gap, or `null` when there
 * are none — which is almost always.
 *
 * **Clamping the selection is not enough, and that was measured rather than
 * assumed**, which is what the plan asked for. A drop carries its own position
 * from `posAtCoords` and dispatches the insertion directly, so it never passes
 * through a selection this module has already moved: dropping text past the end
 * of a CRLF line produced `alpha\rds\nbeta…` in a real browser
 * with the selection clamp in place — the same corruption by a second route.
 *
 * **Expressed as a follow-up rather than by rewriting the transaction.** A
 * rebuilt spec would silently drop annotations, and two of them are load-bearing
 * here: `programmaticChange` and `programmaticSelection` are what stop
 * `rawEdit` and `rawCaretSync` treating the app's own replays as user edits. So
 * the insertion is allowed to land and the `\r` is moved to the far side of
 * it — combined into one transaction before anything is applied, so no observer
 * ever sees the split.
 *
 * Only *pure* insertions are touched. A change that also deletes is a
 * replacement whose range came from a selection already clamped above, and a
 * deletion spanning a line ending is R180's subject rather than this one.
 */
export function crlfInsertionCorrections(
  startDoc: DocumentSlice,
  changes: ChangeSet
): ChangeSpec[] | null {
  const corrections: ChangeSpec[] = []
  changes.iterChanges((fromA, toA, fromB, toB) => {
    if (fromA !== toA) return
    if (!isInsideCrlfPair(startDoc, fromA)) return
    // In the document this transaction produces, the `\r` sits at `fromB - 1`
    // and the inserted text occupies `[fromB, toB)`. Both positions below are in
    // that same document, which is what `sequential` declares.
    corrections.push({ from: fromB - 1, to: fromB, insert: '' })
    corrections.push({ from: toB, insert: '\r' })
  })
  return corrections.length === 0 ? null : corrections
}

/**
 * **Two filters, not one, and the order is the point.**
 *
 * CodeMirror runs transaction filters in sequence, each seeing the transaction
 * the previous one produced. The insertion correction has to run first, because
 * relocating a `\r` moves the positions the selection clamp then judges;
 * clamping first would judge a document that is about to change underneath it.
 *
 * The selection filter reads `newSelection` against `newDoc`, so it catches a
 * selection the transaction set explicitly *and* one merely mapped forward
 * through a change. Every transaction is inspected, which costs two
 * single-character reads per range against a rope; nothing here scans.
 */
export function crlfCaretExtension(): Extension {
  return [
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged) return tr
      const corrections = crlfInsertionCorrections(tr.startState.doc, tr.changes)
      return corrections === null ? tr : [tr, { changes: corrections, sequential: true }]
    }),
    EditorState.transactionFilter.of((tr) => {
      const clamped = clampSelectionOutOfCrlfPairs(tr.newDoc, tr.newSelection)
      if (clamped === null) return tr
      // Appended rather than rebuilt, for the same annotation reason above.
      return [tr, { selection: clamped, sequential: true }]
    })
  ]
}
