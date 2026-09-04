# R43–R46 — the grid's sizing and its scrollbars

<!-- status: built-caveat -->

**Built — R46's own p90 frame-time acceptance criterion unmet** (no display in this environment to
measure it; the fix's mechanism is verified, not the number). Register: `docs/TASKS.md`. Decision:
`docs/DECISIONS.md` D-071 (R43, R46).

Four reports from using the table on `cars-10mb.xml`. R44 and R45 are small and independent; R43 and
R46 are both "the grid uses a fixed constant where it should measure," which is why they share a
decision.

---

## 1. Measured first

Real Electron, `cars-10mb.xml`, 1250 × 900 window:

| | |
|---|---|
| `.detail-grid-container` height | **480 px, fixed** |
| `.grid-scroll` `margin-right` | 15 px (a reserved gutter for the vertical track) |
| `.grid-scroll` `margin-bottom` | **0 px** |
| horizontal track | x 273.8 → 972.2, i.e. the **full** viewport width |
| `.grid-scroll` right edge | 957.2 — the horizontal track runs 15 px past it, into the vertical gutter |
| row-header column width | 56 px, `position: sticky` |
| every column's width | `CELL_WIDTH = 160`, the same for all |
| thumb-drag frame times (60 moves) | median 17 ms, **p90 33 ms**, p99 34 ms, max 50 ms |

---

## R43 — every column is 160 px whether it needs it or not

`CELL_WIDTH = 160` is used three ways: the column virtualizer's `estimateSize`, every cell's inline
`width`, and the `stickyWidth`/`bodyLeft` arithmetic. There is no per-column width anywhere, so
`year` (4 characters) gets exactly as much room as a composite `engine` summary, and a wide table
wastes most of the viewport on columns that need a third of it.

### Content-derived default widths

**Sample, don't measure everything.** The precedent is `isNumericColumn`: sample a bounded number of
present values per column, and cache the answer per `nameId` (R34 made that cache exist). Take the
longest decoded text in the sample, take the header name's own length — a short column with a long
header is the case a naive content-fit gets wrong — and clamp.

Two things to get right rather than discover:

- **Reuse the sample `isNumericColumn` already takes.** Two independent bounded scans over the same
  rows is the shape R34 spent a round removing; one pass answering both questions is the same work.
- **The grid's font is proportional (`--font-ui`), so character count is an estimate, not a
  measurement.** That is fine for a *default* — it only has to stop `year` being 160 px — but it
  will be visibly wrong for some column somewhere, which is the argument for the escape hatch below.

Suggested clamp: a floor around 56–64 px (below that a header is unreadable) and a ceiling around
320 px (above that one column pushes everything off screen). **These are guesses and should be
stated as guesses** — pick them by looking at a real wide document, not by reasoning.

### Column resize

Reported as "we can't adjust the column width, not sure if that would be needed." It is worth
building, and specifically *because* of the estimate above: a heuristic that is wrong 5% of the time
is fine when the user can drag; it is a permanent annoyance when they can't.

Drag the header's right edge, persist per `nameId` for the session, and let an explicitly-set width
win over the derived one. Double-click on the edge resets to derived — the convention every
spreadsheet uses, and it also gives "fit this column to its content" for free.

**Sequence: derived widths first, resize second.** The derived widths fix the reported complaint on
their own; resize without them still leaves every column starting at the wrong size.

---

## R44 — the horizontal scrollbar overlaps content at both edges

Two separate overlaps, both confirmed by the geometry above.

### 44a. It runs underneath the pinned columns

`.scrollbar-track-horizontal` is `left: 0; right: 0`, so it spans the whole viewport — including the
56 px row-header column and any pinned columns, which are `position: sticky` with `z-index: 1` and
therefore paint **over** it. The scrollbar is not hidden by accident; it is drawn and then covered.

**Fix: the horizontal track starts where the scrollable content starts** — after the row header plus
`stickyWidth`. That is the same offset `bodyLeft` already computes for the virtualized cells, so the
number exists; it needs handing to the `Scrollbar`. This is what a frozen-pane spreadsheet does, and
it is also more truthful: the track represents the range that actually scrolls, and the pinned
columns do not.

`Scrollbar` currently has no way to express "inset the horizontal track" — adding one is the real
work here, and it should be a prop with a stated meaning, not a grid-specific stylesheet override.

