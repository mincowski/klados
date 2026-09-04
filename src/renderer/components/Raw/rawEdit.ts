/**
 * M3-PLAN.md F9 — the Raw View's own edits become `documentSession.applyEdit`
 * calls (F1). §4.4's "every offset crossing the Raw View's boundary is
 * absolute" is the whole shape of this module: CodeMirror reports a change
 * in the *window's* local coordinates; `origin + local` (`origin` read from
 * `getWindowStart()`, below) is the only conversion this file exists to
 * make, mirroring `rawCaretSync.ts`'s own `getWindow().start + local`.
 *
 * **CodeMirror's own positions are UTF-16 code units, not bytes.**
 * `sourceBuffer.slice()` decodes the window's byte range into the JS
 * string CodeMirror actually holds (`core/buffer.ts`), and every position
 * `ChangeSet.iterChanges` reports is an index into *that string* — which
 * only equals a byte offset when everything before it in the window is
 * single-byte-per-character. For any non-ASCII content, or for any
 * document in a UTF-16 source encoding (where every character is 2 bytes
 * but only 1–2 UTF-16 units), local-units-as-bytes silently splices at
 * the wrong byte offset. `localUnitsToByteOffset` (now in `rawOffsets.ts`,
 * alongside its own inverse — every other `Raw/*` module that crosses this
 * same boundary uses that module too, UI-FEEDBACK.md M5b) is the real
 * conversion: re-encode the text *up to* the local position, in the
 * document's own source encoding, and measure how many bytes that took.
 *
 * Split into a CodeMirror-free core (`applyChangesToSession`) and a thin
 * `EditorView.updateListener` wrapper around it — this project has no
 * DOM/browser test environment (every other `Raw/*.ts` module with real
 * logic, `rawWindow.ts`/`wrapPolicy.ts`, is CodeMirror-free for the same
 * reason), so the part worth asserting against (absolute-offset
 * conversion, shift accumulation across multiple changes, refusal
 * handling) needs to not require constructing a real `EditorView` to test.
 *
 * R41 (`R41-raw-editing.md` §5): `onCaretMoved` is called with the
 * edit's own resulting caret offset *before* `session.setCaretOffset` —
 * `Raw.tsx` uses it to mark that offset as "already applied" so the
 * `caretOffset` prop change this triggers (via `activeSession`'s snapshot)
 * doesn't read as an external jump and scroll the pane out from under the
 * person still typing in it (§3's "a selection change the user caused by
 * typing must not scroll the pane they are typing in").
 */
