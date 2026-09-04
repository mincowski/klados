/**
 * Theme switching (CONCEPT.md §9.1, §9.6). `data-theme` on `document
 * .documentElement` is the whole mechanism — CSS custom properties do the
 * rest, so toggling never touches React state and never causes a
 * re-render (D2's own acceptance criterion). `subscribeTheme` exists for
 * UI that wants to *display* the current theme (a palette entry's icon,
 * say); it is never how a component should get themed, since that always
 * goes through the CSS tokens directly.
 *
 * `toggleTheme` is reached only through the command registry
 * (`klados.theme.toggle` in `commands/builtins.ts`, bound to Ctrl+Shift+L
 * by D4's keymap). D2's temporary direct keydown listener is gone — this
 * module owns no input handling.
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'klados.theme'

const listeners = new Set<() => void>()
let current: Theme = readInitial()

function readInitial(): Theme {
  if (typeof localStorage === 'undefined') return 'light'
  return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
}

function apply(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

apply(current)

export function getTheme(): Theme {
  return current
}

export function setTheme(theme: Theme): void {
  if (theme === current) return
  current = theme
  apply(theme)
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme)
  for (const listener of listeners) listener()
}

export function toggleTheme(): void {
  setTheme(current === 'light' ? 'dark' : 'light')
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
