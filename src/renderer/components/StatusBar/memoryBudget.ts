/**
 * M5-PLAN.md H9, CONCEPT.md §8's budget table shape. A computed sum from
 * known array lengths, not `performance.memory` — exact, cheap (every
 * figure here is a `.byteLength` or an existing `packedMemoryBytes`
 * getter, never a fresh scan), and doesn't vary with GC timing the way a
 * sampled heap figure would. Recomputed on every render from the live
 * `OpenDocument` rather than cached in session state, which is what makes
 * it update after a Transform (H7) for free — there is nothing to
 * invalidate.
 *
 * M5f-PLAN.md §3a: the undo stack is now a counted component, not a
 * separate curiosity — before R12 this function omitted it entirely, so
 * the total Klados reported was wrong by up to ~2x the document right
 * after a Format (M5g-PLAN.md §1.4). `undoBytes`/`undoEntryCount` come
 * off `OpenDocument` directly (kept current by `documentSession.ts`'s
 * `syncUndoContext`, at exactly the points the stack changes), preserving
 * this function's own O(1) property — it does not walk the stack itself.
 */
import type { OpenDocument } from '../../session/documentSession'

export interface MemoryBudget {
  readonly sourceBufferBytes: number
  /** Node store plus attribute table — `NodeStore.packedMemoryBytes`
   * already combines both, per §8's own table treating them as one
   * component's worth of accounting. */
  readonly nodeStoreBytes: number
  readonly rowIndexBytes: number
  readonly lineIndexBytes: number
  readonly nameIndexBytes: number
  /** §8 calls this "negligible" — summed in anyway rather than
   * special-cased to zero, so the total stays exact rather than
   * approximately exact. */
  readonly internerBytes: number
  /** Every `patch`/`inverse` byte retained across every undo entry,
   * redo entries included (`computeUndoStats`, `undoStack.ts`). */
  readonly undoBytes: number
  readonly undoEntryCount: number
  readonly totalBytes: number
}

export function computeMemoryBudget(document: OpenDocument): MemoryBudget {
  const sourceBufferBytes = document.sourceBuffer.byteLength
  const nodeStoreBytes = document.store.packedMemoryBytes
  const rowIndexBytes = document.rowIndex.byteLength
  const lineIndexBytes = document.lineIndex.checkpoints.byteLength
  const nameIndexBytes = document.nameIndex.starts.byteLength + document.nameIndex.nodes.byteLength
  const internerBytes = document.store.interner.packedMemoryBytes
  const undoBytes = document.undoBytes
  const undoEntryCount = document.undoEntryCount
  return {
    sourceBufferBytes,
    nodeStoreBytes,
    rowIndexBytes,
    lineIndexBytes,
    nameIndexBytes,
    internerBytes,
    undoBytes,
    undoEntryCount,
    totalBytes:
      sourceBufferBytes +
      nodeStoreBytes +
      rowIndexBytes +
      lineIndexBytes +
      nameIndexBytes +
      internerBytes +
      undoBytes
  }
}
