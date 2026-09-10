/**
 * The document session (M1-PLAN.md D6, CONCEPT.md §4/§11): the seam
 * between the parsed data layer and the UI. Holds the parsed document
 * (`SourceBuffer`, `NodeStore`, row index, diagnostics, encoding) plus the
 * `{ selectedNode, caretOffset }` state every view is meant to be both a
 * producer and a consumer of (§4).
 *
 * `createDocumentSession` is a **factory**, not a module-level singleton —
 * D6's own instruction is to build this so more than one can exist later
 * (§11.4's tabs, post-M1) even though M1 creates exactly one (see
 * `activeSession.ts`). Nothing in here assumes it is the only instance:
 * no shared mutable state outside the closure a given call creates.
 */
import {
  parseFromUrlInWorker,
  parseInWorker,
  readTokenUrl,
  type ParseClientOptions,
  type ParseClientResult
} from '../../core/parseClient'
import { Severity, type Diagnostic, type NodeRef, type Offset } from '../../core/types'
import type { NodeStore } from '../../core/nodeStore'
import { EMPTY_DELTA_LIST, recordDelta, type DeltaList } from '../../core/deltaList'
import { buildNameIndex, type NameIndex } from '../../core/nameIndex'
import { SourceBuffer } from '../../core/buffer'
import {
  buildLineIndex,
  DEFAULT_MAX_ROW_BYTES,
  incrementalRowIndex,
  type LineIndex
} from '../../core/rowIndex'
import { getFormatModule } from '../../formats/registry'
import { DEFAULT_MAX_DEPTH } from '../../core/parseDefaults'
import type { DocumentStat, KladosApi } from '../../preload/api'
import { clearPendingReveal, requestReveal } from '../components/Tree/treeController'
import { pathSegmentsOf } from '../components/Detail/detailModel'
import { kindLabelOf } from '../nodeDisplay'
import { resolveWrapperTarget } from '../wrapperDescent'
import { reresolveSelection, resolveFromPath } from '../navigation/reresolve'
import { getKladosApi } from '../preloadApi'
import { recordRecentFile, removeRecentFile } from './recentFiles'
import { setContext } from '../commands/context'
import {
  applyPatch,
  applyPatchesAscending,
  createEdit,
  encodeForRoundTrip,
  estimateReplaceAllUndoBytes,
  rebaseSequentialPatches,
  type EditOutcome,
  type EditRequest,
  type Patch
} from './documentEdits'
import { canEncode, findUnrepresentableCharacter } from '../../core/textEncode'
import { createDebouncedReparse, REPARSE_DEBOUNCE_MS } from './reparse'
import { saveDocument, type SaveOutcome } from './save'
import { beginSpliceSubtree } from './subtreeSplice'
import { JobSlot, type SearchJob } from './searchJob'
import { transformInWorker, type TransformClientOptions } from '../../core/transformClient'
import { getFormatMinifiedOnOpen, getTotalMemoryBudgetBytes } from '../settings'
import { isPathologicallyMinified } from './minifiedDetection'
import {
  canRedo,
  canUndo,
  computeUndoStats,
  EMPTY_UNDO_STACK,
  inversePatchOf,
  pushEntry,
  recordedSelectionOf,
  redoStep,
  undoStep,
  type RecordedSelection,
  type UndoEntry,
  type UndoStackState
} from './undoStack'

/** F7's `saveAs`, distinct from plain `save`: the native dialog can be
 * cancelled, which is not a failure but also isn't "wrote a file" — a
 * caller (F9's UI) that only checked `outcome.ok` before showing a
 * "Saved" confirmation would show one for a cancelled dialog too. */
export type SaveAsOutcome = SaveOutcome | { readonly ok: true; readonly cancelled: true }

/**
 * R169 — what a reload from disk resolves to.
 *
 * `cancelled` is a third outcome rather than a failure, and the distinction
 * is load-bearing: a reload superseded by "Keep Mine" or by a newer reload
 * did exactly what it was told, and reporting it as an error would put a red
 * banner in front of a user who just chose to keep their own edits. Only a
 * genuine failure — the file is gone, the read was refused, the parse threw —
 * carries a message worth showing.
 */
export type ReloadOutcome =
  | { readonly ok: true; readonly cancelled?: false }
  | { readonly ok: true; readonly cancelled: true }
  | { readonly ok: false; readonly message: string }

/** R90 (`R86-find-as-query-surface.md` §6) — Replace All's own byte span,
 * `{ start, end }` rather than a full `SearchResult` (`starts`/`ends`
 * arrays): the caller (`FindBar`) already has both as parallel arrays from
 * `activeSearchStore`; zipping them into one object per match here is what
 * lets `applyReplaceAll` express "sort these, splice these" without a
 * second parallel-array convention just for this one operation. */
export interface ReplaceMatch {
  readonly start: number
  readonly end: number
}

export type ReplaceRefusal =
  | { readonly kind: 'not-ready' }
  | { readonly kind: 'read-only' }
  /** See `documentEdits.ts`'s `EditRefusal` — the document's own encoding
   * can never be written (a genuinely multi-byte non-UTF encoding), the
   * same gate `createEdit` already applies to ordinary typing. */
  | { readonly kind: 'unsupported-encoding'; readonly encoding: string }
  /** The encoding is fine; the replacement text has a character it can't
   * represent. See `documentEdits.ts`'s `EditRefusal` (R125, §3). */
  | {
      readonly kind: 'unrepresentable-character'
      readonly encoding: string
      readonly character: string
    }

export interface ReplaceSuccess {
  readonly ok: true
  readonly replacedCount: number
  /** `false` when the entry was dropped because it would have exceeded
   * the undo memory budget — the replace still ran (it is not itself
   * gated on this), it just is not undoable. The caller is expected to
   * have already told the user this *could* happen, via
   * `estimateReplaceAllUndoBytes` (`documentEdits.ts`), before ever
   * calling this — §11.2's "before the user commits, not afterwards." */
  readonly undoable: boolean
}

export interface ReplaceFailure {
  readonly ok: false
  readonly reason: ReplaceRefusal
  readonly message: string
}

export type ReplaceOutcome = ReplaceSuccess | ReplaceFailure

/** §11.2: confirmation past this, never a refusal. */
const SOFT_CAP_BYTES = 500 * 1024 * 1024
/** §11.2: refused outright — spans are `Int32Array` (`core/types.ts`'s
 * `Offset`), so byte offsets cannot address past this, a structural limit
 * rather than a policy choice. */
const HARD_CEILING_BYTES = 2_147_483_647
/** §8's measured rule of thumb for total memory footprint vs. file size. */
const ESTIMATED_MEMORY_MULTIPLIER = 2.5

/**
 * M5-PLAN.md H7 (§11.2's soft-cap shape). At or above this, `requestTransform`
 * asks first instead of running immediately — and, per D-046, a *confirmed*
 * Transform at this size does not push an undo entry either. Both live on
 * the same threshold rather than two: a whole-buffer undo entry costs
 * roughly 2x the document's own bytes (`Patch.replacement` holds the new
 * content, its inverse holds the old — `undoStack.ts`'s own doc comment on
 * why entries hold patches, not snapshots, still applies per-entry), so the
 * size past which asking first is warranted is the same size past which
 * affording that entry stops being reasonable.
 */
const TRANSFORM_CONFIRM_BYTES = 50 * 1024 * 1024

/**
 * `selectedNode` when there is nothing to select — a document that parsed
 * to zero nodes, which is what a file refused at offset 0 produces (an
 * unsupported encoding, per the worker's `klados.encoding.unsupported`).
 *
 * Not `0`: node 0 is the Document node in every non-empty store, so
 * defaulting to it silently hands consumers a ref that does not exist.
 * Walking links from one is not a harmless no-op — see `NodeStore.
 * childrenOf`'s own note on what it used to do with an out-of-range ref.
 * `hasSelection` (§7) is the context key that tracks this, so a command's
 * `when` can gate on it rather than every consumer range-checking.
 */
export const NO_SELECTION = -1

export interface OpenDocument {
  readonly filePath: string
  readonly fileName: string
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly rowIndex: Int32Array
  readonly lineIndex: LineIndex
  /** M4-PLAN.md G1. Rebuilt wholesale on every reparse (full or spliced) at
   * the same commit point `store` itself changes (`applyReparseResult`) —
   * never patched incrementally, so it can never be read against a `store`
   * it no longer describes. See `M4-RESULTS.md` for why rebuild was
   * chosen over patching a splice's ref shift in place. */
  readonly nameIndex: NameIndex
  readonly diagnostics: readonly Diagnostic[]
  /** False for a partial tree (§11.1) — cancelled, or halted by a Fatal diagnostic. */
  readonly complete: boolean
  readonly formatId: string
  readonly encoding: string
  readonly readOnly: boolean
  /** Best-effort marker for an incomplete parse — see `deriveErrorInfo`. Null when `complete`. */
  readonly errorNode: NodeRef | null
  /** The byte offset the Raw View should open at once it exists (D10) — §11.1's
   * "open the Raw View at the error position". Null when `complete`. */
  readonly errorOffset: Offset | null
  /** M3-PLAN.md F3, §5.1/§11.1's "last known-good tree" applied mid-edit: a
   * debounced reparse that comes back incomplete, when the document was
   * complete before it, does not replace `store`/etc — the message here is
   * the only visible trace that the *live* buffer currently has a parse
   * error, while the Tree/Detail keep showing the last tree that didn't.
   * Null whenever there is nothing pending — including the ordinary
   * "opened already broken" case (§11.1), which has its own fallback via
   * `errorNode`/`errorOffset` and needs no separate flag. */
  readonly pendingParseError: string | null
  /** M3-PLAN.md F7's dirty indicator — `true` from the first successful
   * `applyEdit`/`undo`/`redo` after open (or after the last successful
   * `save`) until the next successful `save`. Deliberately coarse: undoing
   * back to the exact byte sequence on disk without an intervening save
   * still reads as dirty rather than comparing buffers on every undo to
   * detect it — "always safe, not always minimal" (`nodeSpanLookup.ts`'s
   * own phrase for the same kind of tradeoff), and cheap regardless of
   * document size, which a byte comparison on a 200 MB buffer would not be. */
  readonly dirty: boolean
  /** M5-PLAN.md H8/H9 review finding: `sourceBuffer` is replaced by
   * `applyEdit`/`applyUndoEntry`/`applyTransform` well before the reparse
   * they each trigger actually lands — `applyEdit`'s own doc comment
   * already flags this window ("`document.store`/`rowIndex`/`lineIndex`
   * are the *previous* parse's — genuinely stale"). H8's minified-banner
   * heuristic and H9's memory budget both read `rowIndex`/`store` figures
   * that can therefore describe a *different* buffer than
   * `sourceBuffer` itself during that window — this flag is what lets a
   * consumer tell. `true` from the moment `sourceBuffer` changes until
   * `applyReparseResult` commits a store built from it; `false` at open
   * and whenever nothing is pending. */
  readonly reparsePending: boolean
  /** M5-PLAN.md H7/H8 review finding: `true` for the whole duration of a
   * Format/Minify worker round trip, including the part *before*
   * `sourceBuffer` is replaced (`reparsePending` alone only covers
   * *after* the swap). Set the moment `applyTransform` starts, cleared
   * on every exit path. Exists so H8's minified-banner check can be
   * suppressed for an auto-triggered Transform's *entire* run, not just
   * its post-swap tail — otherwise the banner could still flash while
   * the worker is still formatting the very document it would offer to
   * format. */
  readonly transformInProgress: boolean
  /** M3-PLAN.md F8 (§11.3): an external change to this file landed on disk
   * while there are unsaved edits, so it was *not* auto-reloaded — the
   * pending choice between "Reload and discard" (`reloadAndDiscard`) and
   * "Keep mine" (`keepMine`). Always `false` when `dirty` is `false`: a
   * clean document reloads silently the moment the change is detected,
   * never sets this. */
  readonly externalChangeDetected: boolean
  /** R169 (`docs/plans/R169-external-change-reload.md`): a reload from disk
   * is in flight right now.
   *
   * **The state that did not exist, and whose absence was the whole
   * defect.** `reloadFromDisk` never leaves `phase: 'ready'` — it aborts the
   * in-flight work, awaits a read and a parse, and swaps the document in one
   * `setState` at the end — so between the click and the parse completing
   * there was nothing on screen that had changed: no phase transition, no
   * indicator, and the banner still sitting there because it is derived from
   * `externalChangeDetected`, which only clears when the reload commits.
   * Every visible signal said nothing had happened, which reads as a dead
   * button.
   *
   * Deliberately a flag rather than a phase. A phase would make
   * `DocumentArea.tsx` swap the document out for the "Opening…" view it
   * renders for `parsing`, unmounting and remounting every pane — the caret
   * and scroll loss R41 exists to prevent, plus a full-view flash on a
   * reload that usually takes a few milliseconds. A reload keeps its
   * document on screen; only the acknowledgement is new. */
  readonly reloadPending: boolean
  /** M5-PLAN.md H7 (§11.2's soft-cap shape): a Format/Minify request on a
   * document at or above `TRANSFORM_CONFIRM_BYTES`, waiting on
   * `confirmTransformAnyway`/`cancelTransform` rather than running
   * immediately — the same "confirmation with a number in it, never a
   * refusal" pattern `confirmSize`/grid export already use. `null` when
   * nothing is pending, including the common case (a document under the
   * threshold runs immediately and never sets this at all). */
  readonly pendingTransform: {
    readonly kind: TransformKind
    readonly estimatedBytes: number
  } | null
  /** M5-PLAN.md H8: "Dismissing is remembered for the session." Reset to
   * `false` on every open — a *different* pathologically-minified document
   * gets its own offer, not a dismissal carried over from an unrelated
   * file. Whether the banner is currently shown at all is computed from
   * `rowIndex`/`sourceBuffer` (`minifiedDetection.ts`), not stored here —
   * this field only ever means "the user already said no to it." */
  readonly minifiedBannerDismissed: boolean
  /** M5g-PLAN.md O1: set when the last Format/Minify request produced output
   * byte-identical to its input — the whole pipeline (buffer swap, reparse,
   * undo entry, dirty flag) is skipped in that case, so this is the only
   * visible trace that the request ran at all. Cleared at the start of the
   * next Transform and on open; nothing else clears it, since nothing else
   * makes it stale. */
  readonly lastTransformWasNoOp: boolean
  /** M5f-PLAN.md §3a: the undo stack's own footprint, kept as fields here
   * rather than handing `computeMemoryBudget` the stack to walk on every
   * render — the stack lives in this closure, not on `OpenDocument`, and
   * `computeMemoryBudget(document)` being O(1) (every other field a plain
   * `.byteLength` read) is what makes recomputing it on every render
   * acceptable. Recomputed by `syncUndoContext`, which already runs at
   * exactly the points the stack changes. See `computeUndoStats`
   * (`undoStack.ts`) for what's counted and why. */
  readonly undoBytes: number
  readonly undoEntryCount: number
  /** R42/D-070 (`R42-stale-spans.md`): the union of every edit's own
   * shift since `store` was last built, in *`store`'s own* coordinates —
   * `core/deltaList.ts`'s `shiftedOffset` is what a view calls to translate
   * one of `store`'s spans into the live `sourceBuffer`'s coordinates
   * before decoding text from it, closing the window `applyEdit`'s own doc
   * comment used to flag as "flagged, not fixed." `EMPTY_DELTA_LIST`
   * whenever `store` and `sourceBuffer` already agree (the overwhelming
   * common case) — every consumer already takes the `deltas.length === 0`
   * fast path (`spanTranslation.ts`), so this costs nothing when there is
   * nothing to translate. Scoped to node spans only: the row/line index has
   * its own shifting hazard (`deltaList.ts`'s own doc comment on `fold`
   * being unable to add or remove entries for a row-count-changing edit)
   * that this field does not attempt to solve — nothing reads it against
   * either index. */
  readonly pendingSpanDeltas: DeltaList
  /** R100 (`R100-raw-external-rewrite.md`): incremented whenever
   * `sourceBuffer` is replaced by something *other than* an edit
   * originating in the Raw editor. `Raw.tsx`'s live-update effect cannot
   * otherwise distinguish "the user typed this" (the view already has it)
   * from "Replace/Format/Undo/Reload rewrote it" (the view has never seen
   * it) — only the latter needs a full reslice of the CodeMirror window.
   * Four call sites increment this: `applyReplaceAll`, `applyTransform`,
   * `applyUndoEntry` (covers both undo and redo), `reloadFromDisk`. Not
   * `applyEdit`, which is the Raw editor's own path and the one case
   * where the view is already correct. */
  readonly externalRewrites: number
}

