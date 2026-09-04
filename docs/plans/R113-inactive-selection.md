# R113–R116 — content-level focus cues, as a second layer

<!-- status: built -->

**Built.** The caveat §11 recorded was re-checked, corrected and closed by R117 (§12) — read §12
before §11, which is left standing as written so the correction is visible next to the claim it
corrects. Register: `docs/TASKS.md`. Each pane's own selection or active item
says whether the keyboard is currently in that pane: blue when it is, grey when it is not. Sequel
to `docs/plans/R106-detail-focus-ring.md`, whose addendum settled that the whole-pane
`:focus-within` border is *the* pane-level answer. Results at the end of this file.

**Every question in this document is settled — nothing here is waiting on a decision.** Every colour
below was measured against the palette rather than picked, and the two candidates that failed are
recorded with their numbers.

**§11's caveat is factually right and its conclusion is wrong**: `drawSelection()` really is absent,
but native selection *is* reachable — via `::selection`, which R115 never tried. R117 closes it
without the behaviour change §11 declined to make.

---

## 1. This is a second layer, not a replacement

The pane border stays. It was considered as a replacement for it and rejected, for reasons worth
keeping next to the work:

- **Detail in list mode has no active item at all** — no selected row, no active cell, no caret.
  There is nothing to recolour, so a content-only scheme leaves exactly one pane silent.
- **A caret is only visible where the viewport happens to be.** Scroll Raw away from it — which
  `R91`'s own §3 exists to handle — and the cue is gone.
- **Three cues in three vocabularies do not compose into one glance.** "Which pane has focus" stays
  one rule in one place; these answer a different and finer question.

So the border answers *which pane*, and this round answers *which item in it the keyboard will move*.
The two carry different information, which is why both earn their place.

## 2. Overview — every pane, every mode

| Pane / mode | Item | Pane has focus | Pane does not |
|---|---|---|---|
| **Tree** | selected row band | `--row-selected-bg` (blue) | `--row-selected-inactive-bg` (grey) |
| **Detail — grid** | selected row band | `--row-selected-bg` (blue) | `--row-selected-inactive-bg` (grey) |
| **Detail — grid** | active cell ring | `--focus-ring` (blue) | `--focus-ring-inactive` (grey) |
| **Detail — list** | *none — no active item exists* | — | — |
| **Raw** | selected node's span | `--row-selected-bg` (blue) | `--row-selected-inactive-bg` (grey) |
| **Raw** | text selection | `--row-selected-bg` (blue) | `--row-selected-inactive-bg` (grey) |
| **Raw** | caret | visible, blinking | hidden — **already correct, no change** |
| **all three** | pane border | `--pane-focus-ring` | transparent |

**Detail in list mode is a deliberate blank, not an omission.** Its `.detail-child-row` has a hover
background but no selection, no keyboard traversal and no active descendant — checked in
`Detail.tsx`, where the row is a plain `role="row"`. There is no state to reflect. This is precisely
why the pane border has to stay: list mode's only focus indication is the border, and it is enough
because the arrow keys there scroll the pane as a whole.

**The Raw caret already behaves exactly as asked** — but not for the reason first written here.
CodeMirror's base theme does gate `.cm-cursor` on `.cm-focused`, and those rules never apply:
`drawSelection()` is what mounts `.cm-cursorLayer`, and it is not among `Raw.tsx`'s extensions
(§12). The row holds on two other mechanisms, both measured: `.cm-content` is
`contenteditable="true"` and a caret is painted only in the **focused editing host**, so it is
hidden when the pane is not focused by construction; and it is already themed —
`Raw.css:99` sets `caret-color: var(--accent)`. Confirmation, not work — but confirmation of
native behaviour plus one existing app rule, not of CodeMirror's.

## 3. The mechanism — one variable swap per pane, at the pane's own root

Each pane redefines a variable on its own container and overrides it under `:focus-within`; every
rule that draws a selection reads the variable instead of the token directly.

```css
.tree-viewport {
  --selection-bg: var(--row-selected-inactive-bg);
}
.tree-viewport:focus-within {
  --selection-bg: var(--row-selected-bg);
}
.tree-row-selected {
  background: var(--selection-bg);
}
```

**Why the variable rather than a `:not(:focus-within)` override per rule.** There are five drawing
sites across three files, and a sixth will be added by whoever builds the next selectable thing. The
variable makes participation automatic for anything inside the pane; the override form makes it a
rule someone has to remember to write, which is the failure mode `R116` exists to catch and would be
better to not create.

**Which element carries it**, checked against the real DOM rather than guessed:

