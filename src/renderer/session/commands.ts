/**
 * The document session's own registry entries. Imported once, for its
 * registration side effect, by `commands/builtins.ts` — not from a view
 * component, per D3's rule that the palette-parity test can only see what
 * `builtins.ts` has imported.
 */
import { registerCommand } from '../commands/registry'
import { clearRecentFiles } from './recentFiles'
import { getFormatMinifiedOnOpen, toggleFormatMinifiedOnOpen } from '../settings'
import { openNewTab } from './tabs'

registerCommand({
  id: 'klados.document.open',
  title: 'Open File…',
  category: 'File',
  icon: 'folder-open',
  // M5d-PLAN.md R4: always reachable, never disabled — opening a second
  // file is legal in every `DocumentSessionState` phase, unlike Save/
  // Undo/Redo, so this needs no `enabledWhen`. Placed where the tab
  // strip's "+" will go (§4): first in the document-scope group, since
  // it's registered before them (`TitleBar.tsx`'s `documentCommands` is a
  // stable sort on registration order for ties).
  //
  // R26 (`R24-tabs.md` §4): "open into a new tab" — this used to
  // replace the active tab's own document (R24's own test comment said so
  // explicitly: "no tabs in M1"). Now that tabs are real, doing that would
  // make Ctrl+O silently discard whatever the active tab was showing.
  surfaces: ['palette', 'titleBar'],
  run: () => openNewTab()
})

// R95 (`R95-recent-files.md` §2): the six rows themselves are data (like
// tree rows and tab-strip entries), not commands — clicking one is a
// selection. Clear is the one action, gated on `hasRecentFiles` and hidden
// rather than disabled, the reasoning `canUndo`/`canRedo` already give.
registerCommand({
  id: 'klados.document.clearRecentFiles',
  title: 'Clear Recent Files',
  category: 'File',
  when: 'hasRecentFiles',
  surfaces: ['palette'],
  run: () => clearRecentFiles()
})

registerCommand({
  id: 'klados.document.cancelOpen',
  title: 'Cancel Opening File',
  category: 'File',
  surfaces: ['palette'],
  run: (ctx) => ctx.session.cancel()
})

// M3-PLAN.md F9. `when` gates each on whether it would actually do
// anything — the same reasoning `canGoBack`/`canGoForward` already gate
// navigate.back/forward on — rather than leaving an always-enabled command
// that's silently a no-op most of the time.

registerCommand({
  id: 'klados.edit.undo',
  title: 'Undo',
  category: 'Edit',
  icon: 'undo',
  when: 'canUndo',
  // M5d-PLAN.md R7 (D-055): the title bar wants this command disabled, not
  // absent, when there's nothing to undo — `enabledWhen` carries the same
  // condition `when` already gates the palette on, for the surface that
  // renders it regardless (`commandsForSurfaceUnfiltered`).
  enabledWhen: 'canUndo',
  surfaces: ['palette', 'titleBar'],
  run: (ctx) => void ctx.session.undo()
})

registerCommand({
  id: 'klados.edit.redo',
  title: 'Redo',
  category: 'Edit',
  icon: 'redo',
  when: 'canRedo',
  enabledWhen: 'canRedo',
  surfaces: ['palette', 'titleBar'],
  run: (ctx) => void ctx.session.redo()
})

registerCommand({
  id: 'klados.document.save',
  title: 'Save',
  category: 'File',
  icon: 'save',
  when: '!isReadOnly',
  // M5e-PLAN.md R8b: `when` stays `!isReadOnly` — D-055's "disabled, not
  // hidden" rule (D-056) — but `enabledWhen` also requires `isDirty`, or
  // Save renders enabled with nothing to save.
  enabledWhen: 'isDirty && !isReadOnly',
  surfaces: ['palette', 'titleBar'],
  run: (ctx) => void ctx.session.save()
})

registerCommand({
  id: 'klados.document.saveAs',
  title: 'Save As…',
  category: 'File',
  // No `when` — F7's own `saveAs` doc comment: allowed even on a
  // read-only document, since it never overwrites the original file.
  surfaces: ['palette'],
  run: (ctx) => void ctx.session.saveAs()
})

registerCommand({
  id: 'klados.document.revert',
  title: 'Revert File',
  category: 'File',
  icon: 'revert',
  // F8's own mechanism (`reloadAndDiscard`) — discarding unsaved edits is
  // only a meaningful action when there are any.
  when: 'isDirty',
  surfaces: ['palette'],
  run: (ctx) => void ctx.session.reloadAndDiscard()
})

// M5-PLAN.md H5/H7. Gated on `canFormat` (invariant 8: the capability, never
// a format id) and `!isReadOnly` — a read-only document can't be Transformed
// any more than it can be typed into. `requestTransform` itself decides
// whether to run immediately or ask first (§11.2's soft-cap shape,
// `document.pendingTransform`) — this command doesn't need to know which.
//
// M5e-PLAN.md R9 (D-057): also a `paneHeader` command on `raw` — Raw's own
// subject is the source bytes, and Format changes the source shape while
// provably not changing the model (D-030 doesn't model insignificant
// whitespace, so the Tree is unchanged; Detail's source-range labels are
// the only thing that shifts). Undo/Save stay title-bar (D-055): their own
// subject — the edit history, the file — is document scope, not Raw's.

registerCommand({
  id: 'klados.document.format',
  title: 'Format Document',
  category: 'Edit',
  icon: 'code-text',
  when: 'canFormat && !isReadOnly',
  surfaces: ['palette', 'paneHeader'],
  pane: 'raw',
  run: (ctx) => ctx.session.requestTransform('format')
})

registerCommand({
  id: 'klados.document.minify',
  title: 'Minify Document',
  category: 'Edit',
  when: 'canFormat && !isReadOnly',
  surfaces: ['palette'],
  run: (ctx) => ctx.session.requestTransform('minify')
})

// R68 (`R66-palette-polish.md` §3): `Toggle: ` dropped from the
// stored title (it also collided with R66's own `Category: Title` prefix,
// producing two colons) — `tooltipFor` supplies the verb wherever this
// renders as an icon-only button; the palette shows the state instead.
registerCommand({
  id: 'klados.document.toggleFormatMinifiedOnOpen',
  title: 'Format Minified Files on Open',
  category: 'Edit',
  surfaces: ['palette'],
  state: () => getFormatMinifiedOnOpen(),
  run: () => toggleFormatMinifiedOnOpen()
})

// M5f-PLAN.md §3a: not surfaced as a button in the statistics panel for
// now (the panel only shows the figure) — palette-only, invariant 10's
// minimum bar. `when: 'format'` (not `canUndo`) since it's meaningful to
// run even with nothing undoable yet (a cheap no-op, not worth hiding).
registerCommand({
  id: 'klados.edit.clearUndoHistory',
  title: 'Clear Undo History',
  category: 'Edit',
  when: 'format',
  surfaces: ['palette'],
  run: (ctx) => ctx.session.clearUndoHistory()
})
