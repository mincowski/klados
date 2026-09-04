/**
 * The Tree view's own registry entries. Imported once, for its
 * registration side effect, by `commands/builtins.ts` — not from
 * `Tree.tsx` itself, per D3's rule that the palette-parity test can only
 * see what `builtins.ts` has imported.
 */
import { registerCommand } from '../../commands/registry'
import { collapseSubtreeInTree, expandSubtreeInTree } from './treeController'

// M5c-PLAN.md J6 / D-052: both act on the selected node's subtree, falling
// back to the root when nothing is selected — `Tree.tsx`'s own
// `expandSubtree`/`collapseSubtree` resolve the scope, not these. Static
// titles: a context-dependent title ("Expand Subtree" when something's
// selected) would need a registry feature this task's scope doesn't cover
// — see M5c-PLAN.md J6's own note.
registerCommand({
  id: 'klados.tree.expandAll',
  title: 'Expand All',
  category: 'View',
  icon: 'expand-all',
  surfaces: ['palette', 'paneHeader'],
  pane: 'tree',
  run: () => expandSubtreeInTree()
})

registerCommand({
  id: 'klados.tree.collapseAll',
  title: 'Collapse All',
  category: 'View',
  icon: 'collapse-all',
  surfaces: ['palette', 'paneHeader'],
  pane: 'tree',
  run: () => collapseSubtreeInTree()
})