/** M5-PLAN.md H5/H7 — Format Document (pretty-print) or Minify Document.
 * The same underlying `FormatModule.format` call; `applyTransform`'s own
 * `indent === ''` convention (H5) is what actually selects minify, kept
 * out of this public type so callers name the operation, not the
 * encoding trick behind it. */
export type TransformKind = 'format' | 'minify'

export interface SelectionState {
  readonly selectedNode: NodeRef
  readonly caretOffset: number
}

export type DocumentSessionState =
  | { readonly phase: 'empty' }
  | {
      readonly phase: 'confirmSize'
      readonly fileName: string
      readonly fileBytes: number
      readonly estimatedBytes: number
      /** R28 (`R24-tabs.md` §6): `'size'` is the existing per-file
       * `SOFT_CAP_BYTES` confirm; `'budget'` is this file's own estimate
       * pushing the *cross-tab* total past `getTotalMemoryBudgetBytes()` —
       * `totalEstimatedBytes` (this file plus every other open tab) is only
       * meaningful for the latter, and `null` for the former. */
      readonly reason: 'size' | 'budget'
      readonly totalEstimatedBytes: number | null
    }
  | {
      readonly phase: 'parsing'
      readonly fileName: string
      readonly bytesConsumed: number
      readonly totalBytes: number
    }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly document: OpenDocument; readonly selection: SelectionState }

export interface DocumentSession {
  getSnapshot(): DocumentSessionState
  subscribe(listener: () => void): () => void
  /** Shows the native Open dialog; opens whatever the user picks. Resolves
   * once settled — cancelling the dialog resolves with no state change. */
  openFileDialog(): Promise<void>
  /** Opens a specific path directly, bypassing the dialog — the soft/hard
   * size checks still apply. Used by the dialog path, `Layout.tsx`'s
   * drag-drop handler, and tests. */
  openPath(path: string): Promise<void>
  /** Proceeds past a pending soft-cap confirmation. No-op unless the
   * current phase is `'confirmSize'`. */
  confirmOpenAnyway(): void
  /** Cancels an in-progress parse, or dismisses a pending size confirmation. */
  cancel(): void
  /** M5e-PLAN.md R8f: moves the caret to `node`'s span start alongside the
   * selection by default, so Raw's scroll-to-caret effect actually fires —
   * every view is meant to be both a source and a consumer of
   * `{ selectedNode, caretOffset }` together, not just the former. Pass
   * `{ moveCaret: false }` when the selection change *is itself* driven by
   * a caret move (`rawCaretSync`) — moving the caret back to where it
   * already is would fight the person typing. */
  setSelectedNode(node: NodeRef, options?: { readonly moveCaret?: boolean }): void
  setCaretOffset(offset: number): void
  /** F1 (M3-PLAN.md): the mutation primitive. Encodes `text`, splices it
   * into the byte buffer via `documentEdits.ts`, and — on success — replaces
   * `document.sourceBuffer` with the result. Everything downstream of the
   * buffer (`store`, `rowIndex`, `lineIndex`, `diagnostics`) is left exactly
   * as it was — that reconciliation happens asynchronously, debounced
   * ~200ms after the last edit (F3), not synchronously inside this call.
   * A caller reading `document` immediately after `applyEdit` returns will
   * see the tree/spans still disagree with the buffer it just edited;
   * expected until the debounced reparse lands, not a bug in `applyEdit`
   * itself. */
  applyEdit(request: EditRequest): EditOutcome
  /** R90 (`R86-find-as-query-surface.md` §6): replaces every span in
   * `matches` with `replacementText`, as one undo entry applied back to
   * front (descending by `start`, so an earlier splice's offset shift
   * never invalidates a later-processed patch — every patch's own
   * coordinates stay the original match offsets throughout). Refuses on
   * no document, a read-only document, or an encoding `applyEdit` would
   * also refuse (§5.5's UTF-8/UTF-16-only gate). Never refuses on *size*
   * — the confirm-above-50,000-matches gate (§11.2) is the caller's own
   * job, before this is ever called, the same split `requestTransform`/
   * `confirmTransformAnyway` makes for Format. Always runs once called; the
   * one size-driven decision made *inside* this call is whether the
   * resulting entry gets pushed onto the undo stack at all (`undoable` on
   * the outcome) — dropped rather than refused, mirroring `applyTransform`'s
   * own 50 MB skip, except the caller is expected to have already warned
   * about this via `estimateReplaceAllUndoBytes` (`documentEdits.ts`)
   * before the confirmation was even shown. A no-op success
   * (`replacedCount: 0`) for an empty `matches`. */
  applyReplaceAll(matches: readonly ReplaceMatch[], replacementText: string): ReplaceOutcome
  /** F7: writes the live buffer to its current path, verbatim
   * (`save.ts`'s own doc comment on why nothing needs transforming first).
   * Refuses with no document open or on a read-only document. Clears the
   * dirty flag on success. */
  save(): Promise<SaveOutcome>
  /** F7: prompts for a new path via the native Save As dialog, then writes
   * there — allowed even for a read-only document, since it never
   * overwrites the original file; success also clears the document's
   * `readOnly` flag, since a location the user just chose to save into is
   * one they can presumably keep editing. Resolves `{ ok: true, cancelled:
   * true }` with no write performed if the dialog is cancelled — distinct
   * from an actual save so a caller can't mistake one for the other. */
  saveAs(): Promise<SaveAsOutcome>
  /** F8 (M3-PLAN.md, §11.3): reloads the current file from disk, discarding
   * any unsaved edits — the explicit choice offered when `document.
   * externalChangeDetected` is set (a change landed while there were
   * unsaved edits, so it wasn't auto-reloaded). Also what a clean
   * document's *silent* auto-reload calls internally; no separate
   * mechanism. Restores selection via F5's cascade.
   *
   * **R169: resolves with an outcome rather than `void`.** It used to
   * resolve `void` and every failure path returned early and silently, so a
   * reload of a file that had since been deleted left the banner up with no
   * explanation — the same "looks dead" symptom as the missing indicator,
   * from a genuinely different cause. The caller surfaces it; this module
   * stays free of the notification store, exactly as `save` does. */
  reloadAndDiscard(): Promise<ReloadOutcome>
  /** F8: dismisses a pending external-change notice without reloading —
   * "Keep mine." A no-op if nothing is pending.
   *
   * **R169: also cancels a reload that is already in flight.** It used to
   * clear the flag alone, so a user who clicked Reload, saw nothing happen,
   * and clicked Keep Mine to back out still lost their edits when the reload
   * landed moments later — the banner offered two outcomes and the first one
   * was not revocable. Reproduced before it was fixed. */
  keepMine(): void
  /** F6 (M3-PLAN.md): undoes the most recent undo entry (a whole coalesced
   * burst, not one keystroke) — a no-op with nothing to undo, no document
   * open, or a read-only document. Flushes any in-flight burst first, so a
   * still-debouncing edit isn't lost. Reparses immediately rather than
   * waiting out the debounce: undo is a discrete, deliberate action with
   * nothing to amortize the wait against. */
  undo(): void
  /** F6: the inverse of `undo` — reapplies the entry `undo` just reversed.
   * Same flush-first, immediate-reparse behavior. */
  redo(): void
  /** M5-PLAN.md H5/H7: Format Document or Minify Document. No-op with no
   * document, a read-only document, or a format whose
   * `capabilities.canFormat` is false. Below `TRANSFORM_CONFIRM_BYTES`,
   * runs immediately and pushes exactly one undo entry (§5.6's hard
   * rule). At or above it, sets `document.pendingTransform` instead of
   * running — see `confirmTransformAnyway`/`cancelTransform`. */
  requestTransform(kind: TransformKind): void
  /** H7: proceeds past a pending transform confirmation. No-op unless one
   * is pending. A confirmed Transform at this size does not push an undo
   * entry — see `applyTransform`'s own doc comment for why, and D-046 for
   * the policy this implements. */
  confirmTransformAnyway(): void
  /** H7: dismisses a pending transform confirmation without running it. */
  cancelTransform(): void
  /** H8: dismisses the minified-file offer banner for the rest of this
   * session, without running Format. A no-op with no document open. */
  dismissMinifiedBanner(): void
  /** M5f-PLAN.md §3a: frees the undo stack — not destructive to the
   * document, only to reversibility, so unlike most palette actions this
   * needs no confirmation. On a large file it is the one component of the
   * memory total the user can actually reclaim, which is why the
   * statistics panel is what surfaces the number this acts on. Re-runs
   * `syncUndoContext` so `canUndo`/`canRedo` (and the panel's own figure)
   * update immediately. A no-op with no document open. */
  clearUndoHistory(): void
  /** R24-tabs.md: forces every context key this session owns (`format`,
   * `canFormat`, `isReadOnly`, `hasSelection`, `hasDiagnostics`, `isDirty`,
   * `hasExternalChange`, `hasPendingTransform`, `nodeKind`, `canUndo`,
   * `canRedo`) to be rewritten from this session's own current state.
   * `commands/context` is a projection of the *active* tab (§1's table),
   * not per-tab storage — a background tab's internal `setState` calls are
   * gated off (`DocumentSessionDeps.isActive`) so they can't clobber the
   * context another tab's panes are reading, which means the moment a tab
   * *becomes* active its own view of context is stale until this runs.
   * `tabs.ts` calls this exactly once, right after switching. */
  resyncContext(): void
  /** R24-tabs.md: releases this session's one standing external resource
   * — the `document:watch`/`onExternalChange` IPC subscription — so a
   * closed tab's session can actually be garbage collected and can't fire
   * a stale `handleExternalChange` against a document nothing displays
   * anymore. `tabs.ts`'s `closeTab` calls this; nothing else needs to. */
  dispose(): void
}

