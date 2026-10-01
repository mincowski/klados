/**
 * Lets other UI reach the currently-mounted `Raw` view — D12's manual wrap
 * toggle, D13's scrubber — without threading a callback through the
 * component tree. The same "component registers a live handle with a
 * module-level singleton" shape `focus.ts`'s `registerPane` already uses,
 * and for the same reason: neither a registry command nor a sibling
 * component (the scrubber) has a reference to Raw's own instance. M1 ships
 * exactly one Raw view (no tabs, §11.4), so "the current one" is
 * unambiguous.
 */
import { activeSession } from '../../session/activeSession'
import { getActiveTabId, type TabId } from '../../session/tabs'
import { showRawPane } from '../Layout/layoutStore'

export interface RawController {
  toggleWrap(): void
  /** Moves the window to `offset` and positions the caret there — the
   * scrubber's own drag gesture (D13). Deliberately the same primitive
   * "Locate in source" (D14) will use, and just as deliberately *not*
   * anything that touches the document session's selection: CONCEPT.md
   * §4.5 is explicit that navigating the scrubber is not selecting. */
  scrubTo(offset: number): void
}

interface PendingAction {
  readonly tabId: TabId | null
  readonly run: (controller: RawController) => void
}

let current: RawController | null = null
let pending: PendingAction | null = null

export function registerRawController(controller: RawController): () => void {
  current = controller
  if (pending !== null) {
    const action = pending
    pending = null
    // Raw registers this from its own mount effect, which React runs before
    // the effect of the `PaneShell` around it that registers the pane with
    // the focus model. Deferring past the rest of the commit's effects is
    // what lets an action that focuses Raw (`klados.focus.raw`, the palette's
    // position jump) find the pane registered rather than silently no-op.
    // The tab check drops an action asked for on a document that is no
    // longer the active one by the time any Raw view mounted.
    queueMicrotask(() => {
      if (current === controller && getActiveTabId() === action.tabId) action.run(controller)
    })
  }
  return () => {
    if (current === controller) current = null
  }
}

/**
 * R223 (`docs/plans/R223-raw-pane-default.md` §2.3): runs `action` against
 * the Raw view, first showing the Raw pane if it is hidden — so a command
 * that only makes sense in Raw (Locate in Source, Soft Wrap, the palette's
 * position jump, next/previous diagnostic, Focus Raw Source) reveals it
 * instead of doing nothing. A hidden Raw is not mounted at all (`Layout.tsx`),
 * so the action waits for the view to register.
 *
 * A no-op without a ready document: there is no Raw view to show, and
 * revealing the pane then would change (and persist) the layout for a
 * command that did nothing.
 */
export function withRawView(action: (controller: RawController) => void): void {
  if (current !== null) {
    action(current)
    return
  }
  if (activeSession.getSnapshot().phase !== 'ready') return
  pending = { tabId: getActiveTabId(), run: action }
  showRawPane()
}

/** A no-op if no Raw view is mounted (no document open, or Raw hidden) — a
 * command running with nothing to act on is not an error. Callers that need
 * Raw to be visible use `withRawView` instead; the scrubber and the
 * palette's node jumps only bring an already visible Raw along. */
export function scrubRawTo(offset: number): void {
  current?.scrubTo(offset)
}
