/**
 * `window.api`, typed via an explicit import rather than the ambient
 * `Window` augmentation in `preload/index.d.ts` — that augmentation is only
 * visible to `tsconfig.web.json`'s project, and modules here are also
 * typechecked transitively through `tsconfig.lib.json` (test files import
 * them directly). Shared by `commands/keybindings.ts` and
 * `session/documentSession.ts`, both of which need it and must both degrade
 * — not throw — when it's unavailable (no preload bridge under Vitest).
 */
import type { KladosApi } from '../preload/api'

export function getKladosApi(): KladosApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { api?: KladosApi }).api
}
