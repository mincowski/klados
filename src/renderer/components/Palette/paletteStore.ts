/**
 * Open/closed state for the command palette. A module-level store rather
 * than React state, in keeping with `commands/context.ts` and `theme.ts`:
 * the palette is opened by a *command* (`klados.palette.open`, run from a
 * keybinding or another surface), which has no component instance to call
 * `setState` on — it calls this module instead, and the `<Palette>`
 * component subscribes via `useSyncExternalStore`.
 */

type Listener = () => void

let open = false
const listeners = new Set<Listener>()
/** M5f-PLAN.md §5: the caret-position status bar item opens the palette
 * already in `:` mode, rather than opening blank and making the user type
 * `:` themselves. Set by `openPalette`'s optional argument, read (and
 * cleared) exactly once by `PaletteContent`'s own lazy `useState`
 * initializer at mount — a module-level value, not component state, for
 * the same reason `open` itself is: the caller has no component instance
 * to pass a prop to. */
let pendingInitialQuery: string | null = null

export function isPaletteOpen(): boolean {
  return open
}

export function openPalette(initialQuery?: string): void {
  if (initialQuery !== undefined) pendingInitialQuery = initialQuery
  if (open) return
  open = true
  for (const listener of listeners) listener()
}

/** Consumes and clears the pending initial query — `null` for an ordinary
 * open. Meant to be read exactly once, by the palette's own mount. */
export function consumePendingInitialQuery(): string | null {
  const query = pendingInitialQuery
  pendingInitialQuery = null
  return query
}

export function closePalette(): void {
  if (!open) return
  open = false
  for (const listener of listeners) listener()
}

export function togglePalette(): void {
  if (open) closePalette()
  else openPalette()
}

export function subscribePaletteOpen(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: resets module state between test cases. */
export function resetPaletteStoreForTests(): void {
  open = false
  pendingInitialQuery = null
  listeners.clear()
}
