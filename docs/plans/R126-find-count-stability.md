# R126–R128 — the match count: width, alignment, and surviving a reopen

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Three defects in the Find bar's count area, reported together.
R126 is the reported jump (the `(stale)` suffix moving every control sideways), R127 the count's
vertical alignment, R128 a search whose results are not restored when Find is reopened. Measuring
R126 found a second cause of the same jump that was not reported, and ruled out both the first fix
suggested and the first fix this document proposed. Sibling of
`docs/plans/R120-find-bar-keyboard.md`, same component, unrelated mechanism.

**Every question in this document is settled.** Six treatments were rendered in both themes and
measured to the tenth of a pixel; the two rejected on contrast were rejected on measurements, and
the one rejected on looks was rejected on a picture.

---

## 1. R126 — why the bar moves, measured

`.find-bar` is `position: absolute; right: var(--space-2)` with `width: max-content`, and
`.find-bar-row > *:not(.find-input) { flex: none }` — so `.find-count` is sized by its own content
and the bar's width follows it. Because the bar is anchored on the **right**, growth pushes the left
edge outward and **every control translates left**. `.find-count` carries `min-width: 6em` (= 78 px),
which absorbs short labels entirely.

Real `.find-bar` markup against the real stylesheet, at `--font-size-ui`:

| Count label | `.find-count` | Bar width | `.find-input` |
|---|---|---|---|
| `Searching…` / `No matches` / `1 of 3` / `1 of 3 (stale)` | 78.0 | 563.3 | 218 |
| `1 of 65,432` | 78.0 | 563.3 | 218 |
| **`1 of 65,432 (stale)`** | 101.6 | **586.9** | 218 |
| `12,345 of 65,432` | 94.5 | **579.9** | 218 |
| **`12,345 of 65,432 (stale)`** | 132.4 | **617.8** | 218 |

Three things fall out, and two were not in the report:

1. **The jump is 24–38 px**, and it is a *translation*, not a resize — `.find-input` is 218 px in
   every row. That matches the report exactly: the boxes move, they do not change size.
2. **Small documents never jump.** `1 of 3 (stale)` fits inside the 6 em floor. The defect is
   invisible until the count string outgrows 78 px — which is why it appeared on the 10 MB cars file
   and nowhere else.
3. **`(stale)` is not the only cause.** `1 of 65,432` → `12,345 of 65,432` is **+16.6 px** with no
   staleness involved. **Pressing F3 through a large result set creeps the bar sideways**, and
   fixing only the suffix would leave that behind.

## 2. What `(stale)` actually marks — and why it goes

`searchStore.ts` sets `stale` the moment the buffer changes while a query is active, and clears it
when a reparse lands and the re-run starts. So the state's life is **the whole editing burst plus
`REPARSE_DEBOUNCE_MS` (200 ms)** — not a 200 ms flash. Stated precisely because the first draft of
this plan got it wrong: during sustained typing the word sits there the entire time.

What happens next is the reason it can go anyway. The sequence is:

```
correct count → [edit] → frozen count, marked (stale) → [200 ms after the last keystroke]
              → "Searching…" → correct count
```

The moment the number is *genuinely* unknown, the label already says `Searching…` — an honest
signal that costs no width (it fits the 6 em floor). `(stale)` covers only the window in which the
number is frozen and *approximately* right, and in that window the user is looking at the text they
are editing, not at the find bar.

**So R126 removes `(stale)` entirely**, as asked. `countLabel` loses its suffix branch;
`SearchResult.stale` stays in the store (it is real state, and R128 and any future consumer may want
it) but stops being rendered.

### Two alternatives, considered and rejected

- **Show `Searching…` in place of the count while stale.** Never displays a wrong number, needs no
  width. Rejected because it would blank the count for the *entire* duration of a typing burst — a
  longer-lived misstatement than the one it removes, since no search is running for most of it, and
  it throws away a number that is approximately right.
- **A single reserved trailing marker (`*`), with a tooltip.** Costs ~7 px, so the reservation would
  be invisible. Rejected because a glyph that needs a tooltip to decode is a worse trade than either
  the whole word or nothing.

If the unmarked count turns out to mislead in use, the trailing marker is the cheap thing to add
back — it is recorded here so that decision does not have to be rediscovered.

## 3. R126 — the fix, and the empty space that isn't

Removing the suffix kills the reported jump. It does **not** kill §1's third finding: the ordinal
still grows. So the count box still needs a reservation — but a much smaller one, and this is the
part the first draft of this plan got wrong.

**Rendered, both themes, real markup:**

