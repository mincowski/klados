/**
 * Open/closed state for the statistics panel (M5f-PLAN.md §3) — the same
 * module-level-store shape as `Palette/paletteStore.ts`, for the same
 * reason: the panel is opened both by a click (a component *has* an
 * instance to call `setState` on) and by a command
 * (`klados.document.statistics`, invariant 10 — a command has no
 * component instance at all), so the open flag has to live somewhere
 * neither call site owns.
 */

type Listener = () => void

let open = false
const listeners = new Set<Listener>()

export function isStatisticsPanelOpen(): boolean {
  return open
}

export function openStatisticsPanel(): void {
  if (open) return
  open = true
  for (const listener of listeners) listener()
}

export function closeStatisticsPanel(): void {
  if (!open) return
  open = false
  for (const listener of listeners) listener()
}

export function toggleStatisticsPanel(): void {
  if (open) closeStatisticsPanel()
  else openStatisticsPanel()
}

export function subscribeStatisticsPanelOpen(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: resets module state between test cases. */
export function resetStatisticsPanelStoreForTests(): void {
  open = false
  listeners.clear()
}
