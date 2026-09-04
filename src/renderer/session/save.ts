/**
 * M3-PLAN.md F7 — the write side. CONCEPT.md §5.5: two clearly separated
 * write paths, and this is the one that must never generate text
 * (invariant 6) or silently change encoding (invariant 7).
 *
 * **"Fold pending deltas first" (§5.5/§5.2) needs no code here.** That
 * requirement exists for an architecture where the live buffer is a base
 * plus an unresolved offset-correction list; this one isn't one.
 * `documentSession.ts`'s `applyEdit` (F1) already replaces
 * `document.sourceBuffer` with a fully spliced, complete `Uint8Array` on
 * every edit (`documentEdits.ts`'s `applyPatch`) — there is no separate
 * delta list standing between the live buffer and what's actually on disk
 * to fold. `core/deltaList.ts` (F2) exists for a different problem
 * (keeping *span reads* consistent during the reparse-pending window, per
 * F1's own note), not buffer materialization — so by the time `saveDocument`
 * runs, `context.bytes` already *is* the fully materialized result the
 * requirement asks for.
 *
 * `documentSession.ts` owns *when* to call this (guarding `readOnly`,
 * tracking `dirty`, choosing a path for Save vs. Save As) — this module is
 * just the IPC call and its outcome, the same "pure input, small outcome
 * type" shape `documentEdits.ts`'s `createEdit` has, async only because
 * writing a file inherently is.
 */
import type { KladosApi } from '../../preload/api'

export interface SaveContext {
  readonly path: string
  readonly bytes: Uint8Array
}

export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Writes `context.bytes` to `context.path` verbatim via the injected API —
 * no encode/decode step, no BOM handling: both are already baked into
 * `bytes` (§5.5's "the buffer holds bytes"; a `SourceBuffer`'s own bytes
 * include the BOM, untouched since open, per `main/documents.ts`'s own
 * `document:write` comment). `.slice()` before handing the buffer across
 * the IPC boundary — same defensive copy `documentSession.ts`'s own
 * `runReparse` takes for its worker transfer — costs nothing `write`
 * wasn't already going to pay via `ipcRenderer.invoke`'s structured clone.
 */
export async function saveDocument(
  api: Pick<KladosApi, 'document'>,
  context: SaveContext
): Promise<SaveOutcome> {
  try {
    await api.document.write(context.path, context.bytes.slice().buffer as ArrayBuffer)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }
}
