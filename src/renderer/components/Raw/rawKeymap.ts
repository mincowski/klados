/**
 * R61/R64 (`R61-keyboard-workflow.md` §4–5): Raw had no CodeMirror
 * keymap at all — `keymap` appeared nowhere in `src/renderer` — so Tab fell
 * through to the browser's own focus traversal (moving to the Scrubber, not
 * indenting) and Enter produced a plain newline with no indent carried
 * over. Both are the same missing keymap, which is why they land together.
 *
 * Split the same way `rawEdit.ts` is: pure, CodeMirror-free helpers
 * (`sniffIndentUnit`, `leadingWhitespace`) that don't need a real
 * `EditorView` to test, plus the `keymap.of([...])` extension itself.
 *
 * **No new dependency.** `indentWithTab`/`insertNewlineAndIndent` live in
 * `@codemirror/commands`, which is not installed (`package.json` has only
 * `@codemirror/state` and `@codemirror/view`) — these are hand-written
 * against `state.changeByRange`, not a reason to add a package for four
 * keys.
 *
 * **The Tab escape hatch is not optional.** Trapping Tab inside an editor
 * with no way out makes the pane a keyboard dead end for anyone who cannot
 * use a mouse. CodeMirror's own documented convention — Escape, then Tab —
 * is what this implements: pressing Escape while Raw has focus arms a
 * one-shot flag; the very next Tab is let through to the browser's normal
 * focus traversal instead of indenting, and the flag clears either way.
 * Checked against `FindBar.tsx`'s own Escape handler before adding this:
 * that one is a React `onKeyDown` on the Find input itself, a different DOM
 * element from CodeMirror's `contentDOM`, so the two can't collide.
 *
 * **Read-only documents get no indenting or auto-indent.** `state.readOnly`
 * is checked at the top of every command here rather than gating whether
 * this extension is included at mount — `document.readOnly` can change
 * after mount (F7's Save As clearing it) without remounting the
 * `EditorView` (R41), so a static extension list decided once at mount
 * would go stale. Returning `false` un-consumes the key, so Tab keeps
 * traversing focus exactly as it does today when there's nothing to indent.
 */
import { ChangeSet, EditorSelection, type StateCommand } from '@codemirror/state'
import { crlfBackspaceRange, crlfDeleteRange, lineBreakAt, type DocumentSlice } from './crlfCaret'
import { keymap, type KeyBinding } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * Scans up to `sampleChars` of `text` for the first indented line and
 * returns what it uses — a tab if the line's leading whitespace starts with
 * one, two spaces otherwise. Deliberately simple (first indented line
 * decides, not a vote across many) — R61's own scope is "keep a
 * tab-indented file tab-indented," not a general indentation-style
 * detector.
 */
export function sniffIndentUnit(text: string, sampleChars = 20000): string {
  const sample = text.length > sampleChars ? text.slice(0, sampleChars) : text
  for (const line of sample.split('\n')) {
    const leading = /^[ \t]/.exec(line)
    if (leading === null) continue
    return line[0] === '\t' ? '\t' : '  '
  }
  return '  '
}

/** The leading run of spaces/tabs on `line`, empty string if none. */
export function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0]
}

/**
 * Tab: insert `unit` at an empty cursor, or replace a selection confined to
 * one line (the conventional "Tab types like a character" case). A
 * selection spanning more than one line indents every line it touches
 * instead, matching every other editor's Tab-to-indent behaviour.
 */
function indentCommand(unit: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const changes = state.changeByRange((range) => {
      const startLine = state.doc.lineAt(range.from)
      const endLine = state.doc.lineAt(range.to)
      if (range.empty || startLine.number === endLine.number) {
        return {
          changes: { from: range.from, to: range.to, insert: unit },
          range: EditorSelection.cursor(range.from + unit.length)
        }
      }
      const perLine = []
      for (let n = startLine.number; n <= endLine.number; n++) {
        perLine.push({ from: state.doc.line(n).from, insert: unit })
      }
      const changeSet = ChangeSet.of(perLine, state.doc.length)
      return {
        changes: perLine,
        range: EditorSelection.range(
          changeSet.mapPos(range.from, -1),
          changeSet.mapPos(range.to, 1)
        )
      }
    })
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.indent' }))
    return true
  }
}

/** Shift+Tab: removes up to one `unit`'s worth of leading whitespace from
 * every line the selection touches (the exact `unit` string if the line
 * starts with it, otherwise whatever leading spaces/tabs are actually
 * there, capped at `unit.length` — dedenting a file that mixes tabs and
 * spaces should never eat into real content). */
function dedentCommand(unit: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const changes = state.changeByRange((range) => {
      const startLine = state.doc.lineAt(range.from)
      const endLine = state.doc.lineAt(range.to)
      const perLine: { from: number; to: number }[] = []
      for (let n = startLine.number; n <= endLine.number; n++) {
        const line = state.doc.line(n)
        const leading = leadingWhitespace(line.text)
        if (leading.length === 0) continue
        const removeLen = line.text.startsWith(unit)
          ? unit.length
          : Math.min(leading.length, unit.length)
        if (removeLen > 0) perLine.push({ from: line.from, to: line.from + removeLen })
      }
      if (perLine.length === 0) return { range }
      const changeSet = ChangeSet.of(perLine, state.doc.length)
      return {
        changes: perLine,
        range: EditorSelection.range(
          changeSet.mapPos(range.from, -1),
          changeSet.mapPos(range.to, 1)
        )
      }
    })
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'delete.dedent' }))
    return true
  }
}