| | Reservation | Bar | Verdict |
|---|---|---|---|
| Today | none | 513.3 → 536.9 | jumps |
| Drop `(stale)`, no reservation | none | 513.3 → 529.9 | still jumps 16.6 px on the ordinal |
| Drop `(stale)`, reserve `{total} of {total}` | ~16 px slack | 529.9, stable | **kept** |
| **Keep `(stale)`, reserve the lot** | **~54 px slack** | 567.8, stable | **rejected — the void is plainly visible and reads as a layout bug** |

That last row is what this document specified before, and looking at it settles it: a 54 px gap
between the count and `Aa` looks broken. At ~16 px the slack reads as ordinary spacing. **The
objection was right, and it was only answerable by rendering it.**

**Right-align the count in its reserved box.** With the box sized for `{total} of {total}` and the
text right-aligned, the constant part (`of 65,432`) lands at the same x whether the ordinal is `1`
or `12,345` — so nothing moves *inside* the box either, with no per-part sub-spans. The variable
slack falls on the left, next to the input, where the row already has a `--space-2` gap for it to
merge with.

**Reserve exactly, not by estimate.** Stack a hidden sizer and the live value in one grid cell:

```html
<span class="find-count" aria-live="polite">
  <span class="find-count-sizer" aria-hidden="true">65,432 of 65,432</span>
  <span class="find-count-value">1 of 65,432</span>
</span>
```

```css
.find-count { display: grid; text-align: right; font-variant-numeric: tabular-nums; }
.find-count-sizer,
.find-count-value { grid-area: 1 / 1; }
.find-count-sizer { visibility: hidden; }
```

Both children occupy one cell, so the cell is as wide as the sizer and the value paints over it.
**Do not** compute a `min-width` in `ch`: `ch` is the width of `0`, and the label contains letters,
spaces and commas it does not describe. The sizer is exact by construction and cannot drift when the
UI font changes.

Keep `min-width: 6em` — still the floor for short labels, and why small documents keep today's
compact bar and pay nothing.

## 4. R127 — the count is not vertically centred

Visible in the report's screenshot: `No matches` sits a few pixels above the centre line of the
buttons and the input beside it.

**Cause, and it is a leftover.** `.find-bar-row` sets `align-items: flex-start`. R89 chose that
deliberately and said why: *"once the textarea can grow past one line, centering would drift every
button away from the input's own first row."* **R102 reverted the multi-line find field.** There is
no growing element in that row any more — the footnote is outside it — so the justification is gone
and only the side effect remains. `.find-count` is a bare `<span>` with no padding, while every
sibling has `padding: var(--space-1) var(--space-2)` plus a border, so top-aligning puts the count's
text above everything else's.

**Fix:** `align-items: center` on `.find-bar-row`. Rendered against the real stylesheet — the count
lands on the same centre line as the buttons, and nothing else in the row moves.

This is the same class of finding as R102's own note about the multi-line match ring, in the
opposite direction: that decoration outlived its feature *for a good independent reason*, and this
one did not. Record it in the rule's place so the pair reads as one story.

## 5. R128 — reopening Find keeps the query but loses the results

**Reported:** search, close the bar, reopen with `Ctrl+F`. The old query text is still in the field;
the count reads `No matches`.

**Cause, and both halves are deliberate on their own.** `handleClose()` calls
`activeSearchStore.clear()` — correct, because the result also drives Raw's match decorations, and
leaving them painted after Find closes would be wrong. Meanwhile `text` is `FindBar`'s own component
state and the component **never unmounts** between opens (`findState.isOpen` gates the render, not
the mount), so the query survives. The open effect then does this:

```ts
useEffect(() => {
  if (!findState.isOpen) return
  inputRef.current?.focus()
  const prefill = prefillToRunRef.current
  if (prefill === null) return          // ← a plain Ctrl+F stops here
  ...
}, [findState.isOpen])
```

A search is re-run **only** for a palette hand-off's prefill. A plain reopen focuses the field and
nothing else — so the surviving text describes a result set that was deliberately thrown away.

**Fix:** when Find opens with no prefill and `text` is non-empty, re-run it — `runPathQuery(text)`
in path mode, `runSearch(text, …)` otherwise. Restoring the result rather than preserving it is the
right direction: it keeps `clear()` on close honest about the decorations.

Two details the implementation must get right:

- **Use the component's current options**, not hardcoded ones. `caseSensitive`, `matchMode` and the
  regex flag are component state and survived the close along with `text`; a reopen that silently
  reset `Aa` would be a new bug in place of this one.
