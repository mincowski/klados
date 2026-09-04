# R91–R94 — F6 lands on the pane, not on anything in it

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. One report: cycling panes with F6 selects a pane but leaves the
keyboard with nothing to drive. Direct sequel to `docs/plans/R69-focus-and-find.md` §1, which made
focus *reach* a pane, and to `docs/plans/R61-keyboard-workflow.md`, which built the in-pane keyboard
models this round finally connects to. Results at the end of this file.

**Every question in this document is settled — nothing here is waiting on a decision.** Where a
choice was made rather than derived, the section says so and gives the reason.

**R112 is appended as an addendum at the end**: F6 was dead on the first press after opening a
document, because `registerPane` could clear `lastFocusedPane` while the pane it named still held
focus — and `moveFocus`'s null case then made that permanent.

---

## 1. The cause, and how short the gap is

`PaneShell` (`Layout.tsx:85`) renders `<div className="pane-body" ref={ref} tabIndex={-1}
role="region">` and registers *that element* with the focus model. `focusPane` calls
`registered.get(pane)?.focus()` (`focus.ts:52`), so F6, Shift+F6 and Ctrl+1/2/3 all land on a
`tabIndex={-1}` wrapper that handles no keys at all.

Arrow keys then do nothing, and not for a subtle reason: every pane's key handling is a React
`onKeyDown` on an element *inside* `.pane-body`. A `keydown` on the wrapper bubbles **up**, never
down, so those handlers are never reached.

**The interactive element already exists in every pane but one**, fully built and one Tab key away:

| Pane | F6 focuses today | What actually handles arrows | Gap |
|---|---|---|---|
| Tree | `.pane-body` | `.tree` — `role="tree"`, `tabIndex={0}`, `aria-activedescendant` (`Tree.tsx:420-426`) | one Tab |
| Detail, grid mode | `.pane-body` | `.grid-scroll` — `role="grid"`, `tabIndex={0}` (`Grid.tsx:708-715`) | Tab, past the breadcrumb and toolbar groups |
| Detail, list mode | `.pane-body` | **nothing** — `ChildrenList` has no `tabIndex` and no `onKeyDown`; rows are `onMouseDown` only (`Detail.tsx:399`) | no keyboard model exists |
| Raw | `.pane-body` | `.cm-content` (contenteditable, so focusable) | one Tab |

So three quarters of this round is *aiming* focus at something already built. That is also why the
report reads as "the feature is missing" rather than "the feature is broken" — R61/R62 built the
in-pane navigation, R69 built the pane-to-pane navigation, and nobody joined them.

### What is already true, and must not be rebuilt

Checked in the source rather than assumed, because each one removes work this round would otherwise
have invented:

- **The Tree's active row *is* the selection.** `activeIndex` is derived, not stored —
  `Math.max(0, indexOfNode(rows, selectedNode))` (`Tree.tsx:180`) — and an effect scrolls it into
  view on every change (`Tree.tsx:191`). Focus the element and the arrow keys are already pointed at
  the right row, already on screen. Nothing else is needed.
- **Raw's caret is already at the start of the selected node.** `setSelectedNode` sets
  `caretOffset = state.document.store.spanOf(node).start` (`documentSession.ts:1343-1346`); Raw's
  `caretOffset` effect calls `jumpTo`, which dispatches `selection: { anchor: local }`
  (`Raw.tsx:793`). The requested `|<car>` is where the caret sits right now — it is simply in an
  unfocused editor. **Only focus is missing.**
- **The grid's active cell starts at the first row.** `useState({ row: 0, col: 0 })`
  (`Grid.tsx:103`), which is exactly what the report asks for.
