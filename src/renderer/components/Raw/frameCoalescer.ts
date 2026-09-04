/**
 * M5c-PLAN.md J2 — collapses a burst of same-frame calls (`scroll` can fire
 * several times per frame) into exactly one queued unit of work, the same
 * "collapse a burst into one unit of work" shape `rawViewportStore.ts`'s
 * `quantize` already applies one layer further down. Pure and DOM-free
 * (`requestFrame`/`cancelFrame` are injected) so it can be exercised
 * directly by a test with a fake frame queue — this project has no
 * DOM/browser test environment (`rawEdit.ts`'s own top comment), and the
 * coalescing logic is exactly the part worth asserting against.
 */
export interface FrameCoalescer {
  /** Schedules `work` for the next frame unless one is already pending —
   * a second call before that frame fires is a no-op, not a second queue
   * entry, which is the whole point. */
  request(work: () => void): void
  /** Cancels a pending frame, if any — called on unmount so a callback
   * can't fire after the thing it would act on is gone. */
  cancel(): void
}

export function createFrameCoalescer(
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (id: number) => void
): FrameCoalescer {
  let pendingId: number | null = null

  return {
    request(work) {
      if (pendingId !== null) return
      pendingId = requestFrame(() => {
        pendingId = null
        work()
      })
    },
    cancel() {
      if (pendingId !== null) {
        cancelFrame(pendingId)
        pendingId = null
      }
    }
  }
}
