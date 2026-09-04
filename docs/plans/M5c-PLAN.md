# M5c — Raw scroll performance, scrollbar consistency, and Tree/Detail polish

<!-- status: built -->

**Status: built.** Tasks **J1–J9** (`docs/plans/M5c-RESULTS.md`); J9's in-app pass unmeasured. Source: the project lead's own list, seven items found using the app after M5b (verbatim in the appendix below)
landed. This is the third UI round (M2b was the first, M5b the second, tracked in
`docs/plans/UI-FEEDBACK.md`); it gets its own plan document because J1 is a measured performance
regression with a real design behind its fix, not a polish item.

Task ids are **J1–J9** (M5 used H, M4 G, M3 F, M2 E, M1 D, M0 B).

**Do J1 first.** It is a regression that makes the Raw view unusable at scale, and J2/J3/J4
all touch the same code. Nothing else in this plan is blocked by anything else.

---

## 1. What was actually found

### 1.1 The scrolling regression is measured, and its cause is not the scrollbar

The appendix's first item reads as one complaint ("scrolling is not smooth… the Raw view
is empty… it was much better before with the scroll bar") but it is two separate costs, both
introduced in M5b, neither of them caused by hiding the scrollbar.

**Cause A — `rawDecorations.ts` converts offsets in O(window) per mark.**
`buildDecorationSet` runs on **every viewport change** — every scroll that shifts CodeMirror's
rendered range. Since `30f1737` (the byte↔UTF-16 fix) each decoration mark costs *two* calls
to `byteOffsetToLocalUnits`, which walks the window's text one code point at a time from
position 0. It is O(distance into the window) per mark, called O(marks) times per rebuild.

Measured on a ~1 MB window of realistic XML with ~240 marks in view (`spike/`-shaped fixture,
`node` on this machine):

| Viewport sits at… | Cost of one `buildDecorationSet` |
|---|---:|
| 10% into the window | **313 ms** |
| 50% into the window | **1 368 ms** |
| 90% into the window | **2 479 ms** |

That is the "the Raw view is empty and it takes a bit to render it" report exactly: a viewport
change blocking the main thread for a large fraction of a second while decorations rebuild,
and getting *worse* the deeper into the window you scroll — which is why it feels like it
degrades as you keep going.

The same function also calls `localUnitsToByteOffset(text, docLength)` once per rebuild, a
full 1 MB `TextEncoder.encode` at **1.84 ms**, and `view.state.doc.toString()`, materializing
the whole window as a fresh string.

**Cause B — `publishViewport` runs on every `scroll` event and re-encodes the window twice.**
`c2fae60` added the scrubber thumb's Raw→Scrubber channel. `absTopOffset` and
`absBottomOffset` each do `doc.toString()` plus `localUnitsToByteOffset`, which is
`text.slice(0, units)` followed by `TextEncoder.encode`:

| Work | Cost |
|---|---:|
| one conversion at 10% into the window | 0.24 ms |
| one conversion at 50% | 0.94 ms |
| one conversion at 90% | 1.73 ms |
| one `publishViewport` (top + bottom, mid-window) | **2.38 ms** |
| plus `shouldRecenter`'s own third `absTopOffset` | **3.06 ms** |

…before counting the two `doc.toString()` calls. At 60 scroll events per second this alone
eats a third to a half of the frame budget, and it too grows with scroll depth.

**Both causes are the same mistake**: an O(n) conversion dropped into a place that used to be
O(1), then called from a hot loop. `30f1737` was a correctness fix and is right to keep — the
byte/UTF-16 axes really are different, and the drift on non-ASCII content is real (up to
480 000 bytes at the end of a CJK window). What it lacks is a data structure. J1 supplies one.

