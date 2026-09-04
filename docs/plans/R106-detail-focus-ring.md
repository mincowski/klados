# R106–R107 — the Detail pane's focus ring is the browser's, not the app's

<!-- status: built -->

**Built, with §2 since reversed — read the addendum at the end before this document's §2.**
Register: `docs/TASKS.md`. Reported against R94 as built: F6 into the Detail pane in list mode draws
a ~1px white line across the top of the pane, and the same pane reached by pressing Enter on a grid
row does not. Follow-up to `docs/plans/R91-focus-into-content.md`. Results at the end of this file.

**§2 chose to replace the user-agent ring with `.grid-scroll`'s inset `--focus-ring` box. Looking at
it in the running app rejected that**: the addendum removes the ring entirely and leaves the
whole-pane `:focus-within` overlay as the only focus indication, matching `.tree`.

**Every question in this document is settled — nothing here is waiting on a decision**, except
the one the addendum names as still open: the grid's own container ring.

---

## 1. Reproduced and measured

Rebuilt the pane's real DOM (`.pane` → `.pane-body` → `.detail-viewport` → `.detail`) against the
app's own stylesheets in real Chromium, dispatched a key event and called `.focus()` — the sequence
F6 produces. The line appears, in the same place as the report:

| | |
|---|---|
| `.detail` matches `:focus-visible` | **true** |
| `outline-style` | **`auto`** — the user-agent default |
| `outline-color` | `rgb(16, 16, 16)` (the dark half of Chromium's double ring; the light half is what shows) |
| `outline-width` / `outline-offset` | `1px` / `0px` |
| `.detail` top / height | 24.0 / 396.0 |
| `.pane-body` top / height | 24.0 / 396.0 |

**Cause: R94 made `.detail` focusable and never gave it a focus style.** It added `tabIndex={-1}` so
arrow keys would scroll the pane, and `Detail.css` has no `outline` rule at all — so Chromium's
default ring applies.

**Why only the top edge shows.** `.detail` is `height: 100%` and its box is *exactly* `.pane-body`'s
box — measured identical above. An `outline-style: auto` ring straddles the border box, so the part
outside it falls beyond `.pane-body`'s padding box and is clipped by that element's `overflow: auto`;
only the inner sliver survives. It survives on all four edges, but three of them sit against the pane
divider, the scrollbar gutter and the pane's bottom chrome, while the top runs across flat background
directly under the pane header — so that is the one that reads as a line.

**And why the grid route does not show it.** Pressing Enter on a grid row selects a node with no
repeating children, `useGrid` flips to `false`, and `Grid` unmounts — taking the focused
`.grid-scroll` with it. `.detail` never receives focus at all, so `:focus-visible` never matches. §3
is about that.

## 2. R106 — `.detail` gets the ring the grid already has

Two precedents exist in this codebase and `.detail` matches neither:

| Element | At rest | Focused |
|---|---|---|
| `.tree` | `outline: none` (`Tree.css:19`) | nothing — relies on the pane `:focus-within` overlay |
| `.grid-scroll` | `outline: none` (`Grid.css:165`) | `outline: 2px solid var(--focus-ring); outline-offset: -2px` (`Grid.css:36-39`) |
| `.detail` | **nothing** | **the user agent's** |

**Decided: follow `.grid-scroll`.** Three reasons, in order of weight:

- **They are the same pane.** Grid mode rings and list mode does not would be an inconsistency inside
  one pane, produced by which node happens to be selected.
- **List mode has no active item at all.** The tree has a selected row and `aria-activedescendant`;
  the grid has an active cell. Detail in list mode has nothing — so a container ring is the *only*
  indication of where the arrow keys are going, which makes it more useful here than in either of
  the others, not less.
- **`outline-offset: -2px` draws the ring inside the border box**, so it is fully visible instead of
  straddling the boundary the parent clips at. That is exactly the failure §1 measured, and the
  existing grid rule already avoids it.

So: `outline: none` on `.detail`, and `.detail:focus-visible { outline: 2px solid var(--focus-ring);
outline-offset: -2px }`. `:focus-visible`, not `:focus`, matching the grid — a mouse click into the
pane should not ring it. `--focus-ring`, not `--pane-focus-ring`: the latter is documented as "a
deliberately quieter token" for the whole-pane overlay, and this is the same in-pane ring the grid
uses.

Invariant 9 is worth naming here even though no literal colour is being added: the current state is
*worse* than a literal, because the colour comes from the user agent and cannot be themed at all.

## 3. R107 — focus is dropped when the grid unmounts

Not what was reported, but found while explaining why the second scenario looks different, and cheap
enough to fix alongside.

`Detail.tsx`'s effect registers the pane-content delegate and nothing else — the delegate is only
ever *called* by `focusPane`. So when `useGrid` flips `true → false`, `Grid` unmounts with focus
inside it and focus falls back to `<body>`.

**R94's own acceptance criterion is therefore true for F6 and false for this path**: "F6 to Detail in
grid mode leaves the first row active… in list mode leaves focus on `.detail`" holds when F6 is what
brought you there, and does not hold when a grid row's Enter did.

It is not visibly broken — the report says arrow scrolling still works, because Chromium keeps
scrolling the nearest scroll container after focus is lost. But `document.activeElement` is
`<body>`, so Tab restarts from the top of the document rather than continuing from the pane, and any
future `when: 'focus == detail'` gate would be reading a context key that no live focus supports.

Fix: when the pane had focus and the grid is going away, move focus to `.detail` — an effect keyed on
`useGrid` that re-focuses only if focus was inside this pane, never unconditionally. **The
conditional is the whole task**: an unconditional focus would steal the keyboard from the Tree or Raw
every time the selection changed to a non-grid node, which is exactly the behaviour R69 was careful
not to introduce.

## 4. Definition of done

- [x] R106 — F6 into Detail in list mode draws the app's own 2px `--focus-ring`, inset, and **no
      user-agent ring**. Asserted on `outline-style` being something other than `auto` while focused,
      because `auto` is the specific value that signals "nobody styled this".
- [x] R106 — a mouse click into the pane does not ring it (`:focus-visible`, not `:focus`).
- [x] R106 — grid mode and list mode ring identically, checked in the same test rather than in two.
- [x] R107 — pressing Enter on a grid row for a node with no repeating children leaves
      `document.activeElement` inside the Detail pane, not on `<body>`.
- [x] R107 — changing the selection to a non-grid node **while another pane has focus** does not move
      focus. This is the assertion that matters; the fix is trivial and the guard is not.
- [x] `docs/FINDINGS.md` gains the general trap: **a scroller made focusable with `tabIndex={-1}`
      needs an explicit `outline` rule.** The user-agent `auto` ring straddles the border box, the
      parent's `overflow: auto` clips all but a sliver of it, and what survives reads as a stray 1px
      line rather than as a focus ring — so it gets reported as a rendering artefact, not as a
      missing style. R91 made three scrollers focusable; this is the one that had no rule.

## 5. Results

Built as specified, with one deviation from the sketch in §3: **the guard is not a
`document.activeElement` read at all.** An early attempt read `document.activeElement` during
render (the last point at which the DOM still reflects the *previous* commit, before React removes
`Grid`'s subtree) — correct in theory, but two problems killed it: `DetailContent`'s own `document`
prop shadows the DOM global of the same name (an easy trap to reproduce — the read silently returned
`undefined.activeElement` from the prop instead of the real one), and reading a ref's `.current`
during render trips this project's `react-hooks/refs` lint rule (React Compiler assumes render is
pure). Replaced with `wasLastFocusedPane` (new export, `focus.ts`), which asks whether `'detail'`
was the last pane to receive a `focusin` — driven by the pane's own shell (`Layout.tsx`'s
`PaneShell`, which does not unmount when `Grid` does) rather than by DOM state that the unmount race
destroys before any effect can read it, and deliberately not cleared by an ordinary blur, only by
the shell's own unregistration. `DetailContent` tracks the previous `useGrid` value in a ref, but
only reads/writes it inside `useEffect` — never during render — so the render-purity rule the
earlier attempt violated does not apply here.