- **Pane tracking does not move.** `registerPane` listens for **`focusin`**, which bubbles, so
  focusing a descendant still updates `lastFocusedPane` and the `focus` context key. `Layout.css:64`
  uses `:focus-within` for the same reason and its comment already anticipates this ("actual DOM
  focus sits on the nested `.pane-body`" — that sentence needs updating, nothing else does).

## 2. R91 — a pane registers where its focus should go

`focus.ts` gains a second, optional registration alongside `registerPane`:

```ts
/** Puts focus on the pane's interactive heart. Returns false when there is
 *  nothing to focus right now (no document, no selection), in which case the
 *  pane shell's own body takes it, exactly as today. */
export type PaneContentFocus = () => boolean

export function registerPaneContent(pane: Pane, focusContent: PaneContentFocus): () => void
```

and `focusPane` becomes:

```ts
export function focusPane(pane: Pane): void {
  const shell = registered.get(pane)
  if (shell === undefined) return          // hidden pane — no-op, unchanged
  if (content.get(pane)?.() === true) return
  shell.focus()                            // fallback — today's behaviour
}
```

**The order matters and is not arbitrary.** The shell check comes first so a collapsed pane still
no-ops (R69's own trap, and the reason `focusPaneOrFirstAvailable` exists); the delegate is tried
second; the shell is the floor, so no state of the app can leave F6 with nowhere to land.

**A plain function, not an element.** `focus.ts`'s module comment is explicit that it is
"deliberately typed against a minimal structural interface rather than `HTMLElement`, so it can be
exercised in tests with a plain object — no DOM needed", and `test/focus.test.ts` depends on that. A
`() => boolean` keeps it true.

**Cleanup must be identity-guarded** — `if (current === mine) current = null`, the pattern
`rawController.ts` and `gridController.ts` both already use. React can mount a replacement before
unmounting the one it replaces, and an unguarded cleanup would then delete the *new* registration.

**Rejected: hanging this off the existing per-pane controllers.** `treeController`, `rawController`
and `gridController` each already exist, and `focus.ts` could call into all three. It would couple
focus policy to three modules with three different lifetimes (`gridController` only exists when a
grid does; `treeController` re-registers per document), and there is no controller for Detail's list
mode at all. One registry, one lifetime rule.

**Registration follows ownership of the element**, which decides who calls it:

- **Tree** registers directly — it owns `.tree`. In `TreeContent`, alongside the effect that already
  registers `treeController`.
- **Raw** registers directly — it owns the `EditorView`.
- **Detail** registers a delegate that calls **`focusGrid()`**, a new member on the existing
  `GridController`, because the element lives in a child component. `DetailContent` already computes
  `useGrid` locally, so it knows which branch to take without asking whether a controller is
  registered; `focusGrid()` returns a boolean anyway, covering the render where the grid has not
  mounted yet.

R91 ships the mechanism plus the Tree, since a registry with no consumer proves nothing. **Every
element this round needs a handle on is already ref-ed** — `.tree` has `parentRef` for its
virtualizer (`Tree.tsx:182`), `.grid-scroll` likewise (`Grid.tsx:709`), and `.detail` has `paneRef`
for its overlay `<Scrollbar>` (`Detail.tsx:120`). So no ref plumbing is added anywhere; Tree is one
`registerPaneContent('tree', …)` call in the effect that already registers `treeController`.

## 3. R92 — Raw focuses the editor

`handle.view.focus()`. The caret needs no repositioning (§1), and repositioning it would be actively
wrong: leave Raw with the caret somewhere, go to the Tree, come back with F6, and the caret must
still be where you left it. `rawCaretSync` has already resolved the selection to the node containing
it, so the selection and the caret agree without either being moved.

**One thing does need care: the caret may be focused and off-screen.** Raw's own model decouples
scrolling from the caret on purpose — "moving the caret resolves offset → node → selection,
debounced. Scrolling does not" (`rawCaretSync.ts`) — so a user who scrolled Raw with the mouse and
then pressed F6 would get a blinking caret they cannot see, and their first keystroke would teleport
the view.

**Decided: focusing Raw also makes the caret visible, without moving it.** The naive
`EditorView.scrollIntoView(state.selection.main.head)` is not enough, and the reason is specific to
this codebase: scrolling can trigger a **re-slice** (`applyReslice`), and if the window has moved
past the caret's byte offset, CodeMirror will have clamped the selection to the new document's
bounds — so `main.head` no longer names the caret, and scrolling to it would land somewhere
arbitrary. The check is cheap and the pieces already exist:

- `caretOffset` inside `[handle.start, handle.end)` → `scrollIntoView` on the mapped local position.
  A pure scroll, no selection dispatched, so nothing `rawCaretSync` reacts to.
- Outside it → `jumpTo(handle, …, caretOffset, …)`, which already handles both the re-slice and the
  byte→UTF-16-unit conversion. It repositions the caret to `caretOffset`, which is where it
  logically already was.

**Read-only is not this round's problem.** F6 into a read-only document gives a caret that moves but
refuses to type. That is R90's clear-refusal story (`docs/plans/R86-find-as-query-surface.md` §6),
not a reason to skip focusing the editor.

## 4. R93 — the grid's active cell does not scroll into view

**A defect, found while checking that R94 would actually work.** The report asks to "scroll through
the rows with the arrow keys"; today, in the grid, you cannot.

`Grid.tsx` contains **no scroll-into-view of any kind** — `scrollToIndex`, `scrollIntoView` and
`scrollTop` appear nowhere in the file; the only occurrences of "scroll" are class names and R44b's
horizontal-overflow probe. The rows are virtualized (`useVirtualizer`, `Grid.tsx:269`) and focus
stays on the scroll container (an `active`-cell model, not per-cell DOM focus), so the browser's own
"scroll the focused element into view" never fires either.

The consequence is worse than a missing convenience: press ArrowDown past the last visible row and
the active cell moves to a row the virtualizer **has not rendered**, so the highlight vanishes
entirely and further presses appear to do nothing at all.

**It is untested as well as unimplemented**: `test/gridKeyboardNav.test.tsx` never arrows past the
visible rows and never inspects scroll position.

Fix mirrors `Tree.tsx:191` exactly — an effect on `active.row` calling
`rowVirtualizer.scrollToIndex(active.row, { align: 'auto' })`, skipping `row === -1` (R62's header
row, which is sticky and always visible).

**The column axis needs more care than the row axis, and is scoped deliberately.** Columns are
virtualized too (`colVirtualizer`, `Grid.tsx:276`), but the grid also has *pinned* columns
(`stickyCount`/`stickyLefts`) that sit outside the virtual range — scrolling to a sticky column's
index would scroll to the wrong place, and scrolling to a body column must account for the sticky
columns' width or the target lands underneath them. Rows are what the report asks for and are the
one-liner; columns land in the same task with the pinned case handled explicitly, and a test that
arrows right past a **pinned** column rather than only past a plain one.

**R93 must land before R94.** Otherwise R94's contribution is to aim F6 at a grid you can arrow off
the bottom of.

## 5. R94 — Detail, in both of its modes

**Grid mode:** focus `.grid-scroll`. Its `active` is already `{ row: 0, col: 0 }`, so this is
literally the requested "focus on the first row of the details table".

**List mode — the case the report left open, and the recommendation is the modest one.** Give
`.detail` (the pane's own scroller: `height: 100%; overflow: auto`, `Detail.css:22`) a
`tabIndex={-1}` and focus it through the `paneRef` it already carries — the attribute is the only
new thing. Arrow keys, PageUp/PageDown, Home and End then scroll the pane
natively, with no new selection model, no new state and no new ARIA. Focus is on something that
responds to the keyboard, which is the whole of the complaint.

**Rejected: keyboard navigation over the children list.** It was the report's own tentative idea, and
it is worth saying why not, because it will come up again. It would be a second tree with a strictly
worse model — no expand/collapse, no ancestors, no type-ahead — and the "Enter to descend" it implies
*is* the tree, which is one F6 press away and already does all of that. The report's own instinct
("that could also be achieved by navigating tree pane") is right. The children list stays
mouse-driven; if it ever earns a keyboard model, it earns it as a task about the children list, not
as a side effect of a focus round.

**No selection at all** (`Detail` renders `No node selected.`): the delegate is not registered, so
`.pane-body` takes focus exactly as today. That is the fallback in §2 doing its job, not a special
case.

## 6. What else changes, whether or not it was asked for

`focusPane` is the single funnel, so this reaches three callers, not one. Stated because two of them
are not F6, and the change is larger there:

- **Ctrl+1/2/3** (`builtins.ts:75`) — same improvement, free.
- **Opening a file** and **a palette jump** (`focusPaneOrFirstAvailable`, R69) — focus now lands
  *inside* the Tree rather than on its wrapper. This is the good version of R69's intent, and it is a
  real behaviour change: **the Tree consumes bare printable keys for type-ahead**
  (`Tree.tsx:402-404`), so after opening a file a stray keystroke now navigates the tree instead of
  doing nothing. Standard tree-widget behaviour, and the reason `keybindings.ts` requires a modifier
  for global chords — but it belongs in `docs/LOG.md`, because it is the kind of thing that gets
  reported as a bug six weeks later.
- **Tab order shifts by one stop.** Landing on `.tree` (`tabIndex={0}`) and pressing Tab now leaves
  the tree, where before it entered it. Any test asserting a tab sequence from a pane-focus starting
  point needs re-reading — R62 built the roving-tabindex groups those sequences run through.

## 7. Order and definition of done

**R91 → R93 → R94**, with **R92** free to land anywhere after R91. R93 before R94 for the reason in
§4; R91 first because it is the mechanism the other three register with.

- [x] R91 — `registerPaneContent` exists, `focusPane` prefers it, and falls back to the shell when no
      delegate is registered *or* the delegate returns `false`. `test/focus.test.ts` still runs
      against plain objects with no DOM. A hidden pane still no-ops.
- [x] R91 — F6 to the Tree leaves focus on `.tree`, and **the very next ArrowDown moves the
      selection** — asserted on the selection, not on `document.activeElement`, since focusing the
      right element is the means and moving is the point.
- [x] R92 — F6 to Raw leaves focus on `.cm-content` with the caret at the selected node's span start,
      and **the caret is on screen** — including the case where Raw was scrolled away from it first,
      which is the one the naive implementation fails.
- [x] R92 — F6 away from Raw and back does **not** move the caret from where the user left it.
- [x] R93 — ArrowDown from the last visible grid row scrolls the grid and the active cell stays
      rendered; asserted past the virtualizer's window, not within it. ArrowRight past a **pinned**
      column lands the target clear of the sticky columns.
- [x] R94 — F6 to Detail in grid mode leaves the first row active and arrow keys move the cell; in
      list mode leaves focus on `.detail` and arrow keys scroll it; with nothing selected, behaves
      exactly as today.
- [x] `Layout.css:64`'s comment ("actual DOM focus sits on the nested `.pane-body`") is corrected —
      it is the one piece of prose this round falsifies.
- [x] The type-ahead consequence in §6 is in `docs/LOG.md`.

## 8. Results

Landed as planned, in the order §7 lays out: R91 (`632f37a`), R92 (`06ed995`), R93 (`5e89f8f`),
R94 (`48954f3`). No deviations from the design worth recording as their own decision — every
mechanism described above (the shell-then-delegate order in `focusPane`, `jumpTo`'s re-slice-aware
scroll for Raw, the hand-computed sticky-column inset for the grid's horizontal scroll) is exactly
what shipped.

One addition beyond the plan's own scope, found while writing R93's test: `Grid.tsx`'s column axis
needed the sticky-column inset applied only to the *right*-edge scroll target, not the left — a
column's un-shifted `colVirtualizer` offset already lines up flush with the sticky columns' own
right edge when `scrollLeft` is set to it directly, so the left-edge case needs no correction at
all. Verified against real Chromium layout (`test/gridKeyboardNav.test.tsx`'s own two new R93
cases), not just reasoned about, since a sign error here would have been invisible in a shape-only
assertion.

Test coverage: `test/focusIntoContent.test.tsx` (new — R91/R92/R94, against a real session through
the fake-parse harness `findAutoSelect.test.tsx` established, plus `DetailContent`'s own
plain-prop harness for the grid/list-mode cases) and two new cases in `test/gridKeyboardNav.test.tsx`
(R93). `test/focus.test.ts` needed no changes — `registerPaneContent` is exercised there indirectly
through `focusPane`'s existing no-DOM tests via `resetFocusForTests`'s widened cleanup.

---

## Addendum (R112) — F6 was dead on the first press after opening a document

**Reported**: after opening a file, focus is visibly in the Tree pane, and F6 does nothing — not
once, but ever, until the user clicks into another pane by hand, after which cycling works normally.

**Reproduced exactly, then explained.** Mounting the real `Layout` under `StrictMode` — which
`main.tsx` wraps the whole app in — and opening a document leaves:

| | |
|---|---|
| `document.activeElement` | `.tree` — focus really is in the Tree |
| `wasLastFocusedPane('tree' / 'detail' / 'raw')` | **`false` / `false` / `false`** |
| F6 × 3 | `.tree`, `.tree`, `.tree` |

**Two mechanisms, and the bug needs both.**

1. **`focusin` is an event, not a state.** `registerPane` learns which pane holds focus only by
   hearing the event. `StrictMode`'s mount → cleanup → mount replay runs the registration cleanup,
   which clears `lastFocusedPane` — but the DOM element never unmounts, so it *keeps* focus, and no
   second `focusin` is ever fired for the listener that replaces it. `Layout`'s own
   open-a-document effect does not re-run to repair this either: its `previousPhaseRef` already
   reads `ready`, so the phase-transition guard correctly declines to fire twice.

2. **`moveFocus`'s null case then makes it permanent.** With `lastFocusedPane === null` the index is
   `-1`, so `next` starts at `PANE_ORDER[0]` — the Tree — whose element is *already* focused.
   `.focus()` on an already-focused element is a no-op, so no `focusin` fires, so `lastFocusedPane`
   is still `null` on the next press. **The state that breaks F6 is also the state that prevents F6
   from repairing it.** That is why it never recovers on its own, and why a click — which does fire
   `focusin` — fixes it permanently.

**Fix: `registerPane` adopts focus that is already inside the shell it is given.** One line at the
registration site, plus the guard it needs. `FocusablePane` gains an **optional** `contains?` —
real `HTMLElement`s already have it, so `PaneShell` gets the behaviour for free, while the plain
objects the tests register simply skip it and this module stays DOM-free by contract.

`document.body` is excluded deliberately: it contains everything *and* is where focus sits when
nothing is focused, so counting it would make every registration claim the focus.

**Not fixed by making `focusPane` set `lastFocusedPane` itself**, which was the other candidate. It
would leave the first F6 press still doing nothing (it would set the state, then focus the pane
that already had focus) and only unstick the second — treating the symptom one press later rather
than the state being wrong.

**Dev-only in practice, but not fixed as a dev-only problem.** `StrictMode` is what makes it happen
every single time, but the underlying gap — a shell registering while focus is already inside it —
is reachable in production by any remount, and nothing about the fix is conditional on `StrictMode`.

`test/focusAfterOpen.test.tsx` (3 tests): the reproduction above, asserted as **both** halves
(`wasLastFocusedPane('tree')` is true, *and* the first `moveFocus('next')` actually leaves `.tree`)
— checked to fail without the fix, since a regression test that cannot fail is not one; plus a
shell registering while focus is elsewhere, and while nothing at all is focused, neither of which
may claim it.