**Note for the record.** This is the fourth time in this project a component was reasoned
about in isolation and the pipeline around it was not (M0's row-index pre-scan claim, M2's
`isNumericColumn`, D-036's splice figure, now this). The difference here is that the cost was
introduced by a review fix rather than found by one. `CLAUDE.md` already flags the pattern;
J9 adds the check that would have caught it.

### 1.2 Everything else

| Source item | Cause found | Task |
|---|---|---|
| 1 — scrolling not smooth, empty view | §1.1 above | J1, J2, J3 |
| 2 — scrollbar inconsistency across panes | Raw hides its native scrollbar (`c2fae60`); Tree/Detail/Grid use the platform's | J4 |
| 3 — children list: full width, no headers, constant "Element" column | `.detail-child-row` is a full-width flex row with fixed percentage columns and no `<thead>`; the kind column is `kindLabelOf`, genuinely constant for XML | J5 |
| 4 — no Collapse All; scope is the whole document | Only `nodepad.tree.expandAll` exists, and `expandAll(store, ROOT)` is document-wide | J6 |
| 5 — Tree root is `Document` | `Tree.tsx`'s `ROOT: NodeRef = 0` | **closed, no change** — see §2 |
| 6 — title bar icon renders poorly | `src/main/index.ts:5` passes `icons/256.png`; Windows resamples a 256 px gradient tile to 16 px | J7 |
| 7 — open progress shown by the Open button | `DocumentStatus` lives in the command bar and renders every phase there | J8 |

**On item 3's own question** — "is the always-`Element` column because of our example file?"
For XML, no: every element child renders `Element`, and only `Text` / `Comment` / `CData`
children differ, which a well-formed document has few of. For JSON it genuinely varies
(`Property` / `Object` / `Array` / `Scalar`). So the column is near-constant clutter for XML
and load-bearing for JSON. J5 makes it conditional rather than deleting it.

---

## 2. Decisions taken with the project lead

Four questions were put; all four are answered. Each gets a `DECISIONS.md` entry in the commit
that implements it, not before.

- **D-051 — one scrollbar look across every pane** (issues 1+2). The VSCode answer: a single
  overlay scrollbar component used by Tree, Detail, the Grid and Raw, with Raw's being the
  scrubber plus its marker layer. Chosen over "scrubber only" and over restoring CodeMirror's
  native scrollbar. The native scrollbar was *not* restored, and the reason is worth keeping:
  it describes the ~1 MB window, not the document, so its thumb is always near-full-size and
  it jumps whenever a re-slice changes `scrollHeight`. It felt better because it was not
  stuttering, which is J1's problem, not the scrollbar's. → **J4**
- **D-052 — Expand All / Collapse All act on the selected node's subtree**, falling back to
  the root when nothing is selected. Matches the Windows Explorer `*` convention `Tree.tsx`
  already binds, and makes `EXPAND_ALL_LIMIT`'s truncation notice rare instead of routine.
  → **J6**
- **D-053 — the Tree keeps its `Document` root row.** Considered and deliberately kept, so it
  isn't re-proposed cold: it costs one row and one click, and it earns them as the single
  collapse-everything handle and as the place document-level facts hang. Rendering the top
  level as a forest was the alternative. **No task** — recorded only.
- **D-054 — the title bar icon comes from the `.ico`, whose small frames are redrawn from
  `mark-16.svg`.** The bare monogram at 16/24/32, per `assets/README.md` §Title bar's own "the
  bare mark, never the tile." A frameless window with NodePad-drawn chrome — what that section
  actually assumes, and the only way to get the theme-token colour it specifies — was the
  alternative and is not being built now. → **J7**

---

## 3. Tasks

### J1 — A per-window offset map; remove O(n) conversion from every hot path

**The fix.** Build the unit↔byte correspondence **once per window slice** instead of deriving
it per call. New module `src/renderer/components/Raw/rawOffsetMap.ts`:

```
interface RawOffsetMap {
  readonly ascii: boolean          // units === bytes; both conversions are identity
  toBytes(localUnits: number): number
  toUnits(localBytes: number): number
}
buildOffsetMap(text: string, encoding: string): RawOffsetMap
```

Three cases, in the order they should be tested:

1. **ASCII fast path.** Detect it from the window's *bytes* — `sourceBuffer.bytes` has them
   already, so this is one scan for any byte ≥ 0x80, no decode. When clean, both conversions
   are the identity and the map holds nothing. **Every fixture this project owns takes this
   path**, which is exactly why the bug was invisible for five milestones — and why the fast
   path must not be the only thing that works.
2. **UTF-16LE/BE.** Already a division; keep `rawOffsets.ts`'s existing arithmetic.
3. **Everything else (the real UTF-8 case).** Checkpoints every `K = 1024` code units: an
   `Int32Array` of byte offsets, ~1 000 entries for a 1 MB window, ~4 KB. `toBytes` is an
   index plus a walk of ≤ K units; `toUnits` is a binary search plus the same bounded walk.
   Build cost is one pass over the window (~2 ms), paid once per re-slice rather than three
   times per scroll event.

`Int32Array`, not `number[]` — hard rule 2, and the shape `D-042` records `evaluate.ts` as
still owing.

**Ownership and invalidation.** The map hangs off `WindowHandle` alongside `start`/`end`,
built in `applyReslice` and in the mount effect, and reached by the extensions through the
same `() => handleRef.current` accessor they already use for `getWindowStart`. It is
invalidated by exactly the two things that change the window text: a re-slice, and a document
change. Cache the decoded window text on the handle in the same place, so `doc.toString()`
stops being called per rebuild.

A keystroke invalidates the map. Rebuilding it costs one ASCII scan (~0.3 ms) or one
checkpoint pass (~2 ms) per keystroke, which is acceptable and measurable; an incremental
patch of the checkpoints is a possible follow-up, **not** part of J1.

**Sites to route through it** — all six, not the four `30f1737` listed:

| Site | Currently |
|---|---|
| `rawDecorations.ts` `buildDecorationSet` | 3 × `localUnitsToByteOffset` + 2 per mark |
| `Raw.tsx` `absTopOffset` / `absBottomOffset` | 1 each, per scroll event |
| `Raw.tsx` `jumpTo` | 1 `byteOffsetToLocalUnits` |
| `rawCaretSync.ts` | 1 per selection change, with its own `doc.toString()` |
| `rawEdit.ts` | 4, against `startState`'s text — **needs its own pre-change map**, since it deliberately measures against the text *before* the transaction |
| `rawGutter.ts` | none (rank query over the row index) — listed to record that it was checked |

`rawEdit.ts` is the one that cannot simply take the handle's map: its correctness depends on
using the *prior* text. Either build a throwaway map from `update.startState.doc` there, or
keep the handle's map one transaction behind on purpose — **the throwaway is the right call**;
it runs once per transaction, not per mark, and getting `rawEdit` subtly wrong reintroduces
the exact bug `a657235` fixed.

`rawOffsets.ts`'s two functions stay as the reference implementation and the map's oracle in
tests; they should no longer be called from any per-frame path.

**Acceptance.**
- A property test: for a window of mixed ASCII / accented Latin / CJK / emoji / a lone
  surrogate, `map.toBytes(map.toUnits(b)) === b` at every character boundary, and both agree
  with `rawOffsets.ts`'s straightforward implementations at 1 000 random offsets.
- The non-ASCII drift case gets a real fixture — the suite still has **no non-ASCII Raw
  fixture**, flagged in M5b and still true.
- `buildDecorationSet` at 90% into a 1 MB window: **under 5 ms**, from 2 479 ms.
- One conversion: **under 0.01 ms**, from up to 1.73 ms.

### J2 — Stop doing per-scroll work per scroll event

With J1 in place a conversion is nearly free, but the structure is still wrong: `onScroll`
computes `absTopOffset` twice (once inside `publishViewport`, once for `shouldRecenter`), and
`scroll` can fire several times per frame.

- Compute the top offset once per handler and pass it to both.
- Coalesce `onScroll`'s body behind a `requestAnimationFrame`, one pending frame at a time —
  the same "collapse a burst into one unit of work" shape `rawViewportStore.ts`'s `quantize`
  already applies one layer further down.
- Keep `rawViewportStore`'s quantization; it is doing its job and is not implicated in §1.1.

**Acceptance.** A synthetic burst of 20 `scroll` events within one frame produces exactly one
recentre check and one viewport publish.

### J3 — The re-slice must not blank the view

`applyReslice` calls `reevaluateWrap` unconditionally, which **turns wrap off, forces a
synchronous layout by reading `scrollHeight`, and then possibly turns it back on a frame
later at A6b's measured ~400 ms**. On a document that needs wrap this happens at every window
crossing; on one that doesn't, it still costs a forced layout per crossing.

- Only re-evaluate wrap when the window's *shape* could have changed the answer. A re-slice
  moves the window over content of the same kind; the interesting transition is
  minified↔not-minified, which `hasMeaningfulLines` already answers for the document as a
  whole. Re-evaluate on mount and on document change; skip on a plain scroll-driven re-slice
  unless the current wrap state and `needsWrapToScroll` actually disagree.
- Measure the crossing end to end before and after, and record both. §1.1's numbers cover the
  decoration rebuild; the re-slice's own cost has never been measured in the live app, only in
  the M1 spike.

**Acceptance.** Crossing a window boundary by scrolling shows no blank frame and no visible
pause at 200 MB. If a pause remains after J1 and this change, it is measured and reported
rather than smoothed over.

### J4 — One scrollbar look across every pane (D-051)

New `src/renderer/components/Scrollbar/` — an overlay scrollbar component, styled from
semantic tokens (invariant 9), used by:

- **Tree** and **Detail's children list** — both already scroll containers with
  `overflow: auto`.
- **The Grid** — both axes.
- **Raw** — the scrubber *is* Raw's scrollbar, so it does not adopt the component; it adopts
  the component's **visual language** (same width, same thumb shape, same hover/active
  treatment) and keeps its marker layer on top.

