/**
 * Open/closed state for the shortcuts panel — the same module-level-store
 * shape `Palette/paletteStore.ts` already uses, for the same reason: the
 * panel is opened by a *command* (`klados.help.shortcuts`), which has no
 * component instance to call `setState` on.
 */

type Listener = () => void

let open = false
const listeners = new Set<Listener>()

export function isShortcutsOpen(): boolean {
  return open
}

export function openShortcuts(): void {
  if (open) return
  open = true
  for (const listener of listeners) listener()
}

export function closeShortcuts(): void {
  if (!open) return
  open = false
  for (const listener of listeners) listener()
}

export function subscribeShortcutsOpen(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: resets module state between test cases. */
export function resetShortcutsStoreForTests(): void {
  open = false
  listeners.clear()
}
