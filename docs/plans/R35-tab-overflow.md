# R35–R37 — the tab strip once the tabs stop fitting

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Decision: `docs/DECISIONS.md` D-067.

Raised from using the app: *"When many tabs are open, should we have vertical scrolling in the
tab bar?"* The strip already scrolls — horizontally, invisibly, and without ever moving itself to
show you the tab you just switched to. That last part is a real defect and is why this is three
tasks rather than one styling change.

---

## 1. What was measured

Real Electron (Playwright's `_electron` against `out/`, the same route R33's addendum used), 16
tabs restored into a 1200 × 860 window, light theme:

| | |
|---|---|
| tabs open | 16 |
| `.tab-strip-scroll` `clientWidth` | 928 px |
| `.tab-strip-scroll` `scrollWidth` | 1920 px |
| every tab's width | 120 px — all sixteen at the `min-width` floor |
| tabs actually visible | ~7.7 of 16 |

So overflow starts at roughly eight tabs on a 1200 px window, and the flex shrink has already
bottomed out by then: `TabStrip.css:33`'s `flex: 1 1 160px; min-width: 120px` is doing exactly
what its own comment says it should, handing off to scrolling rather than shrinking further.

**Then, from the first tab, `Ctrl+Shift+Tab`:**

| | |
|---|---|
| active tab index after | 15 (of 0–15) — the switch worked |
| `.tab-strip-scroll.scrollLeft` | **0 — unchanged** |
| active tab's x range | 1800 – 1920 |
| strip's visible x range | 0 – 928 |
| active tab visible | **no** |

The document under the strip changed completely and the strip did not move a pixel. That is worse
than an invisible scrollbar: the app looks like it ignored the keystroke.

**A vertical wheel over the strip left `scrollLeft` at 0.** Chromium's implicit vertical-to-
horizontal mapping does not fire here. *Caveat, stated rather than glossed:* this was a synthetic
wheel event, which does not always reproduce a real device's scroll latching — check it by hand
before treating "the wheel does nothing today" as settled. It does not change the plan either way,
since R36 adds an explicit handler regardless.

---

## 2. R35 — the active tab is never scrolled into view

`TabStrip.tsx` renders the strip and never touches its scroll position: there is no ref on
`.tab-strip-scroll` (`TabStrip.tsx:130`) and no `scrollIntoView` anywhere in the component. Every
route into a tab is affected, not just the keyboard one:

- `Ctrl+Tab` / `Ctrl+Shift+Tab` (`activateNextTab`/`activatePreviousTab`, `session/tabs.ts:363`)
- the palette's own Next/Previous Tab
- closing a tab, when the neighbour that becomes active sits outside the visible range
- session restore (`sessionRestore.ts`) landing on a `activeIndex` beyond the eighth tab