The scrubber also gains the scrollbar behaviours it is missing, which is most of what makes it
not read as one today:

- **Wheel over the strip** scrolls the Raw view, rather than doing nothing.
- **Click on the track** pages up/down by a viewport, rather than jumping to that ratio.
  Dragging the *thumb* keeps today's continuous ratio-scrub — those are different gestures and
  a real scrollbar distinguishes them.
- **Hover and active states** on the thumb.

Constraints worth stating up front:

- Do not reimplement scrolling. The component draws a thumb over a natively-scrolling element
  and drives `scrollTop`/`scrollLeft`; the pane keeps `overflow: auto` with the native bar
  hidden, exactly as `Raw.css` already does.
- It must not assume it can read a meaningful `scrollHeight` — that is precisely what the
  scrubber exists to avoid, and why Raw uses the scrubber rather than this component.
- Keyboard and ARIA: the panes remain the focusable, keyboard-scrollable things. The
  scrollbar is `aria-hidden` decoration over them. The scrubber keeps its own `role="slider"`,
  which it has and which is correct for a control you drag directly.

**Acceptance.** All four panes show the same scrollbar at the same width in both themes; no
pane shows a platform scrollbar; the token-only rule passes stylelint; the scrubber responds
to wheel and to track clicks.

### J5 — The children list becomes a proper table

