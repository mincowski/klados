/**
 * Lets `klados.find.next`/`klados.find.previous` reach the mounted
 * `FindBar` — same "component registers a live handle with a module-level
 * singleton" shape as `Raw/rawController.ts` and `Detail/gridController.ts`.
 * Registered unconditionally by `FindBar` (mounted once at the app level,
 * regardless of whether the bar is currently open) so F3/Shift+F3 work even
 * when the bar isn't visible — moving to the next match with nothing
 * currently loaded is a no-op, the same "nothing to act on is not an
 * error" reasoning `treeController.ts` already uses.
 */
export interface FindController {
  goNext(): void
  goPrevious(): void
  /** R90 (`R86-find-as-query-surface.md` §6): resolves a Replace All
   * confirmation notification (§11.2's "a confirmation with a number in
   * it") — `klados.find.confirmReplaceAll`/`cancelReplaceAll` are the
   * notification actions, invariant 10's own requirement that a
   * notification action be a command. A no-op with nothing pending, the
   * same tolerance `treeController.ts` gives an act-on-nothing call. */
  confirmReplaceAll(): void
  cancelReplaceAll(): void
}

let current: FindController | null = null

export function registerFindController(controller: FindController): () => void {
  current = controller
  return () => {
    if (current === controller) current = null
  }
}

export function findNext(): void {
  current?.goNext()
}

export function findPrevious(): void {
  current?.goPrevious()
}

export function confirmReplaceAll(): void {
  current?.confirmReplaceAll()
}

export function cancelReplaceAll(): void {
  current?.cancelReplaceAll()
}