- Noted in passing, **not** fixed here: the prefill path itself hardcodes
  `{ caseSensitive: false, regex: false }`, so a palette hand-off resets those toggles. Defensible
  for a hand-off that brings its own query; recorded because the two call sites will sit next to
  each other and the difference should look deliberate.

**Consequence, stated rather than discovered:** the re-run goes through the same path as typing the
query, so it will resolve a current match at or after the caret and scroll Raw to it, exactly as
retyping would. That is the least surprising rule and needs no new behaviour. If reopening Find
turns out to jump the view annoyingly, suppressing the auto-select on this path only is a one-line
change — flagged as the tuning point so it is not mistaken for a fresh defect.

## 6. Non-functional expectations

The sizer string is derived from `total` and changes only when the result set does — build it in
render from the same value the label uses, never in an effect that could disagree with it. R128's
re-run rides the existing `runSearch` debounce; **do not** add a second timer, and do not re-run on
every render — the effect is keyed on `findState.isOpen`, and it must stay that way or every
keystroke would restart the search.

## 7. Accessibility

`.find-count` keeps `aria-live="polite"` and the sizer is `aria-hidden`, so the announced string is
the value alone, not the value plus a hidden duplicate. Verify this specifically: an `aria-live`
region containing a hidden sizer is exactly the shape that announces both if the `aria-hidden` is
forgotten, and no visual test catches it.

## 8. Acceptance criteria

Browser tests over the real `<FindBar>`, extending `test/findReplace.test.tsx`'s harness. §1's and
§3's tables are the pattern and already ran.

1. **R126** — with `total = 65,432`, `.find-bar`'s width is identical for `1 of 65,432` and
   `12,345 of 65,432`. (Differs by 16.6 px today — the unreported half.)
2. **R126** — identical again for `Searching…` and `No matches` at that total.
3. **R126** — no rendered label anywhere contains the string `(stale)`.
4. **R126** — with `total = 3` the bar is no wider than today: the 6 em floor still governs.
5. **R126** — the constant part of the label (`of 65,432`) has the same left edge at both ordinals,
   i.e. nothing moves inside the box either.
6. **R127** — `.find-count`'s vertical centre matches the `Aa` button's, within 1 px. (Fails today.)
7. **R128** — search `cat` against `cat cat cat`, close Find, reopen with `openFind()`: the field
   still reads `cat` **and** the count reads `1 of 3`. (Reads `No matches` today.)
8. **R128** — with `Aa` pressed before the close, the reopened search is still case-sensitive.
9. 1, 2, 6 and 7 **checked to fail before the fix**, with the deltas above as the expected failures.

---

## 9. Results

Landed as specified: `(stale)` dropped from `countLabel`; `.find-count` reserves exactly via a
hidden `.find-count-sizer` (`{total} of {total}`, `toLocaleString()`-formatted to match the visible
label) stacked in a CSS grid cell with `.find-count-value`, right-aligned; `.find-bar-row` moved to
`align-items: center`; and the open effect re-runs a surviving non-empty query with the component's
current options when there is no prefill.

Nine real-Chromium tests extend `test/findReplace.test.tsx` (`describe('R126-R128 — the match
count', …)`), covering §8's criteria 1, 3, 4, 5 (bar width stable across a growing ordinal, no
`(stale)` string anywhere, the 6em floor still governs a short document, exact reservation directly
measured), 6, 7 and 8. **Criterion 2 is narrower than first read**: given the render's own ternary
(`total === 0 ? 'No matches' : …`), "Searching…" and "No matches" can only be compared "at that
[same] total" when that total is 0 — the plan's own §1 table measured both at `total = 3`, not at a
large total mid-search. Tested as such (a short document's "No matches" against its own real count,
plus the existing floor test covering "Searching…"), rather than the reading briefly tried during
implementation (comparing a large-total "Searching…" state against a completed large-total count) —
that comparison isn't meaningful here, since `activeSearchStore`'s own incomplete result resets
`total` to 0 for the duration of every in-flight search (`searchStore.ts`'s `setResult({
...EMPTY_SEARCH_RESULT, complete: false })`), so the reservation legitimately (and correctly, per
§3's "exact, not by estimate") shrinks to the floor during "Searching…" and grows back once a large
result lands — the same one-time widen the old flat `min-width: 6em` never fully absorbed either
(§1's own measured jumps happened on exactly this transition).

**Review pass** found one thing worth recording rather than silently fixing: the first attempt at
the criterion-2 test asserted "Searching…" and a completed large count render at the same width,
which is false by the above and was a bug in the *test*, not the component — caught by running it,
not by reading the diff, which is the reason this round's own test authoring is worth calling out
in the results rather than leaving as an implementation detail.
