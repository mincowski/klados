/**
 * M3-PLAN.md F6 — the undo stack. CONCEPT.md §5.6/D-011: the document
 * layer owns one stack, every mutation expressed as a `Patch`. Pure logic
 * only (no session/UI imports), same split as `navigation/history.ts` for
 * back/forward — `documentSession.ts` is the wiring half, the way it
 * already is for F5's `reresolve.ts`.
 *
 * **Why entries hold `Patch[]`, not one `SourceBuffer` snapshot per entry.**
 * `documentSession.applyEdit` already allocates a full new byte buffer per
 * keystroke (`documentEdits.ts`'s own top comment: "a full `Uint8Array`
 * splice per patch, not a rope or gap buffer"). Retaining a *second* full
 * buffer per undo entry would make "bounded stack depth" bound entry
 * *count* while leaving memory unbounded by document size — at 200 MB and
 * a plausible depth in the hundreds, that is tens of gigabytes for
 * something a `Patch` (the edited region only) represents in bytes.
 * CONCEPT.md §5.5 measured exactly this shape of cost elsewhere (holding
 * more than one full document's worth of bytes live at once) and it was
 * disqualifying there too.
 *
 * **Why an entry is a burst of patches, not one merged patch.** Merging
 * two sequential patches into one minimal patch is real interval algebra
 * (the same shape `core/deltaList.ts`'s `fold` does for offset shifts, not
 * byte content) for no benefit here: undo/redo only ever needs to replay
 * or reverse a whole burst atomically, never to inspect a burst's
 * "effective" single range. Storing the sequence and replaying it in
 * order (redo) or reverse order (undo) is simpler and exactly as correct.
 */
import type { NodeRef, Offset } from '../../core/types'
import type { PathSegment } from '../components/Detail/detailModel'
import type { Patch } from './documentEdits'

/** A selection, recorded in a form that outlives the `NodeStore` it was
 * read from — `NodeRef`s are indices into one specific store, and every
 * store between "this entry was recorded" and "undo/redo replays it" has
 * long since been replaced by a reparse. `path` is `pathSegmentsOf`'s own
 * structural-path shape (`reresolve.ts`'s `resolveFromPath` input) —
 * store-independent by construction. Empty means "nothing was selected,"
 * a recorded fact, not "no information" (`resolveFromPath`'s own doc
 * comment explains why that distinction matters). */
export interface RecordedSelection {
  readonly path: readonly PathSegment[]
  readonly caretOffset: Offset
}

export interface UndoEntry {
  /** Forward direction — replayed in this order for redo. */
  readonly patches: readonly Patch[]
  /** Reverse direction — `inverses[i]` undoes `patches[i]`, but only once
   * `patches[i+1..]`'s own effects have already been peeled back; applying
   * the whole entry's undo means walking this array back to front, not in
   * the order stored. */
  readonly inverses: readonly Patch[]
  /** The selection as it was before `patches[0]` — what undo restores. */
  readonly selectionBefore: RecordedSelection
  /** The selection as of this entry closing off (the burst's debounce
   * elapsing) — what redo restores. */
  readonly selectionAfter: RecordedSelection
  /**
   * R109 (`R108-replace-all-quadratic.md` §4): whether `patches`/`inverses`
   * were built as one non-overlapping batch against a single baseline
   * buffer (a Replace All, or a Transform's own whole-document patch) —
   * `true` — or incrementally, one edit at a time against the buffer each
   * prior edit in the burst had already produced (an ordinary typing
   * burst) — `false`.
   *
   * This is *not* an optimization hint `applyUndoEntry` could safely
   * ignore. A typing burst can (and does — repeatedly correcting the same
   * character is the ordinary case) touch the *same* byte range more than
   * once, so its `patches`/`inverses` overlap; a single ascending pass
   * over overlapping ranges is not just slower, it is a different,
   * <strong>wrong</strong> operation, and `applyPatchesAscending`'s own
   * precondition explicitly excludes this shape. A Replace All's matches
   * are guaranteed non-overlapping (they come from Find), which is what
   * makes `true` sound for it and unsound in general.
   */
  readonly independent: boolean
}

export interface UndoStackState {
  readonly entries: readonly UndoEntry[]
  readonly index: number
}

export const EMPTY_UNDO_STACK: UndoStackState = { entries: [], index: 0 }

