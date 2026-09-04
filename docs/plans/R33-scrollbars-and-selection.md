# R33 — scrollbars, and the selection that disagrees with the display

<!-- status: built-caveat -->

**Built — the thumb corner-radius artifact at `top: 0` (§3) found, not fixed.** Register:
`docs/TASKS.md`. Decision: `docs/DECISIONS.md` D-065.

Two unrelated corrections from using the app, grouped into one round because both are small and
both are visible on the first screen of the first file opened.

---

## 1. Scrollbars

**D-051 already decided this** — "one overlay scrollbar look across every pane (Tree, Detail, Grid,
Raw)", with `Scrollbar.tsx` as the shared component and the Scrubber adopting its visual language
rather than the component itself. Nothing below reopens that decision. All three complaints are
**the decision not being fully carried out**, plus one genuine open question it never settled.

### 1a. Detail's outer pane still has a native scrollbar — D-051 was half-applied

`Detail` has **two** scroll containers, and only the inner one was converted:

| Element | Where | State |
|---|---|---|
| `.detail` (the whole pane) | `Detail.css:6`, `overflow: auto` | **native scrollbar** — no `scrollbar-host`, no `<Scrollbar>` |
| `.detail-children-list` | `Detail.tsx:333`, `<Scrollbar>` at `:396` | correct |

Tree (`Tree.tsx:414`/`:449`) and Grid (`Grid.tsx:483`/`:556`) are both correct. Detail's outer pane
is the only native scrollbar left in the app.

**The one real design question**, which is why this is not a two-line fix: converting `.detail`
puts a custom scrollbar *inside* another custom scrollbar, since the children list scrolls within
the pane that scrolls. Nesting is unavoidable — the header, comment and attribute sections have to
scroll with the pane while the children list scrolls independently — so the work is making the two
not fight: wheel events over the inner list must not chain to the outer track, and dragging either
thumb must not move the other. **Verify with R10's real-Chromium tooling**, not by reasoning about
event order.

### 1b. The thumb is invisible in light mode because it uses a surface token

```css
.scrollbar-thumb { background: var(--elev-2-bg); }   /* Scrollbar.css:47 */
```

`light.css` maps `--elev-2-bg: var(--gray-0)` — the *lightest* surface in the palette — so the
thumb is near-white on a near-white pane. `dark.css` maps it to `--gray-700`, which is why dark
looks fine and light does not.

**The root cause is token semantics, not a colour value.** An elevation *surface* token is being
used as a *control* colour. Invariant 9 says semantic tokens only, and stylelint passes here —
this is a semantically wrong token that satisfies the rule, which is the failure mode worth naming:
the lint checks that a token is used, not that it means the right thing.

Fix: real control tokens — `--scrollbar-thumb-bg`, `--scrollbar-thumb-hover-bg`,
`--scrollbar-thumb-active-bg`, `--scrollbar-track-bg` — defined per theme against the pane
background they actually sit on, with a **stated minimum contrast ratio** in the token file so the
next person changing the palette knows what they must not break.

**`Scrubber.css:37` uses the same `--elev-2-bg` and must move to the same tokens**, or Raw and the
other three panes will drift apart again the first time either is touched. That is the whole point
of D-051.

### 1c. The track is invisible — the one thing D-051 genuinely left open

```css
.scrollbar-track { background: transparent; }   /* Scrollbar.css:22 */
```

Deliberate overlay styling (macOS/VS Code), and D-051 never said otherwise. The project lead's call
is that the track should be visible: **give it a faint but real background.**

Worth recording *why* rather than treating it as taste: in a three-pane tool, an invisible track
means you cannot tell whether a pane scrolls at all until you try. A visible track makes the
scrollable region discoverable, which matters more here than the few pixels of restraint an overlay
buys.

### 1d. The Scrubber stays Raw-only

Explicitly unchanged: Raw keeps the Scrubber and does **not** adopt `Scrollbar.tsx`. D-051's reason
still holds — Raw's ~1 MB window (D-031) has no meaningful `scrollHeight` to derive a thumb from,
which is the Scrubber's entire reason to exist. The scrubber's extra job — marking where search
results and diagnostics sit in the whole document — is Raw-only too.

What changes is only that it draws from the same tokens as 1b, so all four panes read as one
control set.