export interface DocumentSessionDeps {
  /** Overrides `window.api`'s `document` namespace — tests inject a fake;
   * production uses the real one. Narrowed to just what this module needs,
   * so a test double doesn't have to stub `keybindings` too. */
  readonly api?: Pick<KladosApi, 'document'>
  /** R24-tabs.md: whether this session is the *active* tab right now —
   * `commands/context` is written only while true (`setCtx`, below).
   * Defaults to always-active, which is what every existing direct
   * `createDocumentSession()` call (every test, and M1's own single-session
   * world before tabs) still gets — this dependency exists for `tabs.ts`
   * to inject, not for call sites to reason about. */
  readonly isActive?: () => boolean
  /** Overrides `parseInWorker` — tests inject a fake backed by `runParseJob`
   * directly, since there is no real `Worker` under Vitest. Used only for
   * a full reparse of the live, in-memory (already-edited) buffer — never
   * for the initial open or a reload, which go through `parseFromUrl`
   * below (M5-PLAN.md H12: there is no on-disk file to re-read for an
   * in-memory reparse, so this stays bytes-in, bytes-already-in-hand). */
  readonly parse?: (bytes: ArrayBuffer, options: ParseClientOptions) => Promise<ParseClientResult>
  /** Overrides `parseFromUrlInWorker` — M5-PLAN.md H12's read-from-disk
   * route (mint a token, worker fetches over the token-scoped protocol).
   * Tests inject a fake that ignores the URL's real shape (there is no
   * real protocol handler under Vitest) and resolves however the test
   * wants that "read" to come back. */
  readonly parseFromUrl?: (url: string, options: ParseClientOptions) => Promise<ParseClientResult>
  /** Overrides F3's `REPARSE_DEBOUNCE_MS` — a real 200ms wait per test adds
   * up fast, and mixing `vi.useFakeTimers()` with the real `Promise`-based
   * parse pipeline is more fragile than just injecting a near-zero delay.
   * `reparse.ts`'s own tests already cover the debounce timing itself in
   * isolation; this lets `documentSession.test.ts` exercise what actually
   * happens once a reparse runs, quickly and deterministically. */
  readonly reparseDelayMs?: number
  /** Overrides F6's undo-burst coalescing debounce — defaults to
   * `REPARSE_DEBOUNCE_MS` (§5.6's own "same debounce as reparse"), same
   * reason `reparseDelayMs` exists: a real 200ms wait per test adds up. */
  readonly undoDelayMs?: number
  /** Overrides F6's bounded undo-stack depth — defaults to
   * `DEFAULT_UNDO_MAX_DEPTH`. Lets a test exercise the overflow-drops-the-
   * oldest-entry behavior without pushing hundreds of entries first. */
  readonly undoMaxDepth?: number
  /** Overrides `transformInWorker` — tests inject a fake, same reason
   * `parse` is overridable (no real `Worker` under Vitest). */
  readonly transform?: (
    bytes: ArrayBuffer,
    options: TransformClientOptions
  ) => Promise<ArrayBuffer | null>
  /** Overrides H7's `TRANSFORM_CONFIRM_BYTES` — a real 50 MB buffer per
   * test exercising the soft-cap path would be needlessly slow; this lets
   * `documentSession.test.ts` reach it with a tiny fixture instead. */
  readonly transformConfirmBytes?: number
  /** R28 (`R24-tabs.md` §6): the estimated memory footprint of every
   * *other* open tab, summed — `tabs.ts` injects the real cross-tab total
   * (`getCrossTabMemoryBytes`, excluding this tab's own session); defaults
   * to `() => 0` for every direct `createDocumentSession()` call (every
   * test, and any single-session use), the same "this dependency exists
   * for `tabs.ts` to inject, not for call sites to reason about" as
   * `isActive`. */
  readonly estimateOtherTabsBytes?: () => number
  /** Overrides `settings.ts`'s `getTotalMemoryBudgetBytes()` — lets a test
   * reach the cross-tab confirm path with a tiny budget instead of a real
   * multi-gigabyte one. */
  readonly totalMemoryBudgetBytes?: number
  /** R52 (`R51-main-process.md`): the identity this session's
   * `document:watch`/`document:unwatch`/`onExternalChange` calls use — main
   * now keys watch registrations per tab rather than replacing one
   * module-level watcher, so a stable, session-unique key is what lets a
   * background tab's own external-change notification reach only its own
   * session. `tabs.ts` injects the real `TabId`; defaults to an
   * auto-generated key for every direct `createDocumentSession()` call
   * (every test, and any single-session use) — the same "this dependency
   * exists for `tabs.ts` to inject" shape as `isActive`. */
  readonly watchKey?: string
}

/** §5.6's own "bounded stack depth with the bound recorded as a tunable" —
 * not measured against a real editing session yet (F10 is where that
 * would happen), so this is a starting guess sized to survive a long
 * burst-heavy session without unbounded growth, not a derived number. */
export const DEFAULT_UNDO_MAX_DEPTH = 500

/** Exported for `DocumentStatus.tsx` — the same formatting the size-limit
 * messages here use, so the confirm/error UI doesn't grow its own copy. */
export function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3
  if (gib >= 0.1) return `${gib.toFixed(gib >= 10 ? 0 : 2)} GB`
  const mib = bytes / 1024 ** 2
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fileNameOf(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}

// R52: fallback `watchKey` source for every `createDocumentSession()` call
// that doesn't get one injected by `tabs.ts` — module-scoped so two direct
// sessions in the same test/process never collide.
let nextFallbackWatchKey = 0

/**
 * Best-effort node to mark as "the error node" (§11.1) when a parse doesn't
 * complete. Every parser closes whatever is still open by EOF (e.g.
 * `formats/xml/index.ts`'s `runParser`), so an incomplete parse still
 * leaves every allocated node with a valid span — there is no "unclosed"
 * node left to detect directly. Node refs are allocated in open order,
 * which is document order, so the last-allocated node is the one parsing
 * was working on when it gave up: a cheap, order-only approximation, not
 * the general offset-to-node search D14 will build once selection
 * navigation exists (binary search on `spanStart`, then descend through
 * children) — replace this with that if it proves imprecise in practice.
 */
function deriveErrorInfo(result: ParseClientResult): {
  readonly node: NodeRef | null
  readonly offset: Offset | null
} {
  if (result.complete) return { node: null, offset: null }
  const primary =
    result.diagnostics.find((d) => d.severity === Severity.Fatal) ?? result.diagnostics[0]
  return {
    node: result.store.nodeCount > 0 ? result.store.nodeCount - 1 : null,
    offset: primary?.offset ?? null
  }
}