Three changes to `Detail.tsx`'s `ChildrenList` and `Detail.css`:

**Width — shrink to fit, like Attributes.** `.detail-facets-table` is `width: auto;
min-width: min(240px, 100%); max-width: 100%`, and that is the target behaviour. The list
cannot literally become a `<table>`: it is virtualized, absolutely positioned, and its parent
is a 2-million-child node in the normal case. Instead derive column widths from a **bounded
sample** — the first 200 children — measuring label, kind and preview text length, converting
to `ch`, clamping each column to a maximum, and giving the container `width: max-content;
max-width: 100%`. A sample can be wrong for a later row; that row ellipsizes, which is what
today's fixed percentages do to every row.

This is the first content-derived column width in the codebase — the Grid uses a fixed
`CELL_WIDTH`. Keep the sampling logic in `detailModel.ts` (pure, testable) rather than in the
component, following every other `*Model.ts` in the tree.

**Headings.** A sticky header row above the virtualized body, matching
`.detail-facets-table thead`'s treatment (secondary colour, weight 400, same border). Columns:
Name, Kind (conditional, below), Value, Children.

**The kind column becomes conditional.** Render it only when the sampled children have more
than one distinct `NodeKind`. For XML that hides it; for JSON and for mixed content
(element + comment + text) it appears. The glyph carries the kind either way and gains a
`title`/`aria-label` so the information is never actually lost — the same "moved, not lost"
rule `Layout.tsx`'s `tooltipFor` follows for icon-only buttons.

**Acceptance.** For `cars-*.xml`, the children section is as narrow as its content and shows
Name / Value / Children. For a JSON document with mixed children, the Kind column appears.
Sampling is tested directly on `detailModel`, not through the DOM.

### J6 — Collapse All, and both scoped to the selection (D-052)

- `treeModel.ts` gains `collapseSubtree(store, root)` beside `expandAll`, with the same
  breadth-first bounded walk (`EXPAND_ALL_LIMIT` bounds the *queue*, not just the result —
  keep that property).
- Both commands take the scope node: the current selection, or `ROOT` when there is none.
  `expandAll(store, ROOT)` remains reachable — selecting Document and expanding is exactly
  today's behaviour, which is the argument for D-053 keeping that row.
- `nodepad.tree.collapseAll` registered in `Tree/commands.ts` with `surfaces: ['palette',
  'paneHeader']`, mirroring `expandAll` — invariant 10 is enforced by test, so a missing
  palette entry fails the suite rather than shipping.
- The `*` key keeps expanding, now scoped. Add no new key binding; `-` is tempting and is a
  different convention on every platform.
