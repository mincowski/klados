# R210–R211 — one table per group, decided

<!-- status: built -->

**Built, both ids.** Detection is one bucketing pass producing one table per qualifying group in
document order, with `GRID_MIN_COVERAGE` removed. The Detail view shows **one table at a time with
a tab per group** — no cap, one grid mounted — and a node with a single group shows no tabs at all.
D-103 and D-104 record the two decisions; `CONCEPT.md` §4.3 and §13 are updated.

**§ 7's rendering was built twice.** The first version stacked the tables, capped at five; it was
rendered, shipped to the branch, and rejected by the project lead because the cap was arbitrary on
screen. § 11 records both, since the rejected one is the reason the second looks the way it does.

**And it fixed a shipped format that had never worked.** Detection and member collection used
*different* eligibility tests, so every CSV document rendered an empty table above a list of
anonymous `Object` rows. See § 11.

Raised while deciding R209, and independent of it: a node whose composite children fall into two
groups shows one as a table and the rest as a list. Dropping namespace resolution makes that
reachable more often; it did not cause it.

## 1. The complaint, stated precisely

**The view is not a function of the document's structure — it is a function of its data.**

`detectGrid` promotes the *largest* qualifying group to be the table. So with three `a:item` and two
`b:item` you get an `a:item` table; add two more `b:item` and the whole view switches to a `b:item`
table. Same document shape, different table. Ties break on "first encountered", which the code
comment states outright is arbitrary.

That is the unpredictability, and it is structural rather than cosmetic: nothing the user can see
explains why this group and not that one.

## 2. And it has a cliff nobody knew about

Found by measuring rather than reasoning (`spike/r210-grid-models.ts`):

**Spread children evenly across more than 20 groups and no table renders at all.** With 21 equal
groups each covers 4.76%, under `GRID_MIN_COVERAGE = 0.05`, so nothing qualifies and everything
falls to list mode. At 20 groups there is a table; at 21 there is none.

| groups | today |
|---|---|
| 20 | a table |
| 21 | **NO TABLE AT ALL** |
| 100 | **NO TABLE AT ALL** |

This was not in the plan's first draft, which assumed the pathological case was "a tiny table above a
long list". It is worse than that, and it is a discontinuity in a threshold whose own comment admits
it is a guess awaiting real documents.

## 3. Decided: one table per group

**Every group of two or more same-named composite children renders as its own table, in document
order; everything else lists beneath.**

One sentence, no conditions. No winner, no tie-break, no promotion — adding `b:item`s makes the
`b:item` table taller rather than stealing the view from `a:item`. The output is a function of
document structure, which is what "predictable" means here.

**It degenerates to today's behaviour for the common case.** 1000 `<car>` plus one `<metadata>`
still gives one table, because `metadata` has a single member and stays in the list.

### `GRID_MIN_COVERAGE` is removed, not retuned

Coverage exists to answer *"is this group dominant enough to be **the** table?"* Under one-table-per-
group that question does not exist; what remains is "table or list?", which `GRID_MIN_MEMBERS >= 2`
already answers.

So `CONCEPT.md` §13's open question closes **by deletion** rather than by guessing a better number —
and § 2's cliff goes with it, since there is no coverage floor left to fall off.

### Rejected: one unioned table

The other predictable model, and measured out. On the merged feed the two groups share **no column
names at all** (`a:sku`/`a:price` against `b:sku`/`b:price`), so the union is 5 rows x 4 columns with
every row half empty — two disjoint blocks drawn inside one grid.

Worse, `GRID_COLUMN_CAP` is 60 and **survival past it is decided by frequency**
(`gridColumns.ts:244`). Union many groups and the rarer groups' columns are pushed to overflow, so
their rows render blank in the visible columns with the data behind the picker. That is
data-dependent disappearance — the exact unpredictability this round removes, reintroduced one level
down.

### Rejected: raising the threshold

Keeps the arbitrary winner (§ 1) and keeps a cliff, just at a different group count.

### Not rejected, and not needed: merging groups on column overlap

§ 5 records that D-013 does not preclude it. It is a refinement of one-table-per-group, not an
alternative to it, and nothing measured here calls for it. Left available.

## 4. What it costs, measured

`spike/r210-grid-models.ts`, 200,000 composite children split evenly across N groups, this machine:

| N | today (winner only) | naive model C | **one-pass** | columns, all groups | columns, 5-table cap |
|---|---|---|---|---|---|
| 1 | 56.3 ms | 8.1 ms | 8.5 ms | 32.1 ms | 32.3 ms |
| 2 | 37.1 ms | 13.0 ms | 8.8 ms | 38.2 ms | 35.0 ms |
| 10 | 28.7 ms | 55.3 ms | 9.3 ms | 35.2 ms | 18.0 ms |
| 20 | 22.1 ms | 109.2 ms | 8.0 ms | 48.1 ms | 11.6 ms |
| 21 | **NO TABLE** | 112.9 ms | 10.1 ms | 48.0 ms | 11.8 ms |
| 100 | **NO TABLE** | 513.2 ms | 9.4 ms | 46.3 ms | 2.0 ms |

**Three findings, each of which changes the implementation:**

1. **The naive implementation is O(children x groups) and must not be built.** Calling
   `collectGroupMembers` once per group re-walks every child per group: 8 ms at one group,
   **513 ms at a hundred**. It is the obvious way to extend today's code and it does not scale.
2. **One bucketing pass is flat in group count** — 8–10 ms whatever N is — and it replaces
   `detectGrid`'s counting pass *and* `collectGroupMembers` together, since buckets give both the
   counts and the members. Measured with the same `isGridEligible` filter, so this is like-for-like
   and not a cheaper scan.
3. **The table cap bounds column collection, which is otherwise the dominant cost.** Computing
   columns for every group is ~46 ms regardless of N; capping at five tables drops it to **2.0 ms at
   100 groups**. The cap is therefore a performance mechanism, not only a readability one.

**Net:** one-pass plus a five-table cap is 9.4 + 2.0 = **11.4 ms at 100 groups**, where today spends
~10 ms to render nothing at all. **Model C costs about what today costs and removes the cliff.**

## 5. D-013 does not settle the union question, and it looks like it does

D-013 rejected folding shape into the grouping key: *"that splits `<car>` elements into separate
groups whenever one carries an optional field … Optional fields should widen the column set, not
break it apart."*

**That is an argument against shape as a splitter.** Using column overlap to *merge* two name groups
is the opposite direction and D-013's reasoning does not reach it — a merge cannot fragment
anything. Recorded because the first reading is that the question is closed, and it is not.

## 6. R210 — detection

- One bucketing pass over the parent's children producing counts and members together, replacing
  `detectGrid` + `collectGroupMembers`.
- Every group with `>= GRID_MIN_MEMBERS` qualifies; **no coverage floor**.
- Groups ordered by first appearance in the document.
- `GRID_MIN_COVERAGE` and its `CONCEPT.md` §13 entry are removed.

**Pure logic, testable without React** — the same `*Model.ts`/`*Logic.ts` split the rest of the views
use, so `test/gridDetection.test.ts` exercises it directly and R211's UI work lands against a
detection layer already proven.

## 7. R211 — rendering several tables

**This is the part D-014 deferred past v1, and the reason it was deferred is real work, not
reluctance:**

- **Several virtualizers.** The grid virtualizes for a two-million-child parent (D9's stated normal
  case). Twenty live grids is not free, which is what the table cap is for.
- **The cap's value is a visual decision** (`PLANNING.md` § 1) — at what point does a stack of small
  tables read as noise rather than structure? Render it at 2, 5, 10 and 20 and put it in front of
  the project lead. **Five is this plan's placeholder for measurement purposes, not a recommendation.**
- **Overflow is listed, in document order**, so which tables render is predictable rather than
  frequency-dependent.
- **Focus and keyboard.** F6, selection, and moving between tables. Invariant 10 still applies:
  anything reachable here is reachable from the palette.

## 8. Non-functional expectations (`PLANNING.md` § 3)

- **Detection stays one pass.** § 4's finding 1 is the specification, not a suggestion.
- **Column collection is bounded by the table cap**, not by group count (§ 4, finding 3).
- **`GRID_COLUMN_CAP` still applies per table**, unchanged — one table per group means no table is
  wider than its own group's fields, which is the union problem this model avoids by construction.

## 9. Acceptance

1. Adding members to a second group **never changes which groups render as tables** — the property
   § 1 exists for, asserted directly rather than inferred from an example.
2. A document with 21 evenly-sized groups renders 21 tables (capped), **not nothing** — § 2's cliff,
   as a regression test.
3. 1000 `<car>` plus one `<metadata>` renders exactly as it does today.
4. Detection is one pass: asserted by `spike/r210-grid-models.ts` re-run, with the naive column
   staying out of the implementation.
5. `GRID_MIN_COVERAGE` no longer exists, and `CONCEPT.md` §4.3, §13 and D-014 are updated to match.
6. The table cap is chosen by rendering, and the chosen value is recorded with the screenshots that
   decided it.
7. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 10. Version

**Ask on landing.** Candidate: **minor** — documents with several repeating groups render
differently, deliberately.


## 11. Results — built

### The model (R210)