**Fix: on every activation, scroll the active tab into view.** A ref on `.tab-strip-scroll`, an
effect keyed on `activeId`, `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on the active
`.tab` — `nearest` so a tab that is already fully visible does not move the strip at all, which is
the common case and must stay motionless.

Two things to get right rather than discover:

- **Pointer clicks must not jerk.** Clicking a half-visible tab at the edge will now nudge the
  strip to reveal it. That is correct, but it means the click target moves under the cursor.
  `inline: 'nearest'` keeps that to the minimum distance; check it feels right rather than
  assuming it does.
- **Restore fires before layout is stable.** At session restore the strip may still be measuring
  when the effect first runs. It must re-run once the tab set settles, not only once on mount.

**This is independent of R36 and should land first.** The overflow controls are a convenience; this
is the app failing to show you what you selected.

---

## 3. R36 — Firefox-style overflow controls

Decided with the project lead (D-067). The shape:

```
[<]  [ tab  tab  tab  tab  tab … ]  [>]  [⌄]  [+]
```

- **`<` and `>`** at each end of the scrolling area. Click scrolls by one tab; press-and-hold
  repeats. They move the *viewport only* and never change which tab is active — that is what makes
  "see what else is open without leaving this file" possible, and it is the behaviour people
  already have from Firefox.
- **`⌄`** opens a menu listing every open tab, with its format glyph and dirty dot, using the same
  disambiguated labels the strip itself uses (`tabDisplay.ts`'s `tabLabelsOf`). Choosing one
  activates it.
- **`+`** is unchanged (`.tab-strip-new`, `TabStrip.css:160`).

### 3a. All three appear only when the strip overflows

`<`, `>` and `⌄` are hidden entirely when every tab fits — the project lead's call, and it extends
to the menu button, not just the chevrons. The reasoning is the same for all three: when every tab
is visible, a list of the tabs adds nothing you cannot already see, and permanent chrome for a
condition that is usually false is a worse trade than the one reflow when the eighth tab opens.

**This looks like it could oscillate, and it cannot — say so in a comment where the condition is
computed, because it reads as a bug in review otherwise.** Adding the controls narrows the scroll
area, which can only *increase* overflow, never remove it. And the no-overflow state is measured
with the controls already absent, so widening the area cannot re-introduce them. Both directions
are stable; there is no width at which the strip flickers between the two states.

### 3b. Disabled at the ends, not hidden

At `scrollLeft === 0` the `<` greys out; at the maximum, `>` does. A disabled control answers
"is there more that way?" precisely, where a disappearing one is ambiguous — and it is the one
place in this feature where hiding costs information rather than saving clutter. The same
distinction `D-055` already drew for the title bar ("disabled, not hidden"), for the same reason:
a control that vanishes reflows the strip and destroys pointer muscle memory.

### 3c. The wheel needs a real handler

`overflow-x: auto` alone does not give the strip wheel scrolling (§1). Map `deltaY` (and `deltaX`,
for trackpads and tilt wheels) onto `scrollLeft` in an `onWheel` on `.tab-strip-scroll`.
**`Scrollbar.tsx:239` already does exactly this** for the pane scrollbars — copy that pattern
rather than inventing a second one, which is the same lesson §5 of R33's addendum draws about
`Scrubber.css` and `Scrollbar.css`.

### 3d. Sizing and idiom

The chevrons are ~20 px, not `.tab-strip-new`'s 32 px: three 32 px buttons in a row start to
compete with the tabs themselves. They reuse `.tab-strip-new`'s hover treatment and border idiom
so the right-hand cluster reads as one group. Real `<button>`s with `aria-label`s ("Scroll tabs
left" / "Scroll tabs right" / "List all tabs") — they are redundant with `Ctrl+Tab` for a keyboard
user, but a hidden-from-assistive-technology scroll control is not worth the saving.

---

## 4. R37 — a keyboard route to a *specific* tab

With sixteen tabs, `Ctrl+Tab` is O(n) and there is nothing faster. The `⌄` menu fixes that for the
pointer; this is the keyboard half.

**Recommended: `Alt+1` … `Alt+8` select tabs 1–8, `Alt+9` selects the last tab** — Firefox's own
mapping, nine static commands registered alongside the existing ones in `TabStrip/commands.ts`,
`surfaces: ['palette']` like every other tab command.

**Not `Ctrl+1`…`Ctrl+9`, which is what browsers actually use: those are already taken.**
`commands/keybindings.ts:69–71` binds `Ctrl+1`/`Ctrl+2`/`Ctrl+3` to pane focus (Tree/Detail/Raw),
which is a better use of them in a three-pane tool than tab seven. `Alt+<digit>` is free here
specifically because NodePad draws its own frameless title bar and has no menu bar for Alt to
activate — worth stating, since that is normally the reason to avoid Alt on Windows.

### What was considered and rejected: a searchable "Go to Open Document…"

The obvious nicer thing — type part of a filename in the palette, jump to that tab — **cannot be
built without changing the command registry, so it is reported rather than worked around**
(`CLAUDE.md`'s own agreement). `registerCommand` (`commands/registry.ts:83`) has no unregister:
the only exports are `registerCommand`, `getCommand`, `getAllCommands`, the two `commandsForSurface`
variants, `isCommandEnabled`, and `resetCommandRegistryForTests`. One command per open tab would
therefore accumulate dead entries for every tab ever closed. The alternatives are a registry
unregister API or a picker mode in the palette, and both are real design work with consequences
past this round.

Nine fixed bindings cost none of that and cover the case people actually hit. If the searchable
version is wanted later, it starts from this paragraph.

---

## 5. Rejected shapes (D-067)

- **Multi-row / wrapping tab strip** (Notepad++). The strip's height is fixed at 32 px
  (`TabStrip.css:9`) and the panes below it are sized against that. Wrapping makes the chrome grow
  and shrink as files open and close, moving every pane underneath — a much larger disruption than
  the thing it solves.
- **Vertical tab list in a sidebar.** A different product decision, not an overflow fix, and it
  competes with the Tree pane for the same screen edge.
- **A visible scrollbar on the strip.** The chevrons *are* the overflow indicator, and they are
  both more discoverable and more clickable than a 15 px-tall horizontal track would be. Note the
  strip already hides the native one deliberately (`TabStrip.css:26`, `scrollbar-width: none`).
- **Shrinking tabs below the 120 px floor.** Past that the label is gone and every tab looks the
  same; scrolling a readable strip beats showing sixteen unreadable ones.

---

## 6. Verify in the real app

All of this is layout — `scrollWidth`, `clientWidth`, `scrollLeft`, visibility — which jsdom cannot
give. The **browser project** (R10, real Chromium; `test/tabStrip.test.tsx` is already there), not
the node project:

- With enough tabs to overflow: `<`, `>` and `⌄` are present. With few enough to fit: **all three
  are absent** (§3a) — assert both directions in one test, since the pair is the actual rule.
- `Ctrl+Tab` onto a tab outside the visible range leaves it **inside** the strip's client rect
  (§2) — this is R35's regression guard and the one test that must exist.
- Clicking `>` increases `scrollLeft` and **leaves `activeId` unchanged** (§3).
- `<` is disabled at `scrollLeft === 0`, `>` at the maximum (§3b).
- A wheel over the strip changes `scrollLeft` (§3c) — and, per §1's caveat, this test is also what
  settles whether the wheel ever worked.

`Alt+1`…`Alt+9` (R37) are ordinary command registrations and belong in the node project's existing
`test/keybindings.test.ts` coverage, plus `test/commands.test.ts`'s palette-reachability check
(invariant 10) picking them up for free.

---

## Results — built

R35, R36 and R37 all landed together.

- **R35**: a `ref` on `.tab-strip-scroll`, and an effect keyed on `[activeId, tabIds.join(',')]`
  (content-equality, the same proxy `useTabDisplayInfos` already uses for the same reason) calling
  `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on `.tab-active`. The `tabIds` half of
  the dependency is what makes this re-run once session restore's tab set actually settles, not
  only on mount.
