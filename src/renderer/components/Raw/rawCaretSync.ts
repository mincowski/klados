/**
 * Caret → node resolution (M1-PLAN.md D14, CONCEPT.md §4.4): "moving the
 * caret resolves offset → node → selection, debounced. Scrolling does
 * not." Reuses `nodeSpanLookup.ts`'s `nodeContainingOffset` — the same
 * primitive D11's decorations use, per D14's own instruction not to write
 * it twice.
 */
import { Annotation, type Extension } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import type { NodeStore } from '../../../core/nodeStore'
import { nodeContainingOffset } from '../../nodeSpanLookup'
import { selectNode } from '../../selectNode'
import type { RawWindowSnapshot } from './rawOffsetMap'

/**
 * Tags a dispatch as Raw's own programmatic positioning (`jumpTo`,
 * `applyReslice`'s selection side-effects) rather than the user actually
 * moving the caret — without this, `Raw.tsx`'s own "Locate in source" jump
 * would immediately trigger this module's debounced resolution, which
 * would (harmlessly, but wastefully, and via a code path that shouldn't
 * exist) just reselect the node the jump came from a moment later.
 */
export const programmaticSelection = Annotation.define<true>()

/** Idle time before a caret move resolves to a selection — long enough
 * that fast keyboard/mouse repositioning (arrow-key repeats, a drag)
 * doesn't fire a resolution per intermediate position, short enough that
 * settling on a spot feels immediate.
 *
 * R162 (`docs/plans/R159-fixed-duration-waits.md` §7): exported, because it was
 * module-private and every test that cared about it wrote its own guess instead
 * — `focusIntoContent.test.tsx` waited 250 ms "past rawCaretSync's debounce",
 * a 1.25× margin over a number it had no way to name, and passed at 125 ms
 * because it was not really testing this at all. A test that must express a
 * duration should import the number rather than copy it. */
export const CARET_SYNC_DEBOUNCE_MS = 200

/**
 * `getWindow` is called fresh at the moment the debounce timer fires, not
 * captured when the caret moved — the window can re-slice during the idle
 * period, and reading the live window snapshot at fire time (rather than
 * one taken when the caret moved) is what keeps the resolved offset correct
 * across that.
 *
 * R41: `getStore` is a live getter for the same reason — a same-document
 * reparse (`Raw.tsx`'s live-update effect) can swap in a new `NodeStore`
 * during the idle period too, and resolving against a stale one would hand
 * `selectNode` a `NodeRef` from a tree that no longer exists.
 */
export function rawCaretSyncExtension(
  getStore: () => NodeStore,
  getWindow: () => RawWindowSnapshot
): Extension {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  return ViewPlugin.define((view) => ({
    update(update) {
      if (update.docChanged || !update.selectionSet) return
      if (update.transactions.some((tr) => tr.annotation(programmaticSelection) === true)) return

      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (disposed) return
        // `.head` is a UTF-16 unit position into the window's own text, not
        // a byte offset — the same conversion `rawEdit.ts` and `Raw.tsx`
        // need at this same boundary (UI-FEEDBACK.md M5b).
        const localUnits = view.state.selection.main.head
        const window = getWindow()
        const localBytes = window.map.toBytes(localUnits)
        const offset = window.start + localBytes
        // M5e-PLAN.md R8f: this selection *is* the caret moving — moving it
        // again to the resolved node's span start would fight the person
        // typing (and would fire Raw's own scroll-to-caret effect under
        // their cursor).
        const store = getStore()
        selectNode(store, nodeContainingOffset(store, offset), { moveCaret: false })
      }, CARET_SYNC_DEBOUNCE_MS)
    },
    destroy() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
    }
  }))
}
