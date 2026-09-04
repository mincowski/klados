/**
 * The shortcuts panel's own registry entry. Imported once, for its
 * registration side effect, by `commands/builtins.ts` — `Palette/commands.ts`'s
 * own pattern.
 */
import { registerCommand } from '../../commands/registry'
import { openShortcuts } from './shortcutsStore'

registerCommand({
  id: 'klados.help.shortcuts',
  title: 'Help: Shortcuts',
  category: 'Help',
  surfaces: ['palette'],
  run: () => openShortcuts()
})