| Pane | Element | Covers |
|---|---|---|
| Tree | `.tree-viewport` | `.tree` |
| Detail | `.detail-viewport` | `.detail` (list) **and** `.grid-wrapper` (grid) — the common ancestor of both modes |
| Raw | `.raw-pane` | `.raw` → `.cm-editor` → `.cm-content` |

**Not `.pane:focus-within`**, which would be the obvious choice and is wrong here: `.pane` belongs to
`Layout.css`, and reaching up to a layout class from three component stylesheets couples them to the
shell for no gain. Each pane's own viewport is already the right boundary.

**And not the inner focus target** (`.tree`, `.grid-scroll`, `.cm-content`). `.detail-viewport`
rather than `.grid-scroll` specifically so that **typing in the grid's quick-filter keeps the
selection blue** — the filter sits in `.grid-toolbar`, outside `.grid-scroll` but inside the pane,
and the keyboard is still in Detail. Scoping to the scroller would grey the rows out the moment the
user started filtering them, which is the opposite of informative.

**Consequence worth stating: focus in the Find bar greys all three panes.** That is correct — the
keyboard genuinely is in Find — and the current-match highlight is a separate token
(`--find-match-bg`), so what the user is looking for stays exactly as visible.

## 4. The tokens, measured

Two new tokens, both defined in `themes/dark.css` and `themes/light.css` alongside the pair they
shadow. Invariant 9 is the reason these are tokens rather than values at the use sites.

| Token | dark | light |
|---|---|---|
| `--row-selected-inactive-bg` | `--gray-700` | `--gray-300` |
| `--focus-ring-inactive` | `--gray-400` | `--gray-600` |

`--row-selected-fg` is reused unchanged for text on the inactive band — measured safe on both
(**9.19:1** dark, **10.77:1** light), so a second foreground token would be dead weight.

**The band, against what it has to be distinguishable from.** A selection band is inherently
low-contrast — the *focused* one is only 1.15 (dark) / 1.24 (light) against the surface — so the bar
here is not 3:1. It is: **at least as visible as the focused band, and not confusable with hover.**

| | dark | light |
|---|---|---|
| focused band vs surface | 1.15 | 1.24 |
| hover vs surface | 1.26 | 1.16 |
| **chosen inactive band vs surface** | **1.84** | **1.66** |
| **chosen inactive band vs hover** | **1.45** | **1.43** |

**Rejected: `--gray-200` for light.** 1.31 against the surface but only **1.13 against hover** — a
selected-but-unfocused row would have been near-indistinguishable from whatever row the mouse
happened to be over.

**The ring** does carry the project's 3:1 non-text bar (D-051/R33), against every background an
active cell can sit on:

| ring | on plain cell | on alt row | on inactive selected row |
|---|---|---|---|
| `--gray-400` (dark) | 7.05 | 6.40 | **3.84** |
| `--gray-600` (light) | 6.63 | 6.24 | **3.98** |

**Rejected: reusing `--pane-focus-ring`.** It is `--gray-600` dark / `--gray-300` light, and on the
inactive band it measures **1.47** (dark) and **1.53** (light) — far under the bar. It is documented
as the deliberately quieter whole-pane token and it is quiet for a reason; this ring has a different
job. Worth recording so the two are not "simplified" together later.

**A trap that never fires, recorded so nobody creates it.** In light, the *focused* blue ring
(`--blue-500`) on the *inactive* grey band measures **2.99** — just under. That pairing cannot occur,
because the ring and the band always change together: focused is blue-on-blue (**4.00**), unfocused
is grey-on-grey (**3.98**). Anyone who later drives them from separate conditions will land on the
one combination that fails.

## 5. R113 — the tokens, the mechanism, and the Tree

The reference implementation, done once properly so R114 and R115 are the same shape.

- Both tokens added to both theme files.
- `.tree-viewport` carries `--selection-bg`, overridden under `:focus-within`.
- `Tree.css:46`'s `.tree-row-selected` reads `var(--selection-bg)`.

`.tree-row-matched`'s Find marker (`box-shadow: inset 3px 0` in `--find-match-marker`) is untouched
and must stay untouched — it composes *over* the selected background deliberately, and it means "this
matched", which has nothing to do with where focus is.

## 6. R114 — Detail, grid mode only

- `.detail-viewport` carries `--selection-bg` **and** `--selection-ring`.
- `Grid.css:378`'s `.grid-row-selected .grid-cell` reads `var(--selection-bg)`.
- `Grid.css:234`'s `.grid-cell-active` outline reads `var(--selection-ring)`.

