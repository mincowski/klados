# R170 — a deeply nested tree has nowhere to scroll

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. Found by a user opening `deep-10k.json` — a real fixture the
project generates — and noticing the Tree has no horizontal scrollbar. It cannot have one as
currently built.

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
