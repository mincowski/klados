import { useEffect } from 'react'
import {
  createKeymapController,
  getKeybindings,
  loadKeybindings,
  setKeybindings
} from './commands/keybindings'
import { Layout } from './components/Layout/Layout'
import { Palette } from './components/Palette/Palette'
import { Shortcuts } from './components/Help/Shortcuts'
import { TabStrip } from './components/TabStrip/TabStrip'
import { TitleBar } from './components/TitleBar/TitleBar'
import { initQuitFlow } from './session/quitFlow'
import { installDropGuard } from './dropGuard'

/**
 * D4: the global keymap. Bindings load asynchronously (they may come from
 * a persisted override file read over IPC), so there's a brief window on
 * startup where no binding is active yet — acceptable for M1, since
 * nothing here is safety-critical.
 *
 * Attached in the capture phase for the reason keybindings.ts documents:
 * a global binding must win over whatever a future CodeMirror instance
 * (D10) would otherwise do with the same keys, and capture-phase delivery
 * is what makes that true regardless of where focus is.
 *
 * R65 (`R65-shortcuts-help.md` §2): the loaded result now goes through
 * `keybindings.ts`'s own `setKeybindings`/`getKeybindings` store instead of
 * a private closure variable — the controller reads the same store a
 * display surface (the shortcuts panel, the palette, a tooltip) can also
 * read, so there is one source of truth for "what is bound right now"
 * rather than this effect's own copy plus everyone else guessing from
 * `DEFAULT_KEYBINDINGS`.
 */
function useKeymap(): void {
  useEffect(() => {
    let disposed = false

    const controller = createKeymapController(getKeybindings)

    loadKeybindings().then((loaded) => {
      if (!disposed) setKeybindings(loaded)
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      controller.handleKeyDown(event)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      disposed = true
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      controller.dispose()
    }
  }, [])
}

export function App(): React.JSX.Element {
  useKeymap()
  // R26 (`R24-tabs.md` §4): no "before first render" constraint like
  // `beginSessionRestore` — arming it any time before the user tries to
  // quit is enough.
  useEffect(() => initQuitFlow(), [])
  // R164: window-level, so no region of the window is an unguarded drop
  // target — see dropGuard.ts for what used to fall through the chrome.
  useEffect(() => installDropGuard(), [])

  return (
    <main>
      <TitleBar />
      <TabStrip />
      <Layout />
      <Palette />
      <Shortcuts />
    </main>
  )
}
