/**
 * Navigation commands (M1-PLAN.md D14, CONCEPT.md §4.5). Imported once,
 * for its registration side effect, by `commands/builtins.ts` — not from
 * a view component, per D3's rule that the palette-parity test can only
 * see what `builtins.ts` has imported.
 */
import { locateInTree } from '../components/Tree/treeController'
import { scrubRawTo } from '../components/Raw/rawController'
import type { AppContext } from '../commands/registry'
import { registerCommand } from '../commands/registry'
import { nodeContainingOffset } from '../nodeSpanLookup'
import { selectNode } from '../selectNode'
import type { DocumentSessionState } from '../session/documentSession'
import { nextDiagnostic, previousDiagnostic } from './diagnosticNav'
import { goBack, goForward } from './navigationStore'

/** `null` unless a document is actually open — every command below is a
 * no-op without one, and `when: 'hasSelection'` already keeps them off the
 * palette in that case, but a command can still be invoked by keybinding
 * regardless of `when` filtering elsewhere going stale, so each `run`
 * checks for itself rather than trusting the gate alone. */
function readyState(ctx: AppContext): Extract<DocumentSessionState, { phase: 'ready' }> | null {
  const snapshot = ctx.session.getSnapshot()
  return snapshot.phase === 'ready' ? snapshot : null
}

registerCommand({
  id: 'klados.navigate.back',
  title: 'Back',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'canGoBack',
  run: (ctx) => {
    const node = goBack()
    const state = readyState(ctx)
    if (node !== null && state !== null) {
      selectNode(state.document.store, node, { recordHistory: false })
    }
  }
})

registerCommand({
  id: 'klados.navigate.forward',
  title: 'Forward',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'canGoForward',
  run: (ctx) => {
    const node = goForward()
    const state = readyState(ctx)
    if (node !== null && state !== null) {
      selectNode(state.document.store, node, { recordHistory: false })
    }
  }
})

registerCommand({
  id: 'klados.navigate.drillUp',
  title: 'Drill Up (Select Parent)',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'hasSelection',
  run: (ctx) => {
    const state = readyState(ctx)
    if (state === null) return
    const parent = state.document.store.parentOf(state.selection.selectedNode)
    if (parent !== -1) selectNode(state.document.store, parent)
  }
})

registerCommand({
  id: 'klados.navigate.drillDown',
  title: 'Drill Down (Select First Child)',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'hasSelection',
  run: (ctx) => {
    const state = readyState(ctx)
    if (state === null) return
    const child = state.document.store.firstChildOf(state.selection.selectedNode)
    if (child !== -1) selectNode(state.document.store, child)
  }
})

registerCommand({
  id: 'klados.navigate.locateInTree',
  title: 'Locate in Tree',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'hasSelection',
  run: (ctx) => {
    const state = readyState(ctx)
    if (state !== null) locateInTree(state.selection.selectedNode)
  }
})

registerCommand({
  id: 'klados.navigate.locateInSource',
  title: 'Locate in Source',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'hasSelection',
  run: (ctx) => {
    const state = readyState(ctx)
    if (state === null) return
    scrubRawTo(state.document.store.spanOf(state.selection.selectedNode).start)
  }
})

/** Shared by both directions below — resolves a diagnostic to a node
 * (D14's offset → node primitive) and drives selection, Tree, and Raw the
 * same way `Palette.tsx`'s go-to-position flow does, except scrubbed to
 * the diagnostic's own offset rather than its containing node's span
 * start, which is the more precise of the two here.
 *
 * Also advances `caretOffset` itself, via `setCaretOffset` — not just a
 * visual scrub. `nextDiagnostic`/`previousDiagnostic` both read
 * `selection.caretOffset` as "where we are now"; without this, repeated
 * F8 would keep computing from the offset the document opened at and
 * never advance past the first diagnostic. `selectNode` only moves
 * `selectedNode`, so this is the one caller that actually needs the
 * caret to track the jump target, not just the node. */
function gotoDiagnostic(
  ctx: AppContext,
  state: Extract<DocumentSessionState, { phase: 'ready' }>,
  offset: number
): void {
  const node = nodeContainingOffset(state.document.store, offset)
  selectNode(state.document.store, node)
  ctx.session.setCaretOffset(offset)
  locateInTree(node)
  scrubRawTo(offset)
}

registerCommand({
  id: 'klados.navigate.nextDiagnostic',
  title: 'Next Diagnostic',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'hasDiagnostics',
  run: (ctx) => {
    const state = readyState(ctx)
    if (state === null) return
    const target = nextDiagnostic(state.document.diagnostics, state.selection.caretOffset)
    if (target !== null) gotoDiagnostic(ctx, state, target.offset)
  }
})

registerCommand({
  id: 'klados.navigate.previousDiagnostic',
  title: 'Previous Diagnostic',
  category: 'Navigate',
  surfaces: ['palette'],
  when: 'hasDiagnostics',
  run: (ctx) => {
    const state = readyState(ctx)
    if (state === null) return
    const target = previousDiagnostic(state.document.diagnostics, state.selection.caretOffset)
    if (target !== null) gotoDiagnostic(ctx, state, target.offset)
  }
})