`detectGrid` returns `{ compositeChildCount, groups, tables }`, where a `GridGroup` carries its
own `members`. `tables` is the groups with at least `GRID_MIN_MEMBERS`, in document order —
insertion order into a `Map` keyed while walking the children forwards, so § 6's "ordered by
first appearance" needs no sort. `grid` (the winner), `memberCount` and `GRID_MIN_COVERAGE` are
gone, and so is `collectGroupMembers`.

### The defect the round was not looking for

**Every CSV document has rendered an empty table since CSV shipped.** `detectGrid` counted
children with `isGridEligible` — has children **or** has scalar facets, which D-088 widened
precisely so CSV rows would qualify — and `collectGroupMembers` collected them with
`hasChildren`. A CSV row is attributes-only by R145 §2's design, so detection found a group of
N and collection returned **zero members**: an empty grid, with all N rows in the list beneath it
as unnamed `Object`s. Confirmed in the built application before the change and after.

**Neither function was wrong on its own**, which is why it survived R145–R149 and their tests. The
CSV presentation test built its members with `childrenOf` directly rather than through the path
the application takes, so it asserted the columns were right while the rows were never collected.
That is `CLAUDE.md`'s "a component measured cleanly while the pipeline around it was not" — the
sixth instance, and the first found by removing the pipeline rather than by measuring it.

**One pass fixes it by construction**: there is one eligibility test because there is one pass.
Every grid test file now goes through `detectGrid` rather than a second collector, which is the
point of deleting the second function rather than making its predicate match.

### Rendering, first attempt: a stack capped at five — rejected

Every qualifying group rendered as its own table, stacked in document order. The cap was chosen by
rendering 2, 5, 10 and 20 against a document with 21 equal groups; five was picked; groups past it
listed beneath with *"Showing 5 of 8 tables — the rest are listed below."* Each stacked table was
sized to its own rows, and the grid controller registry became plural, tracking the focused grid.

**Rejected by the project lead after using it**: *"it still is arbitrary: Why do 5 tables show and
then no more?"* That is correct, and the argument for five did not answer it. The cap was a sound
rendering budget — live virtualizers, column collection — but a budget is invisible, and what the
user sees is a number with nothing on screen to justify it. **It moved R210's arbitrariness from
"which group wins" to "which groups fit"**, which is a smaller version of the same defect.

Recorded rather than squashed away, because it is the reason for the design below, and because a
future proposal to "just show them all stacked" should find that it was tried.

### Rendering, as built: one table, a tab per group

Four options were costed before choosing (a picker in Detail; group rows in the Tree; an uncapped
collapsible stack; a groups summary to drill into). **Group rows in the Tree were rejected on
cost**: they reorder the document where a name repeats non-contiguously, widen selection from a
node to "a node or a group" across every consumer, and bring R210's problem back through their own
trigger — group rows only when there are several groups means adding one `<metadata>` reshapes
the Tree. The picker in Detail was the one that removes the cap instead of tuning it.

**Three renderings of the picker** in the running application, on the 8-group demo and the
21-group document: tabs that wrap, tabs that overflow into a menu, and a dropdown. **Tabs with a
"+N more" menu**, the project lead's choice. Wrapping pushes the table down a line per row of tabs
on a wide node — the 21-group file already took two at 1180px. The dropdown hides the one fact the
control exists to communicate, that this node has several tables. On the 8-group file the two tab
versions are indistinguishable; they differ only where the tabs do not fit.

What it does:

- **No cap, one grid.** Every group is named on screen or one menu away, and exactly one grid is
  mounted whatever the group count — cheaper than the stack at any count.
- **One group, no tabs.** The common case is the view from before R210.
- **The current group is never invisible**: when it lives in the menu, the more button names it
  and carries the selected underline.
- **Remembered by name per document.** Stepping between sibling nodes of the same shape keeps
  `magazine` open; a node without that group shows its first and does not forget the choice.
- **Keyboard**: one Tab stop for the strip (roving tabindex), arrows move focus without switching —
  switching remounts the grid, which on a two-million-row group is not free, so activation is
  Enter/Space/click. The menu closes on Escape and on a press outside it.
- **Palette**: `Show Next Grid Group` / `Show Previous Grid Group`, wrapping (invariant 10).
- **A fresh grid per group.** Sort, filters and pinned columns are keyed by one group's column
  name ids and do not carry to another group's table. **Switching back also resets them** — a
  known limitation, not an oversight; keeping every group's grid mounted to preserve it would
  reintroduce the cost the tabs removed.

The plural controller registry from the first attempt is reverted to `main`'s single slot, since
one grid mounts. Each grid keeps its group's name as its accessible name.

### How the tab strip is fitted

