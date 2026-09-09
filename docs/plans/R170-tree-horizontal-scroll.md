# R170 — a deeply nested tree has nowhere to scroll

<!-- status: built -->

**Built** — by horizontal scrolling, chosen over the capping shapes after all three were
rendered and looked at. Register: `docs/TASKS.md`. Results in §8, including the correction to §1:
**the scroll extent already existed; what was missing was the track, and a label wide enough to be
worth scrolling to.**
Found by a user opening `deep-10k.json` — a real fixture the project generates — and noticing the
Tree has no horizontal scrollbar. **This document originally said it could not have one as built.
§8a corrects that: it could, and the scroll extent was already there — only the track was not.**

---

## 1. Why no scrollbar can appear

Read at the line cited; this is mechanism, not conjecture.

- `.tree` **can** scroll — `Tree.css:26` sets `overflow: auto`.
- But **a row can never be wider than the container**: `Tree.tsx:520` renders each virtualized row
  with `style={{ position: 'absolute', top, left: 0, right: 0 }}`. Pinning both edges makes the
  row's width exactly the container's width, whatever it contains.
- The indent is real and unbounded: `Tree.tsx:539` renders
  `<span className="tree-row-indent" style={{ width: row.depth * 16 }} />`.
- The label absorbs the shortfall silently: `Tree.css:112` gives `.tree-row-label`
  `overflow: hidden; text-overflow: ellipsis`.

So on `deep-10k.json` the indent reaches **160,000 px** inside a row that is, by construction,
exactly as wide as the viewport. Nothing overflows `.tree`, so `overflow: auto` has nothing to
scroll, and the label ellipsises away to nothing. **The content is not clipped by a scroll region —
it is compressed out of existence inside each row.**

## 2. Why `right: 0` is there, and why this is not a one-line fix

The obvious change — let rows size to content — collides with three things that are all deliberate:

- **R33's overlay scrollbar.** `Tree.css:37`'s `margin-right: var(--scrubber-width)` exists so a
  row's hover/selected background sits *beside* the overlay `<Scrollbar>` track rather than
  underneath it, and the comment there ties that directly to rows being laid out with `right: 0`
  relative to `.tree`. A row that extends past the viewport changes what "beside the track" means.
- **The row background is the selection affordance.** A selected row currently paints the full
  viewport width. If rows become content-width, a shallow row's highlight stops short of the right
  edge — which is a visible design change, not a neutral refactor.
- **The virtualizer.** `useVirtualizer` measures vertically; horizontal extent is not something it
  currently tracks, so "how wide is the widest row" has to come from somewhere.

## 3. There is already a solution in this codebase — study it first

**`Grid.tsx` solves exactly this problem for wide tables** and should be read before anything is
designed: `Grid.tsx:277` runs a second `useVirtualizer` with `horizontal: true`, manages
`scrollLeft` by hand (`Grid.tsx:314-336`, including clamping it into a valid range), and lets the
`<Scrollbar>` decide for itself whether to render a horizontal track.

Whether the Tree wants the full apparatus is an open question — a tree has one variable-width
column, not hundreds — but the *decisions* Grid already made (who owns `scrollLeft`, how the
overlay scrollbar learns about horizontal extent, what happens to sticky elements) are the same
decisions, already taken once, and R170 should not take them differently without a reason.

## 4. The design question the plan does not settle

**Is horizontal scrolling even the right answer at depth 10,000?** A scrollbar that can travel
160,000 px is technically correct and practically unusable: the label a user wants is off-screen by
two orders of magnitude, and finding it means scrolling by hand.

At least three shapes exist, and this document deliberately does not pick one:

- **Scroll horizontally**, matching Grid. Simple, consistent, and useless at extreme depth.
- **Cap the indent** past some depth, so nesting stops consuming width and the label always
  survives. Loses the visual depth cue exactly where it is most confusing.
- **Elide the middle** — indent up to a budget, then a marker meaning "and N more levels".

**`PLANNING.md` §1 applies with full force here**: this is a visual decision, and that section's own
record is unambiguous — every visual decision rendered before it was settled survived contact, and
every one reasoned about came back as a follow-up round. **Render all three against `deep-10k.json`
in the browser project and put the screenshots in front of the user before choosing.** That is
minutes of work and it is the whole point of the rule.

## 5. Non-functional expectation (`PLANNING.md` §3)