List mode gets the variables from the same ancestor and simply has nothing that reads them, which is
the correct outcome rather than a special case to write.

## 7. R115 — Raw

- `.raw-pane` carries `--selection-bg`.
- `Raw.css:149`'s `.cm-np-selected` — the selected node's span, the direct analogue of the Tree's
  selected row — reads `var(--selection-bg)`.
- The text selection is `::selection` on `.cm-content`, reading the same `--selection-bg`.
  **Corrected by R117 (§12)** — this was originally written as a `.cm-selectionBackground` pair,
  which is dead in this editor: `drawSelection()` mounts that class and is not among `Raw.tsx`'s
  extensions. Both `.cm-content ::selection` and `.cm-content::selection` are needed, since the
  text sits in descendant `.cm-line` elements.
- The caret needs no change (§2), for the reason given there.

## 8. What deliberately does not participate

Enumerated because every one of these reads `--row-selected-bg` or `--focus-ring` today and would
otherwise look like an oversight:

| Site | Why not |
|---|---|
| `Grid.css:49` `.grid-quick-filter:focus-visible` | If it is focused, the pane *is* focused. A focus ring on the focused element is never inactive. |
| `Grid.css:131-133` `.grid-filter-toggle[aria-pressed='true']` | A toggle's on-state. "This filter is on" stays true regardless of where the keyboard is. |
| `Grid.css:325` `.grid-header-filter-active` | Same — a column-has-a-filter indicator, not a selection. |
| `Grid.css:345` `.grid-header-resize-handle:hover` | Mouse-only affordance; hover already implies the pointer, not the keyboard. |
| `Find.css`, `DocumentArea.css`, `Notifications.css`, `CommandPalette.css` | Outside the three panes entirely. |

## 9. R116 — the rule, enforced by test rather than by memory

The mechanism's whole point is that a future selectable thing participates automatically, and the
thing that can still go wrong is a **new pane** — or a rewritten one — that never sets the variables
at all. A per-pane test cannot fail for a pane added later.

So: a test that **enumerates the panes** and asserts, for each, that its selection colour differs
between focused and unfocused, without naming the elements individually. `R101`'s
`externalRewrites` enumeration test is the established precedent, and invariant 10's "enforced by
test, not discipline" is the principle.

Alongside it, per-pane assertions on the actual values — focused resolves to `--row-selected-bg`,
unfocused to `--row-selected-inactive-bg` — because "they differ" would pass on two wrong colours.

## 10. Definition of done

- [x] R113 — both tokens exist in both themes; `.tree-row-selected` is blue with focus in the Tree
      and grey with focus in another pane, asserted on computed colour, not on a class.
- [x] R113 — the Tree's Find marker (`.tree-row-matched`) is unchanged in both states.
- [x] R114 — the grid's selected row **and** active cell both switch, in the same test, since they
      are driven by two different variables and could diverge.
- [x] R114 — **focus in the grid's quick-filter leaves the selection blue.** This is the case the
      element choice in §3 exists for, and the one a `.grid-scroll`-scoped implementation gets wrong.
- [x] R114 — Detail in list mode renders unchanged in both states (no regression from the variables
      being inherited by a mode that ignores them).
- [x] R115 — `.cm-np-selected` switches, driven by `:focus-within` on `.raw-pane`.
- [x] R115 — the text selection switches with pane focus, and the caret is hidden when Raw is
      unfocused. **Closed by R117 (§12), not by the mechanism R115 assumed**: `drawSelection()` is
      not among the editor's extensions, so `.cm-selectionBackground` never reaches the DOM — but
      `::selection` does paint, and it is what carries this now. The caret is native
      `contenteditable` behaviour plus `Raw.css:99`'s `caret-color`.
- [x] R116 — an enumeration test over the panes that a newly added pane fails until it participates.
- [x] Contrast is asserted, not just eyeballed: text on the inactive band ≥ 4.5:1 and the inactive
      ring ≥ 3:1 against the inactive band, in both themes. `test/scrollbarContrast.test.tsx` and
      `test/findMatchContrast.test.tsx` are the pattern to follow.
- [x] Every site in §8 is verified unchanged, so the sweep did not catch a toggle or a hover.

## 11. Results

