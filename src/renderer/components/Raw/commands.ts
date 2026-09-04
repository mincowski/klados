/**
 * The Raw View's own registry entries (M1-PLAN.md D12). Imported once, for
 * its registration side effect, by `commands/builtins.ts` — not from
 * `Raw.tsx` itself, per D3's rule that the palette-parity test can only
 * see what `builtins.ts` has imported.
 */
import { getContext } from '../../commands/context'
import { registerCommand } from '../../commands/registry'
import { toggleRawWrap } from './rawController'

// R68 (`R66-palette-polish.md` §3): `isWrapped` already lives in the
// context store (`Raw.tsx`'s own `setContext('isWrapped', ...)` calls) —
// the getter this needs already exists, it was just never asked.
registerCommand({
  id: 'klados.raw.toggleWrap',
  title: 'Soft Wrap',
  category: 'View',
  icon: 'wrap',
  surfaces: ['palette', 'paneHeader'],
  pane: 'raw',
  state: () => getContext().isWrapped,
  run: () => toggleRawWrap()
})