### Acceptance

**This is a contrast bug, so "looks right" is not acceptance.** Assert computed background colours
for track and thumb in **both themes** through the browser project (R10), and assert the
thumb-against-track contrast ratio meets whatever minimum 1b writes into the token file. A
screenshot proves nothing here — the defect shipped precisely because it looks fine in the theme
whoever last touched it was using.

---

## 2. The selection that disagrees with the display

### 2a. The real bug: the initial selection is the root, not what's on screen

`documentSession.ts:647` sets the initial selection to node 0 — the `Document` root:

```ts
const selectedNode = node ?? (result.store.nodeCount > 0 ? 0 : NO_SELECTION)
```

The Detail view then independently descends through transparent wrappers to `elements` and renders
*that*. So on `cars-10mb.xml` the Tree highlights `Document` while every other pane shows
`elements`. Nothing is wrong with either half; they simply never agreed on who decides.

**Fix: the initial selection is the descent destination** —
`resolveWrapperTarget(store, root).destination` — so Tree, Detail, the breadcrumb and Raw all agree
from the first frame, and the click the descent was saving stays saved.

Three consequences to handle rather than discover:

- **Layering.** `transparentWrapper.ts` lives under `components/Detail/`, and `documentSession.ts`
  is not a component. It is pure logic with no React (its own header says so), so moving it
  somewhere neutral is the clean answer — but that is a real relocation with imports in `Tree.tsx`
  and `Detail.tsx` to update. **Report if it turns out to need more than moving a file.**
- **The caret moves too.** R8f made selection move the caret to the node's span start, so a deeper
  initial selection means Raw opens scrolled to `elements` rather than byte 0. That is arguably
  better — it matches what the other panes show — but it is a behaviour change and should be
  stated, not slipped in.
- **F5's re-resolution already runs this path.** `applyReparseResult` re-resolves selection after
  every reparse; check the initial-open path and the re-resolution path agree, or a reparse will
  quietly move the selection back.

### 2b. The comment inconsistency is by design, and the design should stay

The observation is exact: selecting `Document` or `garage` shows `elements`' children **and**
`garage`'s comment; selecting `elements` shows the children without the comment.

That is `skippedComments` (`transparentWrapper.ts:143`) doing what §4.3 asks — *"comments on
skipped nodes are not lost"* — because compaction must never hide documentation. Selecting
`elements` skips nothing, so there is nothing to surface; the comment belongs to `garage` and
appears when you look at `garage`. Both behaviours are individually correct.

**The suggestion to stop the descent at `garage` because it carries a comment should not be
adopted**, and it is worth writing down why, because it is a reasonable-sounding rule that breaks
the feature's main case:

- `wrapperCompositeChild` deliberately ignores `Comment`/`ProcessingInstruction`/`DocType` children
  as *"pure document metadata, never a data field a consumer could lose visibility into."*
  `CONCEPT.md` Appendix A names `garage` and `cars` as wrappers **that carry comments**.
- Under the proposed rule, one comment anywhere in a wrapper chain stops the descent. Opening
  `cars-10mb.xml` would land on `garage` — a node with a single child and no table — which is
  exactly the document the grid exists for. A stray comment would decide whether the app's
  signature feature appears.
- The distinction D-015 turns on is **data vs. metadata**, not empty vs. non-empty. A comment does
  not make a wrapper a data-bearing node; it makes it a documented one.

### 2c. What 2a does to the symptom, and what is left

Once the initial selection *is* the destination, the default view has no skipped nodes and so
surfaces no ancestor comment. The confusing case then only arises when the user **deliberately**
selects an ancestor — and there, showing that ancestor's comment beside the compacted table is the
correct behaviour, not an inconsistency.

What remains is presentational, and should be checked before anything is changed: when the pane is
showing a *different* node than the one selected, is that obvious? D-050 already added the
breadcrumb marker and the Tree's unfold-along-the-descent for exactly this. If it reads clearly,
**this round changes nothing else** — say so in the results rather than inventing work. If it does
not, the fix is to strengthen that marker, not to change which node is displayed.

One small thing to look at while there: the comment section is headed `Comment` and mixes surfaced
ancestor comments (labelled `garage:`) with the node's own (unlabelled). With 2a in place this is
rare, but a heading that distinguishes them would cost nothing.

