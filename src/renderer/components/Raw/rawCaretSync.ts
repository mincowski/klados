/**
 * Caret → node resolution (M1-PLAN.md D14, CONCEPT.md §4.4): "moving the
 * caret resolves offset → node → selection, debounced. Scrolling does
 * not." Reuses `nodeSpanLookup.ts`'s `nodeContainingOffset` — the same
 * primitive D11's decorations use, per D14's own instruction not to write
 * it twice.
 *
 * R218 (`docs/plans/R218-range-selection-sync.md`): D14 was written for a
 * caret, and a range selection went through the same path — so dragging a
 * selection moved the node selection to wherever the pointer was, even
 * mid-drag. Two rules now:
 *
 * - **Nothing resolves while the mouse button is held.** A drag resolves
 *   once, on release.
 * - **A range resolves to the smallest node containing all of it**, with
 *   layout whitespace trimmed from both ends; a caret resolves as before.
 *   Keyboard and mouse follow the same rule, so Shift+arrow grows the node
 *   selection outward exactly as a drag would.
 */
import { Annotation, type Extension, type Text } from '@codemirror/state'
import { ViewPlugin, type EditorView } from '@codemirror/view'
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { nodeContainingOffset, nodeContainingRange } from '../../nodeSpanLookup'
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
 * that fast keyboard repositioning (arrow-key repeats) doesn't fire a
 * resolution per intermediate position, short enough that settling on a
 * spot feels immediate. A mouse drag no longer relies on it (R218): nothing
 * resolves while the button is held.
 *
 * R162 (`docs/plans/R159-fixed-duration-waits.md` §7): exported, because it was
 * module-private and every test that cared about it wrote its own guess instead
 * — `focusIntoContent.test.tsx` waited 250 ms "past rawCaretSync's debounce",
 * a 1.25× margin over a number it had no way to name, and passed at 125 ms
 * because it was not really testing this at all. A test that must express a
 * duration should import the number rather than copy it. */
export const CARET_SYNC_DEBOUNCE_MS = 200

/** Whitespace that only lays a document out. Deliberately not Unicode's
 * wider set: this decides which node a selection belongs to, and a selection
 * ending in a no-break space selected that character on purpose. */
function isLayoutWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/**
 * `[from, to)` with layout whitespace trimmed from both ends, in the window's
 * UTF-16 units — so Shift+Down over exactly one line selects the element on
 * it, not the parent that owns its indentation and line break. `null` when
 * nothing but whitespace is selected.
 *
 * Reads one character at a time from each end rather than slicing the range:
 * a selection can cover the whole window, and only the whitespace runs at its
 * edges are ever looked at.
 */
export function trimLayoutWhitespace(
  doc: Text,
  from: number,
  to: number
): { from: number; to: number } | null {
  let start = from
  let end = to
  while (start < end && isLayoutWhitespace(doc.sliceString(start, start + 1))) start++
  while (end > start && isLayoutWhitespace(doc.sliceString(end - 1, end))) end--
  return start < end ? { from: start, to: end } : null
}

/** The node a Raw selection stands for: the node containing the caret, or the
 * smallest node containing a whole range (R218). */
function nodeForSelection(view: EditorView, store: NodeStore, window: RawWindowSnapshot): NodeRef {
  const { head, from, to } = view.state.selection.main
  // UTF-16 unit positions into the window's own text, not byte offsets — the
  // same conversion `rawEdit.ts` and `Raw.tsx` need at this same boundary
  // (UI-FEEDBACK.md M5b).
  const bytesAt = (units: number): number => window.start + window.map.toBytes(units)
  const range = from === to ? null : trimLayoutWhitespace(view.state.doc, from, to)
  if (range !== null) {
    const node = nodeContainingRange(store, bytesAt(range.from), bytesAt(range.to))
    if (node !== null) return node
  }
  return nodeContainingOffset(store, bytesAt(head))
}

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
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    // R218: the primary button is down on the content — a drag may be under
    // way — and whether the selection changed since it went down.
    let held = false
    let changedWhileHeld = false

    function schedule(): void {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (disposed) return
        const store = getStore()
        // M5e-PLAN.md R8f: this selection *is* the caret moving — moving it
        // again to the resolved node's span start would fight the person
        // typing (and would fire Raw's own scroll-to-caret effect under
        // their cursor).
        selectNode(store, nodeForSelection(view, store, getWindow()), { moveCaret: false })
      }, CARET_SYNC_DEBOUNCE_MS)
    }

    // Capture, so this runs before CodeMirror's own mousedown handler on the
    // same element dispatches the press's selection. The timer check covers
    // the other order anyway: a resolution already scheduled is held back too.
    function press(event: MouseEvent): void {
      if (event.button !== 0) return
      held = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
        changedWhileHeld = true
      }
    }

    // `mouseup` on the document, where CodeMirror listens for the end of its
    // own drag, since the button can be released outside the editor. `dragend`
    // ends a drag of already-selected text, which never sees a `mouseup`; a
    // window blur ends anything the other two missed.
    function release(): void {
      if (!held) return
      held = false
      if (changedWhileHeld) {
        changedWhileHeld = false
        schedule()
      }
    }

    const doc = view.contentDOM.ownerDocument
    const win = doc.defaultView
    view.contentDOM.addEventListener('mousedown', press, true)
    view.contentDOM.addEventListener('dragend', release)
    doc.addEventListener('mouseup', release)
    win?.addEventListener('blur', release)

    return {
      update(update) {
        if (update.docChanged || !update.selectionSet) return
        if (update.transactions.some((tr) => tr.annotation(programmaticSelection) === true)) return
        if (held) {
          // Every selection a mouse drag makes is CodeMirror's `select.pointer`.
          // Anything else while "held" — a keyboard move — means the release
          // was missed somewhere, and staying held would silently switch caret
          // sync off until the next click.
          if (update.transactions.some((tr) => tr.isUserEvent('select.pointer'))) {
            changedWhileHeld = true
            return
          }
          held = false
          changedWhileHeld = false
        }
        schedule()
      },
      destroy() {
        disposed = true
        if (timer !== null) clearTimeout(timer)
        view.contentDOM.removeEventListener('mousedown', press, true)
        view.contentDOM.removeEventListener('dragend', release)
        doc.removeEventListener('mouseup', release)
        win?.removeEventListener('blur', release)
      }
    }
  })
}