/**
 * Appends `entry`, discarding anything past the current position first —
 * the standard rule (same one `history.ts`'s `recordVisit` applies): once
 * you've undone partway back and then make a new edit, the undone entries
 * are no longer a valid "future," so redo can no longer reach them.
 * `maxDepth` bounds memory by dropping the *oldest* surviving entry, never
 * the one just pushed.
 */
export function pushEntry(
  state: UndoStackState,
  entry: UndoEntry,
  maxDepth: number
): UndoStackState {
  const truncated = state.entries.slice(0, state.index)
  const appended = [...truncated, entry]
  const overflow = Math.max(0, appended.length - maxDepth)
  return { entries: appended.slice(overflow), index: appended.length - overflow }
}

/** M5f-PLAN.md §3a: the undo stack as a component of the memory budget,
 * not a separate curiosity — `computeMemoryBudget` had never counted it at
 * all, so the total Klados reported was wrong by up to ~2x the document
 * right after a Format. Sums `replacement.byteLength` across every `patch`
 * *and* every `inverse` of *every* entry, regardless of `state.index` —
 * redo entries (above the cursor) are real retained bytes for as long as
 * they exist, not free just because they're not the "current" direction.
 * O(entries), not O(bytes): bounded by `DEFAULT_UNDO_MAX_DEPTH`.
 * `RecordedSelection`'s path strings are excluded as genuinely negligible
 * next to the patch bytes they sit alongside. */
export interface UndoStats {
  readonly bytes: number
  readonly entryCount: number
}

export function computeUndoStats(state: UndoStackState): UndoStats {
  let bytes = 0
  for (const entry of state.entries) {
    for (const patch of entry.patches) bytes += patch.replacement.byteLength
    for (const inverse of entry.inverses) bytes += inverse.replacement.byteLength
  }
  return { bytes, entryCount: state.entries.length }
}

export function canUndo(state: UndoStackState): boolean {
  return state.index > 0
}

export function canRedo(state: UndoStackState): boolean {
  return state.index < state.entries.length
}

export interface UndoStep {
  readonly state: UndoStackState
  readonly entry: UndoEntry
}

/** `null` when nothing is undoable. The caller applies `entry.inverses`
 * back to front (see `UndoEntry.inverses`'s own doc comment). */
export function undoStep(state: UndoStackState): UndoStep | null {
  if (!canUndo(state)) return null
  const index = state.index - 1
  return { state: { ...state, index }, entry: state.entries[index]! }
}

/** `null` when nothing is redoable. The caller applies `entry.patches`
 * front to back — the order they were originally made in. */
export function redoStep(state: UndoStackState): UndoStep | null {
  if (!canRedo(state)) return null
  const entry = state.entries[state.index]!
  return { state: { ...state, index: state.index + 1 }, entry }
}

/** `Patch` carries only the replacement — not what it replaced — so its
 * own inverse has to be computed from the buffer it was cut from, before
 * the cut. `preEditBytes` is that buffer; `patch.start`/`patch.end` are
 * already in its coordinates (the range this same patch just spliced
 * out), so the inverse's own range is `[patch.start, patch.start +
 * replacement.length)` — where the replacement now lives — restoring the
 * bytes the forward patch removed. */
export function inversePatchOf(preEditBytes: Uint8Array, patch: Patch): Patch {
  return {
    start: patch.start,
    end: patch.start + patch.replacement.length,
    replacement: preEditBytes.slice(patch.start, patch.end)
  }
}

/** A ref no store will ever allocate, `documentSession.ts`'s own
 * `NO_SELECTION` value duplicated locally for the same "this module's
 * caller is the one place that constant means anything, don't import back
 * to it" reason `reresolve.ts` gives for its own copy. */
const NO_SELECTION: NodeRef = -1

/** `[]` when `node` is `NO_SELECTION` — "nothing was selected" recorded as
 * a fact `resolveFromPath` restores exactly, not degraded into "no
 * information" (see its own doc comment on why those differ). Otherwise
 * defers to the caller for the actual `pathSegmentsOf` call, since that
 * needs the live `NodeStore` this module deliberately doesn't depend on. */
export function recordedSelectionOf(
  node: NodeRef,
  caretOffset: Offset,
  pathOf: (node: NodeRef) => readonly PathSegment[]
): RecordedSelection {
  return { path: node === NO_SELECTION ? [] : pathOf(node), caretOffset }
}
