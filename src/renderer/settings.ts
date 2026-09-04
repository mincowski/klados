/**
 * Small persisted user preferences — same shape as `theme.ts`'s own
 * `localStorage` pattern, kept separate from it since these are unrelated
 * settings, not a reason to grow a single "settings" object prematurely.
 */

const FORMAT_MINIFIED_ON_OPEN_KEY = 'klados.formatMinifiedOnOpen'

/** M5-PLAN.md H8 — "Format minified files on open." Off by default: the
 * banner (offer, never impose — §5.7) is the default experience; this is
 * the opt-in for users who'd rather it just happened. */
export function getFormatMinifiedOnOpen(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(FORMAT_MINIFIED_ON_OPEN_KEY) === 'true'
}

export function setFormatMinifiedOnOpen(value: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(FORMAT_MINIFIED_ON_OPEN_KEY, value ? 'true' : 'false')
}

export function toggleFormatMinifiedOnOpen(): void {
  setFormatMinifiedOnOpen(!getFormatMinifiedOnOpen())
}

const TOTAL_MEMORY_BUDGET_KEY = 'klados.totalMemoryBudgetBytes'

/** R28 (`R24-tabs.md` §6, `CONCEPT.md` §11.4): "opening a document
 * that would exceed a configurable budget prompts rather than silently
 * degrading" — the cross-tab counterpart to `documentSession.ts`'s own
 * per-file `SOFT_CAP_BYTES`. Default matches §8's own worked example
 * ("three 200 MB files is ~1.5 GB") with headroom for a few more. */
export const DEFAULT_TOTAL_MEMORY_BUDGET_BYTES = 4 * 1024 * 1024 * 1024

export function getTotalMemoryBudgetBytes(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_TOTAL_MEMORY_BUDGET_BYTES
  const raw = localStorage.getItem(TOTAL_MEMORY_BUDGET_KEY)
  const parsed = raw === null ? NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOTAL_MEMORY_BUDGET_BYTES
}

export function setTotalMemoryBudgetBytes(bytes: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(TOTAL_MEMORY_BUDGET_KEY, String(Math.max(0, Math.round(bytes))))
}

const ZOOM_FACTOR_KEY = 'klados.zoomFactor'

/** R59 (`R58-zoom.md` §4): "Bounded. Chromium will happily go to
 * 500%; the app's own drawn title bar and status bar are fixed-height
 * chrome." 50–200% either side of 100%, matching a typical browser's own
 * zoom range without inheriting Chromium's much wider one. */
export const MIN_ZOOM_FACTOR = 0.5
export const MAX_ZOOM_FACTOR = 2

export function clampZoomFactor(factor: number): number {
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, factor))
}

/** Storage only — `zoom.ts` is what actually applies a value (through the
 * preload seam, `webContents` being main-process-only) and owns the
 * in-memory current value everything else reads. Pure `get`/`set`, the same
 * shape as this file's other two settings, is what keeps this file's own
 * contract free of side effects. */
export function getZoomFactor(): number {
  if (typeof localStorage === 'undefined') return 1
  const raw = localStorage.getItem(ZOOM_FACTOR_KEY)
  const parsed = raw === null ? NaN : Number(raw)
  return Number.isFinite(parsed) ? clampZoomFactor(parsed) : 1
}

export function setZoomFactor(factor: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(ZOOM_FACTOR_KEY, String(clampZoomFactor(factor)))
}