---

## 3. Not in scope

- **Reopening D-051.** The shared-component decision stands; §1 is about carrying it out.
- **Reopening D-015 / §4.3's wrapper rule** — see 2b.
- **The Tree's own auto-expand chain** (D-034a) is a different mechanism for a different pane and
  is not touched by 2a.
- **Horizontal scrolling in Tree or Detail.** Only the Grid has a horizontal axis today; adding one
  elsewhere is a separate question.

---

## Results — built

Both halves landed together; details and the full test/verification account are in
`docs/DECISIONS.md`'s D-051 addendum and D-065's "Implementation note," and `docs/LOG.md`'s own R33
entry. Summary:

- §1a: `.detail` gained `Scrollbar`, wrapped in a new `.detail-viewport` positioning context;
  `.detail-children-list` gained `overscroll-behavior: contain` so the nested thumbs and wheel
  scrolling don't fight (verified real-Chromium via `test/scrollbarContrast.test.tsx` and the
  existing `test/detail.test.ts`/`.tsx` suites, all passing unmodified).
- §1b/§1c: new control tokens replace `--elev-2-bg`/`--row-hover-bg`/`--accent` reuse in
  `Scrollbar.css` and `Scrubber.css`; >= 3:1 thumb-vs-track contrast asserted in both themes by a
  new browser-project test, not screenshotted.
- §1d: unchanged, as specified.
- §2a: `documentSession.ts`'s initial-selection fallback now calls `resolveWrapperTarget`, moved to
  `src/renderer/wrapperDescent.ts` for the layering reason §2a's own text anticipated (a plain file
  move, no behavioural change to the function itself). One test's expectation updated to match the
  corrected selection.
- §2b/§2c: not reopened; no further work — reading the current breadcrumb/Tree markers after 2a's
  fix found nothing unclear enough to justify strengthening them, per §2c's own instruction to say
  so rather than invent work.

`npm run typecheck`, `npm run lint`, `npx stylelint`, and the full `vitest` suite (node + browser
projects) are clean.

---

## Addendum — four follow-up defects from using the app after R33 landed

Reported directly from a screenshot of `cars-10mb.xml`'s Detail pane, in grid mode. Not new `R`
tasks — small enough to fold into this file rather than allocate a new id, per `CLAUDE.md`'s own
"a topic file needs no milestone" allowance.

### 1. The overlay track sat on top of content, not beside it (fixed)

D-051's overlay scrollbar was never given a reserved gutter in three of the four panes — only
`Raw.css`'s `.raw` had `margin-right: var(--scrubber-width)` (the comment there literally says why:
"without this, CodeMirror's own content would sit underneath it"). `.detail`'s own padding
(`--space-3`, 12px) was narrower than the track (`--scrubber-width`, 15px), so the track's
right-most 3px sat on real content — visibly, the breadcrumb's "Copy path" button and the
children table's rightmost column. Tree and the Grid had *no* reserved space at all: Tree's
virtualized rows are positioned `right: 0` against `.tree` itself (Tree.tsx), and the Grid's own
internal vertical `<Scrollbar>` (`axis="both"`) had nothing reserved either, so its rightmost
column sat directly under the thumb whenever the grid actually scrolled vertically — exactly what
the screenshot showed on the `sunroof` column.

Fixed by applying the same reservation Raw.css already established, in each pane's own idiom:
`.detail` and `.detail-children-list` gained `padding-right: var(--scrubber-width)` (added to, not
replacing, their existing padding — an absolutely-positioned child's `right: 0` resolves against
the *padding* edge, so this is what actually creates the gutter); `.tree` and `.grid-scroll` gained
`margin-right: var(--scrubber-width)`, mirroring `.raw` exactly.

### 2. The Raw scrubber and the other three panes' track used different tokens (fixed)

`Scrubber.css`'s `.scrubber` used `background: var(--elev-1-bg)` — an elevation *surface* token,
the same category of mistake 1b already found and fixed for the *thumb* — while `Scrollbar.css`'s
`.scrollbar-track` (Tree/Detail/Grid) already used the real control token,
`--scrollbar-track-bg`. The two tokens happen to resolve to the same value in dark mode
(`--gray-800`), which is exactly why this was invisible there and only showed up in light mode
(`--elev-1-bg` is `--gray-0`, the lightest surface; `--scrollbar-track-bg` is `--gray-100`).
Fixed by switching `.scrubber` to `--scrollbar-track-bg`, the same token every other pane's track
already used — the two behaviours (§4 of the user's report, "in dark mode the backgrounds are the
same") and (§3, "should be the same for all of them, prefer the lighter one") were the same root
cause, one token swap.

### 3. The scrubber thumb's rounded corners disappear at the very top (found, not fixed — real,
narrowed down, needs a decision)