import { Annotation, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { DocumentSession } from '../../session/documentSession'
import { buildOffsetMap } from './rawOffsetMap'

export { localUnitsToByteOffset } from './rawOffsets'

/**
 * Tags a dispatch as Raw's own window management (`applyReslice`'s re-slice
 * of the CodeMirror buffer to a shifted absolute range) rather than a real
 * user edit — without this, every scroll-triggered re-centre would be
 * read back as if the user had retyped up to ~1 MB of text, both wrongly
 * calling `applyEdit` and corrupting the document with a no-op-but-massive
 * patch. Same shape as `rawCaretSync.ts`'s own `programmaticSelection`.
 */
export const programmaticChange = Annotation.define<true>()

/** One CodeMirror `ChangeSet` entry, in the shape `iterChanges` hands out —
 * `fromA`/`toA` are **UTF-16 code-unit** offsets into the *pre-change*
 * window document, not bytes (see this module's own top comment). */
export interface RawChange {
  readonly fromA: number
  readonly toA: number
  readonly inserted: string
}

export type ApplyChangesResult =
  | { readonly ok: true; readonly netByteDelta: number }
  | { readonly ok: false; readonly message: string }

/**
 * Replays `changes` against `session.applyEdit` in order, each one's
 * absolute BYTE range computed from `priorText` (the whole pre-transaction
 * window text — `localUnitsToByteOffset` needs the text *before* the
 * change's own position to measure correctly) via `localUnitsToByteOffset`,
 * plus the cumulative BYTE shift of every change before it in the same
 * transaction. CodeMirror itself guarantees `changes` don't overlap and
 * are given in document order, which is what makes computing each one's
 * byte offset against the same fixed `priorText` baseline (rather than a
 * moving one) correct — only the *shift added on top* needs to account for
 * earlier changes, not the conversion itself.
 *
 * Stops at the first refusal — `createEdit`'s own reasons
 * (`documentEdits.ts`: read-only, a BOM boundary, an encoding with no
 * encoder) — and reports it rather than attempting the remaining changes
 * against a buffer some of the transaction's edits may already have
 * altered.
 */
export function applyChangesToSession(
  session: Pick<DocumentSession, 'applyEdit'>,
  origin: number,
  priorText: string,
  encoding: string,
  changes: readonly RawChange[]
): ApplyChangesResult {
  // Built once per transaction, not once per change (J1) — a throwaway map
  // rather than the live window's cached one, since this measures against
  // `priorText`, the text *before* the transaction, which the live map no
  // longer reflects once the dispatch that carries these changes lands.
  const map = buildOffsetMap(priorText, encoding)
  let shift = 0
  for (const change of changes) {
    const fromBytes = map.toBytes(change.fromA)
    const toBytes = map.toBytes(change.toA)
    const outcome = session.applyEdit({
      start: origin + fromBytes + shift,
      end: origin + toBytes + shift,
      text: change.inserted
    })
    if (!outcome.ok) return { ok: false, message: outcome.message }
    shift += outcome.patch.replacement.length - (toBytes - fromBytes)
  }
  return { ok: true, netByteDelta: shift }
}

/**
 * `EditorView.updateListener` reacting to `update.docChanged` — the doc-
 * change listener this component never had before F9, since editing was a
 * hard no-op (`EditorState.readOnly.of(true)`, unconditional).
 *
 * `getWindowStart` is read once per changed *transaction*, not once per
 * changed *range* within it — a single transaction never re-slices the
 * window (only `applyReslice`, tagged `programmaticChange`, does that), so
 * the window's start is stable across every change visited in one call.
 * `update.startState.doc.toString()` — the pre-transaction window text —
 * is materialized once per transaction for `localUnitsToByteOffset`'s own
 * re-encoding; bounded by the window size (~1 MB, `rawWindow.ts`'s own
 * `WINDOW_BYTES`), never the full document, so this doesn't reach for
 * invariant 1's actual concern (the *document*, up to 500 MB, never
 * becomes a JS string here — only the window CodeMirror already holds as
 * one). Re-encoding a ~1 MB prefix on every keystroke is real, measurable
 * work this doesn't try to avoid — a future optimization (incremental
 * unit↔byte tracking instead of re-deriving it per edit) is a performance
 * question for F10's own measurement pass, not a correctness one this
 * task needs to solve.
 *
 * **Known limitation, not a silent gap**: a transaction with more than one
 * change (multi-cursor editing — not enabled anywhere in this app today,
 * `EditorState.allowMultipleSelections` is never set) can have a later
 * change refused after an earlier one in the *same* transaction already
 * succeeded. This reverts the *view* back to the transaction's starting
 * document (`ChangeSet.invert`) but has no way to un-apply the earlier
 * change that already landed in the live document session — the view and
 * the session would disagree until the next successful edit or reparse.
 * Single-cursor typing, paste and cut (the only input this app currently
 * produces) is always exactly one change per transaction, so this is
 * unreachable in practice today; flagged rather than engineered around,
 * since fixing it for real needs a transactional multi-patch `applyEdit`
 * this task's scope doesn't cover.
 */
export function rawEditExtension(
  session: Pick<DocumentSession, 'applyEdit' | 'setCaretOffset'>,
  getEncoding: () => string,
  getWindowStart: () => number,
  onApplied: (netByteDelta: number) => void,
  onCaretMoved: (offset: number) => void,
  onRefused: (message: string) => void
): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    if (update.transactions.some((tr) => tr.annotation(programmaticChange) === true)) return

    const origin = getWindowStart()
    const encoding = getEncoding()
    const priorText = update.startState.doc.toString()
    const changes: RawChange[] = []
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ fromA, toA, inserted: inserted.toString() })
    })

    const result = applyChangesToSession(session, origin, priorText, encoding, changes)
    if (!result.ok) {
      update.view.dispatch({
        changes: update.changes.invert(update.startState.doc),
        annotations: programmaticChange.of(true)
      })
      onRefused(result.message)
      return
    }
    if (result.netByteDelta !== 0) onApplied(result.netByteDelta)

    // F5's reparse cascade and F6's undo-entry selection recording both
    // read `documentSession`'s own `caretOffset` — without this, it stays
    // frozen at wherever it was before the user started typing, which was
    // harmless while editing was a no-op and is actively wrong now that
    // it isn't (a stale cascade target, a stale undo-restore position).
    // `update.state` (post-transaction), not `update.startState`, is what
    // the caret's own position is measured against here.
    const postText = update.state.doc.toString()
    const caretUnits = update.state.selection.main.head
    const caretBytes = buildOffsetMap(postText, encoding).toBytes(caretUnits)
    const caretOffset = origin + caretBytes
    onCaretMoved(caretOffset)
    session.setCaretOffset(caretOffset)
  })
}