`.detail:focus-visible` matches `.grid-scroll`'s existing rule exactly (`outline: 2px solid
var(--focus-ring); outline-offset: -2px`); `.detail`'s base rule gains `outline: none` alongside it.

`test/detailFocusRing.test.tsx` (5 tests, real Chromium): F6 in list mode gives `.detail` a solid
2px outline (not `auto`); a real `userEvent.click` (not a programmatic `.focus()`, which — checked
rather than assumed — matches `:focus-visible` in Chromium the same as a keyboard focus does, unlike
an actual mouse click) leaves it unringed; grid and list mode ring identically, compared as
snapshotted style strings rather than a live `CSSStyleDeclaration` (reading the live object *after*
the element is unmounted silently returns the post-unmount default instead of the value that was
true when it was captured — caught during review, not assumed); Enter on a grid row moves
`document.activeElement` from `.grid-scroll` into `.detail` rather than `<body>`; and moving focus to
a second registered pane (a real Tree shell, not an arbitrary unregistered element — the first draft
used a bare `<button>`, which doesn't exercise the guard at all, since `lastFocusedPane` only changes
on another *pane's* `focusin`) before the same transition leaves that focus untouched. Full browser
suite (40 files, 201 tests) and lint (eslint + stylelint) clean; `npm run typecheck:web` unaffected
(same nine pre-existing, unrelated failures as before this round).

---

## Addendum — the ring is removed again, and the pane overlay is the answer

**Reported after looking at R106 in the running app**: F6 into Detail draws a blue box around the
Detail *content*, and it reads as a sub-region being highlighted rather than as "this pane has
focus." The expectation is the quiet grey highlight around the whole pane — the one Tree and Raw
already show.

**That is correct, and §2's decision was wrong.** The reasoning there ("list mode has no active item,
so the container ring is the only indication of where the arrow keys are going") is true as far as it
goes, and it is answering a question the app had already answered somewhere else. `.pane:focus-within
::after` (`Layout.css`) exists precisely to say which pane has focus, for every pane, and F6 is a
*pane*-level operation. A second ring inside the pane does not add precision; it competes with the
indication that was already there and moves the apparent boundary of the focused region inward, past
the pane header.

**What changed:** `.detail:focus-visible` is deleted. `.detail` keeps `outline: none`, which is what
actually fixed the reported defect — the user-agent `outline: auto` ring, whose clipped sliver was
the original ~1px white line. `.tree` has exactly this shape (`outline: none`, nothing on focus), so
all three panes now indicate focus the same way.

**What this costs, stated rather than glossed:** in list mode there is now no indication of *which
element within the pane* takes the arrow keys. That is the same position Tree and Raw are in, and in
both of those the answer comes from content (a selected row, a caret) rather than from a ring. List
mode genuinely has neither. Judged acceptable because the arrow keys scroll the pane as a whole
there — there is no item to be ambiguous about, so a ring would be marking a target that does not
exist.

**Verified**: rendered the real pane DOM in Chromium with the app's own stylesheets, focused
`.detail`, and screenshotted — the grey `--pane-focus-ring` border runs around the whole pane,
header included, and no inset box appears. `test/detailFocusRing.test.tsx` now asserts
`outlineStyle` is `none` (neither `auto` nor a replacement ring) and that `.pane::after`'s border
colour becomes `--pane-focus-ring` on focus, in both grid and list mode. The token is resolved
through a probe element rather than `getPropertyValue`, which returns the literal `var(--gray-300)`
and would never match.

### R111 — the grid's own container ring, and the window edge

`.grid-scroll:focus-visible` (`Grid.css:36-39`) draws the identical inset `--focus-ring` box, so in
**grid** mode F6 still produces exactly the sub-pane highlight this addendum removed from list mode.
It predates R106 and was not reported, so it is left alone rather than quietly changed — but the
principle above applies to it unchanged, and grid mode has a *second* ring already
(`.grid-cell-active`, the keyboard-focused cell), which makes the container ring the redundant one of
the two.

**Done: `.grid-scroll` is out of that selector, `.grid-quick-filter` stays** — the filter is an
ordinary text input and needs its own focus indication; the scroll container does not, now that the
pane overlay is the pane-level answer and the active cell is the within-pane one. `.grid-scroll`
keeps `outline: none`, so the user-agent ring does not return in its place.

#### The window edge — a 1px gutter, not a thinner ring

Second half of R111, reported alongside: the pane focus overlay is a 1px border at `inset: 0`, so on
the leftmost and rightmost panes it occupies the window's own edge pixel, where Windows' frame and
rounded-corner mask cover it. A focused Tree loses its left edge and a focused Detail/Raw its right,
so the focus box reads as open on one side. **Only left and right are ever at risk**: `TitleBar` sits
above `.layout` and `StatusBar` below `.layout-body`, so no pane touches the window's top or bottom.

**Insetting the overlay instead cannot work, and the measurement is why.** The scrollbar track is
pinned to `right: 0` at `--scrubber-width` (15px) and its thumb is inset `left: 1px; right: 1px`, so
the thumb spans `[W-14, W-1)` and **the overlay currently occupies exactly the one free pixel column
the thumb leaves**. Moving it inward by 1px would put it on the thumb.

So `.layout-body` gets `padding: 0 1px` and every pane moves off the window edge instead.

**The cost, measured and accepted rather than glossed:** the scrollbar track's background is
deliberately opaque (`--scrollbar-track-bg`, R33/1c) and differs from `--surface-bg` — `--gray-800`
on `--gray-900` in dark, `--gray-100` on `--gray-0` in light — so on Detail and Raw this leaves a 1px
seam of surface colour between the scrollbar and the window edge **at all times, focused or not**.
Rendered both ways and compared: indistinguishable at 1x, obvious at 6x. On the Tree's left edge
there is no track, so the gutter is invisible there. Accepted after looking at it.

**What it is not.** The gutter shows `--surface-bg`, the same colour as the panes, so it does **not**
draw a visible window boundary — it does not help tell one window from another when two overlap.
That would be `border-left`/`border-right` on `.layout` in `--surface-border`, matching the
`border-top` it already has. Recorded because the two are easy to confuse: this change only makes the
focus ring complete.