- Update both titles so the scope is visible: "Expand Subtree" / "Collapse Subtree" when
  something is selected. If that turns out to need context-dependent titles the registry
  doesn't support, keep the static titles and say so — do not add a registry feature for a
  label.
- The truncation notice's wording still says "the rest stayed collapsed," which is right for
  either scope.

**Acceptance.** Collapse All on a selected node collapses that subtree and leaves the rest
alone; the palette-parity test passes; the existing `expandAll` tests still pass unmodified.

### J7 — Title bar icon (D-054)

- `src/main/index.ts:5` imports `../../assets/build/icons/256.png?asset`. Pass
  `assets/build/icon.ico` on Windows instead, so the OS picks a purpose-drawn frame rather
  than resampling a 256 px gradient tile.
- ~~Regenerate the `.ico`'s 16/24/32 frames from `assets/mark-16.svg`~~ — **reverted, D-054b.**
  Windows picks an `.ico` frame by pixel size, not by which surface is asking, and a 48px split
  cuts through the range the *taskbar* uses: the same build showed a bare mark in the taskbar
  at 100% scaling and the tile at 150%. Every frame is `icon.svg` again.
- ~~**Note the side effect rather than discovering it later**: the Windows taskbar at small
  sizes also becomes the bare mark. That is judged an improvement.~~ — the side effect was
  correctly predicted here and **the judgement was wrong**, reported from the running app. Worth
  keeping visible: naming a consequence in a plan is not the same as having evaluated it.
- What actually fixed the blur this task was written for was **rendering each frame at its own
  size** instead of resampling one 256px tile — D-054a's `append_images` fix, not the change of
  source. The tile is legible at 16/24/32 when rendered natively.
- ~~Python is not installed on the current dev machine~~ — **done, see D-054a and
  `M5c-RESULTS.md` §J7.** The generator now runs via `uv run --with resvg-py --with pillow
  tools/generate.py`; `cairosvg` was unusable on Windows at any point (no pip-installable
  libcairo), which is the actual reason these assets went a milestone without being generated.
  Two silent generator bugs were fixed in the same pass — wrong output directory, and an
  `.ico` written by resampling one image into every frame.
- ~~The OS-facing mark is `#A9701E`~~ — moot under D-054b; no OS raster contains the bare mark.
  The measurement stays in `assets/README.md` as reference.

**Acceptance — met, then corrected.** The app was run: the title bar icon was crisp (the point
of the task), and the *taskbar* was wrong, which is what D-054b fixes. Re-verify the taskbar in
a GUI session. Note that M5d R1 removes the native title bar entirely, at which point this
task's original consumer no longer exists and the `.ico` serves only OS surfaces.

### J8 — Open progress moves into the document area

`DocumentStatus` renders every phase in the command bar, so "Opening file.xml… 43%" appears as
small text beside the Open button while the main area shows "No document open." The project
lead's own preference — the main window, before the views render — is the better of the two
they named, and is what this builds.