**Whatever supplies the horizontal extent must not measure every row.** The Tree virtualizes
because a document can have millions of nodes; computing "the widest rendered label" by walking all
of them would reintroduce the cost the virtualizer exists to avoid. Grid's own approach — extent
derived from the rendered window, clamped, and corrected as the window moves — is the shape to
follow. A visible consequence is acceptable: a scrollbar whose extent adjusts as you scroll is
normal in virtualized views, and cheaper than being exact.

## 6. Acceptance criteria

1. Opening `deep-10k.json` leaves the node labels **readable** — by whichever of §4's shapes is
   chosen after rendering them.
2. Whatever is chosen is demonstrated on a screenshot in the results section, at a real depth, in
   both themes (the overlay scrollbar is theme-sensitive — see `docs/FINDINGS.md` on `--elev-2-bg`
   and light-mode boundaries).
3. Selection and hover backgrounds still read correctly, at shallow *and* deep indentation, with
   the overlay scrollbar present (§2).
4. No per-frame walk of all rows (§5); the existing tree-render measurements do not regress.
5. Keyboard navigation still reveals the selected row — if the tree can scroll horizontally, moving
   to a deep node must bring its label into view, not just its row.

## 7. Not in scope

R168's CRLF corruption and R169's reload affordance, both found in the same manual pass and both
unrelated. Also out of scope: whether `DEFAULT_MAX_DEPTH` should be lower, which is a parser
question and not a rendering one.

---

## 8. Results

**Built.** Horizontal scrolling, chosen over §4's other two shapes after all of them were rendered.
The diagnosis in §1 turned out to be half wrong, which changed what the fix had to do.

### 8a. §1 named one cause; there were two

§1 said rows are pinned to the container width, so nothing overflows `.tree`, so `overflow: auto`
has nothing to scroll. The first clause is right and the rest is not. Measured against the original
layout, 40 levels deep in a 400px pane:

```
clientWidth 385   scrollWidth 684    ← the scroll extent already existed
deep row width 385                   ← the row box is pinned, as §1 says
deep label width 0                   ← ellipsised to nothing
```

**The extent was always there** — a row's fixed-width indent span overflows the row box and extends
the scrollable area regardless of the row being pinned. What was missing was any way to reach it:
`<Scrollbar>` was mounted `axis="vertical"`, so the horizontal track was never drawn. And reaching
it would not have helped on its own, because the label was already zero pixels wide.

So the report — *"our tree view doesn't have a horizontal scroll bar"* — was literally about the
missing track, and the missing track was only half the problem. Two changes answer two failures, and
each is pinned by its own test, because either alone leaves the report unanswered.

### 8b. §4's design question, settled by rendering (`PLANNING.md` §1)

All three shapes were rendered against the depths `deep-10k.json` actually produces and put in front
of the user before anything was chosen. Two things came out of it that the written arguments had
not:

- **Horizontal scrolling looks identical to the defect at `scrollLeft: 0`.** The fixture is 10,000
  *singly*-nested arrays, so every row sits one level deeper than the one above and no single scroll
  position shows more than a handful of labels.
- **That is an argument about the fixture, not about the tree.** `deep-10k.json` is a synthetic
  parser stress fixture; real documents nest tens of levels, where scrolling works and surprises
  nobody. Designing the tree around depth 10,000 would have been optimising for the wrong case.

The capping shapes were dropped for a reason worth recording: **they have no prior art in this
category.** VS Code's Explorer truncates and does not scroll horizontally at all; the
cap-plus-depth-marker pattern belongs to comment threads, not data trees. The referenced answer for
chains like this one is a *third* thing — collapsing single-child chains onto one line, as
`explorer.compactFolders` does by default and as React DevTools has an open proposal to do. That is
orthogonal to this round: it would still want a scrollbar underneath it.

### 8c. What landed

- **`Scrollbar` gains `onHorizontalTrackChange`.** It already knew whether it was drawing a track;
  `Grid.tsx` recomputes the same comparison from its own column geometry under a comment noting it
  *"has no way to ask"* this component, and the tree has no column geometry to recompute it from.
  The measurement is not repeated — it comes from the existing rAF-coalesced read.
- **`axis="both"`** on the tree's scrollbar, which is the missing track.
- **The row stops pinning its right edge.** Width now comes from `.tree-row` in CSS.
- **A conditional bottom gutter**, mirroring `Grid.css`'s `.grid-scroll-has-horizontal-track` — an
  unconditional one would cost every ordinary tree 15px of vertical space for a track it never draws.
