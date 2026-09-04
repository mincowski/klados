/**
 * The focus model (CONCEPT.md §7, M1-PLAN.md D4): moving between the
 * three panes by keyboard, and keeping the `focus` context key in sync
 * with wherever focus actually is — including a plain mouse click into a
 * pane, not just keyboard-driven moves.
 *
 * No pane components exist yet (D7 builds them), so this is the
 * registration-based model they'll opt into: a pane calls `registerPane`
 * with a ref to its focusable root once mounted. Deliberately typed
 * against a minimal structural interface rather than `HTMLElement`, so it
 * can be exercised in tests with a plain object — no DOM needed.
 *
 * R112 qualifies that last claim rather than breaking it: `registerPane`
 * now reads `document.activeElement` *when a DOM exists*, to adopt focus
 * that is already inside the shell being registered (see its own comment
 * for the bug that needs). The interface stays DOM-free — the capability
 * it uses is an optional member, and the read is guarded on `document`
 * existing — so a plain object in the node test project still registers
 * exactly as before.
 */
import { setContext, type Focus } from './commands/context'

export type Pane = Focus

/** The subset of `HTMLElement` this module actually needs. */
export interface FocusablePane {
  focus(): void
  addEventListener(type: 'focusin', listener: () => void): void
  removeEventListener(type: 'focusin', listener: () => void): void
  /** Optional so this interface stays satisfiable by the plain objects the
   * tests register (see this module's own header). Real `HTMLElement`s have
   * it already, so `PaneShell`'s registration gains the behaviour below for
   * free while a DOM-less test simply skips it. */
  contains?(other: unknown): boolean
}

/**
 * Whether focus is already inside `element` at the moment it registers.
 *
 * `document.body` is excluded deliberately: it "contains" everything, and
 * it is also where focus sits when nothing is focused at all — treating
 * that as "this pane has focus" would make every registration claim the
 * focus.
 */
function alreadyHoldsFocus(element: FocusablePane): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  if (active === null || active === document.body) return false
  return element.contains?.(active) === true
}

// Canonical left-to-right order (CONCEPT.md §4.1) — also the cycle order
// for moveFocus('next'/'previous'). A pane not currently registered
// (collapsed via a D7 layout toggle, or not yet mounted) is skipped.
const PANE_ORDER: readonly Pane[] = ['tree', 'detail', 'raw']

const registered = new Map<Pane, FocusablePane>()
const content = new Map<Pane, PaneContentFocus>()
let lastFocusedPane: Pane | null = null

export function registerPane(pane: Pane, element: FocusablePane): () => void {
  const onFocusIn = (): void => {
    lastFocusedPane = pane
    setContext('focus', pane)
  }
  registered.set(pane, element)
  element.addEventListener('focusin', onFocusIn)
  // A shell can mount — or, under `StrictMode`, re-run its registration
  // effect — while focus is *already* inside it, and `focusin` is an event,
  // not a state: it fired before this listener existed and will not fire
  // again. Without this, `lastFocusedPane` stays `null` while the pane
  // visibly holds focus, and `moveFocus` then reads "nowhere" and starts
  // from `PANE_ORDER[0]` — the Tree — whose element is already focused, so
  // `.focus()` is a no-op, no `focusin` fires, and `lastFocusedPane` is
  // still `null` on the next press. F6 is then permanently dead until the
  // user clicks another pane. That is exactly what StrictMode's
  // mount → cleanup → mount replay produces: the cleanup below clears
  // `lastFocusedPane`, the DOM element never unmounts so it keeps focus,
  // and `Layout`'s own open-a-document effect does not re-run to repair it
  // (its `previousPhaseRef` already says `ready`).
  if (alreadyHoldsFocus(element)) onFocusIn()
  return () => {
    element.removeEventListener('focusin', onFocusIn)
    registered.delete(pane)
    if (lastFocusedPane === pane) lastFocusedPane = null
  }
}