export function createDocumentSession(deps: DocumentSessionDeps = {}): DocumentSession {
  const parse = deps.parse ?? parseInWorker
  const parseFromUrl = deps.parseFromUrl ?? parseFromUrlInWorker
  const transform = deps.transform ?? transformInWorker
  const transformConfirmBytes = deps.transformConfirmBytes ?? TRANSFORM_CONFIRM_BYTES
  const getApi = (): Pick<KladosApi, 'document'> | undefined => deps.api ?? getKladosApi()
  const isActive = deps.isActive ?? ((): boolean => true)
  const estimateOtherTabsBytes = deps.estimateOtherTabsBytes ?? ((): number => 0)
  const totalMemoryBudgetBytes = deps.totalMemoryBudgetBytes ?? getTotalMemoryBudgetBytes()
  // R52: `tabs.ts` injects the real `TabId`; every direct call (tests, or
  // any single-session use) gets an auto-generated fallback so `watch`/
  // `unwatch`/`onExternalChange` below always have *some* stable per-session
  // identity to key on, even outside a tabbed context.
  const watchKey = deps.watchKey ?? `session-${nextFallbackWatchKey++}`
  // R24-tabs.md: every internal write below goes through this rather than
  // `setContext` directly, so a background tab's own state changes (a
  // debounced reparse landing while a different tab is focused, say) can't
  // overwrite context the active tab's panes are reading. `resyncContext`
  // (below) is the other half — it writes for real, unconditionally, for
  // the one moment gating this away would be wrong: becoming active.
  function setCtx(...args: Parameters<typeof setContext>): void {
    if (isActive()) setContext(...args)
  }
  // F8, R52: one subscription for this session's whole lifetime, not
  // per-document — `document:watch`'s own replace-on-call semantics
  // (main/documents.ts, now scoped per `watchKey` rather than the whole
  // app) are what make "the currently watched file" track whichever
  // document *this session* has open, without this session layer having to
  // resubscribe on every open. Every session in the renderer process shares
  // the one `document:externalChange` IPC channel, so the `key` filter
  // below is what keeps a background tab's own file change from reaching a
  // different tab's session.
  //
  // R24-tabs.md: the returned unsubscribe is kept (`dispose`, below) —
  // before tabs, exactly one `DocumentSession` ever existed for the app's
  // whole lifetime, so discarding it was harmless; `tabs.ts`'s `closeTab`
  // can now discard a session while this callback stays registered with
  // the preload layer, which would otherwise keep the whole closed
  // session's closure alive and let a stale `handleExternalChange` fire
  // against a document nothing displays anymore.
  const unsubscribeExternalChange = getApi()?.document.onExternalChange((key) => {
    if (key === watchKey) void handleExternalChange()
  })

  let state: DocumentSessionState = { phase: 'empty' }
  const listeners = new Set<() => void>()
  let pendingOpen: { path: string; fileName: string; readOnly: boolean; size: number } | null = null
  let activeAbort: AbortController | null = null
  // F3's own `AbortController`, separate from `activeAbort` (opens) rather
  // than sharing it — two independent async operations with independent
  // supersede rules are simpler kept apart than coordinated through one
  // variable two call sites both have to remember to reset correctly.
  let reparseAbort: AbortController | null = null
  // F8's own, same "kept apart" reasoning — a reload races against
  // neither an open nor an ordinary reparse in any way that sharing their
  // controllers would simplify.
  let reloadAbort: AbortController | null = null
  // M5-PLAN.md H7: an in-flight Transform's own abort, and the request a
  // pending size confirmation (`document.pendingTransform`) is waiting to
  // resume once `confirmTransformAnyway` is called.
  let transformAbort: AbortController | null = null
  let pendingTransformRequest: TransformKind | null = null

  // M3-PLAN.md F10/D-036: subtree splicing, wired in after F10's
  // measurement pass found F4's `spliceSubtree` correct, tested and 4-7x
  // faster than a full reparse at every size measured, but never actually
  // called. `pendingDirtyRange` is the union of every edit's own range
  // since `lastParsedByteLength` was last set (i.e. since the last
  // successful reparse, splice or full), in THAT reparse's own store
  // coordinates — `spliceSubtree`'s own `dirtyStart`/`dirtyEnd` contract.
  // `lastParsedByteLength` is the buffer length as of that same point;
  // `recordEditForSplice` derives the accumulated delta from it rather
  // than tracking a second number that could drift out of sync with the
  // buffer it's meant to describe.
  let pendingDirtyRange: { start: Offset; end: Offset } | null = null
  let lastParsedByteLength: number | null = null

  // F6 (M3-PLAN.md): the undo stack. `undoState` is the committed stack;
  // `pendingUndoBurst` is the burst still being coalesced (mutated in
  // place, not replaced, the same "private closure state" treatment
  // `pendingOpen`/`activeAbort` already get — nothing outside this factory
  // call ever sees it). `pendingSelectionRestore` is how `undo`/`redo`
  // tell the *next* `applyReparseResult` to resolve selection from a
  // recorded path instead of the live `state.selection` — set right
  // before the immediate reparse `applyUndoEntry` triggers, consumed and
  // cleared the moment that reparse lands.
  let undoState: UndoStackState = EMPTY_UNDO_STACK
  let pendingUndoBurst: {
    patches: Patch[]
    inverses: Patch[]
    selectionBefore: RecordedSelection
  } | null = null
  let pendingSelectionRestore: RecordedSelection | null = null

  function setState(next: DocumentSessionState): void {
    state = next
    for (const listener of listeners) listener()
  }

  // R24-tabs.md: also reached via `resyncContext` for a tab that isn't
  // `ready` (still opening, or never opened anything) — every key this
  // file owns needs a default here now, not just the ones a same-session
  // transition away from `ready` happened to leave already-correct. Before
  // tabs, `canUndo`/`canRedo`/`hasExternalChange`/`nodeKind` were always
  // already `false`/`null` by the time this ran (a fresh open resets the
  // undo stack, `openPath` resets `hasExternalChange` itself, and a
  // selection only exists once `ready`) — never wrong, just untested by
  // anything that would have caught it being incomplete.
  function resetContextForNoDocument(): void {
    setCtx('format', null)
    setCtx('isReadOnly', true)
    setCtx('hasSelection', false)
    setCtx('hasDiagnostics', false)
    setCtx('isDirty', false)
    setCtx('canFormat', false)
    setCtx('hasPendingTransform', false)
    setCtx('hasExternalChange', false)
    setCtx('nodeKind', null)
    setCtx('canUndo', false)
    setCtx('canRedo', false)
  }

  async function startParse(
    path: string,
    fileName: string,
    readOnly: boolean,
    fileBytes: number
  ): Promise<void> {
    const api = getApi()
    if (api === undefined) {
      setState({ phase: 'error', message: 'The document API is unavailable.' })
      return
    }

    const controller = new AbortController()
    activeAbort = controller
    // Entered synchronously (before the `mintReadToken()` await below) so a
    // caller — `confirmOpenAnyway` in particular — sees the confirmation UI
    // replaced by progress immediately, not after the mint completes.
    setState({ phase: 'parsing', fileName, bytesConsumed: 0, totalBytes: fileBytes })

    // M5-PLAN.md H12: mints an opaque, single-use token for `path` — the
    // read itself happens in the worker (`parseFromUrl` below), which
    // fetches it directly over the token-scoped protocol. Never bytes over
    // IPC here; `activeAbort`'s abort-supersede pattern below is unchanged
    // from when this awaited a real read.
    let token: string
    try {
      token = await api.document.mintReadToken(path)
    } catch (err) {
      if (activeAbort !== controller) return // superseded by a newer open
      activeAbort = null
      setState({ phase: 'error', message: describeError(err) })
      resetContextForNoDocument()
      return
    }

    try {
      const result = await parseFromUrl(readTokenUrl(token), {
        filename: fileName,
        signal: controller.signal,
        onProgress: (bytesConsumed) => {
          if (state.phase === 'parsing') setState({ ...state, bytesConsumed })
        }
      })
      if (activeAbort !== controller) return // superseded by a newer open
      activeAbort = null

      const { node, offset } = deriveErrorInfo(result)
      const document: OpenDocument = {
        filePath: path,
        fileName,
        store: result.store,
        sourceBuffer: result.sourceBuffer,
        rowIndex: result.rowIndex,
        lineIndex: result.lineIndex,
        nameIndex: result.nameIndex,
        diagnostics: result.diagnostics,
        complete: result.complete,
        formatId: result.formatId,
        encoding: result.encoding,
        readOnly,
        errorNode: node,
        errorOffset: offset,
        pendingParseError: null,
        dirty: false,
        reparsePending: false,
        externalChangeDetected: false,
        reloadPending: false,
        pendingTransform: null,
        minifiedBannerDismissed: false,
        transformInProgress: false,
        lastTransformWasNoOp: false,
        undoBytes: 0,
        undoEntryCount: 0,
        pendingSpanDeltas: EMPTY_DELTA_LIST,
        externalRewrites: 0
      }
      // `node` is null for a complete parse (nothing went wrong to mark) and
      // also for one that produced no nodes at all — only the first of those
      // has a Document node to fall back to. R33/D-065: the fallback is the
      // wrapper-descent destination, not the raw root — Tree, Detail, the
      // breadcrumb and Raw all agree on the initial selection from the
      // first frame instead of the Tree highlighting `Document` while every
      // other pane shows what it descended to on its own.
      const selectedNode =
        node ??
        (result.store.nodeCount > 0
          ? resolveWrapperTarget(result.store, 0).destination
          : NO_SELECTION)
      // R8f moved selection to the node's span start; a deeper initial
      // selection means Raw opens scrolled there instead of byte 0 —
      // stated rather than slipped in (R33 §2a).
      const initialCaretOffset =
        offset ?? (selectedNode !== NO_SELECTION ? result.store.spanOf(selectedNode).start : 0)
      setCtx('format', result.formatId)
      setCtx('canFormat', getFormatModule(result.formatId)?.capabilities.canFormat ?? false)
      setCtx('isReadOnly', readOnly)
      setCtx('hasSelection', selectedNode !== NO_SELECTION)
      setCtx('hasDiagnostics', document.diagnostics.length > 0)
      setCtx('isDirty', false)
      setCtx('hasExternalChange', false)
      setCtx('hasPendingTransform', false)
      // F10/D-036: this document's own baseline for `recordEditForSplice`
      // — `openPath`'s reset block already nulled `pendingDirtyRange`, so
      // there is nothing dirty yet, only a starting length to compare
      // future edits against.
      lastParsedByteLength = document.sourceBuffer.bytes.length
      setState({
        phase: 'ready',
        document,
        selection: { selectedNode, caretOffset: initialCaretOffset }
      })
      // R95 (`R95-recent-files.md` §2): the one place a document transitions
      // *into* `ready` — every successful open (dialog, drag-drop, session
      // restore, a recent-file click itself) passes through here exactly
      // once, so this is the single recording site for all of them.
      recordRecentFile({ path, fileName, formatId: document.formatId })
      // F8, R52: one watcher at a time *for this session* (main's own
      // `document:watch` replaces whatever `watchKey` was watching) —
      // fire-and-forget, since a watch failure shouldn't block the document
      // that just opened successfully from being usable.
      void api.document.watch(path, watchKey)
      // M5-PLAN.md H8: "Format minified files on open" — the automatic
      // half of the offer. Goes through the same `requestTransform` path
      // a manual Format command would (soft cap included, undoable), not
      // a special-cased silent rewrite — a user who turned this setting on
      // still gets §11.2's confirmation on a document large enough to earn
      // one, and can still undo it.
      if (
        !readOnly &&
        getFormatMinifiedOnOpen() &&
        isPathologicallyMinified(document.rowIndex.length, document.sourceBuffer.byteLength)
      ) {
        requestTransform('format')
      }
    } catch (err) {
      if (activeAbort !== controller) return // superseded by a newer open
      activeAbort = null
      if (err instanceof DOMException && err.name === 'AbortError') {
        setState({ phase: 'empty' })
      } else {
        setState({ phase: 'error', message: describeError(err) })
      }
      resetContextForNoDocument()
    }
  }

  /**
   * M3-PLAN.md F10/D-036: tracks the union of edited regions since the
   * last successful reparse, in that reparse's own store coordinates —
   * exactly `spliceSubtree`'s own `dirtyStart`/`dirtyEnd` contract.
   * `patch.start`/`patch.end` arrive in *current* buffer coordinates
   * (already shifted by whatever earlier edits landed in this same
   * burst); this translates them back using the delta accumulated since
   * `lastParsedByteLength`, derived fresh from the live buffer rather
   * than tracked as a second number that could drift out of sync with it.
   *
   * Three cases: the new edit lands entirely after the tracked region
   * (the overwhelmingly common one — sequential typing) translates
   * exactly by subtracting the accumulated delta; entirely before it (a
   * cursor jump backward) needs no translation at all, since that
   * territory hasn't been touched by anything shifting it yet; anything
   * overlapping widens conservatively using both translations rather than
   * computing which one is exactly right. All three are safe by
   * construction — `spliceSubtree` finds the innermost node *containing*
   * whatever range it's given, so a wider-than-strictly-necessary range
   * costs a larger (never wrong) splice, the same "always safe, not
   * always minimal" tradeoff `nodeSpanLookup.ts`'s own zero-width bias
   * makes for the same reason.
   */
  function recordEditForSplice(patch: Patch): void {
    if (state.phase !== 'ready' || lastParsedByteLength === null) return
    const patchDelta = patch.replacement.length - (patch.end - patch.start)
    const totalDeltaAfter = state.document.sourceBuffer.bytes.length - lastParsedByteLength
    const deltaBeforeThisPatch = totalDeltaAfter - patchDelta

    if (pendingDirtyRange === null) {
      pendingDirtyRange = { start: patch.start, end: patch.end }
      return
    }

    const trackedCurrentStart = pendingDirtyRange.start
    const trackedCurrentEnd = pendingDirtyRange.end + deltaBeforeThisPatch

    if (patch.start >= trackedCurrentEnd) {
      const oldEnd = patch.end - deltaBeforeThisPatch
      pendingDirtyRange = {
        start: pendingDirtyRange.start,
        end: Math.max(pendingDirtyRange.end, oldEnd)
      }
    } else if (patch.end <= trackedCurrentStart) {
      pendingDirtyRange = {
        start: Math.min(pendingDirtyRange.start, patch.start),
        end: pendingDirtyRange.end
      }
    } else {
      const asIfAfter = patch.end - deltaBeforeThisPatch
      pendingDirtyRange = {
        start: Math.min(pendingDirtyRange.start, patch.start),
        end: Math.max(pendingDirtyRange.end, asIfAfter)
      }
    }
  }

  // M5-PLAN.md H2d: holds at most one in-flight chunked splice — starting a
  // new one (or falling through to a full reparse) cancels whatever splice
  // is still grafting, so a splice overtaken by continued typing (or by
  // undo/redo, or by opening a different document) never lands. See
  // `searchJob.ts`'s own `JobSlot` doc comment for why this has no race
  // window the way `reparseAbort`'s controller-identity check needs.
  const spliceJobSlot = new JobSlot<ParseClientResult>()

  /**
   * M3-PLAN.md F10/D-036, chunked per M5-PLAN.md H2d: begins an incremental
   * reparse via `beginSpliceSubtree` (F4/H2d) before `runReparse` falls
   * back to a full worker reparse. The *decide* phase — same as the
   * synchronous `spliceSubtree` used to run entirely — is still
   * synchronous and still bounded by the edited subtree's own size, so
   * `runReparse` learns "splice or full reparse" immediately, unchanged
   * from before H2d. Only the graft itself (the O(document) part, D-036's
   * addendum: ~1.2s at 500 MB before H2d) now yields via `runChunkedJob`,
   * so it never blocks a frame the way the fully-synchronous version did.
   * `null` whenever splicing isn't attempted or doesn't succeed at the
   * decide phase; every such case falls through to the existing
   * full-reparse path completely unchanged.
   */
  function beginTrySpliceReparse(
    readyState: Extract<DocumentSessionState, { phase: 'ready' }>
  ): SearchJob<ParseClientResult> | null {
    const dirty = pendingDirtyRange
    if (dirty === null || lastParsedByteLength === null) return null

    const format = getFormatModule(readyState.document.formatId)
    if (format === undefined || !format.capabilities.canIncrementalReparse) return null

    const newBytes = readyState.document.sourceBuffer.bytes
    const delta = newBytes.length - lastParsedByteLength

    const begun = beginSpliceSubtree({
      format,
      oldStore: readyState.document.store,
      newBytes,
      interner: readyState.document.store.interner,
      dirtyStart: dirty.start,
      dirtyEnd: dirty.end,
      delta,
      options: { maxDepth: DEFAULT_MAX_DEPTH, encoding: readyState.document.encoding }
    })
    if (!begun.ok) return null

    const oldRowIndex = readyState.document.rowIndex
    const { formatId, encoding } = readyState.document
    const bomLength = readyState.document.sourceBuffer.bomLength
    const sourceBuffer = readyState.document.sourceBuffer

    const result = begun.job.result.then((store): ParseClientResult => {
      // M5-PLAN.md H2b: the row index does not need rebuilding wholesale —
      // rows before `dirty.start` and after `dirty.end` are unaffected or a
      // constant shift away; only the re-scan between the two is real
      // work. `buildLineIndex` stays a full rebuild deliberately (its own
      // doc comment: 34-94ms, cheap enough to run unconditionally, and
      // cheap enough not to need its own chunking here either).
      const rowIndex = incrementalRowIndex(
        oldRowIndex,
        newBytes,
        dirty.start,
        dirty.end,
        delta,
        DEFAULT_MAX_ROW_BYTES,
        format.capabilities.rowBreakBytes
      )
      const lineIndex = buildLineIndex(newBytes, rowIndex)

      return {
        store,
        sourceBuffer,
        encoding,
        bomLength,
        rowIndex,
        lineIndex,
        // Rebuilt wholesale against the spliced store, not patched against
        // the old one — G1's "must never be readable in a stale state" rule
        // taken as literally as this function already takes it for
        // `rowIndex`/`lineIndex` above, which are rebuilt in full here too.
        nameIndex: buildNameIndex(store, store.interner.size),
        diagnostics: store.diagnostics,
        complete: true,
        bytesConsumed: newBytes.length,
        formatId
      }
    })

    return { result, cancel: () => begun.job.cancel() }
  }

  /**
   * Applies a completed reparse's result to the live document — or
   * doesn't, per §5.1/§11.1's "last known-good tree retained while the
   * document is temporarily invalid" applied mid-edit rather than at open.
   * `document.sourceBuffer` is never touched here: `applyEdit` (F1) is
   * what keeps it live, and a reparse — which can take over a second on a
   * large document — must never regress it backward against edits that
   * landed while it was running.
   */
  function applyReparseResult(result: ParseClientResult): void {
    if (state.phase !== 'ready') return
    const wasComplete = state.document.complete

    // F6: `undo`/`redo` set this right before triggering an immediate
    // reparse, for the *next* `applyReparseResult` call to consume —
    // captured and cleared unconditionally, here at the top, rather than
    // past the early-return below. This function has two exits; leaving
    // the clear in only one of them means a reparse that takes the other
    // exit (the document was already malformed, or stays malformed) leaves
    // the flag set for whatever *later, unrelated* reparse happens to be
    // the next one to reach the bottom — hijacking that edit's own F5
    // resolution with a stale recorded path instead of the live cascade.
    // The early-return branch below never touches `selection` at all (the
    // retained last-good store means there is nothing to restore against),
    // so simply discarding `restoreTarget` there is correct, not a gap.
    const restoreTarget = pendingSelectionRestore
    pendingSelectionRestore = null

    if (wasComplete && !result.complete) {
      const primary =
        result.diagnostics.find((d) => d.severity === Severity.Fatal) ?? result.diagnostics[0]
      setState({
        ...state,
        document: {
          ...state.document,
          pendingParseError: primary?.message ?? 'The document is not currently valid.'
        }
      })
      return
    }

    // M3-PLAN.md F10/D-036: this commit is the one place — reached by
    // both the splice and the full-reparse path — where a store this
    // reparse produced actually becomes the new baseline. Whatever was
    // dirty relative to the *previous* baseline no longer is; a later
    // edit's own dirty range starts fresh from here.
    pendingDirtyRange = null
    lastParsedByteLength = result.sourceBuffer.bytes.length

    const { node, offset } = deriveErrorInfo(result)
    // F5 (M3-PLAN.md), CONCEPT.md §5.1: the three-step cascade —
    // structural path, then caret offset (scoped to the surviving
    // ancestor), then nearest surviving ancestor — run against the store
    // and selection this reparse is about to replace. Skipped in favor of
    // the line above whenever this reparse is undo/redo's own.
    const caretOffset = restoreTarget?.caretOffset ?? state.selection.caretOffset
    const resolved =
      restoreTarget !== null
        ? resolveFromPath(restoreTarget.path, result.store, restoreTarget.caretOffset)
        : reresolveSelection(
            state.document.store,
            state.selection.selectedNode,
            result.store,
            caretOffset
          )

    setCtx('hasSelection', resolved.node !== NO_SELECTION)
    setCtx('hasDiagnostics', result.diagnostics.length > 0)
    // `selectNode.ts` keeps `nodeKind` in sync with every ordinary
    // selection change (it gates a command's `when`); a reparse-driven
    // relocation bypasses `selectNode` entirely (it writes `selection`
    // straight into session state below), so without this a step-2/3
    // relocation onto a node of a different kind would leave `nodeKind`
    // pointing at the node that no longer exists.
    if (resolved.node !== NO_SELECTION) {
      setCtx('nodeKind', kindLabelOf(result.store.kindOf(resolved.node)))
    }
    setState({
      ...state,
      document: {
        ...state.document,
        store: result.store,
        rowIndex: result.rowIndex,
        lineIndex: result.lineIndex,
        nameIndex: result.nameIndex,
        diagnostics: result.diagnostics,
        complete: result.complete,
        errorNode: node,
        errorOffset: offset,
        pendingParseError: null,
        // The store/indexes above were just built from `result.sourceBuffer`
        // — matched against the live `sourceBuffer` closely enough for this
        // flag's purpose (the same ~200ms-class tolerance `applyEdit`'s own
        // doc comment already accepts for this exact staleness window; see
        // `reparsePending`'s own doc comment on `OpenDocument`).
        reparsePending: false,
        // R42/D-070: `result.store` was just built from `result.sourceBuffer`
        // — nothing left to translate, and carrying a delta list computed
        // against the *previous* store forward would be exactly the
        // silently-wrong-but-plausible offset `deltaList.ts`'s own doc
        // comment warns a caller against.
        pendingSpanDeltas: EMPTY_DELTA_LIST
      },
      selection: { selectedNode: resolved.node, caretOffset }
    })
    // §5.1: "steps 2 and 3 change the selection, so the change is never
    // silent" — make a reparse-driven relocation visible by revealing it in
    // the Tree. `requestReveal`, not `locateInTree`: the Tree view that's
    // currently registered (if any) was registered against the *old*
    // store, and won't pick up `result.store` until it re-renders — a
    // synchronous `locateInTree` call right here would run against a
    // controller whose closures don't know about `result.store` yet. The
    // breadcrumb needs no equivalent deferral — Detail subscribes to
    // `selection` directly and re-renders from the state just committed
    // above, no closure staleness possible there.
    //
    // An undo/redo restore always reveals, even a "silent" (step 1, exact
    // structural match) one — F5's own silence is about not surprising the
    // user with an unrequested move; undo/redo *is* the user's own request
    // to jump somewhere, so showing where it landed is the point, not a
    // surprise to suppress.
    const isRestoring = restoreTarget !== null
    if ((isRestoring || !resolved.silent) && resolved.node !== NO_SELECTION) {
      requestReveal(resolved.node, result.store)
    }
  }

  /**
   * The reparse itself. Runs against a *copy* of the live bytes, not
   * `document.sourceBuffer.bytes` directly — `parseInWorker` transfers
   * (detaches) whatever `ArrayBuffer` it's given to the worker, and
   * `sourceBuffer` is still being read by the UI (the Raw View, decorations)
   * for the whole time this is in flight. Handing over the live buffer
   * would zero it out from under the document currently on screen.
   */
  async function runReparse(): Promise<void> {
    if (state.phase !== 'ready') return
    const readyState = state

    // M3-PLAN.md F10/D-036, chunked per M5-PLAN.md H2d: the decide phase
    // still runs synchronously — falls through to the existing
    // full-reparse-via-worker path unchanged whenever splicing isn't
    // attempted or doesn't succeed (unsupported format, nothing tracked as
    // dirty, or `beginSpliceSubtree`'s own boundary-crossing/malformed
    // refusal). When it does succeed, the graft itself runs as a chunked
    // job behind `spliceJobSlot` — starting it here supersedes (cancels)
    // whatever splice was still grafting from an earlier `runReparse` call.
    const spliceJob = beginTrySpliceReparse(readyState)
    if (spliceJob !== null) {
      const job = spliceJobSlot.start(() => spliceJob)
      try {
        const result = await job.result
        applyReparseResult(result)
      } catch (err) {
        // A `JobSlot`-cancelled job rejects with this same `AbortError`
        // shape (`searchJob.ts`'s `runChunkedJob`) — superseded by a later
        // edit, undo/redo, or a document switch; nothing to surface.
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (state.phase === 'ready') {
          setState({
            ...state,
            document: { ...state.document, pendingParseError: describeError(err) }
          })
        }
      }
      return
    }
    // No splice was attempted this time — any splice still grafting from an
    // earlier call must not land after the full reparse below commits.
    spliceJobSlot.cancel()

    const controller = new AbortController()
    // Same "clear, don't just abort" discipline as `activeAbort` — the
    // superseded reparse's own rejection handler must see a controller
    // that is no longer `reparseAbort`, not one that was merely aborted.
    reparseAbort?.abort()
    reparseAbort = controller

    const bytesCopy = readyState.document.sourceBuffer.bytes.slice().buffer as ArrayBuffer
    try {
      const result = await parse(bytesCopy, {
        filename: readyState.document.fileName,
        signal: controller.signal
      })
      if (reparseAbort !== controller) return // superseded by a newer reparse
      reparseAbort = null
      applyReparseResult(result)
    } catch (err) {
      if (reparseAbort !== controller) return
      reparseAbort = null
      if (err instanceof DOMException && err.name === 'AbortError') return
      // Parsers never throw (invariant 5) — a rejection here means the
      // pipeline itself failed (e.g. a worker crash), not a malformed
      // document. The last-good tree is already what's showing; surface
      // the failure without discarding it.
      if (state.phase === 'ready') {
        setState({
          ...state,
          document: { ...state.document, pendingParseError: describeError(err) }
        })
      }
    }
  }

  const reparseScheduler = createDebouncedReparse(
    () => void runReparse(),
    deps.reparseDelayMs ?? REPARSE_DEBOUNCE_MS
  )

  /**
   * R97 (`R95-recent-files.md` §5): a thin wrapper around the actual attempt
   * below — checking `state.phase` after it settles is what catches every
   * failure path at once (a `stat` throw for a deleted file, the hard-
   * ceiling/soft-cap-then-`startParse` paths, a parse failure) without
   * threading a removal call through each one individually. Harmless to run
   * for a path that was never in the recent list (`removeRecentFile` is a
   * no-op then) — every caller of `openPath`, not just a recent-file click,
   * benefits from the same cleanup.
   */
  async function openPath(path: string): Promise<void> {
    await attemptOpenPath(path)
    if (state.phase === 'error') removeRecentFile(path)
  }

  async function attemptOpenPath(path: string): Promise<void> {
    // Clearing `activeAbort`, not just aborting it, is what makes the
    // superseded parse's rejection handler take its `activeAbort !==
    // controller` early return. Left set, that handler runs first (the
    // abort rejects on a microtask; the `stat` below is IPC) and drives the
    // UI to 'empty' — a visible flash of the no-document state between two
    // opens, for as long as the stat takes. `cancel()` deliberately does
    // *not* clear it, because there the reset to 'empty' is the point.
    activeAbort?.abort()
    activeAbort = null
    pendingOpen = null
    // A reparse for whatever document was open before must never land
    // against the new one — same reasoning as `activeAbort` above, and the
    // same "clear, don't just abort" rule (`174606f`).
    reparseScheduler.cancel()
    reparseAbort?.abort()
    reparseAbort = null
    // M5-PLAN.md H2d: a splice still grafting for whatever document was
    // open before must never land against the new one — same "clear,
    // don't just abort" reasoning as `reparseAbort` above.
    spliceJobSlot.cancel()
    // M5-PLAN.md H7: same reasoning again, for a Transform still running or
    // a confirmation still pending for whatever document was open before.
    transformAbort?.abort()
    transformAbort = null
    pendingTransformRequest = null
    // F10/D-036: a dirty range and baseline length tracked against
    // whatever document was open before mean nothing once this session
    // moves on — reset alongside everything else here, not left to be
    // implicitly stale until the next `applyEdit` happens to overwrite it.
    pendingDirtyRange = null
    lastParsedByteLength = null
    // F6: an unconsumed reveal request from whatever document was open
    // before must not linger for a hypothetical future store that happens
    // to match it — `clearPendingReveal`'s own doc comment explains why
    // this is the one place that's guaranteed safe to say for certain.
    clearPendingReveal()
    undoBurstScheduler.cancel()
    pendingUndoBurst = null
    undoState = EMPTY_UNDO_STACK
    pendingSelectionRestore = null
    setCtx('canUndo', false)
    setCtx('canRedo', false)
    // F8: whatever was open before must stop being watched — its
    // `document:externalChange` notifications mean nothing once this
    // session has moved on to a different file (or none).
    reloadAbort?.abort()
    reloadAbort = null
    setCtx('hasExternalChange', false)
    void getApi()?.document.unwatch(watchKey)

    const api = getApi()
    if (api === undefined) {
      setState({ phase: 'error', message: 'The document API is unavailable.' })
      return
    }

    let info: DocumentStat
    try {
      info = await api.document.stat(path)
    } catch (err) {
      setState({ phase: 'error', message: describeError(err) })
      return
    }

    const fileName = fileNameOf(path)

    if (info.size >= HARD_CEILING_BYTES) {
      setState({
        phase: 'error',
        message:
          `${fileName} is ${formatBytes(info.size)} — larger than the ~2 GB Klados can ` +
          `address (byte offsets are 32-bit).`
      })
      return
    }

    const estimatedBytes = Math.round(info.size * ESTIMATED_MEMORY_MULTIPLIER)

    if (info.size >= SOFT_CAP_BYTES) {
      pendingOpen = { path, fileName, readOnly: info.readOnly, size: info.size }
      setState({
        phase: 'confirmSize',
        fileName,
        fileBytes: info.size,
        estimatedBytes,
        reason: 'size',
        totalEstimatedBytes: null
      })
      return
    }

    // R28 (`R24-tabs.md` §6): the cross-tab counterpart — this file is
    // under the per-file soft cap on its own, but opening it would push the
    // *total* across every open tab past the configured budget. Same
    // soft-cap shape (confirm, never a silent refusal), a different reason.
    const totalEstimatedBytes = estimatedBytes + estimateOtherTabsBytes()
    if (totalEstimatedBytes > totalMemoryBudgetBytes) {
      pendingOpen = { path, fileName, readOnly: info.readOnly, size: info.size }
      setState({
        phase: 'confirmSize',
        fileName,
        fileBytes: info.size,
        estimatedBytes,
        reason: 'budget',
        totalEstimatedBytes
      })
      return
    }

    await startParse(path, fileName, info.readOnly, info.size)
  }

  async function openFileDialog(): Promise<void> {
    const api = getApi()
    if (api === undefined) {
      setState({ phase: 'error', message: 'The document API is unavailable.' })
      return
    }
    let picked: Awaited<ReturnType<KladosApi['document']['openDialog']>>
    try {
      picked = await api.document.openDialog()
    } catch (err) {
      // Every other IPC call in this module (stat, read) degrades to an
      // 'error' phase rather than an unhandled rejection — this one is no
      // different just because it happens to run first.
      setState({ phase: 'error', message: describeError(err) })
      return
    }
    if (picked === null) return
    await openPath(picked.path)
  }

  function confirmOpenAnyway(): void {
    if (state.phase !== 'confirmSize' || pendingOpen === null) return
    const { path, fileName, readOnly, size } = pendingOpen
    pendingOpen = null
    void startParse(path, fileName, readOnly, size)
  }

  function cancel(): void {
    if (state.phase === 'confirmSize') {
      pendingOpen = null
      setState({ phase: 'empty' })
      return
    }
    if (state.phase === 'parsing') {
      activeAbort?.abort()
    }
  }

  function setSelectedNode(node: NodeRef, options?: { readonly moveCaret?: boolean }): void {
    if (state.phase !== 'ready') return
    setCtx('hasSelection', node !== NO_SELECTION)
    const moveCaret = options?.moveCaret ?? true
    const caretOffset =
      moveCaret && node !== NO_SELECTION
        ? state.document.store.spanOf(node).start
        : state.selection.caretOffset
    setState({ ...state, selection: { ...state.selection, selectedNode: node, caretOffset } })
  }

  function setCaretOffset(offset: number): void {
    if (state.phase !== 'ready') return
    setState({ ...state, selection: { ...state.selection, caretOffset: offset } })
  }

  /** The live selection, in F6's store-independent `RecordedSelection`
   * shape — what an undo entry's `selectionBefore`/`selectionAfter` are
   * built from. A no-op (`{ path: [], caretOffset: 0 }`) outside `'ready'`;
   * callers only ever call this while `state.phase === 'ready'` themselves. */
  function recordCurrentSelection(): RecordedSelection {
    if (state.phase !== 'ready') return { path: [], caretOffset: 0 }
    const { selectedNode, caretOffset } = state.selection
    const store = state.document.store
    return recordedSelectionOf(selectedNode, caretOffset, (node) => pathSegmentsOf(store, node))
  }

  /** M5f-PLAN.md §3a: also keeps `document.undoBytes`/`undoEntryCount`
   * current — recomputed here, not cached anywhere else, since this is
   * already the one function every stack mutation (`flushUndoBurst`,
   * `undo`, `redo`, a Transform's own push, reload's own reset) routes
   * through. */
  function syncUndoContext(): void {
    setCtx('canUndo', canUndo(undoState))
    setCtx('canRedo', canRedo(undoState))
    if (state.phase === 'ready') {
      const stats = computeUndoStats(undoState)
      setState({
        ...state,
        document: { ...state.document, undoBytes: stats.bytes, undoEntryCount: stats.entryCount }
      })
    }
  }

  /** §5.6's own coalescing rule: every `applyEdit` call within the burst
   * debounce extends the *same* pending entry rather than starting a new
   * one — `pendingUndoBurst` is mutated in place, not replaced, exactly
   * because it needs to keep accumulating across many calls before it's
   * ever turned into a real, pushed `UndoEntry`. */
  function recordUndoableEdit(patch: Patch, inverse: Patch): void {
    if (state.phase !== 'ready') return
    if (pendingUndoBurst === null) {
      pendingUndoBurst = {
        patches: [patch],
        inverses: [inverse],
        selectionBefore: recordCurrentSelection()
      }
    } else {
      pendingUndoBurst.patches.push(patch)
      pendingUndoBurst.inverses.push(inverse)
    }
    undoBurstScheduler.trigger()
  }

  /** Closes off whatever burst is pending — pushed onto the real stack as
   * one `UndoEntry` — either because the coalescing debounce elapsed or
   * because `undo`/`redo` needs the burst it's about to act underneath to
   * not simply vanish. A no-op with nothing pending. */
  function flushUndoBurst(): void {
    if (pendingUndoBurst === null) return
    const burst = pendingUndoBurst
    pendingUndoBurst = null
    const entry: UndoEntry = {
      patches: burst.patches,
      inverses: burst.inverses,
      selectionBefore: burst.selectionBefore,
      selectionAfter: recordCurrentSelection(),
      // R109: an ordinary typing burst is incremental, not a single batch
      // against one baseline — see `UndoEntry.independent`'s own doc
      // comment for why this can't be `true` here (the same byte range
      // edited twice in one burst, the everyday case of correcting a
      // character, produces overlapping patches).
      independent: false
    }
    undoState = pushEntry(undoState, entry, deps.undoMaxDepth ?? DEFAULT_UNDO_MAX_DEPTH)
    syncUndoContext()
  }

  const undoBurstScheduler = createDebouncedReparse(
    flushUndoBurst,
    deps.undoDelayMs ?? REPARSE_DEBOUNCE_MS
  )

  /** Splices `patches` into the live buffer, requests F5's cascade restore
   * the given selection once the immediate reparse this triggers lands,
   * and reparses right away rather than waiting out the debounce —
   * `undo`/`redo` are discrete, deliberate actions with no burst to
   * amortize a wait against.
   *
   * R109 (`R108-replace-all-quadratic.md` §4): `fast`, when `true`, means
   * `patches` is already ascending, non-overlapping and valid against
   * `oldBuffer.bytes` as given — `applyPatchesAscending`'s own
   * precondition — and takes the single-allocation path. `undo()`/`redo()`
   * only ever pass `true` for an `entry.independent` `UndoEntry` (a
   * Replace All or a Transform), after getting the list into that shape
   * themselves (`entry.patches` for redo just needs reversing to ascending
   * since it's already in the input buffer's coordinates; `entry.inverses`
   * for undo needs `rebaseSequentialPatches` first, since each is only
   * valid once the ones before it have been restored).
   *
   * `false` is the general, always-correct case — a plain per-patch loop,
   * applying each patch to the progressively-updated buffer in the exact
   * order given. It has to stay the default: an ordinary typing burst can
   * (and does, whenever the same character is corrected twice) touch the
   * same byte range more than once, so its patches overlap, and
   * `applyPatchesAscending`'s single ascending pass is not merely slower
   * over that shape, it is a different, wrong operation — proven by
   * `test/documentSession.test.ts`'s own "a burst of many edits is one
   * undo entry" failing loudly (not silently) the one time this was tried
   * unconditionally. */
  function applyUndoEntry(
    patches: readonly Patch[],
    selection: RecordedSelection,
    fast: boolean
  ): void {
    if (state.phase !== 'ready') return
    const oldBuffer = state.document.sourceBuffer
    const bytes = fast
      ? applyPatchesAscending(oldBuffer.bytes, patches)
      : patches.reduce((acc, patch) => applyPatch(acc, patch), oldBuffer.bytes)
    const sourceBuffer = new SourceBuffer(bytes, oldBuffer.encoding, oldBuffer.bomLength)
    setCtx('isDirty', true)
    setState({
      ...state,
      document: {
        ...state.document,
        sourceBuffer,
        dirty: true,
        reparsePending: true,
        // R42/D-070: `patches` are replayed directly via `applyPatch`, not
        // through `applyEdit`'s own `recordDelta` call — whatever was
        // pending before no longer describes this buffer's relationship to
        // `store` (undo/redo's own edits aren't reflected in it), and
        // carrying it forward would translate spans by the *wrong* amount
        // rather than by none. Reset, same "wait for the reparse" fallback
        // §3c of the doc allows — safe here because undo/redo reparses
        // immediately rather than after the ~200ms typing debounce.
        pendingSpanDeltas: EMPTY_DELTA_LIST,
        // R100: undo/redo replays patches directly against the buffer —
        // the Raw editor's own view has never seen this text.
        externalRewrites: state.document.externalRewrites + 1
      }
    })

    pendingSelectionRestore = selection
    reparseScheduler.cancel()
    reparseAbort?.abort()
    // M5-PLAN.md H2d: a splice from *before* this undo/redo could still be
    // mid-graft — its `dirtyStart`/`dirtyEnd` describe a buffer this call
    // just replaced wholesale, so it must never be allowed to land after
    // undo/redo's own forced full reparse commits below.
    spliceJobSlot.cancel()
    // F10/D-036: undo/redo's own patches never go through `applyEdit`
    // (they're replayed directly via `applyPatch` above), so
    // `recordEditForSplice` never saw them — whatever `pendingDirtyRange`
    // is left over describes edits from *before* this undo/redo, against
    // a buffer this call just replaced wholesale. Cleared here so the
    // forced reparse below always takes the full-reparse path, never a
    // splice computed from a stale, unrelated range.
    pendingDirtyRange = null
    void runReparse()
  }

  function undo(): void {
    if (state.phase !== 'ready' || state.document.readOnly) return
    flushUndoBurst()
    const step = undoStep(undoState)
    if (step === null) return
    undoState = step.state
    syncUndoContext()
    // `inverses[i]` only undoes `patches[i]` once everything after it in
    // the burst has already been peeled back — `undoStack.ts`'s own doc
    // comment on `UndoEntry.inverses`. For an `independent` entry (a
    // Replace All), reversing to ascending and rebasing converts that
    // sequential validity into a single ascending pass valid against the
    // *current* buffer all at once (R109); for an ordinary typing burst,
    // rebasing is unsound (`applyUndoEntry`'s own comment), so the reversed
    // list is replayed one patch at a time instead, exactly as before R109.
    if (step.entry.independent) {
      const ascendingInverses = [...step.entry.inverses].reverse()
      applyUndoEntry(rebaseSequentialPatches(ascendingInverses), step.entry.selectionBefore, true)
    } else {
      applyUndoEntry([...step.entry.inverses].reverse(), step.entry.selectionBefore, false)
    }
  }

  function redo(): void {
    if (state.phase !== 'ready' || state.document.readOnly) return
    flushUndoBurst()
    const step = redoStep(undoState)
    if (step === null) return
    undoState = step.state
    syncUndoContext()
    // For an `independent` entry (Replace All/Transform), `entry.patches`
    // is already in the input buffer's coordinates — reversing to ascending
    // is all `applyPatchesAscending` needs, no rebase. An ordinary typing
    // burst's `entry.patches` is only valid replayed one at a time, in the
    // order stored (`undoStack.ts`'s own "replayed in this order for
    // redo") — reversing it would be wrong, not just slower.
    if (step.entry.independent) {
      applyUndoEntry([...step.entry.patches].reverse(), step.entry.selectionAfter, true)
    } else {
      applyUndoEntry(step.entry.patches, step.entry.selectionAfter, false)
    }
  }

  function applyEdit(request: EditRequest): EditOutcome {
    if (state.phase !== 'ready') {
      return { ok: false, reason: { kind: 'not-ready' }, message: 'No document is open.' }
    }
    if (state.document.readOnly) {
      return { ok: false, reason: { kind: 'read-only' }, message: 'This file is read-only.' }
    }
    const oldBuffer = state.document.sourceBuffer
    const outcome = createEdit(oldBuffer, request)
    if (!outcome.ok) return outcome

    recordUndoableEdit(outcome.patch, inversePatchOf(oldBuffer.bytes, outcome.patch))

    const sourceBuffer = new SourceBuffer(outcome.bytes, oldBuffer.encoding, oldBuffer.bomLength)

    // R42/D-070: translate this patch's own end into `store`'s coordinates
    // — the same "subtract whatever shifted ahead of it" translation
    // `recordEditForSplice` (below) performs for its own tracked range,
    // computed here from `oldBuffer` (the buffer *before* this patch,
    // still in the same coordinate space `lastParsedByteLength` was
    // measured against) rather than depending on the post-`setState`
    // buffer the way `recordEditForSplice` itself does. `deltaList.ts`'s
    // own contract: `position` is the *end* of the edited region in
    // original (i.e. `store`-relative) coordinates.
    const patchDelta = outcome.patch.replacement.length - (outcome.patch.end - outcome.patch.start)
    const deltaBeforeThisPatch =
      lastParsedByteLength === null ? 0 : oldBuffer.bytes.length - lastParsedByteLength
    const originalPatchEnd = outcome.patch.end - deltaBeforeThisPatch
    const pendingSpanDeltas = recordDelta(
      state.document.pendingSpanDeltas,
      originalPatchEnd,
      patchDelta
    )

    setCtx('isDirty', true)
    setState({
      ...state,
      document: {
        ...state.document,
        sourceBuffer,
        dirty: true,
        reparsePending: true,
        lastTransformWasNoOp: false,
        pendingSpanDeltas
      }
    })
    // After `setState`, not before: F10/D-036's `recordEditForSplice`
    // reads `state.document.sourceBuffer.bytes.length` to derive the
    // accumulated delta, which must already include this patch.
    recordEditForSplice(outcome.patch)
    // §5.1: ~200 ms idle, never per keystroke — a burst of `applyEdit`
    // calls collapses to the one reparse that actually runs once typing
    // pauses (F3).
    reparseScheduler.trigger()
    return outcome
  }

  /** M5-PLAN.md H5/H7. Newline style is fixed at `\n` rather than detected
   * from the document's own existing line endings — a real gap (a Format
   * on a CRLF document would flip its line endings), left for a future
   * pass since nothing in M5 measures or tests for it; flagged here rather
   * than silently assumed correct. */
  const DEFAULT_FORMAT_INDENT = '  '
  const DEFAULT_FORMAT_NEWLINE: '\n' | '\r\n' = '\n'

  /**
   * M5-PLAN.md H4/H5/H7: runs a Transform via the worker (`transformInWorker`),
   * replaces the buffer, and — per D-046 — pushes exactly one undo entry,
   * but only when `allowUndo` *and* the result actually stayed under
   * `transformConfirmBytes`. `allowUndo` is the caller's own decision
   * (`requestTransform` passes `true` for a document that measured small
   * enough to skip confirmation; `confirmTransformAnyway` passes `false`
   * unconditionally, since the user was already told a Transform at that
   * size wouldn't be undoable) — but Format/Minify can change the byte
   * count substantially (deeply-nested pretty-printed output can run
   * 2-3x the minified input), so a document measured *before* running
   * could still produce an oversized result. Checking
   * `Math.max(oldBytes.length, newBytes.length)` after the transform
   * completes, not just the pre-transform size `requestTransform` saw, is
   * what keeps this honest: the Transform still runs either way (it
   * already ran by the time this check happens — there is no "ask first"
   * once the size is only known after finishing), it just silently isn't
   * made undoable if the result turned out too large. Always triggers a
   * *full* reparse: a Transform rewrites the whole document, so
   * `pendingDirtyRange` is cleared and any in-flight splice is cancelled
   * rather than left to land against bytes it knows nothing about (hard
   * rule 3's "one undo entry" only makes sense if nothing else is also
   * mutating the buffer underneath it).
   */
  async function applyTransform(kind: TransformKind, allowUndo: boolean): Promise<void> {
    if (state.phase !== 'ready') return
    const readyState = state
    if (readyState.document.readOnly) return
    const format = getFormatModule(readyState.document.formatId)
    if (format === undefined || !format.capabilities.canFormat || format.format === undefined) {
      return
    }

    const oldBuffer = readyState.document.sourceBuffer
    const oldBytes = oldBuffer.bytes

    const controller = new AbortController()
    transformAbort?.abort()
    transformAbort = controller
    setState({
      ...state,
      document: { ...state.document, transformInProgress: true, lastTransformWasNoOp: false }
    })

    let output: ArrayBuffer | null
    try {
      const copy = oldBytes.slice().buffer as ArrayBuffer
      output = await transform(copy, {
        formatId: format.capabilities.id,
        options: {
          indent: kind === 'minify' ? '' : DEFAULT_FORMAT_INDENT,
          newline: DEFAULT_FORMAT_NEWLINE
        },
        signal: controller.signal
      })
    } catch (err) {
      if (transformAbort !== controller) return // superseded by a newer transform
      transformAbort = null
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (state.phase === 'ready') {
          setState({ ...state, document: { ...state.document, transformInProgress: false } })
        }
        return
      }
      if (state.phase === 'ready') {
        setState({
          ...state,
          document: {
            ...state.document,
            pendingParseError: describeError(err),
            transformInProgress: false
          }
        })
      }
      return
    }
    if (transformAbort !== controller) return
    transformAbort = null
    // The document this was for may have closed, switched, or been edited
    // again while the worker was running — same staleness check `save`
    // makes after its own await, for the same reason.
    if (
      state.phase !== 'ready' ||
      state.document.filePath !== readyState.document.filePath ||
      state.document.sourceBuffer !== oldBuffer
    ) {
      return
    }

    // M5g-PLAN.md O1: `format()` on an already-canonical document returns
    // its input back byte-identical — the reported sluggishness with "no
    // visible change" was exactly this case. The worker already did this
    // comparison (it holds both copies; the renderer only ever gets the
    // new one) and signals it by resolving `null` instead of transferring
    // the result back. Skip the buffer swap, the reparse, the undo entry
    // and the dirty flag entirely rather than spending the whole pipeline
    // to reproduce the document that was already open.
    if (output === null) {
      setState({
        ...state,
        document: { ...state.document, transformInProgress: false, lastTransformWasNoOp: true }
      })
      return
    }

    const newBytes = new Uint8Array(output)

    // See this function's own doc comment: re-checked against the actual
    // output size, not just the pre-transform size `requestTransform` saw.
    const resultSmallEnough = Math.max(oldBytes.length, newBytes.length) < transformConfirmBytes

    if (allowUndo && resultSmallEnough) {
      // Closes off any in-progress typing burst first — a Transform must
      // never merge into a burst of keystrokes as if it were more typing
      // (§5.6's "always exactly one entry, however much text it rewrote").
      flushUndoBurst()
      const patch: Patch = { start: 0, end: oldBytes.length, replacement: newBytes }
      const inverse = inversePatchOf(oldBytes, patch)
      const selection = recordCurrentSelection()
      undoState = pushEntry(
        undoState,
        {
          patches: [patch],
          inverses: [inverse],
          selectionBefore: selection,
          selectionAfter: selection,
          // A single whole-document patch has no overlap/ordering question
          // to get wrong either way; `true` is the accurate description
          // (built directly against `oldBytes`, not incrementally).
          independent: true
        },
        deps.undoMaxDepth ?? DEFAULT_UNDO_MAX_DEPTH
      )
      syncUndoContext()
    }

    const sourceBuffer = new SourceBuffer(newBytes, oldBuffer.encoding, oldBuffer.bomLength)
    setCtx('isDirty', true)
    setCtx('hasPendingTransform', false)
    setState({
      ...state,
      document: {
        ...state.document,
        sourceBuffer,
        dirty: true,
        reparsePending: true,
        pendingTransform: null,
        transformInProgress: false,
        // R100: a Transform rewrites the buffer outside the Raw editor.
        externalRewrites: state.document.externalRewrites + 1
      }
    })
    // A Transform rewrites the whole document — the reparse it triggers is
    // always a full one, never a splice (hard rule per H4). Clearing
    // `pendingDirtyRange` and cancelling any in-flight splice job is what
    // makes `beginTrySpliceReparse` refuse immediately rather than compute
    // a splice against a dirty range that describes the buffer *before*
    // this replaced it wholesale.
    pendingDirtyRange = null
    reparseScheduler.cancel()
    reparseAbort?.abort()
    spliceJobSlot.cancel()
    void runReparse()
  }

  /** R90 — see the interface's own doc comment for the shape and the
   * split with the caller's confirm-above-50,000-matches gate. */
  function applyReplaceAll(
    matches: readonly ReplaceMatch[],
    replacementText: string
  ): ReplaceOutcome {
    if (state.phase !== 'ready') {
      return { ok: false, reason: { kind: 'not-ready' }, message: 'No document is open.' }
    }
    if (state.document.readOnly) {
      return { ok: false, reason: { kind: 'read-only' }, message: 'This file is read-only.' }
    }
    const oldBuffer = state.document.sourceBuffer
    const replacement = encodeForRoundTrip(replacementText, oldBuffer.encoding)
    if (replacement === null) {
      if (!canEncode(oldBuffer.encoding)) {
        return {
          ok: false,
          reason: { kind: 'unsupported-encoding', encoding: oldBuffer.encoding },
          message: `Klados can't write ${oldBuffer.encoding} — it isn't a single-byte encoding.`
        }
      }
      const character = findUnrepresentableCharacter(replacementText, oldBuffer.encoding) ?? ''
      return {
        ok: false,
        reason: { kind: 'unrepresentable-character', encoding: oldBuffer.encoding, character },
        message: `${oldBuffer.encoding} can't represent "${character}". The rest of the edit was not applied.`
      }
    }
    if (matches.length === 0) return { ok: true, replacedCount: 0, undoable: true }

    const oldBytes = oldBuffer.bytes
    // Sorted ascending here rather than trusted from the caller — every
    // production call site happens to pass `SearchResult.starts`, which is
    // already ascending, but "back to front" (below) only keeps every
    // patch's offsets valid if ascending-then-reversed is actually
    // descending; a caller that passed matches out of order would
    // otherwise corrupt the buffer silently. To build `(patch, inverse)`
    // pairs against the *original* buffer, then reversed for actual
    // application. Every inverse is sliced from `oldBytes` at the match's
    // own original offsets — safe regardless of application order, since
    // none of these spans overlap and slicing happens before anything is
    // spliced.
    const sortedAscending = [...matches].sort((a, b) => a.start - b.start)
    const patchesAscending: Patch[] = sortedAscending.map((match) => ({
      start: match.start,
      end: match.end,
      replacement
    }))
    const inversesAscending = patchesAscending.map((patch) => inversePatchOf(oldBytes, patch))

    // Applied back to front (§6's own "Apply back to front"): descending by
    // `start` means each splice only ever shifts bytes *after* its own
    // range, which is exactly the region every not-yet-applied (smaller
    // `start`) patch never touches — so every patch's original offsets
    // stay valid throughout, with nothing to recompute.
    const patchesDescending = [...patchesAscending].reverse()
    const inversesDescending = [...inversesAscending].reverse()

    // R108: one allocation, not one per match — `patchesAscending` is
    // already ascending, non-overlapping and valid against `oldBytes`
    // (every match comes from Find, which never returns overlapping
    // spans), exactly `applyPatchesAscending`'s precondition. The old
    // per-match `applyPatch` loop copied the whole document once per
    // match — O(document × matches), measured taking minutes at the
    // reported match count (`docs/FINDINGS.md`).
    const bytes = applyPatchesAscending(oldBytes, patchesAscending)

    // A Replace All must never merge into a burst of typing (§5.6's
    // "always exactly one entry, however much text it rewrote") — same
    // rule `applyTransform` follows for the same reason.
    flushUndoBurst()

    // §6, "Do not invent a second undo threshold": reuses the same figure
    // `computeUndoStats`/`document.undoBytes` already track the stack
    // against, rather than a Replace-All-specific number. The caller
    // (`FindBar`) is expected to have already computed this same estimate
    // via `estimateReplaceAllUndoBytes` to warn the user before showing
    // the confirmation; this is the authoritative, re-checked decision —
    // not a re-derivation, but not blindly trusted from the caller either.
    const estimatedEntryBytes = estimateReplaceAllUndoBytes(matches, replacement.byteLength)
    const undoable = state.document.undoBytes + estimatedEntryBytes <= totalMemoryBudgetBytes
    if (undoable) {
      const selection = recordCurrentSelection()
      undoState = pushEntry(
        undoState,
        {
          patches: patchesDescending,
          inverses: inversesDescending,
          selectionBefore: selection,
          selectionAfter: selection,
          // R109: every match is non-overlapping and independently valid
          // against a single shared baseline — `UndoEntry.independent`'s
          // own doc comment on why that's what makes the fast undo/redo
          // path sound here and unsound for an ordinary typing burst.
          independent: true
        },
        deps.undoMaxDepth ?? DEFAULT_UNDO_MAX_DEPTH
      )
      syncUndoContext()
    }

    const sourceBuffer = new SourceBuffer(bytes, oldBuffer.encoding, oldBuffer.bomLength)
    setCtx('isDirty', true)
    setState({
      ...state,
      document: {
        ...state.document,
        sourceBuffer,
        dirty: true,
        reparsePending: true,
        lastTransformWasNoOp: false,
        pendingSpanDeltas: EMPTY_DELTA_LIST,
        // R100: Replace/Replace All rewrites the buffer outside the Raw editor.
        externalRewrites: state.document.externalRewrites + 1
      }
    })
    // A whole-document rewrite, same as a Transform — never a splice (the
    // dirty range this tracks describes the buffer *before* this replaced
    // it, and would misdirect `beginTrySpliceReparse` into grafting against
    // bytes it knows nothing about).
    pendingDirtyRange = null
    reparseScheduler.cancel()
    reparseAbort?.abort()
    spliceJobSlot.cancel()
    void runReparse()

    return { ok: true, replacedCount: matches.length, undoable }
  }

  function requestTransform(kind: TransformKind): void {
    if (state.phase !== 'ready' || state.document.readOnly) return
    const format = getFormatModule(state.document.formatId)
    if (format === undefined || !format.capabilities.canFormat) return

    const size = state.document.sourceBuffer.bytes.length
    if (size >= transformConfirmBytes) {
      pendingTransformRequest = kind
      setCtx('hasPendingTransform', true)
      setState({
        ...state,
        document: { ...state.document, pendingTransform: { kind, estimatedBytes: size } }
      })
      return
    }
    void applyTransform(kind, true)
  }

  function confirmTransformAnyway(): void {
    if (state.phase !== 'ready' || state.document.pendingTransform === null) return
    const kind = pendingTransformRequest ?? state.document.pendingTransform.kind
    pendingTransformRequest = null
    setCtx('hasPendingTransform', false)
    setState({ ...state, document: { ...state.document, pendingTransform: null } })
    // D-046: a Transform confirmed at this size is not made undoable — see
    // that decision for the reasoning and the byte figure behind it.
    void applyTransform(kind, false)
  }

  function cancelTransform(): void {
    if (state.phase !== 'ready' || state.document.pendingTransform === null) return
    pendingTransformRequest = null
    setCtx('hasPendingTransform', false)
    setState({ ...state, document: { ...state.document, pendingTransform: null } })
  }

  function dismissMinifiedBanner(): void {
    if (state.phase !== 'ready' || state.document.minifiedBannerDismissed) return
    setState({ ...state, document: { ...state.document, minifiedBannerDismissed: true } })
  }

  function clearUndoHistory(): void {
    if (state.phase !== 'ready') return
    undoBurstScheduler.cancel()
    pendingUndoBurst = null
    undoState = EMPTY_UNDO_STACK
    syncUndoContext()
  }

  /**
   * R176 (`docs/plans/R175-self-write-suppression.md` §8) — a successful save
   * resolves any pending external-change state.
   *
   * Independent of R175's suppression and still needed once it lands. If a
   * *genuine* external change is pending and the user answers it by saving,
   * their bytes are now the file's contents: the prompt asking whether to
   * discard "your unsaved edits" is stale, there are no unsaved edits, and
   * **Reload and Discard** would reload their own content over the top of it.
   *
   * **The abort is the load-bearing half**, and it is R169's finding in the
   * one other place a reload can be superseded. `keepMine` had to learn this:
   * clearing the banner does not stop a reload already in flight, so the
   * button that exists to protect unsaved edits let them be destroyed a
   * moment later. Dropping the controller is what makes `reloadFromDisk`'s own
   * `reloadAbort !== controller` checks bail before committing; `abort()`
   * additionally rejects the in-flight `parseFromUrl` rather than letting it
   * run to completion and be discarded.
   *
   * Callers apply this only inside their own post-`await` guards — still
   * `ready`, still the same `filePath`, still the same `sourceBuffer`.
   *
   * Side-effecting as well as returning: it aborts the in-flight reload and
   * lowers the context key, then hands back the document fields to spread —
   * the same shape and the same order `keepMine` uses.
   */
  function clearExternalChangeAfterSave(document: OpenDocument): OpenDocument {
    reloadAbort?.abort()
    reloadAbort = null
    setCtx('hasExternalChange', false)
    return { ...document, externalChangeDetected: false, reloadPending: false }
  }

  async function save(): Promise<SaveOutcome> {
    if (state.phase !== 'ready') {
      return { ok: false, message: 'No document is open.' }
    }
    if (state.document.readOnly) {
      return { ok: false, message: 'This file is read-only.' }
    }
    const api = getApi()
    if (api === undefined) {
      return { ok: false, message: 'The document API is unavailable.' }
    }
    const { filePath, sourceBuffer } = state.document
    const outcome = await saveDocument(api, { path: filePath, bytes: sourceBuffer.bytes })
    // Re-checked after the `await`, not just at the top. `filePath` catches
    // a document close or a switch to a different file landing while the
    // write was in flight. `sourceBuffer` identity (every `applyEdit`
    // replaces it, F1) catches the narrower case a bare `filePath` check
    // misses: a *newer edit to this same document* landing mid-write — the
    // bytes actually on disk are the pre-edit ones, so clearing `dirty`
    // here would be wrong even though the file didn't change.
    if (
      outcome.ok &&
      state.phase === 'ready' &&
      state.document.filePath === filePath &&
      state.document.sourceBuffer === sourceBuffer
    ) {
      setCtx('isDirty', false)
      setState({
        ...state,
        document: { ...clearExternalChangeAfterSave(state.document), dirty: false }
      })
    }
    return outcome
  }

  async function saveAs(): Promise<SaveAsOutcome> {
    if (state.phase !== 'ready') {
      return { ok: false, message: 'No document is open.' }
    }
    const api = getApi()
    if (api === undefined) {
      return { ok: false, message: 'The document API is unavailable.' }
    }
    const { filePath, sourceBuffer } = state.document
    const picked = await api.document.saveAsDialog(filePath)
    if (picked === null) return { ok: true, cancelled: true }
    // Re-checked after the dialog resolves — it waits on the user, so it
    // can sit open arbitrarily long. If the document this save was *for*
    // closed, was replaced by a different file, or was edited again while
    // the dialog was up, `picked.path` was chosen for something that, from
    // here, no longer exists in that form. Applying it anyway would stamp
    // whatever document happens to be open now with a path nobody actually
    // chose for it — silently redirecting its future saves there.
    if (
      state.phase !== 'ready' ||
      state.document.filePath !== filePath ||
      state.document.sourceBuffer !== sourceBuffer
    ) {
      return { ok: false, message: 'The document changed before Save As completed.' }
    }
    const outcome = await saveDocument(api, { path: picked.path, bytes: sourceBuffer.bytes })
    if (
      outcome.ok &&
      state.phase === 'ready' &&
      state.document.filePath === filePath &&
      state.document.sourceBuffer === sourceBuffer
    ) {
      setCtx('isReadOnly', false)
      setCtx('isDirty', false)
      setState({
        ...state,
        document: {
          ...clearExternalChangeAfterSave(state.document),
          filePath: picked.path,
          fileName: picked.fileName,
          readOnly: false,
          dirty: false
        }
      })
      // R95 (`R95-recent-files.md` §2): after a Save As the document being
      // edited *is* that path — a recent list missing the most recent file
      // of all would be wrong. `formatId` doesn't change on a Save As.
      recordRecentFile({
        path: picked.path,
        fileName: picked.fileName,
        formatId: state.document.formatId
      })
    }
    return outcome
  }

  /**
   * F8 (§11.3) — re-reads the current file and replaces the live document
   * with it, discarding whatever unsaved edits exist. The undo/redo stack
   * is cleared too: its entries are patches against the buffer that
   * existed *before* the reload, which no longer exists in any form the
   * stack could sensibly reverse into. Selection is carried across via
   * F5's own cascade — the reload produces a brand new store exactly the
   * way an ordinary reparse does, so the same machinery applies.
   */
  async function reloadFromDisk(): Promise<ReloadOutcome> {
    if (state.phase !== 'ready') return { ok: false, message: 'No document is open.' }
    const api = getApi()
    if (api === undefined) return { ok: false, message: 'The document API is unavailable.' }
    const { filePath, fileName } = state.document

    const controller = new AbortController()
    reloadAbort?.abort()
    reloadAbort = controller
    // R169: raised *before* the first await, so the acknowledgement is on
    // screen within the same frame as the click even though the work behind
    // it takes as long as it takes. `clearReloadPending` is what lowers it,
    // on every exit — including the ones that return early.
    setReloadPending(true)
    // Cancelled up front, not just cleaned up on success: an ordinary
    // debounced reparse (`runReparse`) racing this reload writes to the
    // same `document.store`/`sourceBuffer` fields via entirely separate
    // bookkeeping (`reparseAbort`) that doesn't know about `reloadAbort`.
    // Aborting it here — before either of this function's own awaits —
    // means it can never resolve *after* this reload commits and clobber
    // it; if it was already past its own point of no return, its result
    // still lands (harmlessly) before this one and gets fully overwritten
    // below regardless.
    reparseScheduler.cancel()
    reparseAbort?.abort()
    reparseAbort = null
    // M5-PLAN.md H2d: same reasoning — a splice mid-graft from before this
    // reload must not land afterward and clobber it.
    spliceJobSlot.cancel()
    // M5-PLAN.md H7: same reasoning — a Transform in flight for the
    // pre-reload buffer must not land afterward either.
    transformAbort?.abort()
    transformAbort = null
    pendingTransformRequest = null

    // M5-PLAN.md H12: same token-mint + worker-fetch route as `startParse` —
    // see that function's own comment.
    let token: string
    try {
      token = await api.document.mintReadToken(filePath)
    } catch {
      // R169: the document is left showing as-is, which is right — but this
      // used to be the whole of it, so a reload of a file that had since been
      // deleted or locked was indistinguishable from a reload that did
      // nothing. The caller turns this into a visible explanation.
      reloadAbort = null
      clearReloadPending()
      return {
        ok: false,
        message: `Could not read ${fileName}. It may have been moved or deleted.`
      }
    }
    // Superseded — by "Keep Mine" (R169) or by a newer reload. Not a failure:
    // `reloadAbort` no longer being this controller means someone else is now
    // responsible for the flag, so this path must not lower it.
    if (reloadAbort !== controller) return { ok: true, cancelled: true }
    if (state.phase !== 'ready' || state.document.filePath !== filePath) {
      reloadAbort = null
      clearReloadPending()
      return { ok: true, cancelled: true }
    }

    let result: ParseClientResult
    try {
      result = await parseFromUrl(readTokenUrl(token), {
        filename: fileName,
        signal: controller.signal
      })
    } catch {
      // An abort lands here too — `parseFromUrl` rejects on `controller.signal`
      // — so a cancellation must not be reported as a failure. The controller
      // identity is what tells them apart: a supersession replaced it.
      const superseded = reloadAbort !== controller
      if (!superseded) {
        reloadAbort = null
        clearReloadPending()
      }
      return superseded
        ? { ok: true, cancelled: true }
        : {
            ok: false,
            message: `Could not reload ${fileName}. The file may be invalid or unreadable.`
          }
    }
    if (reloadAbort !== controller) return { ok: true, cancelled: true }
    reloadAbort = null
    if (state.phase !== 'ready' || state.document.filePath !== filePath) {
      clearReloadPending()
      return { ok: true, cancelled: true }
    }

    const oldStore = state.document.store
    const oldSelectedNode = state.selection.selectedNode
    const { node, offset } = deriveErrorInfo(result)
    const resolved = reresolveSelection(
      oldStore,
      oldSelectedNode,
      result.store,
      state.selection.caretOffset
    )

    setCtx('hasSelection', resolved.node !== NO_SELECTION)
    setCtx('hasDiagnostics', result.diagnostics.length > 0)
    setCtx('isDirty', false)
    setCtx('hasExternalChange', false)
    setCtx('hasPendingTransform', false)
    if (resolved.node !== NO_SELECTION) {
      setCtx('nodeKind', kindLabelOf(result.store.kindOf(resolved.node)))
    }
    // F10/D-036: a reload's own new store is a fresh baseline, same as any
    // other successful reparse — nothing dirty relative to *this* store yet.
    pendingDirtyRange = null
    lastParsedByteLength = result.sourceBuffer.bytes.length
    setState({
      ...state,
      document: {
        ...state.document,
        store: result.store,
        sourceBuffer: result.sourceBuffer,
        rowIndex: result.rowIndex,
        lineIndex: result.lineIndex,
        nameIndex: result.nameIndex,
        diagnostics: result.diagnostics,
        complete: result.complete,
        errorNode: node,
        errorOffset: offset,
        pendingParseError: null,
        dirty: false,
        reparsePending: false,
        externalChangeDetected: false,
        // R169: the reload has committed, so both the banner and the
        // acknowledgement it replaced go down together, in this same
        // `setState` — which is what makes the banner's disappearance
        // coincide with the content actually changing.
        reloadPending: false,
        pendingTransform: null,
        transformInProgress: false,
        // R42/D-070: same fresh-baseline reasoning as `pendingDirtyRange`
        // above — a reload's `result.store` is built from `result.
        // sourceBuffer` with nothing yet to translate.
        pendingSpanDeltas: EMPTY_DELTA_LIST,
        // R100: a reload replaces the buffer wholesale from disk, outside
        // the Raw editor.
        externalRewrites: state.document.externalRewrites + 1
      },
      selection: { selectedNode: resolved.node, caretOffset: state.selection.caretOffset }
    })
    if (!resolved.silent && resolved.node !== NO_SELECTION) {
      requestReveal(resolved.node, result.store)
    }

    // The ordinary reparse scheduler was already cancelled up front (see
    // above) — old undo entries are patches against the pre-reload buffer,
    // which no longer exists in any form they could reverse into.
    undoBurstScheduler.cancel()
    pendingUndoBurst = null
    undoState = EMPTY_UNDO_STACK
    syncUndoContext()
    // `reloadPending` was lowered by the `setState` above, in the same commit
    // that swapped the document — not here — so there is no frame in which the
    // new content is showing while the acknowledgement is still up.
    return { ok: true }
  }

  /** The main process's own change notification — CONCEPT.md §11.3's own
   * two behaviors, dispatched on whether there's anything unsaved to
   * protect. */
  async function handleExternalChange(): Promise<void> {
    if (state.phase !== 'ready') return
    if (!state.document.dirty) {
      await reloadFromDisk()
      return
    }
    setCtx('hasExternalChange', true)
    setState({ ...state, document: { ...state.document, externalChangeDetected: true } })
  }

  async function reloadAndDiscard(): Promise<ReloadOutcome> {
    return reloadFromDisk()
  }

  function keepMine(): void {
    if (state.phase !== 'ready') return
    // R169: **cancel a reload that is already in flight.** Dropping the
    // controller is what makes `reloadFromDisk`'s own `reloadAbort !==
    // controller` checks bail before committing; `abort()` additionally
    // rejects an in-flight `parseFromUrl` through `controller.signal`
    // rather than leaving it to run to completion and be discarded.
    //
    // Without this, "Keep Mine" cleared the banner and the reload landed
    // moments later anyway — so the button that exists to protect unsaved
    // edits destroyed them. Reproduced against the real session before it
    // was fixed, and the reproduction is now `keepMine cancels a reload
    // already in flight` in `documentSession.test.ts`.
    reloadAbort?.abort()
    reloadAbort = null
    setCtx('hasExternalChange', false)
    setState({
      ...state,
      document: { ...state.document, externalChangeDetected: false, reloadPending: false }
    })
  }

  /**
   * R169 — raises or lowers the in-flight flag without disturbing anything
   * else on the document.
   *
   * Guarded on `phase`, because every call site is either side of an await
   * and the document can close underneath one. Guarded on the current value
   * too: `setState` notifies subscribers, and a no-op notification during a
   * reload is a re-render of every pane for nothing.
   */
  function setReloadPending(pending: boolean): void {
    if (state.phase !== 'ready') return
    if (state.document.reloadPending === pending) return
    setState({ ...state, document: { ...state.document, reloadPending: pending } })
  }

  function clearReloadPending(): void {
    setReloadPending(false)
  }

  /** R24-tabs.md: writes real `setContext` calls, unconditionally — every
   * key this file ever mutates elsewhere, mirroring exactly what those
   * gated (`setCtx`) call sites would have written had this session been
   * active the whole time. `tabs.ts` calls this immediately after making a
   * tab active, so the panes it's about to render read this tab's state,
   * not whatever the previously active tab last wrote. */
  function resyncContext(): void {
    if (state.phase !== 'ready') {
      // Not `resetContextForNoDocument()` — that goes through the gated
      // `setCtx` and would silently no-op if this is ever called before
      // `tabs.ts` has actually flipped `activeTabId` to this session's own
      // id, contradicting "writes for real, unconditionally" above.
      setContext('format', null)
      setContext('isReadOnly', true)
      setContext('hasSelection', false)
      setContext('hasDiagnostics', false)
      setContext('isDirty', false)
      setContext('canFormat', false)
      setContext('hasPendingTransform', false)
      setContext('hasExternalChange', false)
      setContext('nodeKind', null)
      setContext('canUndo', false)
      setContext('canRedo', false)
      return
    }
    const { document, selection } = state
    setContext('format', document.formatId)
    setContext('canFormat', getFormatModule(document.formatId)?.capabilities.canFormat ?? false)
    setContext('isReadOnly', document.readOnly)
    setContext('hasSelection', selection.selectedNode !== NO_SELECTION)
    setContext('hasDiagnostics', document.diagnostics.length > 0)
    setContext('isDirty', document.dirty)
    setContext('hasExternalChange', document.externalChangeDetected)
    setContext('hasPendingTransform', document.pendingTransform !== null)
    // Unlike every other key here, `nodeKind` is never cleared by the
    // gated call sites elsewhere in this file (a pre-existing gap harmless
    // in a single-document world, since a selection change always sets it
    // fresh) — but `resyncContext`'s whole point is that the newly active
    // tab's context must never carry over a stale value from whichever tab
    // was active before, so this is the one place that has to clear it
    // explicitly rather than mirror the gap.
    setContext(
      'nodeKind',
      selection.selectedNode !== NO_SELECTION
        ? kindLabelOf(document.store.kindOf(selection.selectedNode))
        : null
    )
    setContext('canUndo', canUndo(undoState))
    setContext('canRedo', canRedo(undoState))
  }

  function dispose(): void {
    unsubscribeExternalChange?.()
    // R52: under the single-watcher predecessor this was harmless to skip
    // (a closed tab's watcher just got silently overwritten by whatever
    // watched next); per-key registration means skipping it now would leak
    // this key's entry in main's registry forever.
    void getApi()?.document.unwatch(watchKey)
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    openFileDialog,
    openPath,
    confirmOpenAnyway,
    cancel,
    setSelectedNode,
    setCaretOffset,
    applyEdit,
    applyReplaceAll,
    undo,
    redo,
    save,
    saveAs,
    reloadAndDiscard,
    keepMine,
    requestTransform,
    confirmTransformAnyway,
    cancelTransform,
    dismissMinifiedBanner,
    clearUndoHistory,
    resyncContext,
    dispose
  }
}
