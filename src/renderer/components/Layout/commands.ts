/**
 * The layout shell's own registry entries (M1-PLAN.md D7). Imported once,
 * for its registration side effect, by `commands/builtins.ts` — not from
 * `Layout.tsx` itself, per D3's rule that the palette-parity test can only
 * see what `builtins.ts` has imported.
 *
 * Surfaced on `palette` and `titleBar` (M5d-PLAN.md R2, D-055): pane
 * toggles are window scope, so they moved from the command bar — verified
 * these three were its only other users before doing this — into the
 * title bar, which renders whatever's registered for it the same way the
 * command bar used to (D-026).
 */
import { registerCommand } from '../../commands/registry'
import { getLayoutState, toggleDetailPane, toggleRawPane, toggleTreePane } from './layoutStore'

// R68 (`R66-palette-polish.md` §3): titles renamed to the noun
// (`Tree Pane`, not `Toggle Tree Pane`) — `tooltipFor` now supplies the
// `Toggle ` verb on these icon-only title-bar buttons because `state` is
// set, not because the stored title says so (D-055's own "the title stores
// the name, the surface composes the rest" move).
registerCommand({
  id: 'klados.layout.toggleTree',
  title: 'Tree Pane',
  category: 'View',
  icon: 'panel-left',
  surfaces: ['palette', 'titleBar'],
  state: () => getLayoutState().treeVisible,
  run: () => toggleTreePane()
})

registerCommand({
  id: 'klados.layout.toggleDetail',
  title: 'Detail Pane',
  category: 'View',
  // M5e-PLAN.md R8d: was `document`, which reads as "new page" — see
  // `commands/icons.ts` for the full reasoning.
  icon: 'apps-list-detail',
  surfaces: ['palette', 'titleBar'],
  state: () => getLayoutState().detailVisible,
  run: () => toggleDetailPane()
})

registerCommand({
  id: 'klados.layout.toggleRaw',
  title: 'Raw Pane',
  category: 'View',
  icon: 'panel-bottom',
  surfaces: ['palette', 'titleBar'],
  state: () => getLayoutState().rawVisible,
  run: () => toggleRawPane()
})