Confirmed with real-Electron screenshots (Playwright's `_electron`, matching R33 §1's own
"verify with real-Chromium tooling, not by reasoning about event order" instruction): when the
thumb's `top` is exactly `0` (scrolled to the document's very start), its top-left/top-right
corners render perfectly flat — `border-radius: 4px` is present in computed style, but nothing
visibly curves. The bottom corners round normally.

**This is not a `Scrubber.css` bug.** A freshly-created, completely unrelated `position: fixed` div
with the same `border-radius`, appended straight to `document.body` with no ancestry relationship
to `.scrubber` at all, shows the *identical* flat-top artifact when positioned at the same
fractional-pixel `top` the real pane boundary happens to land on in this window's own flex layout
(`438.8125px` for the fixture used) — and renders a normal rounded corner at an arbitrary Y with no
nearby border (`250px`, tested). Two attempted fixes did not resolve it: forcing the thumb onto
its own compositing layer (`transform: translateZ(0)`), and a 2px inset moving the thumb's top
away from the neighbouring `.pane-header`'s border-bottom. Both were ruled out empirically, not
assumed to fail.

The working theory is a Chromium/Electron rendering artifact tied to a specific fractional device-
pixel row in *this* window's layout (the pane heights are not integers, since `--row-height`,
banner presence, and the resizable Raw/Detail split all compose to a non-round number) — not
something fixable inside `Scrubber.css` alone. A real fix would mean pixel-snapping pane heights
somewhere in the layout system, which is bigger and riskier than this report's scope. **Left open,
undecided** — worth a project-lead call on whether it is worth chasing further, given it is
cosmetic and only visible in the single frame where the scrubber sits at the exact top.

### Verification

`npm run typecheck`, `npm run lint` (baseline warnings only — the same ones present before this
change), `npx stylelint` on the four touched files, and the full `vitest` suite (99 files, 1167
tests, node + browser projects) are all clean. Item 3 was investigated live via a scratch
Playwright/Electron script (not committed, matching the R26-addendum precedent) rather than
screenshotted and guessed at.

---

## Addendum 2 — two more, from a second pass over the same screenshot

Reported as *"in light mode the Tree scrollbar is a slightly different grey"* and *"the Raw
scrollbar has a thin separator line the others don't"*. Both were measured against real Electron
before being written up, and the first turned out not to be what it looked like. **Open — not yet
implemented.**

### The measurement

Rendered pixels sampled from a real-Electron screenshot (`cars-10mb.xml`, light theme, tree
expanded so its own `Scrollbar` actually mounts — it does not render at all when the pane does not
overflow, which is why a small fixture shows nothing to compare). All four sampled at
`devicePixelRatio` 1; **the Tree strip alone was re-checked at 1.25** and was unchanged (the other
three fell outside the screenshot bounds at that zoom and were not re-measured, so fractional-pixel
blending is ruled out for Tree only):

| Pane | track fill | thumb fill | thumb width | 1 px neighbour |
|---|---|---|---|---|
| Tree | `236,238,242` | `113,123,140` | 13 px | `221,225,231` on the **right** |
| Grid (inner) | `236,238,242` | `113,123,140` | 13 px | `221,225,231` on the **right** |
| Detail (outer) | `236,238,242` | `113,123,140` | 13 px | none — window edge |
| Raw (scrubber) | `236,238,242` | `113,123,140` | **12 px** | `221,225,231` on the **left** |

*(Measured against a rebuilt `out/` — the bundle on disk was five hours stale and still had the
pre-addendum-1 scrubber, which would have sent this chase after an already-fixed bug. Worth
remembering before any future real-Electron measurement: `out/` is not rebuilt by `npm test`.)*

### 4. The Tree track's colour is correct; its *framing* is what differs (no fix proposed)