- **R36**: `<`/`>`/`⌄`, all three gated on one `overflowing` flag read from `scrollWidth >
  clientWidth`, tracked via a `ResizeObserver` (strip width), a `scroll` listener (`scrollLeft`),
  and a `MutationObserver` (`Scrollbar.tsx`'s own trio, for the tab *set* changing `scrollWidth`
  without necessarily resizing the container). The chevrons scroll by one tab's own measured width
  and never call `setActiveTab`; disabled (not hidden) at each end; press-and-hold repeats after a
  400 ms delay at 120 ms intervals, with a `heldByHoldRef` flag so the trailing `click` after a
  hold doesn't add one extra step. `⌄` opens a menu of every open tab (format glyph, dirty dot,
  the same disambiguated label the strip itself uses), each item activating and closing the menu.
  The wheel handler mirrors `Scrollbar.tsx`'s own (`deltaX` if non-zero, else `deltaY`, onto
  `scrollLeft`) rather than inventing a second copy of the same pattern.
- **R37**: nine fixed commands (`nodepad.tabs.select1`…`select8`, `nodepad.tabs.selectLast`) bound
  to `Alt+1`…`Alt+9`, registered alongside R26's existing tab commands — `surfaces: ['palette']`
  picks them up for invariant 10 (`test/commands.test.ts`) automatically.
- A review pass before commit found one real bug: a press-and-hold's `setInterval` was never
  cleared on unmount (closing the last dirty tab mid-hold, into the quit flow) — harmless per tick
  once `scrollRef.current` goes null, but a permanent leak. Fixed with a cleanup effect.

`test/tabStrip.test.tsx` gained the six §6 assertions (overflow presence/absence in one test per
its own "assert both directions" instruction, the R35 regression guard via `getBoundingClientRect`,
chevron click leaving `activeId` unchanged, disabled state at both ends, the wheel handler, and the
menu). `test/keybindings.test.ts` gained a duplicate-chord guard plus explicit `Alt+1`…`Alt+9`
coverage.

`npm run typecheck`, `npm run lint` (baseline warnings only), `npx stylelint`, and the full
`vitest` suite (100 files, 1185 tests, node + browser projects) are all clean.
