# R210–R211 — one table per group, decided

<!-- status: built -->

**Built, both ids.** Detection is one bucketing pass producing one table per qualifying group in
document order, with `GRID_MIN_COVERAGE` removed; the Detail view stacks them, capped at five —
a value the project lead chose from 2, 5, 10 and 20 rendered in the running application. D-103 and
D-104 record the two decisions; `CONCEPT.md` §4.3 and §13 are updated.

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

### The cap (R211), chosen by rendering

2, 5, 10 and 20 rendered against a document with 21 equal groups of 4 rows, in a 900×2100 window
so each whole stack fits one frame. **Five**, the project lead's call — the plan called it a
measurement placeholder and rendering did not argue against it. Groups past it list beneath, in
document order, with a line saying how many.

Two layout decisions came out of rendering rather than the plan:

- **Each stacked table is sized to its own rows**, bounded at 320px. `flex: 1` across five tables
  divides the pane equally, which gives a two-row group the same height as a twenty-four-row one.
  A **single** table is untouched and keeps R43/D-071's `flex: 1` and 230px floor, so the common
  case is pixel-identical to before.
- **A name heading appears only when there is more than one table.** With one, "Children" and the
  table together are unambiguous; a repeated name would spend a row of chrome in the common case
  for nothing (§9.4's budget, applied to vertical space).

### What the plural broke, and how

**The grid controller was a single slot.** Several mounted grids meant every palette command went
to whichever registered last — R210's arbitrary target, moved one layer up and made invisible.
It now holds every mounted grid plus the most recently focused, and commands act on that one,
falling back to the first.

Two details are load-bearing and neither is obvious:

1. **The grid's identity is a ref, not the controller object.** `Grid` re-registers its controller
   whenever its sort, filter or column set changes, so keying "which grid has the keyboard" on the
   controller would lose the target on a single filter keystroke.
2. **Focus is sticky — never cleared on blur.** Running a palette command moves focus into the
   palette; a registry that cleared on blur would have no target by the time the command ran.

Verified in the built application: Ctrl+2 with nothing focused lands on the first table; after
using the fourth and leaving to the Tree, Ctrl+2 comes back to the fourth, and `Filter Grid Rows`
follows it. **The clipboard commands could not be verified end to end** — `navigator.clipboard`
silently fails under Playwright automation, with one table or five, so this is a harness limit
rather than a finding; the routing they share with the filter command is asserted directly in
`test/gridController.test.ts`.

Each grid also carries its group's name as its accessible name. Five tables announcing
"Data grid" is the same ambiguity in a screen reader.

### The review found two things

- **The stacked-height chrome constants were wrong, and the comment claimed they were measured.**
  Written as `41 + 24`; the real values are 44 and 23, so every stacked table clipped 2px off its
  last row. Measured now, with a test asserting a table whose rows fit does not scroll —
  mutation-verified against the old constants.
- **`Grid.tsx`'s export soft-cap comment still said "there's exactly one `Grid` instance at a
  time"**, which R211 makes false. It now says why the mechanism still holds: `pendingExport` is
  per grid, the resolving commands route to the focused grid, and the click that started the
  export was on that grid's own toolbar.

### Acceptance

1. **Met** — asserted as the property, in detection (`test/gridDetection.test.ts`) and at the
   render level (`test/detailMultiGrid.test.tsx`): growing a second group across 2, 3, 4, 10 and
   100 members never changes which groups render.
2. **Met** — 21 evenly-sized groups produce 21 tables, and the 20-vs-21 pair is kept as its own
   regression test.
3. **Met** — 1000 `<car>` plus one `<metadata>` is one table of 1000 with the singleton listed.
4. **Met** — `spike/r210-grid-models.ts` re-run against the shipped code. It needed updating
   twice over: it called `Interner`'s removed second constructor argument (R209) and read
   `detection.grid`, so it had been unrunnable since R209 landed. The old model survives in it as
   `legacyDetect`, now the only thing that can reproduce § 2's cliff.
5. **Met** — `GRID_MIN_COVERAGE` is gone; `CONCEPT.md` §4.3 and §13 updated, D-014 annotated,
   D-103 added.
6. **Met** — see the cap section above.
7. **Met** — `npm test` 2162 passing, 5 skipped, 175 files; typecheck, lint and stylelint clean.

### Measured again, against the shipped implementation

`spike/r210-grid-models.ts`, 200,000 composite children, this machine:

| N groups | pre-R210 model | naive per-group members | **shipped one pass** | columns, all groups | columns, capped at 5 |
|---|---|---|---|---|---|
| 1 | 75.9 ms | 23.0 ms | 11.1 ms | 40.1 ms | 35.6 ms |
| 10 | 39.0 ms | 74.8 ms | 9.0 ms | 36.0 ms | 17.7 ms |
| 20 | 34.6 ms | 132.4 ms | 8.1 ms | 53.4 ms | 12.6 ms |
| 21 | **NO TABLE AT ALL** | 132.9 ms | 8.5 ms | 49.1 ms | 10.7 ms |
| 100 | **NO TABLE AT ALL** | 649.0 ms | 13.4 ms | 71.1 ms | 2.1 ms |

§ 4's three findings hold: the naive per-group collection is the one that does not scale, the
bucketing pass is flat in group count, and the cap is what bounds column collection.

### Version

**Minor — 1.1.0**, the project lead's call and § 10's candidate. Documents with several repeating
groups render differently, deliberately, and CSV renders its rows for the first time.