### 44b. It covers the last row

`.grid-scroll` reserves a 15 px gutter on the right (`margin-right`, added by R33's addendum for
exactly this) and **nothing at the bottom**. So the vertical track sits beside the content and the
horizontal track sits on top of it, hiding the final row when scrolled to the end.

**Fix: `margin-bottom: var(--scrubber-width)` when the horizontal track is present**, mirroring what
`margin-right` already does. Note the condition — the gutter should not be reserved when the table
doesn't scroll horizontally, or every narrow table loses 15 px for nothing. `Scrollbar` already
knows whether it renders each axis; the grid needs to know the same thing.

**Answering the question in the report:** the vertical scrollbar does **not** have this problem —
`margin-right: 15px` is already there. It was the same defect and R33's addendum 1 fixed it on that
axis only.

---

## R44 — Results

Built as scoped, both halves. **44a**: `Scrollbar` gained `horizontalInset?: number` (default `0`,
every non-Grid caller unaffected), applied as an inline `left` on the horizontal track — a stated
prop, not a Grid-specific stylesheet override, per the plan's own instruction. `Grid.tsx` passes its
existing `bodyLeft` (row header plus sticky width, the same number the virtualized cells already use)
straight through; the track's own `getBoundingClientRect()` then reflects the inset automatically, so
none of the thumb-drag/track-click math in `ScrollbarTrack` needed to change — both already compute
percentages from the track element's own measured rect, not from an assumed full-viewport width.

**44b**: `Grid.tsx` now computes `hasHorizontalOverflow` (`totalWidth > viewportWidth`, the same
comparison `Scrollbar` makes internally to decide whether to render the track at all, duplicated
rather than exposed — `Scrollbar` has no API to ask it "are you showing," and adding one for a
single caller felt like more surface than the question warranted) and adds a
`grid-scroll-has-horizontal-track` class conditionally; `Grid.css` reserves the bottom gutter only
under that class, matching `margin-right`'s unconditional shape but gated, per the plan's own
"a narrow table should not lose 15px for nothing."

New coverage: `test/grid.test.tsx`'s `Grid scrollbar geometry (R44)` block, real Chromium —
the horizontal track's measured left edge past the row header (44a), and the bottom margin present
only when a wide document actually overflows and absent for a narrow one (44b).

---

## R45 — the wheel does nothing over a horizontal track

```ts
function onWheel(event: ReactWheelEvent<HTMLDivElement>): void {
  scrollBy(vertical ? event.deltaY : event.deltaX)     // Scrollbar.tsx
}
```

Over a **horizontal** track this reads `deltaX`, which is `0` for an ordinary mouse wheel — so
pointing at the horizontal scrollbar and scrolling does nothing at all.

**Fix: `event.deltaX !== 0 ? event.deltaX : event.deltaY`** for the horizontal axis. This is the
idiom `TabStrip.tsx`'s own `onWheel` already uses (R36 §3c), for the same reason; the third copy is
the point at which it should be one shared helper rather than three.

This is not grid-specific — it fixes every horizontal track in the app, of which the grid's is
currently the only one.

---

## R45 — Results

Built as scoped. `horizontalWheelDelta` (`src/renderer/wheelDelta.ts`) is the shared function —
`TabStrip.tsx`'s own `onWheel` now calls it too instead of carrying its own copy of the same
ternary, so this is the one place either changes going forward. `Scrollbar.tsx`'s horizontal branch
calls it in place of the bare `event.deltaX`.

New coverage: `test/wheelDelta.test.ts` (the function itself — deltaX wins when non-zero, deltaY is
the fallback, both-zero stays zero) and a real-Chromium regression guard in `test/grid.test.tsx`'s
`Grid scrollbar geometry` block, dispatching a `deltaY`-only `WheelEvent` at the horizontal track and
asserting `scrollLeft` actually moved — the exact case that did nothing before this fix.

---

## R46 — dragging the vertical thumb runs at ~30 fps

**Measured, not impressionistic:** across a 60-step thumb drag, median frame 17 ms but **p90 33 ms**
— roughly every other frame missed, which is exactly the "lacks a bit" in the report. 31 rows and 10
columns were live.

**The cause was not measured. Do not fix it before it is.** What follows is a lead, not a diagnosis.

The strongest candidate is in `Scrollbar.tsx`:

