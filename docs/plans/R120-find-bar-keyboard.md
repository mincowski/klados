# R120–R123 — the Find bar's keyboard: tab order, Enter, Escape, and staying inside

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Four keyboard defects in the Find bar, reported together from
use. Three of them are one mechanism — a `keydown` handler on the bar's own container — and the
fourth (Enter/Ctrl+Alt+Enter in the replace field) rides on the same handler. Follow-up to
`docs/plans/R86-find-as-query-surface.md` (R90 built the replace row) and
`docs/plans/R102-find-single-line.md` (R103 left `handleKeyDown` on the find input alone).
Sibling: `docs/plans/R124-go-to-position-hint.md`, reported in the same message but a separate
topic.

**Every question in this document is settled — nothing here is waiting on a decision.** Every
statement about current behaviour below was measured in real Chromium against the real
`<FindBar>`, not read off the source; §1 is that probe's output.

---

## 1. What the bar does today — measured, not assumed

A throwaway browser test mounted the real `<FindBar>` over a real document (`findReplace.test.tsx`'s
own harness), opened it with the replace row expanded, ran a search so nothing was disabled, and
reported five things:

| Probe | Result |
|---|---|
| Focusables inside `.find-bar`, in DOM order | disclosure, **Find**, `Aa`, `.*`, `/`, ↑, ↓, ✕, **Replace**, ⇄ Replace, ⟳ Replace All |
| Any `tabindex` attribute anywhere in the bar | **none** — tab order is pure DOM order |
| `Escape` dispatched on the Replace All button | bar **stays open** |
| `Enter` dispatched in the replace input | **nothing happens** — count unchanged at `1 of 3`, no replacement |
| Real `userEvent.tab()` ×14 from the find input | `Aa`, `.*`, `/`, ↑, ↓, ✕, Replace input, ⇄, ⟳, **`#outside-after`**, `BODY`, then back around to the disclosure |

So all four reports are exactly right, and the causes are each one line:

- **Tab order** is DOM order, and the replace input is in the second row's DOM, after every
  first-row control. Nothing to undo — there is no tab order being *maintained* today.
- **Escape** is inside `handleKeyDown`, which is wired to `onKeyDown` on the find `<input>` only
  (`FindBar.tsx:544`). No other element in the bar has a key handler, and there is no `Escape`
  entry in `DEFAULT_KEYBINDINGS`.
- **Enter in the replace input** has no handler at all, and the bar is not a `<form>`, so there is
  no implicit submission either.
- **Tab leaves the bar** because nothing stops it. `.find-bar` is `position: absolute` inside
  `.layout` (R70), rendered as a sibling *before* `<StatusBar />` — so Tab out of ⟳ lands on the
  status bar's own buttons.

One more measured fact that constrains the fix: **the global keymap does not stop propagation.**
`createKeymapController`'s `handleKeyDown` calls `event.preventDefault()` and returns, with no
`stopPropagation()` (`keybindings.ts`). `Ctrl+Tab` is bound (`nodepad.tabs.next`), so a container
handler that treats every `Tab` as its own would switch tabs *and* move focus inside the bar. §5
carries the guard this implies.

---

## 2. The target order, and why it is not DOM order

The order asked for is: **Find → Replace → the rest of the first row → the two replace buttons.**

| # | Control | Row |
|---|---|---|
| 1 | Replace disclosure (chevron) | 1 |
| 2 | **Find input** | 1 |
| 3 | **Replace input** | 2 ← the one deviation |
| 4 | `Aa` | 1 |
| 5 | `.*` | 1 |
| 6 | `/` | 1 |
| 7 | ↑ Previous match | 1 |
| 8 | ↓ Next match | 1 |
| 9 | ✕ Close find | 1 |
| 10 | ⇄ Replace | 2 |
| 11 | ⟳ Replace All | 2 |

The disclosure stays where it is, ahead of the find input: it is already first in "the original
order," and the request is to splice the replace input in, not to renumber the row.

This matches VS Code's find widget, which also moves Tab from the find input straight to the
replace input when the replace row is showing rather than walking the toggles first. *Stated as the
reason it is a familiar order, not as evidence — VS Code was not available to probe in this
environment, and nothing below depends on the claim.*

### Three ways to get it, and why the third wins

**(a) Positive `tabIndex` on the replace input.** Rejected outright, and not on style grounds: a
positive tabindex does not reorder *within a group*, it promotes the element ahead of **every**
`tabindex="0"` element in the document. A fresh Tab from the top of the app would visit the Find
bar's replace field before the Tree, the grid and the status bar. It also cannot express R123's
wrap at all.

