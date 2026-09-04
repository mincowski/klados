# R69–R70 — where focus lands, and where Find lives

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Two reports that share a cause: an action changes what the app
is *showing* without changing what the keyboard is *pointing at*. Related: `docs/plans/R61-keyboard-workflow.md`,
which found the pane-focus model built and undiscovered. Results at the end of this file.

---

## 1. R69 — nothing ever moves focus into a pane

**Confirmed by reading every path that could**: `focusPane` is called from exactly one place, the
`nodepad.focus.*` commands (`builtins.ts:69`). It does not appear in `documentSession.ts`,
`activeSession.ts`, `tabs.ts` or `Palette.tsx`. So:

- **Opening a file** leaves focus wherever it was — the Open button, or nothing. The document
  appears; the arrow keys still do not drive it.
- **Jumping to a node from the palette** calls `selectNode(store, node)` (`Palette.tsx:283`), which
  changes the selection, and then the palette *restores focus to whatever had it before it opened*
  (its own documented behaviour). The tree scrolls to the node and the keyboard is still pointing
  somewhere else.

Selection and focus are decoupled throughout, which is correct as a default — a mouse click in
Detail should not steal the keyboard from Raw — but wrong for these two, where the user's action
*was* "take me there."

**Fix: focus a pane after both.**

- **After open**, once the session reaches `ready` (the same condition `when: 'format'` already
  gates the focus commands on). The report says Tree, and Tree is right — it is the navigable pane
  and the one the arrow keys serve best.
- **After a palette jump** (`@` name lookup, `/` path query, and `:` go-to-position), focus Tree
  instead of restoring the previous focus. Ordinary commands must keep restoring, so this is a
  per-mode decision inside the palette's existing restore path, not a change to it.

**The trap: Tree can be hidden.** `focusPane` no-ops on an unregistered pane, so under a layout with
the Tree collapsed both fixes would silently do nothing and leave focus stranded. Use a
first-visible-pane fallback — `moveFocus` already filters `PANE_ORDER` by what is registered, so the
logic exists and needs only a "focus this one, or the first available" entry point.

**A `:` go-to-position jump is arguably Raw's**, not Tree's, since a byte offset is a source
location. Worth deciding rather than inheriting: the recommendation is Tree for `@` and `/` (both
name *nodes*) and Raw for `:` (which names a *position*), falling back as above when the preferred
pane is hidden.

## 2. R70 — Ctrl+F does nothing when the Raw pane is hidden

`<FindBar />` is rendered inside `Raw.tsx:670`. Measured against the built app with the Raw pane
toggled off:

| Layout | `.cm-content` | Find elements after `Ctrl+F` | Focus |
|---|---|---|---|
| Raw hidden | 0 | **0** | unchanged |
| Raw visible | 1 | 7 | `.find-input` |

So with Raw hidden the shortcut is inert — no bar, no message, no indication that anything happened.
The report's instinct is right.

### The scope is already correct; only the location is wrong

Worth separating, because the two look like one problem. **Find is already document-wide.** D-038
settled it: Find takes the conventional `Ctrl+F` and searches the document's bytes, while the grid's
own quick filter moved to `Ctrl+Alt+F` rather than having `Ctrl+F` mean different things in
different panes. Nothing about the *search* is Raw-scoped.

What is Raw-scoped is where the bar is mounted. **Fix: hoist `<FindBar />` to the app shell**, beside
`<Palette />` in `App.tsx`, positioned like the palette and the notification stack — a floating
surface, not a child of a pane.

**This is not just a move, and the plan should not pretend it is.** The bar drives Raw: it scrolls
to and highlights the current match in the editor. Hoisted, it needs an answer for "Raw is not
there." The recommendation, smallest first:

1. Hoist the bar so `Ctrl+F` always opens something and always reports the match count. That alone
   removes the silent-nothing case, which is the actual defect.
2. When Raw is hidden, make "next match" **select the node containing the match**, so Tree and
   Detail follow the search the way they follow any other selection. Check first whether a match
   offset maps to a node cheaply — if it does not, say so and stop at step 1 rather than adding an
   index for it.

### The open-and-close-tag question: that is text search working correctly

Searching `car` matching both `<car>` and `</car>` is what a byte search over the source *is*, and
changing it would make Find lie about the document. The structural search the report is reaching for
already exists, in the palette:

