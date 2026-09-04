/**
 * Raw → Scrubber, one-way (UI-FEEDBACK.md M5b: "the thumb shows the
 * viewport, not the window" — D-031's own window must stay invisible, but
 * the visible *viewport* within it is exactly what a scroll thumb
 * conventionally means). `rawController.ts` already carries the opposite
 * direction (Scrubber → Raw, `scrubTo`); this is the other half, following
 * the same "module-level store, `useSyncExternalStore` on the read side"
 * shape `findStore.ts` uses, since neither side has a component reference
 * to the other.
 *
 * `Raw.tsx`'s `onScroll` fires once per scroll frame — publishing the raw
 * ratio on every call would re-render the scrubber that often for no
 * visible difference, so `publishRawViewport` quantizes before comparing
 * against the last published value and only notifies on an actual change.
 */
export interface RawViewport {
  readonly topRatio: number
  readonly bottomRatio: number
}

const EMPTY: RawViewport = { topRatio: 0, bottomRatio: 0 }

/** Quantization step — finer than any screen's practical scrubber height in
 * pixels, so this reads as continuous while still collapsing the flood of
 * near-identical ratios one `scroll` event produces into far fewer
 * publishes. Not derived from the strip's actual rendered height: this
 * module has no DOM reference to it, by the same design as
 * `scrubberModel.ts`'s own position-never-depends-on-geometry rule. */
const QUANTUM = 2000

let state: RawViewport = EMPTY
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function quantize(ratio: number): number {
  return Math.round(Math.max(0, Math.min(1, ratio)) * QUANTUM) / QUANTUM
}

export function publishRawViewport(topRatio: number, bottomRatio: number): void {
  const next: RawViewport = { topRatio: quantize(topRatio), bottomRatio: quantize(bottomRatio) }
  if (next.topRatio === state.topRatio && next.bottomRatio === state.bottomRatio) return
  state = next
  notify()
}

/** Called on unmount / document change — an empty viewport is what makes
 * the thumb disappear rather than showing the previous document's last
 * known position while nothing is actually mounted to keep it current. */
export function clearRawViewport(): void {
  if (state === EMPTY) return
  state = EMPTY
  notify()
}

export function getRawViewport(): RawViewport {
  return state
}

export function subscribeRawViewport(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