**(b) Put the replace input in the first row's DOM and place it visually with CSS grid.** This is
the "make DOM order the truth" option and it is the one worth wanting. Rejected on risk: the two
`.find-bar-row` flex rows carry three rounds of accumulated fixes that are per-row by construction
— R8e's "no `flex-wrap` on the row that matters", R89's `overflow-x: auto` **on the row** plus
`.find-bar-row > *:not(.find-input) { flex: none }`, and the `.find-replace-spacer` that aligns the
replace input under the find input. Collapsing both rows into one grid means re-deriving all of it,
and `test/findReplace.test.tsx` already asserts the two rows' geometry to the pixel. A large,
visual, regression-prone change to buy an ordering that (c) buys in one function.

**(c) Manage Tab in a `keydown` handler on `.find-bar`.** Chosen — and the deciding reason is that
**R123 needs this handler anyway.** Wrapping Tab at the end of the bar is not expressible in DOM
order or in `tabindex`; it requires intercepting the key. Once the handler exists, the ordering is
a two-line list transform inside it rather than a second mechanism.

### The one rule the handler encodes

Do **not** hand-maintain a list of refs. Derive the order from the DOM and encode only the
deviation:

```
orderedFocusables(bar):
  els = bar.querySelectorAll('input, button')      // DOM order
        filtered to !disabled
  move the '.find-replace-input' element to directly after '.find-input'
  return els
```

A control added to the bar later is picked up with no edit here, which is the property the
hand-maintained alternative loses on its first use. The filter on `disabled` matters in practice:
↑/↓ and ⟳ are disabled with no matches, and ⇄ is disabled with no current match, so a fixed list
would tab onto dead controls.

---

## 3. R120 — the tab order

**Task.** `.find-bar` gets an `onKeyDown` that handles `Tab` and `Shift+Tab` by moving focus along
`orderedFocusables()` and calling `preventDefault()`.

**Acceptance.** With the replace row expanded and a search run, Tab from the find input lands on
the replace input; Tab again lands on `Aa`; and Shift+Tab from `Aa` returns to the replace input,
Shift+Tab again to the find input.

**With the replace row collapsed or in path mode** there is no replace input, so `orderedFocusables`
returns plain DOM order and the bar behaves exactly as it does today. No separate code path.

---

## 4. R121 — Enter replaces, Ctrl+Alt+Enter replaces all

**Enter in the replace input runs Replace.** It maps onto the existing `handleReplace()` with
nothing added: that function already replaces the current match and re-selects the next one
(`pendingAutoSelectRef`), which is what `test/findReplace.test.tsx`'s "Replace replaces only the
current match and advances to the next" asserts. Enter in the *find* input keeps meaning find-next
/ Shift+Enter find-previous, unchanged.

Guard: no-op when `findState.currentIndex === null`, the same condition that disables the ⇄ button.

### The Replace All modifier — what other apps actually bind

| App | Replace (single) | Replace All |
|---|---|---|
| VS Code | `Enter` in the replace field | **`Ctrl+Alt+Enter`** (`editor.action.replaceAll`) |
| Sublime Text | `Enter` in the replace field | **`Ctrl+Alt+Enter`** |
| Notepad++, Word, and the Win32 Find/Replace dialog lineage | `Enter` = the default button | `Alt+A` — a dialog **access key** on the button's `&A`ll |

Two families, and only one of them is available here. `Alt+A` belongs to a mnemonic-underline
convention this app does not use anywhere: NodePad draws its own frameless title bar with no menu
bar, no control in the app carries an access-key underline, and `Alt+<digit>` is already tab
selection (R37/D-067). Adopting `Alt+A` for one button would introduce a vocabulary of one.

**So: `Ctrl+Alt+Enter`.** It is free (`Ctrl+Alt+F` is the grid's quick filter; nothing else in
`DEFAULT_KEYBINDINGS` uses `Ctrl+Alt`), and it is what the two editors closest in shape to this app
both use.

### Handled locally, not as a registered command

`Ctrl+Alt+Enter` and `Enter` are handled in the bar's own container handler, **not** added to
`DEFAULT_KEYBINDINGS`.

The reason is the one `Find/commands.ts` already states for itself, about close: *"nothing outside
the open bar itself can meaningfully 'close find'."* The same is true of replace — the replacement
text lives in `FindBar`'s component state, and a Replace All from a closed bar with an empty
replacement field is not a command anyone wants offered. Making it a global binding needs a new
`findOpen` context key to gate it, plus a controller hop, to buy an invocation path that does not
make sense.

