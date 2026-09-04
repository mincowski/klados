/**
 * R26 (`R24-tabs.md` §4) — wires `session/tabs.ts`'s consolidated quit
 * flow to the main-process IPC seam (`preload/api.ts`'s `app` namespace).
 * `tabs.ts` owns *what* happens (which tabs, which prompts, in what order);
 * this module only owns *telling main when it's actually safe to let the
 * window close* — the same "session logic stays free of the IPC/preload
 * dependency, a small orchestrator wires the two" split
 * `session/sessionRestore.ts` and `documentSession.ts`'s own injected
 * `api`/`parse` deps already use elsewhere in this codebase.
 *
 * Unlike `beginSessionRestore`, this has no "must run before first render"
 * constraint — arming it any time before the user tries to quit is enough,
 * so it's called from `App.tsx`'s mount effect rather than `main.tsx`.
 */
import { getKladosApi } from '../preloadApi'
import { setQuitFlowHandlers, startQuitFlow } from './tabs'

let started = false

export function initQuitFlow(): void {
  if (started) return
  started = true

  const api = getKladosApi()
  if (api === undefined) return

  setQuitFlowHandlers({
    onAllResolved: () => api.app.confirmQuit(),
    onCancelled: () => api.app.cancelQuit()
  })
  api.app.onQuitRequested(() => startQuitFlow())
}

/** Test-only: undoes the one-shot guard, mirroring every other
 * `resetXForTests` in this codebase. */
export function resetQuitFlowForTests(): void {
  started = false
}