```ts
const update = (): void => setMetrics(readMetrics(el))
...
const mutationObserver = new MutationObserver(update)
mutationObserver.observe(el, { childList: true, subtree: true })
```

`readMetrics` reads `scrollHeight`/`clientHeight`/`scrollWidth`/`clientWidth` — a forced synchronous
layout. The observer fires on **every** DOM mutation in the subtree, and virtualization mounts and
unmounts every visible row and cell on every scroll frame. So each frame plausibly runs: React
mutates the DOM → observer fires → layout is forced → state updates → render. The grid is the pane
that mutates the most DOM per frame, which fits the symptom being reported there and not elsewhere.

The observer exists for a real reason, stated in its own comment (virtualization changes
`scrollHeight` without resizing the element), so **the fix is to coalesce it, not remove it** —
one read per animation frame rather than one per mutation batch.

Other candidates worth eliminating in the same profile, in order of suspicion: `cellOf` per visible
cell per frame (R34 measured it as O(row fan-out)); the sticky row-header and pinned cells
re-rendering outside the virtualizer; and `Scrollbar`'s own per-scroll re-render, which is expected
and probably innocent.

**Acceptance is the number, not the change:** p90 frame time during a thumb drag on the same fixture
and window size, compared against the 33 ms above.

---

## R46 — Results

**The stated acceptance criterion — p90 frame time on the original fixture and window size — was not
met, and is flagged rather than quietly substituted.** This environment has no display and no real
Electron window; a headless Chromium instance with no compositor/vsync cannot produce a frame-time
number that means what the original 33 ms measurement meant. Building the fix without a way to
confirm it was the explicit risk the plan's own "do not fix it before it is measured" warned against.

**What was measured instead, and why it's still evidence, not a substitute:** the coalescing fix's
own mechanism is "fewer forced-layout reads per frame" — that part *is* measurable headless, by
counting calls to the `scrollHeight` getter `readMetrics` reads through (spied directly, not via
React re-render counts, which React 18's own automatic batching would coalesce regardless of this
fix and so can't tell the two apart). `test/scrollbarCoalescing.test.tsx` simulates six frames, each
with one `scrollTop` write plus two DOM mutations — one `pointermove`-equivalent, each with a virtual
row mounting and unmounting under it, the shape the plan's own lead names. Before the fix: **13**
forced-layout reads for those six frames (each source read independently). After: **6 or fewer** —
never more than one per frame regardless of how many of the three observers fired in it. This
confirms the fix's *mechanism* holds; it does not confirm this mechanism was the dominant cost of the
original 33 ms, which remains unverified.

**Built anyway, on balance**, for three reasons stated rather than assumed: the lead is specific and
plausible (a forced synchronous layout, on the pane that mutates the most DOM per frame, is a
textbook layout-thrashing shape); the fix is strictly an improvement in the dimension it targets
(fewer forced-layout reads never costs more, and the `requestAnimationFrame` coalescing changes
nothing observable — same events, same final `metrics` value, just batched); and the plan's own
"other candidates" (`cellOf` per cell, sticky-cell re-rendering) are each a larger, riskier change
this round didn't attempt. **If a real Electron measurement later shows the p90 unchanged, the
conclusion is that this lead was not the dominant cost — not that the fix was wrong to make**, and
the remaining candidates are exactly where to look next.

## R43 continued — should the table's height be fixed at all? (the report's open question)

`.detail-grid-container { height: 480px }` is fixed. It neither grows into a tall pane nor shrinks
into a short one, which produces the awkwardness described: on a small window the 480 px table
forces `.detail` itself to scroll, so there are **two nested vertical scrollbars**, and the one you
grab first is usually the wrong one.

**Recommendation: make it flexible, with a floor.** `flex: 1` within the Detail pane's column, plus
a `min-height` of roughly eight rows plus the header. Then:

- on a tall pane (or with Raw hidden) the table uses the space instead of leaving a gap below it;
- on a short one it shrinks, and the outer pane only starts scrolling once the floor is hit — so the
  common case has **one** scrollbar, not two, which is most of what makes scrolling around easier;
- R33 §1a's nested-scroll work stays necessary but stops being load-bearing for ordinary window
  sizes.

The floor is what keeps this honest: without one, a short window plus a long Attributes section
leaves a two-row table, which is worse than today. **Pick the floor against a real document at a
small window size.**

One consequence to state rather than discover: the table's height becoming variable means the row
virtualizer's viewport changes on every pane resize, so the resize path gets exercised far more than
it is today. That is a correctness question (does the virtualizer recompute cleanly?), not a
performance one, and it deserves a test at a couple of pane heights.

---

## R43 — Results

Built substantially as scoped. `gridColumnWidth.ts`'s `sampleColumnStats` is the one-pass answer to
both "is this numeric" and "how wide by default" the plan asked for, reusing `isNumericColumn`'s own
`NUMERIC_SCAN_LIMIT`/sample-until-decided loop rather than a second scan — but **the two samples
are deliberately different sizes**, found necessary in review rather than planned: `isNumericColumn`
exits after exactly one non-numeric value, so a first draft that used the *same* 200-value sample for
width reproduced M2's own "more than half the grid's time to first paint" cost for every non-numeric
column (measured live: R30's tab-switch benchmark went from 63 ms to 6.8 s wall time on a 30,000-row
fixture). `WIDTH_SAMPLE_SIZE = 24`, independent of `NUMERIC_SAMPLE_SIZE`, is what keeps the new scan
from costing more than the old one on exactly the columns — text — that `CELL_WIDTH = 160` mattered
most for.

**Column resize landed as planned**: drag the header's right edge (`window`-level pointer listeners,
the same shape `Scrollbar.tsx`'s own thumb drag already uses, not `setPointerCapture` as first
written — consistency with the one other drag gesture in the codebase, and one fewer dependency on
a synthetic pointer id being a real captured pointer in a test environment), double-click resets to
derived. Persisted per `nameId` for this `Grid` instance's own lifetime, reset alongside the stats
cache whenever the document or the grouped members change.