- **A horizontal reveal** for keyboard navigation, computed from `depth` rather than measured.

### 8d. The part §2 was right to worry about, and where it actually bit

§2 expected three collisions: R33's overlay track, the full-width selection background, and the
virtualizer's lack of a horizontal extent. `min-width: 100%` disposes of the first two — a shallow
row still measures the full pane, so its background spans and R33's arrangement is untouched.

**But only at `scrollLeft: 0`.** 100% resolves against the pane, so scrolled to the right edge of a
40-deep tree a shallow row's selected background stopped **175px short** — measured, after a first
version of the test asserted the right property at the one scroll position where it cannot fail.
Acceptance 3 asks for the backgrounds to read correctly at shallow *and* deep indentation, and that
is the case it meant. Fixed by flooring `min-width` at the measured content extent as well as the
pane.

Getting that measurement right took three attempts, and the two failures are the useful part:

1. **Feeding back `el.scrollWidth` latches.** Once the rows have been widened to it, they are what
   `scrollWidth` reports, so it can only grow — a tree stayed permanently scrollable after one deep
   document had been open. Caught by the shallow case in the new test.
2. **Measuring to a row's last child latches too**, for a subtler reason: `.tree-row-preview` is
   `flex: 1`, so it stretches to whatever the row currently is. The fix is also the right rule on its
   own terms — **the extent is what it takes to read the label, deliberately not the preview**, since
   a preview exists to be truncated and a long one should not make the whole tree scrollable.

The value is written as a **CSS custom property, not React state**. Routing it through state cost a
render per measurement, which `documentPropsRenderCost.test.tsx` caught immediately — 10 renders
across a typing burst became 15. It is a presentational measurement and belongs in the cascade.

### 8e. One rule shipped and then removed for being inert

`width: max-content` was written alongside the `min-width` floor and looked obviously necessary.
Mutating it away failed no test, and the reason it is genuinely dead is that the measurement runs in
a `useLayoutEffect` — so the floor is always set before first paint, and there is no frame in which
`max-content` is what makes a label survive.

It was also **actively wrong**: sizing to content lets a long preview widen the row and make the
whole tree scrollable, contradicting the rule 8d just established. Removed rather than kept as
insurance, per `CLAUDE.md`'s *"never ship code you have already discovered is inert."*

### 8f. Verified by breaking it

Every change was mutated and the mutation checked to have landed where it was aimed (R169's own
lesson, one round old):

| Mutation | Result |
|---|---|
| `axis="both"` → `"vertical"` | 2 failed — the track test and the gutter test |
| `min-width` floor → `100%` | 1 failed — the shallow row, scrolled right |
| `width: max-content` removed | **0 failed** — which is why it is gone (§8e) |

### 8g. Acceptance, criterion by criterion

1. **Labels readable on `deep-10k.json`** — by horizontal scrolling, chosen after rendering all
   three shapes.
2. **Screenshot at real depth in both themes** — the real fixture through the real `TreeContent`,
   scrolled off its origin, track visible in both.
3. **Selection and hover backgrounds at shallow and deep indentation, with the overlay scrollbar
   present** — §8d, asserted *after scrolling*, which is the only position where it can fail.
4. **No per-frame walk of all rows** — the measurement is bounded by the rendered window, which the
   virtualizer keeps at a few dozen elements; the reveal reads no DOM at all. The render-cost test
   is back at its budget of 10.
5. **Keyboard navigation reveals the label, not just the row** — with a test for the return trip
   too, since a reveal that only scrolls one way leaves the pane stranded on empty indentation.

Suite **1887 → 1896**, lint at its 3-warning ratchet, typecheck clean.

### 8h. Review pass

Reviewed as a separate pass over `git diff`. One finding, fixed: the reveal effect held `rows` in a
ref assigned during render — the same pattern lint had just rejected in `Scrollbar.tsx` a few
minutes earlier, and unnecessary, since the effect wants one number. Replaced with a derived scalar
depth, which removes the ref and lets the effect depend on primitives.

### 8i. Not done

**Nothing makes depth 10,000 pleasant**, and this round does not claim to. A scrollbar that travels
that far is correct and unusable; §8b's argument is that the fixture is synthetic and the realistic
range is served. Collapsing single-child chains onto one line — the VS Code / React DevTools
pattern — is the move if that ever stops being true, and it composes with this rather than replacing
it.