An invisible copy of every tab is laid out at natural width and measured; the real row shows as
many as fit. Three details, each of which was a defect before it was a detail:

1. **Measured bold.** The selected tab renders bold, so a normal-weight measurement lets it clip.
2. **The more button's width depends on the answer.** It names the selected group when that group
   is hidden and reads "+N more" otherwise, so `tabsThatFit` takes its width as a function of the
   candidate count — and **scans every count rather than stopping at the first that fails**,
   because the button narrows once the selected group becomes visible. Pure and DOM-free, with its
   own test.
3. **Clipped, not merely hidden.** At natural width the copy can be thousands of pixels wide, and an
   absolutely positioned box that wide still extends its scroll container: **the Detail pane's
   scroll width measured 4,516px in a 900px pane** before the copy was put inside a clipping box.
   Invisible in a screenshot, since the pane draws no horizontal scrollbar — a trackpad swipe would
   have slid it sideways into nothing. Asserted now.

### What the review and the project's own guards found

- **The palette's step command read a stale selection.** It used the index captured at render, so
  two commands before a re-render — a held key repeating — moved once instead of twice. It reads
  the current selection at call time, and the test that caught it is kept.
- **The 4,516px scroll width** above.
- **`▾` failed R71's text-as-icons guard** (`test/textAsIcons.test.ts`); it is the tab strip's own
  `chevron-down` icon, the one the document tab strip's overflow button already uses.
- **The menu is a new `--elev-2-bg` surface**, and the completeness check R212 added to
  `test/elevationBorders.test.ts` failed until `Detail.css` was listed — the first new surface it has
  caught, one round after it was written.
- **After a pick from the menu, focus fell to `<body>`**, because the clicked item unmounts. Focus
  returns to the more button, which survives the re-render and now names the chosen group.
- **The tab panel had no accessible name.**
- **From the first attempt**, before it was replaced: its stacked-height chrome constants were
  written as `41 + 24` under a comment claiming they were measured, and clipped 2px off every
  stacked table. Recorded because the comment lied, not because the code survives.

### Acceptance

1. **Met** — asserted as the property, in detection (`test/gridDetection.test.ts`) and at the
   render level (`test/detailGridGroupTabs.test.tsx`): growing a second group never changes the
   tabs or the selected one.
2. **Met** — 21 evenly-sized groups produce 21 tables, and the 20-vs-21 pair is kept as its own
   regression test. At the render level all 21 are reachable: the visible tabs plus the menu's
   items come to 21.
3. **Met** — 1000 `<car>` plus one `<metadata>` is one table of 1000 with the singleton listed.
4. **Met** — `spike/r210-grid-models.ts` re-run against the shipped code. It needed updating
   twice over: it called `Interner`'s removed second constructor argument (R209) and read
   `detection.grid`, so it had been unrunnable since R209 landed. The old model survives in it as
   `legacyDetect`, now the only thing that can reproduce § 2's cliff.
5. **Met** — `GRID_MIN_COVERAGE` is gone; `CONCEPT.md` §4.3 and §13 updated, D-014 annotated,
   D-103 added.
6. **Superseded, and met in the form that replaced it.** The criterion was "the table cap is chosen
   by rendering"; the cap was chosen by rendering and then removed. The picker that replaced it was
   chosen the same way, from three renderings in the running application.
7. **Met** — `npm test` 2166 passing, 5 skipped; typecheck, lint and stylelint clean.

### Measured again, against the shipped implementation

`spike/r210-grid-models.ts`, 200,000 composite children, this machine:

| N groups | pre-R210 model | naive per-group members | **shipped one pass** | columns, all groups | columns, capped at 5 |
|---|---|---|---|---|---|
| 1 | 75.9 ms | 23.0 ms | 11.1 ms | 40.1 ms | 35.6 ms |
| 10 | 39.0 ms | 74.8 ms | 9.0 ms | 36.0 ms | 17.7 ms |
| 20 | 34.6 ms | 132.4 ms | 8.1 ms | 53.4 ms | 12.6 ms |
| 21 | **NO TABLE AT ALL** | 132.9 ms | 8.5 ms | 49.1 ms | 10.7 ms |
| 100 | **NO TABLE AT ALL** | 649.0 ms | 13.4 ms | 71.1 ms | 2.1 ms |

§ 4's three findings hold: the naive per-group collection is the one that does not scale, and the
bucketing pass is flat in group count. The third — that a table cap bounds column collection — is
now moot rather than wrong: with one table shown, columns are collected for **one** group, which is
cheaper than the "capped at 5" column at every row of the table.

### Version

**Minor — 1.1.0**, the project lead's call and § 10's candidate. Documents with several repeating
groups render differently, deliberately, and CSV renders its rows for the first time.
