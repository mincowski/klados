/**
 * The Detail view's grid-mode registry entries (M2-PLAN.md E8, E9).
 * Imported once, for its registration side effect, by
 * `commands/builtins.ts` — not from `Grid.tsx`/`Detail.tsx` themselves, per
 * D3's rule that the palette-parity test can only see what `builtins.ts`
 * has imported.
 */
import { registerCommand } from '../../commands/registry'
import {
  cancelGridExport,
  confirmGridExport,
  copyGridAs,
  focusGridQuickFilter
} from './gridController'

registerCommand({
  id: 'klados.grid.copyCsv',
  title: 'Copy Grid as CSV',
  category: 'Edit',
  surfaces: ['palette'],
  run: () => copyGridAs('csv')
})

registerCommand({
  id: 'klados.grid.copyTsv',
  title: 'Copy Grid as TSV',
  category: 'Edit',
  surfaces: ['palette'],
  run: () => copyGridAs('tsv')
})

registerCommand({
  id: 'klados.grid.copyMarkdown',
  title: 'Copy Grid as Markdown',
  category: 'Edit',
  surfaces: ['palette'],
  run: () => copyGridAs('markdown')
})

registerCommand({
  id: 'klados.grid.focusFilter',
  title: 'Filter Grid Rows',
  category: 'Edit',
  icon: 'filter',
  surfaces: ['palette'],
  run: () => focusGridQuickFilter()
})

// R21-notifications.md §1/§3g: resolve the export soft-cap choice
// notification. No `when` gate — same reasoning `copyGridAs` already
// accepts: a no-op with nothing pending or no Grid mounted is not an error.
registerCommand({
  id: 'klados.grid.confirmExport',
  title: 'Confirm Grid Export',
  category: 'Edit',
  surfaces: ['palette'],
  run: () => confirmGridExport()
})

registerCommand({
  id: 'klados.grid.cancelExport',
  title: 'Cancel Grid Export',
  category: 'Edit',
  surfaces: ['palette'],
  run: () => cancelGridExport()
})
