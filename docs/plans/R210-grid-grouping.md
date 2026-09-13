# R210–R211 — one table per group, decided

<!-- status: open -->

**Open. The model is decided** (§ 3) and measured (§ 4); what remains is implementation.
**R210** is the detection change — one bucketing pass, one table per qualifying group, and the
coverage threshold removed. **R211** is the multi-table rendering D-014 deferred past v1:
virtualizers, focus and the table cap.

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