**Cost, and how it is paid.** A locally-handled chord is invisible to the Shortcuts panel's derived
section, which reads the command registry. That panel already has the answer: `IN_PANE_KEYS`, its
curated table, exists exactly for Tree's arrows, Grid's cell keys, Raw's Tab/Enter/Escape and the
palette's mode prefixes — none of which are commands either. **R121 adds a "Find bar" group to it**
(§7). And the two buttons' `title` attributes name their chords, following the disclosure button's
own `title="Replace (Ctrl+H)"`:

- ⇄ → `Replace (Enter)`
- ⟳ → `Replace All (Ctrl+Alt+Enter)`

**Scope.** `Ctrl+Alt+Enter` fires from anywhere inside the bar, including the find input — not only
the replace field. It routes through `handleReplaceAllClick()` unchanged, so the confirmation gate
above 50,000 matches and the undo-budget warning (R90 §6) apply identically; this adds a way to ask,
not a second path that skips the asking. No-op when the replace row is not showing.

---

## 5. R122 — Escape closes from anywhere in the bar

**Task.** `Escape` moves out of the find input's `handleKeyDown` and into the container handler, so
every control in the bar closes on it. The input's handler keeps `Enter` only.

**And closing returns focus to the pane that had it.** This is one step past the literal report, and
it is included because R122 and R123 together create the gap: once Escape works from the ⟳ button,
closing unmounts the focused element and focus falls to `<body>` — and once Tab no longer leaves the
bar (R123), the user has no keyboard way back into a pane except `F6`. Today the same fall-to-body
happens on the ✕ button and is merely less reachable.

`handleClose()` gains: **if focus is currently inside the bar**, return focus to the last focused
pane after closing. The guard is load-bearing — `closeFind()` is also reachable from paths where the
user is not in the bar at all, and grabbing focus there would be a worse bug than the one being
fixed.

**`focus.ts` needs one new export for this, and it belongs there rather than in `FindBar`.**
Checked: `lastFocusedPane` is a module-private `let` with no getter, and `PANE_ORDER` is private
too — `wasLastFocusedPane(pane)` is a predicate, so a caller outside the module can only recover the
answer by trying all three panes in an order it would have to hardcode. Leaking pane order into the
Find bar to close a find bar is the wrong direction. Add instead:

```ts
export function focusLastPane(): void {
  focusPaneOrFirstAvailable(lastFocusedPane ?? 'raw')
}
```

`focusPaneOrFirstAvailable`, not `focusPane`, because the remembered pane may since have been
collapsed (`Ctrl+Shift+R` with Find open) — that is the exact trap R69 wrote it for. The `?? 'raw'`
fallback covers `lastFocusedPane === null`, which R112 made effectively unreachable once a document
is open but which is still the state before one is; `'raw'` matches `paletteLogic.ts`'s own
`paneForPaletteJump` default rather than inventing a second answer to the same question. And
`focusPane` already tries each pane's registered *content* delegate before its shell (R91), so this
lands the caret where the user can type, not on the pane wrapper.

