/**
 * Selecting a node (§4's `{ selectedNode, caretOffset }`) always means the
 * same things regardless of which view initiated it — update the document
 * session, keep the `nodeKind` context key in sync so a command's `when`
 * can gate on it, and record the visit in navigation history (D14).
 * Shared by the Tree (D8), Detail (D9) and Raw (D14 caret resolution)
 * views rather than each reimplementing it.
 */
import type { NodeStore } from '../core/nodeStore'
import type { NodeRef } from '../core/types'
import { setContext } from './commands/context'
import { kindLabelOf } from './nodeDisplay'
import { recordNavigation } from './navigation/navigationStore'
import { activeSession } from './session/activeSession'

export interface SelectNodeOptions {
  /** `false` for a selection change that *is itself* a history navigation
   * (`goBack`/`goForward`) — recording it would immediately re-append the
   * very step it just stepped away from. Defaults to `true`: every other
   * caller (Tree, Detail, Raw's debounced caret resolution) is a genuine
   * new visit. */
  readonly recordHistory?: boolean
  /** `false` for a selection change that *is itself* driven by the caret
   * moving (`rawCaretSync`) — moving the caret back to where it already is
   * would fight the person typing. Defaults to `true`: every other caller
   * (Tree, Detail, "Locate in Source", `goBack`/`goForward`) wants Raw to
   * scroll to the selected node (M5e-PLAN.md R8f). */
  readonly moveCaret?: boolean
}

export function selectNode(store: NodeStore, node: NodeRef, options: SelectNodeOptions = {}): void {
  activeSession.setSelectedNode(node, { moveCaret: options.moveCaret })
  setContext('nodeKind', kindLabelOf(store.kindOf(node)))
  if (options.recordHistory ?? true) recordNavigation(node)
}
