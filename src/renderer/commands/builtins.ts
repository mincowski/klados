/**
 * Built-in commands that don't belong to a specific view. Imported once,
 * for its registration side effects, by `main.tsx`.
 */
import '../components/Palette/commands'
import '../components/TabStrip/commands'
import '../components/Detail/commands'
import '../components/Find/commands'
import '../components/Help/commands'
import '../components/Layout/commands'
import '../components/Raw/commands'
import '../components/StatusBar/commands'
import '../components/Tree/commands'
import '../navigation/commands'
import '../notifications/commands'
import '../session/commands'

import { focusPane, moveFocus, type Pane } from '../focus'
import { getTheme, toggleTheme } from '../theme'
import { zoomIn, zoomOut, resetZoom } from '../zoom'
import { registerCommand } from './registry'

// R68 (`R66-palette-polish.md` §3's own worked table): named for what
// is on or off (`Dark Theme`, not `Light/Dark Theme`) — the one rename in
// this file's own toggle set that isn't cosmetic. `Light/Dark Theme · On`
// would say nothing; `Dark Theme · Off` does.
registerCommand({
  id: 'klados.theme.toggle',
  title: 'Dark Theme',
  category: 'View',
  surfaces: ['palette'],
  state: () => getTheme() === 'dark',
  run: () => toggleTheme()
})

// R59 (`R58-zoom.md` §4).
registerCommand({
  id: 'klados.view.zoomIn',
  title: 'Zoom In',
  category: 'View',
  surfaces: ['palette'],
  run: () => zoomIn()
})

registerCommand({
  id: 'klados.view.zoomOut',
  title: 'Zoom Out',
  category: 'View',
  surfaces: ['palette'],
  run: () => zoomOut()
})

registerCommand({
  id: 'klados.view.resetZoom',
  title: 'Reset Zoom',
  category: 'View',
  surfaces: ['palette'],
  run: () => resetZoom()
})

// `when: 'format'` — panes only mount (and only register with the focus
// model, focus.ts) once a document is ready; `format` is set exactly then
// and cleared exactly when leaving that state (documentSession.ts). Without
// this, F6/Ctrl+1-3 and these palette entries stayed "fireable" while no
// pane exists to receive focus — moveFocus/focusPane already no-op safely
// in that case, but the gate makes it visible in the palette too, not just
// silently harmless.
function registerFocusPaneCommand(pane: Pane, title: string): void {
  registerCommand({
    id: `klados.focus.${pane}`,
    title,
    category: 'View',
    surfaces: ['palette'],
    when: 'format',
    run: () => focusPane(pane)
  })
}

registerFocusPaneCommand('tree', 'Focus Tree')
registerFocusPaneCommand('detail', 'Focus Detail')
registerFocusPaneCommand('raw', 'Focus Raw Source')

registerCommand({
  id: 'klados.focus.next',
  title: 'Focus Next Pane',
  category: 'View',
  surfaces: ['palette'],
  when: 'format',
  run: () => moveFocus('next')
})

registerCommand({
  id: 'klados.focus.previous',
  title: 'Focus Previous Pane',
  category: 'View',
  surfaces: ['palette'],
  when: 'format',
  run: () => moveFocus('previous')
})