`lastFocusedPane` is still correct at that moment: `registerPane` listens for `focusin` on the pane
shells, and the Find bar is outside all three, so focusing a find control never overwrote it
(R112's own mechanism, in the direction that helps here).

### The guard §1 found

The container handler must ignore any `Tab` with `Ctrl`/`Alt`/`Meta` held. The global keymap
`preventDefault()`s `Ctrl+Tab` for `nodepad.tabs.next` but **does not** `stopPropagation()`, so the
event still reaches the bar; without the guard, `Ctrl+Tab` inside the Find bar would switch tabs and
move focus in the bar at the same time.

---

## 6. R123 — Tab cycles inside the bar until it is closed

**Task.** Tab past the last control in `orderedFocusables()` wraps to the first; Shift+Tab before
the first wraps to the last. Falls out of R120's handler — the ordering function is already there,
so this is `(index + 1) % list.length`.

**The exits stay open, and they are the reason this is acceptable.** The bar is `role="search"`, not
a dialog, and it deliberately does **not** become `aria-modal` — it does not block interaction with
the document behind it, and claiming otherwise would be a lie to assistive technology. Trapping Tab
in a non-modal widget is a real accessibility hazard when Tab is the *only* way out. It is not,
here:

| Exit | Effect on the bar |
|---|---|
| `Escape` (now from any control, R122) | closes, focus returns to the pane |
| ✕ | closes, focus returns to the pane |
| `F6` / `Shift+F6`, `Ctrl+1`/`2`/`3` | focus moves to a pane, **bar stays open** |
| Clicking anywhere | as today |

**What is genuinely lost:** you can no longer Tab from the Find bar into the Raw editor while
keeping the bar open. `F6` or `Ctrl+3` does it instead, and the Shortcuts entry in §7 says so
explicitly, because a trap that is never explained is the version of this that goes wrong.

---

## 7. The Shortcuts panel entry

`Shortcuts.tsx`'s `IN_PANE_KEYS` gains a fifth group. Its `file` field points at `FindBar.tsx`, the
same way the existing four point at the file whose `onKeyDown` they describe.

```
{
  pane: 'Find bar',
  file: 'components/Find/FindBar.tsx',
  keys: [
    { keys: 'Enter / Shift+Enter', does: 'Next / previous match (from the find field)' },
    { keys: 'Enter',               does: 'Replace the current match and move to the next (from the replace field)' },
    { keys: 'Ctrl+Alt+Enter',      does: 'Replace all' },
    { keys: 'Tab / Shift+Tab',     does: "Cycle the bar's own controls — find, then replace, then the rest" },
    { keys: 'Escape',              does: 'Close Find and return to the pane' },
    { keys: 'F6 or Ctrl+1/2/3',    does: 'Leave the bar with it still open' }
  ]
}
```

The last row is not padding: it is the answer to "the trap took Tab away from me," and it is the
only place in the app that says it.

---

## 8. Non-functional expectations

Nothing here is hot — one handler on one bar with at most eleven controls, and `querySelectorAll`
runs once per Tab keystroke, not per frame. Stated only so it is not read as an omission: **do not**
cache the focusable list across renders. It changes whenever a control's `disabled` flips, which
happens on every search keystroke.

---

## 9. Acceptance criteria

Each is a browser test over the real `<FindBar>`, extending `test/findReplace.test.tsx`'s harness —
these are focus and key-dispatch behaviours, which is what `userEvent.tab()` in the real-Chromium
project exists for. §1's probe is the pattern; it already ran green.

1. **R120** — replace row expanded, search run: `Tab` from the find input focuses
   `.find-replace-input`; `Tab` again focuses the `Aa` toggle. `Shift+Tab` reverses both steps.
2. **R120** — replace row **collapsed**: `Tab` from the find input focuses `Aa` (unchanged from
   today).
3. **R121** — `Enter` in the replace field with `dog` typed against `cat cat cat` replaces exactly
   one match and the count moves to the next; asserted on the **document bytes**, not only the
   count.
4. **R121** — `Ctrl+Alt+Enter` from the *find* input replaces all three; and with the replace row
   collapsed it does nothing.
5. **R121** — the ⇄ and ⟳ buttons' `title` attributes contain `Enter` and `Ctrl+Alt+Enter`.
6. **R122** — `Escape` dispatched on the ⟳ button closes the bar. (Fails today — §1 measured it.)
7. **R122** — after that close, `document.activeElement` is inside a pane, not `document.body`.
8. **R122** — `Ctrl+Tab` inside the bar does **not** move focus within the bar.
9. **R123** — `Tab` from the last control (⟳) focuses the disclosure button, not an element outside
   `.find-bar`. (Fails today — §1 measured it landing on `#outside-after`.)
10. **R123** — `Shift+Tab` from the disclosure button focuses ⟳.
11. Every one of 1–10 **checked to fail before the fix**, not only to pass after. Six of them
    already have their failing measurement recorded in §1.

---

## 10. Results

Landed as specified — one container `keydown` handler (`handleBarKeyDown`) on `.find-bar`, carrying
Escape, `Ctrl+Alt+Enter`, and Tab/Shift+Tab (ordering + wrap) together, exactly as §2's "the third
wins" reasoning predicted. `orderedFocusables` derives the tab order from the DOM each keystroke
(not cached — §8), splicing the replace input in after the find input and filtering disabled
controls. `focus.ts` gained `focusLastPane`, used only when `handleClose` finds focus was inside the
bar at the moment of closing.

All eleven acceptance criteria in §9 pass, as ten real-Chromium tests extending
`test/findReplace.test.tsx`'s own harness (`describe('R120-R123 — the Find bar keyboard', …)`),
each verified against a fake pane shell registered through `focus.ts`'s own `registerPane` so the
"focus returns to a pane" assertion (§9.7) is checked against a real registered target rather than
merely "not document.body".

**Review pass found nothing to fix.** The one thing worth recording: `handleReplaceAllClick()` is
now also reachable from `Ctrl+Alt+Enter`, so its own guard (`matchMode !== 'path' &&
findState.replaceExpanded`) was added at the call site in `handleBarKeyDown` rather than inside
`handleReplaceAllClick` itself, since the click handler's own callers (the ⟳ button) are already
only rendered when both conditions hold.