/**
 * R91 (`R91-focus-into-content.md` §2): puts focus on the pane's interactive
 * heart — `.tree`, `.cm-content`, `.grid-scroll` — rather than on
 * `PaneShell`'s own `tabIndex={-1}` wrapper, which handles no keys at all.
 * Returns `false` when there is nothing to focus right now (no document, no
 * selection), in which case `focusPane` falls back to the shell exactly as
 * before this existed.
 *
 * A plain function, not an element, so this module keeps working against
 * plain objects in tests with no DOM — see `FocusablePane`'s own comment.
 * Identity-guarded cleanup (`rawController.ts`'s pattern): React can mount a
 * replacement before unmounting the one it replaces, and an unguarded
 * cleanup would delete the *new* registration.
 */
export type PaneContentFocus = () => boolean

export function registerPaneContent(pane: Pane, focusContent: PaneContentFocus): () => void {
  content.set(pane, focusContent)
  return () => {
    if (content.get(pane) === focusContent) content.delete(pane)
  }
}

export function isPaneRegistered(pane: Pane): boolean {
  return registered.has(pane)
}

/**
 * R107 (`R106-detail-focus-ring.md` §3): whether `pane` was the last one to
 * receive a `focusin` — true even after focus has since fallen to `<body>`
 * because some element *inside* the pane was removed from under it (a grid
 * unmounting mid-selection-change), since nothing here resets the flag on a
 * plain blur, only on the pane's own shell unregistering. That is
 * deliberate: it is exactly the signal a pane's content needs to tell "the
 * user left this pane" apart from "something inside this pane disappeared
 * out from under the user."
 */
export function wasLastFocusedPane(pane: Pane): boolean {
  return lastFocusedPane === pane
}

/** Direct jump — a no-op if `pane` isn't currently registered (hidden or
 * not yet mounted), rather than throwing on a layout the user chose. The
 * shell-registered check comes first so a collapsed pane still no-ops
 * (`focusPaneOrFirstAvailable` exists for exactly that trap); the content
 * delegate is tried second and the shell is the floor, so no state of the
 * app can leave this with nowhere to land. */
export function focusPane(pane: Pane): void {
  const shell = registered.get(pane)
  if (shell === undefined) return
  if (content.get(pane)?.() === true) return
  shell.focus()
}

/**
 * R69 (`R69-focus-and-find.md` §1): `preferred`, or the first
 * available pane in `PANE_ORDER` if `preferred` is hidden — the trap the
 * plan names explicitly: `focusPane` alone silently no-ops on a collapsed
 * pane and would leave focus stranded wherever it already was (nowhere, on
 * a freshly opened document). A true no-op only when *no* pane is
 * registered at all (every pane collapsed, or none mounted yet), which
 * `moveFocus` already treats as unreachable in practice.
 */
export function focusPaneOrFirstAvailable(preferred: Pane): void {
  if (registered.has(preferred)) {
    focusPane(preferred)
    return
  }
  const fallback = PANE_ORDER.find((pane) => registered.has(pane))
  if (fallback !== undefined) focusPane(fallback)
}

/** R122 (`R120-find-bar-keyboard.md` §5): focuses whichever pane last held
 * focus, falling back to `'raw'` (matching `paletteLogic.ts`'s own
 * `paneForPaletteJump` default) when nothing has been focused yet.
 * `focusPaneOrFirstAvailable`, not `focusPane`, because the remembered pane
 * may since have been collapsed — the trap that function exists for. */
export function focusLastPane(): void {
  focusPaneOrFirstAvailable(lastFocusedPane ?? 'raw')
}

export function moveFocus(direction: 'next' | 'previous'): void {
  const available = PANE_ORDER.filter((pane) => registered.has(pane))
  if (available.length === 0) return

  const currentIndex = lastFocusedPane === null ? -1 : available.indexOf(lastFocusedPane)
  const step = direction === 'next' ? 1 : -1
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + step + available.length) % available.length
  focusPane(available[nextIndex]!)
}

/** Test-only: resets module state between test cases. */
export function resetFocusForTests(): void {
  registered.clear()
  content.clear()
  lastFocusedPane = null
}
