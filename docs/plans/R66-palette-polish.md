# R66–R68 — the palette: labels, scrolling, and toggle state

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Three reports from using the palette. Related: R63 (its
discoverability) and R65 (which reads the same registry). Results at the end of this file.

---

## 1. R66 — `Category: Title`, matched as well as shown

**The categories exist and are already displayed**, as a separate right-aligned span
(`Palette.tsx:427`, `.palette-option-category`). What they are not is *searchable*:

```ts
const match = fuzzyMatch(query, command.title)   // paletteLogic.ts:98
```

Only the title. So typing `view` matches nothing in the View category unless the word also happens
to be in the command's own name — which is exactly the discoverability the report is after.

**Fix: match and render `${category}: ${title}`**, VS Code's shape ("View: Toggle Word Wrap").
One string, used for both, so what the user sees is what the matcher saw.

Three things that make this less trivial than it reads:

- **The highlighter indexes into the matched string.** `fuzzyMatch` returns `indices`, and
  `highlight(entry)` (`Palette.tsx:425`) uses them to bold the matched characters *of the title*.
  Prefixing the category shifts every index. Change both together or the highlighting silently
  points at the wrong characters — a defect that looks like a rendering glitch and is actually a
  units mismatch.
- **Drop the separate category span.** Otherwise the category appears twice on every row.
- **One title already carries a hand-rolled prefix.**
  `nodepad.document.toggleFormatMinifiedOnOpen` is titled `"Toggle: Format Minified Files on Open"`
  and lives in the `Edit` category, so it would render as **"Edit: Toggle: Format Minified Files on
  Open"**. Two colons. Retitle it — and, per the refinement below, retitle all six toggles rather
  than only this one.

**Prefixes only, no section headers.** VS Code shows separators when the input is empty and drops
them while filtering; that is a second layout mode for a list that is already sorted by category.
The prefix does the same work in one mode.

### Refinement — yes, drop the verb, but the title is doing two jobs

Asked after the plan landed: should the `Toggle` prefix just be removed from these titles?

**Yes, and it is more than tidying** — but a plain rename would quietly damage four buttons, so the
verb has to move rather than disappear.

#### Where these titles actually render

| Command | Title today | Surfaces |
|---|---|---|
| `nodepad.theme.toggle` | `Toggle Light/Dark Theme` | palette |
| `nodepad.layout.toggleTree` | `Toggle Tree Pane` | palette, **titleBar** |
| `nodepad.layout.toggleDetail` | `Toggle Detail Pane` | palette, **titleBar** |
| `nodepad.layout.toggleRaw` | `Toggle Raw Pane` | palette, **titleBar** |
| `nodepad.raw.toggleWrap` | `Toggle Soft Wrap` | palette, **paneHeader** |
| `nodepad.document.toggleFormatMinifiedOnOpen` | `Toggle: Format Minified Files on Open` | palette |

Four of the six render as **icon-only buttons**, where `tooltipFor` renders `command.title`
verbatim as both `title` and `aria-label` (`TitleBar.tsx:83`, `Layout.tsx:73`). So the same string
serves two surfaces with opposite needs:

- **In the palette**, once R68 shows the state, `View: Soft Wrap · On` is complete and the verb is
  redundant — worse, `Toggle Soft Wrap · On` is genuinely ambiguous, since `On` could be read as the
  state or as what the toggle will do.
- **On an icon button**, the tooltip is the *only* text there is. `Soft Wrap (Ctrl+Shift+W)` names a
  thing; `Toggle Soft Wrap (Ctrl+Shift+W)` says what pressing it does. Dropping the verb there is a
  real loss, not a tidy-up.

#### So: the title becomes the noun, and the surface supplies the verb

R68 is already adding `state?: () => boolean` to `Command`, and **`state !== undefined` is exactly
"this command is a toggle."** That one flag lets each surface render what it needs from the same
title:

- **Palette** — `Category: Title` plus the state (R66, R68).
- **`tooltipFor`** — prefix `Toggle ` when `state` is defined, so the four icon buttons keep the
  tooltip they have today without keeping it in the stored title.

This is the same move D-055 already made for the chord: the title stores the name, and `tooltipFor`
composes the rest. Nothing new in the model.

#### One of the six needs a semantic rename, not just a shorter one

Worth checking each against R68's boolean before renaming, because a state indicator only reads if
the title names *the thing that is on or off*:

| Renamed to | Reads as |
|---|---|
| `Tree Pane` / `Detail Pane` / `Raw Pane` | `Tree Pane · On` ✓ |
| `Soft Wrap` | `Soft Wrap · On` ✓ |
| `Format Minified Files on Open` | `Format Minified Files on Open · On` ✓ |
| ~~`Light/Dark Theme`~~ | `Light/Dark Theme · On` — **meaningless** |

`nodepad.theme.toggle` needs **`Dark Theme`**, with `state: () => getTheme() === 'dark'`. Then
`View: Dark Theme · Off` says something true. This is the one place where the rename is not
cosmetic, and it would have been easy to miss by renaming mechanically.

#### The accepted cost

Typing `toggle` in the palette currently returns all six; afterwards it returns none. That is a
small real loss and the mitigation is a trap, so take the loss: matching against a string you do not
display (`Category: Toggle Title` shown as `Category: Title · On`) reintroduces exactly the
highlight-index mismatch R66's own §1 warns about. Match what you show.

## 2. R67 — the active option never scrolls into view

Measured, after 14 `ArrowDown` presses in the palette:

```
scrollTop      0
scrollHeight   1227
clientHeight   498
selectedInView false
```

The list never scrolls. The selection walks off the bottom and the user is arrowing blind — the
selected row is real and `aria-activedescendant` is correct, it is simply not on screen.