Built as designed, in `Tree.css`, `Detail.css`, `Grid.css`, `Raw.css` and both theme files, exactly
per §§5–7 — reviewed against `git diff`, not against memory of having written it. Tests:
`test/inactiveSelection.test.tsx` (real Chromium — `:focus-within`, computed colours and a real
mounted `Raw`/`EditorView`), `test/inactiveSelectionSites.test.ts` (§8's static source guard, in
the node project because `node:fs` is externalized from the browser project's Vite build).

**One caveat, found while writing R115's own DoD items rather than assumed from the plan text.**
§2 and §7 both describe `.cm-selectionBackground`/`.cm-cursorLayer`/`.cm-cursor` as CodeMirror's
own base-theme behaviour, already active — reasonable to believe, since `Raw.css` already had
`!important` rules for `.cm-selectionBackground` before this round, as if they mattered. They
don't, currently: `drawSelection()` (`@codemirror/view`) is what actually mounts those layers into
the DOM, and it is not in `Raw.tsx`'s `extensions` array (confirmed by search, not inference — no
match for `drawSelection` anywhere under `src/renderer/components/Raw/`). Without it, CodeMirror
falls back to the browser's own native `::selection`/caret rendering, which this app's CSS does
not — and currently cannot — touch. So:

- The `.cm-selectionBackground` token split (§7's "one-line change") was made as asked, faithfully
  matching the plan text, but it is dead CSS both before and after this round — nothing renders
  that class today.
- The caret table row's "already correct, no change" claim (§2) could not be verified the way the
  plan intended, because there is no `.cm-cursor` element to characterize. Whatever caret behaviour
  the user actually sees while typing in Raw comes from the browser's native contenteditable caret,
  which this codebase's CSS has no rule for at all — not verified correct, not verified wrong, only
  established as out of this app's control today.
- `test/inactiveSelection.test.tsx`'s own R115 tests reflect this: one positive test for
  `.cm-np-selected` (the real, active decoration, confirmed switching correctly), and one
  characterization test asserting `.cm-selectionBackground`/`.cm-cursorLayer` are **absent** from
  the DOM — so it fails loudly, not silently, the day `drawSelection()` is added and this gap
  needs closing instead of documenting.

Reported rather than worked around, per `CLAUDE.md`'s "a measurement contradicts the plan": adding
`drawSelection()` is a real behaviour change to the editor (secondary-range rendering, a DOM-layout
performance cost per its own doc comment) well outside a CSS-token-splitting round, not a call to
make silently while implementing R113–R116. Owed in `docs/TASKS.md`.

## 12. R117 — the caveat re-checked: every fact holds, the conclusion does not

§11's caveat was investigated independently rather than taken at face value. **Its measurements are
all correct. The conclusion drawn from them is wrong, and the impact is larger than it describes.**

### What holds

`drawSelection()` really is absent — `Raw.tsx`'s `extensions` array is six custom extensions with no
`basicSetup`, and nothing under `src/renderer/components/Raw/` mentions it. Mounting a real `Raw`
with a real selection and counting nodes confirms the consequence:

| | focused | blurred |
|---|---|---|
| `.cm-selectionBackground` | **0** | **0** |
| `.cm-cursorLayer` / `.cm-cursor` | **0** / **0** | **0** / **0** |
| `.cm-focused` | 1 | 0 |

So `Raw.css`'s two `!important` selection rules are dead, exactly as reported.

### What does not: native selection *is* reachable from CSS

The caveat says the browser's own rendering is something "this app's CSS does not — and currently
cannot — touch." **`::selection` touches it.** Measured, in the exact form R115 would ship — the
same `--selection-bg` variable R113 already drives from `:focus-within`:

```css
.raw-pane .cm-content ::selection,
.raw-pane .cm-content::selection { background: var(--selection-bg); }
```

| | computed `::selection` background | painted |
|---|---|---|
| Raw focused | `rgb(23, 35, 63)` — `--row-selected-bg` | ✅ verified by screenshot |
| Raw blurred | `rgb(61, 68, 83)` — `--row-selected-inactive-bg` | ✅ verified by screenshot |

Custom properties resolve inside `::selection` (they inherit from the originating element), and
`:focus-within` on an ancestor re-evaluates and **repaints** — checked by screenshot, not just by
`getComputedStyle`, because a computed value that never reaches the screen is precisely the failure
mode this whole caveat is about.

**So R115's goal needs no `drawSelection()` at all.** The trade-off §11 declines to make —
secondary-range rendering and a DOM-layout cost, correctly judged out of scope — simply does not
have to be made. That is the part that changes what we do.

### And the impact is bigger than "dead CSS"

The caveat frames this as inert code: nothing renders, so nothing is wrong on screen. Measured, that
is not the case.

- **`.cm-content`'s computed `::selection` background is `rgba(0, 0, 0, 0)`** — no author rule
  applies at all, so Chromium paints its own default. Raw's text selection is **unthemed in both
  themes**: a saturated default blue on a near-black surface in dark, matching no token in the
  palette. Screenshotted.
- **It does not dim on blur.** Chromium keeps an unfocused `contenteditable`'s selection at full
  strength here — the DOM selection survives (`rangeCount: 1`, `collapsed: false`, same text after
  focus moves to a button) and paints identically. So the state R115 set out to fix is not merely
  un-dimmed; it is the loudest thing in an unfocused pane.

R115 is therefore not "landed but inert" — it is **the one row of §2's table that is still wrong on
screen**, and it is wrong in the direction the round existed to fix.

### The caret row: right answer, wrong reason

§2 credits CodeMirror's base theme (`.cm-cursor { display: none }` gated on `.cm-focused`). Those
rules exist but never apply, for the reason above. The row is still correct, on two different
mechanisms:

- **Hidden when unfocused, by construction.** `.cm-content` is `contenteditable="true"`, and a caret
  is painted only in the focused editing host. Verified across six samples either side of a blur
  that `document.activeElement` is `.cm-content` while focused and never while not; the blurred
  screenshots show no caret.
- **Already themed.** `Raw.css:99` sets `caret-color: var(--accent)`, computed `rgb(122, 162, 255)`.
  §11's "this codebase's CSS has no rule for it at all" is wrong by one line in the same file.

Nothing to build; the reasoning under the row needs replacing so the next reader does not re-derive
it from a base theme that is not in play.

### R117 — what to do

- Replace `Raw.css:113`/`:118`'s dead `.cm-selectionBackground` pair with the `::selection` rules
  above, reading the `--selection-bg` that `.raw-pane` already carries. **Delete** the dead pair
  rather than leaving it: it reads as load-bearing (it has `!important`) and is not.
- Both `.cm-content ::selection` *and* `.cm-content::selection` — the text sits in descendant
  `.cm-line` elements, and the bare form alone does not cover it.
- Fix §2's caret rationale and §7's `.cm-selectionBackground` bullet to describe the mechanism that
  is actually in play.
- Keep §11's characterization test asserting `.cm-selectionBackground`/`.cm-cursorLayer` are absent.
  It is still the right guard: it now documents *why* `::selection` is the mechanism, and still
  fires the day someone adds `drawSelection()` and makes both mechanisms live at once — which is
  the one state that would be genuinely confusing.
- `::selection` accepts only a restricted property set; `background-color` is in it. Do not reach
  for `outline` or `box-shadow` here.

**Definition of done for R117**

- [x] Selecting text in Raw paints `--row-selected-bg` while the pane has focus and
      `--row-selected-inactive-bg` while it does not, asserted on computed `::selection` background
      in both themes **and** verified as painted, since this whole item exists because computed and
      painted diverged.
- [x] No `.cm-selectionBackground` rules remain in `Raw.css`.
- [x] The characterization test still asserts `drawSelection()`'s layers are absent.
- [x] §2's caret row and §7 cite native `contenteditable` behaviour and `Raw.css:99`'s
      `caret-color`, not CodeMirror's base theme.

### R117 results

Built. `Raw.css`'s dead `.cm-selectionBackground` pair is gone, replaced by
`.cm-content ::selection` / `.cm-content::selection` reading the `--selection-bg` that
`.raw-pane` already carries — so the text selection now uses the app's own tokens and follows
pane focus, in both themes.

Verified as **painted**, not only computed, because that distinction is the entire reason this
task exists: screenshotted focused and blurred against the real stylesheet in dark theme, where
the selection was previously Chromium's default blue at full strength in both states.
`test/inactiveSelection.test.tsx` gains a positive test asserting the computed `::selection`
background on both `.cm-content` and a `.cm-line` (the descendant form is the one that colours
what the user sees), **checked to fail without the CSS** — it reports `rgba(0, 0, 0, 0)`, the
"no author rule applies" state that let the browser default through. A second new test locks the
caret's two real mechanisms: `.cm-content` is `contenteditable="true"`, and `caret-color`
resolves to `--accent`.

The characterization test asserting `drawSelection()`'s layers are absent is kept, with its comment
rewritten: it no longer describes an owed gap but explains why `::selection` is the mechanism, and
it still fails loudly the day someone adds `drawSelection()` and both mechanisms would go live at
once.

Full suite 1655 passed, lint and typecheck clean; the single failure is `jsonParser.test.ts`'s
pre-existing depth-20000 timeout, unchanged by this round.
