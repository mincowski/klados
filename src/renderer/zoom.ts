/**
 * Content zoom (R59, `R58-zoom.md` §4). Same shape as `theme.ts`: an
 * in-memory `current` value applied eagerly at module load — no React
 * state, so no component re-renders just because zoom changed — with a
 * subscribe list for anything that wants to *display* the current value.
 * `settings.ts` owns the persisted number; this module owns acting on it.
 *
 * Unlike theme, `apply` can't be a synchronous DOM write: Chromium's zoom
 * lives on `webContents`, a main-process-only object, so it goes through
 * the preload seam (`preload/api.ts`'s `view.setZoomFactor`) rather than
 * `webFrame` in the renderer (§4's own instruction — `webFrame` would zoom
 * only the calling frame, invisibly to the `BrowserWindow`-level zoom main
 * itself reads). This also means `main/index.ts`'s R58-era `did-finish-load`
 * handler is gone: this module's own eager `apply(current)` call —
 * defaulting to `1` when nothing is persisted, exactly like that handler
 * did — is a strict superset of it, and keeping both would race (see that
 * file's own comment).
 */
import { getKladosApi } from './preloadApi'
import {
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  clampZoomFactor,
  getZoomFactor as readPersistedZoomFactor,
  setZoomFactor as persistZoomFactor
} from './settings'

export { MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR }

/** Chromium's own zoom steps are roughly logarithmic (25/33/50/67/75/80/90/
 * 100/110/125/150/175/200/250/300/400/500%) — this is that same shape,
 * clamped to R59's own 50–200% bound, so `zoomIn`/`zoomOut` feel like the
 * browser convention instead of a fixed ±10% ratchet. */
const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

const listeners = new Set<() => void>()
let current: number = readPersistedZoomFactor()

function apply(factor: number): void {
  void getKladosApi()?.view.setZoomFactor(factor)
}

apply(current)

export function getZoomFactor(): number {
  return current
}

export function setZoomFactor(factor: number): void {
  const next = clampZoomFactor(factor)
  if (next === current) return
  current = next
  persistZoomFactor(next)
  apply(next)
  for (const listener of listeners) listener()
}

/** The smallest step strictly greater than `value`, or `MAX_ZOOM_FACTOR` if
 * `value` is already at or past the last one — never a no-op, so repeatedly
 * zooming in from any starting factor (including one restored from an
 * older build with a wider range) always makes progress toward the bound. */
function nextStepUp(value: number): number {
  for (const step of ZOOM_STEPS) {
    if (step > value + 1e-9) return step
  }
  return MAX_ZOOM_FACTOR
}

function nextStepDown(value: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const step = ZOOM_STEPS[i]!
    if (step < value - 1e-9) return step
  }
  return MIN_ZOOM_FACTOR
}

export function zoomIn(): void {
  setZoomFactor(nextStepUp(current))
}

export function zoomOut(): void {
  setZoomFactor(nextStepDown(current))
}

export function resetZoom(): void {
  setZoomFactor(1)
}

export function subscribeZoom(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