- **`@name`** — jump to a node by exact name (M4's G1).
- **`/path/query`** — the NodePad path query (G9), whose grammar is `/`-separated steps.

That is the third instance in three rounds of "already built, undiscovered" (after F6/Ctrl+1-3 and
the arrow keys). It is not a coincidence and it is not fixed by building more: **R65's shortcuts
panel is where these become visible**, and the `@` and `/` prefixes belong in it explicitly — they
are palette *modes*, not commands, so the registry-derived half of that panel will not find them on
its own.

---

## Results

**R69.** `focus.ts` gained `focusPaneOrFirstAvailable(preferred)` — `preferred` if registered,
otherwise the first pane in canonical order that is (§1's own named trap: `focusPane` alone silently
strands focus on a hidden target). `Layout.tsx` calls it with `'tree'` from a `useEffect` gated on an
actual phase *transition into* `ready` (a `useRef` holding the previous render's phase, compared
before being overwritten) — not "phase is ready," which would also fire on a session restored
already-`ready` at startup or on switching between two tabs that are both already `ready`. One case is
broadened beyond the letter of "after open": switching from a non-ready tab (freshly created and still
empty) back to an already-`ready` one also focuses Tree now — accepted rather than engineered around,
since precisely excluding it would need tracking tab identity, and a tab switch refocusing the main
pane grid is a reasonable thing for it to do anyway, not a clear defect.

Palette jumps (`@`/`:`/`/`) now call a new `closeAndFocus(pane)` instead of `closeRestoringFocus()` —
`paneForPaletteJump(mode)` (new, in `paletteLogic.ts`, kept pure and unit-testable per that module's
own convention) resolves Tree for `@`/`/` and Raw for `:`, per §1's own recommendation. Ordinary
command runs are untouched — they still restore focus to wherever it was, exactly as before.

**R70.** `<FindBar />` moved from a child of `Raw.tsx`'s `.raw-container` to a direct child of
`Layout.tsx`'s `.layout`, unconditional on both the document session's phase and `layoutStore`'s
`rawVisible` — `Ctrl+F` now always opens the bar and always reports a match count, regardless of
which panes are showing. `.layout` gained `position: relative` (`Layout.css`) as `.find-bar`'s new
`position: absolute` anchor, replacing `.raw-container`'s own — since `.layout` already sits entirely
below the title bar and tab strip the same way `.raw-container` did, R8e's original fix (never
colliding with Windows' caption-button overlay) carries over with no pixel offset needing to guess the
title bar's height.

**Step 2 of §2's own recommendation — select the node containing the match when Raw is hidden — turned
out to already be built**, found while reading `FindBar.tsx`'s `moveTo` rather than needing new code:
it already calls `activeSession.setSelectedNode(node)` unconditionally on every match navigation, never
gated on Raw's visibility. Verified, not built — Tree and Detail already followed Find's current match
before this round; only the bar's own visibility was the defect.

**The bonus item §2's own closing note asked for** — the `@`/`:`/`/`/`>` palette-mode prefixes added
to R65's shortcuts panel, since they're palette *modes* rather than registered commands and the
registry-derived half of that panel could never find them on its own. New "Command Palette" group in
`Shortcuts.tsx`'s `IN_PANE_KEYS`.

**Review.** No findings — `focusPaneOrFirstAvailable`, `paneForPaletteJump` and the `Layout.tsx` phase-
transition effect were each checked against the specific trap the plan named for it (the hidden-pane
strand, the restore-vs-jump distinction, the restored-ready-on-startup false positive) while writing
them, and the one accepted broadening (tab-switch-back-to-ready also focusing Tree) is disclosed above
rather than silently shipped.

**Tests.** `test/focus.test.ts` gained 3 (`focusPaneOrFirstAvailable`); `test/palette.test.ts` gained 2
(`paneForPaletteJump`); `test/findBarHoisted.test.tsx` (new, 4, real Chromium) covers Find rendering
with no document open, with Raw explicitly hidden, its new `.layout`-relative positioning, and
open/close. `npm run typecheck` and `npm run lint` both clean; the full suite passes (one pre-existing,
unrelated flaky timeout in `jsonParser.test.ts`, confirmed to pass in isolation).