/** Enter: copies the current line's leading whitespace into the new line —
 * format-agnostic (invariant 8), unlike a language-aware indenter, since it
 * never has to know what XML or JSON or TOML is.
 *
 * **R181: the line ending comes from the document, not from a literal.** This
 * built `'\n' + indent`, so every line a user added to a CRLF file got an LF
 * ending and editing a CRLF document steadily converted it to a mixed one — a
 * slower version of the same silent corruption R179 and R180 fix outright.
 *
 * Not `EditorState.lineBreak` either: that follows `lineSeparator`, which R168
 * pins to `\n` deliberately so splitting stays exact on mixed files. The
 * answer has to come from the line being split — see `lineBreakAt`.
 *
 * `leadingWhitespace` matches spaces and tabs only, so a trailing `\r` can
 * never be captured into the indent this copies. Checked rather than assumed,
 * since an indent containing a CR would be a second corruption hiding inside
 * the fix for the first. */
function insertNewlineAndIndentCommand(): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const changes = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from)
      const insert = lineBreakAt(state.doc, range.from) + leadingWhitespace(line.text)
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length)
      }
    })
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

/**
 * R180 — Backspace and Delete cross a whole line ending or none of it.
 *
 * Neither key was bound at all before this, so both were native contentEditable
 * deletion, which works in units: Backspace at the start of a line removed the
 * `\n` and stranded the `\r` inside the joined line (`alpha\rbeta`), and Delete
 * at the visible end of a line removed the `\r` alone and quietly converted that
 * one ending from CRLF to LF. Both survive a save, because invariant 6 writes
 * the buffer back verbatim.
 *
 * **These return `false` for everything else**, which un-consumes the key and
 * leaves native deletion to do its job. That is deliberate: the round's scope is
 * not to reimplement deletion, and a hand-written deleter would have to get
 * grapheme clusters, surrogate pairs and IME state right to break even.
 *
 * **Only a single empty selection is handled.** A range deletion removes what is
 * selected, and R179 has already clamped both its endpoints out of any pair; a
 * multi-range selection is not reachable in this editor today, and handling it
 * here would mean deciding what to do when some ranges match and others do not
 * — which is reimplementing deletion by another name. Both cases fall through.
 */
function deleteAcrossCrlfCommand(
  rangeFor: (doc: DocumentSlice, pos: number) => { from: number; to: number } | null
): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    if (state.selection.ranges.length !== 1) return false
    const range = state.selection.main
    if (!range.empty) return false
    const span = rangeFor(state.doc, range.head)
    if (span === null) return false
    dispatch(
      state.update({
        changes: span,
        selection: EditorSelection.single(span.from),
        scrollIntoView: true,
        userEvent: 'delete'
      })
    )
    return true
  }
}

/**
 * The binding table itself, separated from `keymap.of(...)` so
 * `test/rawKeymap.test.ts` can call each `run` directly against a fake
 * `{state, dispatch}` target — `keymap.of`'s return value is an opaque
 * Facet-backed `Extension`, not something a test can introspect without a
 * real `EditorView`.
 *
 * `getIndentUnit` is read fresh on every Tab/Shift-Tab/Enter, not sniffed
 * once and closed over — the mount effect builds this extension before
 * `sourceBuffer` has necessarily settled, and a getter keeps this in step
 * with `Raw.tsx`'s own live-ref pattern (`storeRef`/`sourceBufferRef`) for
 * everything else that can change after mount without a remount (R41).
 */
export function createRawKeymapBindings(getIndentUnit: () => string): readonly KeyBinding[] {
  let armedFocusEscape = false

  return [
    {
      key: 'Escape',
      run: () => {
        armedFocusEscape = true
        return true
      }
    },
    {
      key: 'Tab',
      run: (view) => {
        if (armedFocusEscape) {
          armedFocusEscape = false
          return false
        }
        return indentCommand(getIndentUnit())(view)
      }
    },
    {
      key: 'Shift-Tab',
      run: (view) => {
        if (armedFocusEscape) {
          armedFocusEscape = false
          return false
        }
        return dedentCommand(getIndentUnit())(view)
      }
    },
    { key: 'Enter', run: insertNewlineAndIndentCommand() },
    // R180: both fall through to native deletion unless the caret is exactly at
    // a whole CRLF, so nothing about ordinary deleting changes.
    { key: 'Backspace', run: deleteAcrossCrlfCommand(crlfBackspaceRange) },
    { key: 'Delete', run: deleteAcrossCrlfCommand(crlfDeleteRange) }
  ]
}

export function rawKeymapExtension(getIndentUnit: () => string): Extension {
  return keymap.of(createRawKeymapBindings(getIndentUnit))
}
