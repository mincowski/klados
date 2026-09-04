/**
 * The palette's own registry entry. Imported once, for its registration
 * side effect, by `commands/builtins.ts` — not from `Palette.tsx` itself,
 * per D3's rule that the palette-parity test can only see what
 * `builtins.ts` has imported.
 */
import { registerCommand } from '../../commands/registry'
import { openPalette } from './paletteStore'

registerCommand({
  id: 'klados.palette.open',
  title: 'Show All Commands',
  category: 'View',
  surfaces: ['palette', 'titleBar'],
  icon: 'text-bullet-list-square',
  run: () => openPalette()
})