**Fix:** an effect on `activeIndex` calling `scrollIntoView({ block: 'nearest' })` on the active
option.

- **`'nearest'`, not `'center'`** — centring yanks the list on every keypress even when the target
  was already visible, which is worse than not scrolling for a user stepping one row at a time.
- **No smooth scrolling**, or gate it on `prefers-reduced-motion` the way R38 did for the tab strip.
  For a keyboard-repeat list, instant is also simply better.
- **Both lists need it.** The palette renders a command list *and* a node-match list for `@` mode
  (`Palette.tsx:456`); `@` on a large document is exactly where a long list is likely.

## 3. R68 — a toggle that does not show what it is toggling

`"Toggle: Format Minified Files on Open"` says nothing about the current value. The report is right
that this is the palette being used as a settings menu, and right that "probably fine for now, but
the state has to be retrievable."

**It generalises. There are six toggle commands and not one of them shows its state:**

| Command | State reachable via |
|---|---|
| `nodepad.theme.toggle` | `getTheme()` |
| `nodepad.layout.toggleTree` / `toggleDetail` / `toggleRaw` | `layoutStore`'s `PaneVisibility` |
| `nodepad.raw.toggleWrap` | the wrap store |
| `nodepad.document.toggleFormatMinifiedOnOpen` | `getFormatMinifiedOnOpen()` (`settings.ts:12`) |

Every one already has a getter. The palette simply never asks.

**Fix: an optional `state?: () => boolean` on `Command`**, rendered by the palette as a trailing
`On`/`Off` (or a check mark) beside the category. `commands/registry.ts` is renderer-side — this is
**not** a `src/core/types.ts` change and needs no contract conversation.

Deliberately optional, not a separate `ToggleCommand` type: a command that has a state says so, and
everything else is unaffected. Invariant 10's palette-reachability test is untouched either way.

### Should Enter still close the palette?

The report asks. **Yes — keep it closing.**

The palette is a command launcher, and "Enter runs the thing and dismisses" is the one rule every
entry shares; making six of sixty behave differently costs more than it saves. With the state now
visible, flipping a toggle and confirming it took is `Ctrl+Shift+P`, arrow, Enter, `Ctrl+Shift+P` —
and the second open shows the new value, which is the thing that was actually missing.

Recorded because it is a real fork: the alternative (Enter keeps the palette open for stateful
commands, so several can be flipped in one visit) is defensible and is what a settings *panel* would
do. If toggles ever outgrow the palette, a settings panel is the answer, not a second Enter
behaviour inside this one.

---

## Results

Built in the order R68, R66, R67 — R66's own refinement depends on R68's `state` flag existing first
(the verb-moves-to-the-surface trick needs something to test), so it went first despite the numbering.

**R68.** `Command` gained `readonly state?: () => boolean` (`commands/registry.ts`). All six toggle
commands retitled to the noun per §3's own worked table — `nodepad.theme.toggle` is now **Dark
Theme** (the one semantic rename, not just a shorter one) with `state: () => getTheme() === 'dark'`;
the three pane toggles are **Tree/Detail/Raw Pane** with `state` reading `layoutStore.getLayoutState()`;
`nodepad.raw.toggleWrap` is **Soft Wrap**, `state` reading `getContext().isWrapped` (a getter that
already existed — `Raw.tsx`'s own `setContext('isWrapped', ...)` calls, just never asked); `nodepad.document.toggleFormatMinifiedOnOpen`
is **Format Minified Files on Open**, `state` reading `settings.ts`'s existing `getFormatMinifiedOnOpen()`.
The palette renders a trailing `On`/`Off` (`.palette-option-state`) beside the chord hint. Enter still
closes the palette on every command, toggles included, per §3's own recorded fork.

**R66.** New `paletteLabel(command)` in `paletteLogic.ts` — `${category}: ${title}`, computed once and
carried on `RankedCommand.label` rather than recomputed at each render/highlight call site, exactly
so a caller can't highlight indices from one string against a different one (§1's own warning). `rankCommands`
matches against the label, not the bare title; `Palette.tsx`'s `highlight()` and the rendered option
both read `entry.label`; the separate `.palette-option-category` span is gone. `tooltipFor` (`uiHelpers.ts`)
now prefixes `Toggle ` exactly when `command.state !== undefined` — the one-line change §1's own
"Refinement" called for, landed in the same commit as the rename it depends on.

**R67.** A `useEffect` on `[activeIndex, activeList]` in `Palette.tsx` calls
`.palette-option-active`'s `scrollIntoView({ block: 'nearest' })` — covers both the command list and
the `@`-mode node-match list, since both render the same `.palette-option-active` class. No `behavior`
given (instant, not smooth), matching §2's own "instant is simply better for a keyboard-repeat list."

**Review.** No findings — the three changes are small (a struct field, a string-building function, a
scroll effect) and each was checked against its own acceptance shape (the highlight-index warning in
§1, the `state`-defines-the-verb contract in §3) while writing it, not after.

**Tests.** `test/palette.test.ts` gained 4 (R66's label/indices, R68's `state` pass-through);
`test/uiHelpers.test.ts` (new, 5) covers `tooltipFor`'s `Toggle ` prefix in combination with the
effective-chord suffix; `test/paletteRender.test.tsx` (new, 4, real Chromium) covers the rendered
`Category: Title` label and category-searchability, the removed `.palette-option-category` span, R67's
scroll-into-view (geometry-asserted against real `getBoundingClientRect()`), and R68's On/Off badge.
`npm run typecheck` and `npm run lint` both clean; the full suite (121 files, 1355 tests) passes.
