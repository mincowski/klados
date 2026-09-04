/**
 * The debounce half of M3-PLAN.md F3 (CONCEPT.md §5.1: "~200 ms idle,
 * never per keystroke"). Deliberately just a timer — no parsing, no
 * cancellation of an in-flight parse, no session state. `documentSession.ts`
 * owns all of that (the same `AbortController`-based supersede discipline
 * it already uses for opens, per M3-PLAN.md F3's own note that this had a
 * real bug once, `174606f`); this module's only job is "call `run` once,
 * `delayMs` after the last `trigger()`," kept separate because that's the
 * one piece cleanly testable with fake timers and nothing else.
 */

export const REPARSE_DEBOUNCE_MS = 200

export interface DebouncedReparse {
  /** Call on every edit. Resets the idle timer — a burst of calls closer
   * together than `delayMs` produces exactly one eventual `run()`. */
  trigger(): void
  /** Cancels a pending (not yet fired) timer. Has no effect on a `run()`
   * already in progress — cancelling that is the caller's own concern
   * (an in-flight reparse), not this scheduler's. */
  cancel(): void
}

export function createDebouncedReparse(
  run: () => void,
  delayMs: number = REPARSE_DEBOUNCE_MS
): DebouncedReparse {
  let timer: ReturnType<typeof setTimeout> | null = null

  function trigger(): void {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      run()
    }, delayMs)
  }

  function cancel(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  return { trigger, cancel }
}
