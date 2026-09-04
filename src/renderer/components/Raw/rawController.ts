/**
 * Lets other UI reach the currently-mounted `Raw` view — D12's manual wrap
 * toggle, D13's scrubber — without threading a callback through the
 * component tree. The same "component registers a live handle with a
 * module-level singleton" shape `focus.ts`'s `registerPane` already uses,
 * and for the same reason: neither a registry command nor a sibling
 * component (the scrubber) has a reference to Raw's own instance. M1 ships
 * exactly one Raw view (no tabs, §11.4), so "the current one" is
 * unambiguous.
 */
export interface RawController {
  toggleWrap(): void
  /** Moves the window to `offset` and positions the caret there — the
   * scrubber's own drag gesture (D13). Deliberately the same primitive
   * "Locate in source" (D14) will use, and just as deliberately *not*
   * anything that touches the document session's selection: CONCEPT.md
   * §4.5 is explicit that navigating the scrubber is not selecting. */
  scrubTo(offset: number): void
}

let current: RawController | null = null

export function registerRawController(controller: RawController): () => void {
  current = controller
  return () => {
    if (current === controller) current = null
  }
}

/** A no-op if no Raw view is mounted (no document open) — a command
 * running with nothing to act on is not an error. */
export function toggleRawWrap(): void {
  current?.toggleWrap()
}

/** Same no-op-when-nothing-mounted reasoning as `toggleRawWrap`. */
export function scrubRawTo(offset: number): void {
  current?.scrubTo(offset)
}
