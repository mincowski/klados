/**
 * Find's own registry entries (M4-PLAN.md G5). Imported once, for its
 * registration side effect, by `commands/builtins.ts` — not from
 * `FindBar.tsx` itself, per D3's rule that the palette-parity test can only
 * see what `builtins.ts` has imported.
 *
 * No `klados.find.close` command: closing is a local `Escape`-in-input
 * interaction, the same shape `Palette.tsx` already uses for its own close
 * (no `klados.palette.close` command exists either) — nothing outside the
 * open bar itself can meaningfully "close find."
 */
import { registerCommand } from '../../commands/registry'
import { cancelReplaceAll, confirmReplaceAll, findNext, findPrevious } from './findController'
import { openFind, openFindWithReplace, toggleFilterToMatches, toggleReplace } from './findStore'

registerCommand({
  id: 'klados.find.open',
  title: 'Find in Document',
  category: 'Edit',
  icon: 'search',
  surfaces: ['palette'],
  when: 'format',
  run: () => openFind()
})

// R90 (`R86-find-as-query-surface.md` §6): `Ctrl+H`'s own command — opens
// Find with the replace row already expanded, rather than requiring an
// extra click on the disclosure control after `Ctrl+F`.
registerCommand({
  id: 'klados.find.openWithReplace',
  title: 'Find and Replace',
  category: 'Edit',
  surfaces: ['palette'],
  when: 'format',
  run: () => openFindWithReplace()
})

// Invariant 10: the disclosure control in the bar is a real UI affordance,
// but the rule is every command reachable from any surface is also
// palette-reachable — this is that.
registerCommand({
  id: 'klados.find.toggleReplace',
  title: 'Toggle Replace Row',
  category: 'Edit',
  surfaces: ['palette'],
  when: 'format',
  run: () => toggleReplace()
})

// R21-notifications.md §3g: a notification action must be a registered
// command — these two resolve the Replace All confirmation
// (`FindBar.tsx`'s own `handleReplaceAllClick`).
registerCommand({
  id: 'klados.find.confirmReplaceAll',
  title: 'Confirm Replace All',
  category: 'Edit',
  surfaces: ['palette'],
  run: () => confirmReplaceAll()
})

registerCommand({
  id: 'klados.find.cancelReplaceAll',
  title: 'Cancel Replace All',
  category: 'Edit',
  surfaces: ['palette'],
  run: () => cancelReplaceAll()
})

registerCommand({
  id: 'klados.find.next',
  title: 'Find Next',
  category: 'Edit',
  surfaces: ['palette'],
  when: 'format',
  run: () => findNext()
})

registerCommand({
  id: 'klados.find.previous',
  title: 'Find Previous',
  category: 'Edit',
  surfaces: ['palette'],
  when: 'format',
  run: () => findPrevious()
})

registerCommand({
  id: 'klados.find.toggleFilterToMatches',
  title: 'Filter Tree to Matches',
  category: 'View',
  icon: 'filter',
  surfaces: ['palette'],
  when: 'format',
  run: () => toggleFilterToMatches()
})