- `Layout` already swaps the pane grid for `EmptyState` whenever the session isn't `ready`.
  Widen that: a phase-aware document area rendering `empty` (today's `EmptyState`),
  `confirmSize`, `parsing` (file name, percentage, a determinate progress bar, Cancel) and
  `error` — all centred, at a size that suits the whole window rather than a toolbar.
- The command bar keeps only what belongs to a *ready* document: the diagnostic banner, the
  minified banner, the pending-transform confirmation, "Open Another File…". It should no
  longer render `empty`/`parsing`/`confirmSize`/`error`.
- `DocumentStatus.tsx`'s module comment still describes itself as "minimal, temporary UI…
  deliberately not the Tree/Detail/Raw layout" from D6. That is no longer true of the file and
  becomes actively misleading once it is split — rewrite it.
- Keep `data-testid="document-status"` and `data-phase` reachable for whichever component ends
  up owning each phase; existing tests key off them.

**Acceptance.** Opening a 200 MB file shows a centred, legible progress state in the document
area with a working Cancel, and nothing about progress in the command bar. `cancel()` from
that surface still leaves no half-built state (D6's own criterion).

### J9 — Measurement and the check that would have caught J1

A short pass, not an M1-scale one.

1. **Raw scroll frame time, in the real app.** Scroll continuously through a 200 MB file with
   a `requestAnimationFrame` loop recording frame intervals; report median and the count over
   32 ms, the same shape `M1-RESULTS.md` §1 uses. Do this on **an ASCII fixture and a
   non-ASCII one** — the whole of §1.1 hides on ASCII in one direction and shows up on
   non-ASCII in the other.
   This is also `M2-RESULTS.md`'s own flagged gap ("grid and Tree scroll frame time need a
   real `requestAnimationFrame` loop driving real rendered React components"). J9 does not
   close it for the grid; it closes it for Raw, and says so.
2. **Window-crossing cost**, before and after J3.
3. **A regression guard for the J1 class of bug.** A test that asserts the *number* of
   `localUnitsToByteOffset`/`byteOffsetToLocalUnits` calls a decoration rebuild makes is O(1)
   in the mark count — a counting spy, not a timing assertion. A timing test is flaky; a call
   count is exactly the invariant that was broken and it fails deterministically.
4. Append the results to a new `docs/plans/M5c-RESULTS.md`, and correct §1.1's table if the live
   figures differ from the `node` harness — they will, and the harness numbers are a lower
   bound (no React, no CodeMirror, no layout).

---

## 4. Out of scope

Named so they are not quietly absorbed:

- **The five findings in `docs/plans/M4-RESULTS.md`'s second addendum** (the case-insensitive find
  path, `buildFilteredRows`' budget, the match-decoration look-back, `Interner.lookup`'s UTF-8
  encoding, `applyPredicate`'s decoded comparison). Still for the fine-tuning pass.
- **The flaky `documentSession.test.ts` burst-coalescing test.** Same.
- **The Grid's scroll frame time** (`M2-RESULTS.md`'s gap) beyond J4's visual change.
- **A frameless window and NodePad-drawn title bar.** D-054's rejected alternative.
- **Rendering the Tree's top level as a forest.** D-053, closed.
- **Incremental patching of J1's checkpoint array on edit.** A follow-up if the per-keystroke
  rebuild ever measures badly; it currently has no evidence behind it.

---

## 5. Order

J1 → J2 → J3 (all Raw, same files, strictly in this order) → J9's first measurement, to
confirm the regression is actually gone before building on top of it → then J4, J5, J6, J7, J8
in any order → J9's remainder.

If J1's acceptance figures are not met, **stop and report** rather than continuing to J4. The
scrollbar work is cosmetic; a Raw view that stutters is not shippable, and the plan's own §1.1
is the standard it has to clear.

---

## Appendix — the source list, verbatim (`docs/issues.md`, retired)

These are the project lead's own notes as written, kept here because this plan is what
triaged them and because four `DECISIONS.md` entries quote them by name. The file itself was
deleted when `docs/` was restructured — it was a scratch list, and every item below is
accounted for in the table above or in `docs/plans/M5c-RESULTS.md`.

* After the latest adjustments of the stutter in Raw View, scrolling is not smooth anymore. Even for the 10m cars file. Also, when scrolling a lot (potentially beyond the 1MB window), the Raw view is empty and it takes a bit to render it. This must be improved to reach a shippable product. Also, it was much better before with the scroll bar.
* Along the same lines with the scroll bar, we now have systm scroll bars in tree and detail view but the stutter in raw view. VSCode solves this by having the same stutter-like scroll bar verywhere. Should we also consider this for UI consistency?
* For a single element with child elements (e.g. a single `car`), we now always render children as a list. I'd like to adjust that rendering a bit:
  * Width of this list-like table is the whole window but it should be similar to the "Attributes" section collapse to a minium column width and expand when needed.
  * We should have column headings there, similar to the "Attributes" section.
  * There is a column that is always "Element". Is that because of our example file or will it always be that? Because in that case it is useless UI clutter. The little icon (or `<>`) before the name of the element in that list should already indicate that this is an element.
* In Tree view, we have an "expand all" button, we should also have an "collapse all" button. And should we only expand / collapse all sub-nodes of the currently selected node, instead of all nodes in the document?
* In Tree view, the root node is the "Document". Do we need that? We could just start with `garage`. And if there are multiple elements on the root level, then they are just rendered below each other, no need for a single root node like `Document`, no?
* The icon in the title-bar renders not so nicely. Didn't we have a simpler version of the icon (even monochrome) to be used in the titlebar? At least we should consider using only the N, without the square around it.
* Opening a file shows the progress in above the "Open file button". We should show that elsewhere, e.g. in the statusbar. Or in the main window before all the views are rendered. Maybe the latter is the best idea.
