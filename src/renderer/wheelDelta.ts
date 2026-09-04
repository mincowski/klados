/**
 * R45 (`R43-grid-sizing-and-scroll.md`): the horizontal-scroll wheel
 * idiom, shared rather than copied a third time. An ordinary mouse wheel
 * only ever reports `deltaY`; a trackpad or a tilt wheel reports `deltaX`
 * directly. Falling back to `deltaY` when `deltaX` is zero is what makes an
 * ordinary wheel work over a horizontal target at all — `TabStrip.tsx`
 * worked this out first (R36 §3c) for its own tab strip; `Scrollbar.tsx`'s
 * horizontal track (R45, `R43-grid-sizing-and-scroll.md`) is the
 * second consumer, and "not grid-specific — it fixes every horizontal
 * track in the app" is the plan's own reason a shared function, not a
 * second copy, is the right shape now.
 */
export function horizontalWheelDelta(event: {
  readonly deltaX: number
  readonly deltaY: number
}): number {
  return event.deltaX !== 0 ? event.deltaX : event.deltaY
}