Every pane's track resolves to the same `--scrollbar-track-bg` and renders the identical
`236,238,242`; every thumb renders the identical `113,123,140`. **There is no colour bug**, and
addendum 1's token unification did hold.

What differs is the 1 px column immediately beside each strip: Tree and the Grid's inner scrollbar
are each butted hard against a `--surface-border` divider (the pane divider, and
`.detail-grid-container`'s `border-right`) with no gap, Detail's sits at the window edge with
nothing beside it, and Raw's has a line on the *opposite* side. Three different framings of the
same grey across four panes — which is enough to make one read lighter than another, and no token
change can fix it because nothing about the token is wrong.

**Recorded rather than fixed.** Removing the divider next to the Tree strip is a layout decision
about pane boundaries, not a scrollbar one, and it is not obviously an improvement. Item 5 below
removes the only framing difference that *is* clearly a defect.

### 5. The scrubber's `border-left` is a pre-D-051 leftover (fix)

```css
border-left: var(--border-width) solid var(--surface-border);   /* Scrubber.css:19 */
```

No `.scrollbar-track` has one. It survived addendum 1 because that pass was looking at colour, not
geometry — and it has a second effect nobody had noticed: the border eats into the 15 px box, so
Raw's usable track is 14 px and its thumb renders **12 px wide against 13 px everywhere else**,
offset 1 px right. Deleting the declaration makes Raw pixel-identical to the other three.

### 6. Extract the shared strip styles so the two files stop drifting (fix)

The project lead's question — *"should we use the same scrollbar class in all views so we don't
have these issues of separate UI in the different panes?"* — is half yes, and it is the more
important half.

The **component** cannot be shared, for the reason §1d already gives and D-051 settled: the
Scrubber's thumb cannot derive from `scrollHeight` because Raw only holds a ~1 MB window (D-031),
and its search/diagnostic markers are Raw-only. That is not reopened.

The **stylesheet** is duplicated for no reason. `Scrubber.css` re-declares the thumb's positioning,
`left/right: 1px`, `border-radius`, `transition` and hover/active states in parallel with
`Scrollbar.css`. That duplication is the actual mechanism behind every defect this file has
recorded: two token drifts (§1b, addendum 1's item 2) and now a stray border, each of them
"someone edited one file and not the other."

**Fix: one shared strip stylesheet both import** — a `.scroll-strip` / `.scroll-strip-thumb` pair
carrying track background, width, thumb geometry, radius, transition and the hover/active states,
with `Scrubber.css` keeping only what is genuinely Raw's (the markers, `cursor: grab`,
`min-height`, the `.scrubber-active` variant). After this, divergence has to be written on purpose
instead of happening by omission — which is the whole point of D-051 and the thing three separate
addenda have now failed to get by convention alone.

`test/scrollbarContrast.test.tsx` should gain the scrubber alongside the scrollbar, so the parity
this creates is asserted rather than assumed.

### Results — built

Both items landed together.

- **Item 5**: `Scrubber.css:19`'s `border-left` deleted. Raw's track and thumb are now sized
  identically to the other three panes.
- **Item 6**: new `src/renderer/components/Scrollbar/ScrollStrip.css`, `@import`ed by both
  `Scrollbar.css` and `Scrubber.css`, carries track background, the vertical track's width, thumb
  positioning/radius/transition, and the hover/active colour states — the exact set item 6 named.
  `Scrollbar.css` keeps only native-scrollbar hiding, per-orientation placement (including the
  horizontal track's own height and its thumb's `top`/`bottom` inset), and the vertical/horizontal
  corner handoff. `Scrubber.css` keeps only markers, `cursor: grab`, `min-height`, and the
  `.scrubber-active` cursor swap — its colour states now come from the shared file, not a parallel
  declaration.
- `test/scrollbarContrast.test.tsx` gained a second `describe` block: the scrubber's own >= 3:1
  contrast check in both themes, plus a parity test asserting the scrubber's track/thumb computed
  colours and track width are identical to the scrollbar's — rendering both in the same DOM tree so
  a future drift is a failing assertion, not a screenshot someone has to notice.

`npm run typecheck`, `npm run lint` (baseline warnings only), `npx stylelint` on the four touched
files, and the full `vitest` suite (99 files, 1171 tests, node + browser projects) are all clean.