**The virtualizer-cache risk flagged in the plan is real and was hit, not just anticipated.**
`@tanstack/virtual-core`'s `estimateSize` is only consulted for an index it hasn't already measured
— a changing `estimateSize` function identity does not, by itself, invalidate a size already
computed. `colVirtualizer.measure()` (the library's own escape hatch) is called from a `useEffect`
keyed on `columnWidth`'s own identity, forcing every visible column to re-ask on a resize or a new
document's derived widths. Verified in `test/grid.test.tsx`'s new resize test, not just assumed.

**The height change reproduced the exact hazard the plan's own closing paragraph named**: "the row
virtualizer's viewport changes on every pane resize... deserves a test at a couple of pane heights."
`test/tabSwitchMeasurement.test.tsx`'s R30 benchmark — which renders `DetailContent` with no explicit
ancestor height, because `.detail-grid-container`'s old fixed `height: 480px` never needed one — went
from 63 ms to ~3 s per tab switch once the container became `flex: 1`. Root cause: `flex: 1` against
an *indefinite* ancestor height has nothing to distribute against and falls back to content-based
sizing, so the row virtualizer's own "viewport" ends up sized by its content instead of bounding it —
the classic auto-height-virtualizer trap. Not a NodePad bug: `Layout.tsx`'s real `PaneShell` always
gives Detail a genuine flexed height ("Detail always takes the remainder"), so this never manifests
in the app itself. Fixed at the test, matching the explicit-height wrapper the same file already gives
Raw for the identical reason — and left as a documented lesson here rather than only in the diff: any
future caller of `DetailContent`/`Grid` that skips giving it a real ancestor height inherits this same
trap.

**Floor picked, not measured**: `min-height: 230px` on `.detail-grid-container` (≈8 rows at
`ROW_HEIGHT = 23` plus a header row) — this environment has no display to pick it against a real
document at a small window size, exactly the caveat the plan itself flagged. `test/detailGrid.test.tsx`
verifies the floor holds and that a short pane produces exactly one scrolling ancestor (`.detail`),
not two, but not that 230px is the *right* number for real use — flag before revising it by feel
alone.

New tests: `test/gridColumnWidth.test.ts` (pure `sampleColumnStats`/`defaultColumnWidthPx` logic),
`test/grid.test.tsx`'s new `Grid column widths (R43)` block (content-derived width comparison, drag
resize, double-click reset — real Chromium), `test/detailGrid.test.tsx` (the height/floor/single-
scrollbar behavior). `test/grid.test.tsx`'s existing R34 §3 caching regression guard was retargeted
from `isNumericColumn` to `sampleColumnStats`, the call `Grid.tsx` actually makes now.
