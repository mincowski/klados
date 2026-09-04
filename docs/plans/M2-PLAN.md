# NodePad — M2 Implementation Plan

<!-- status: built -->

**Audience:** the coding agent implementing this milestone.
**Reference:** `CONCEPT.md` §4.3 (grid mode — read it in full before E1), §6.5 (interning),
§9.5 (icons), §11.5 (ARIA `grid`). `DECISIONS.md` D-013 to D-018, D-030.

---

## How to use this plan

Work through tasks **in order**. Each has explicit acceptance criteria — do not move on
until they pass. Where a task says "stop and report," stop and report.

> **M1 is complete** (`docs/plans/M1-RESULTS.md`). Three things it left open are M2's to inherit,
> not to rediscover: Tree's own scroll frame time was never measured (an M1 done-criterion),
> wrap's first-paint cost (§13, D12) was never answered, and end-to-end open time at 200 MB
> is **~5.46 s** against a bar that only ever covered the parse function. E10 picks up the
> first two. The third is a decision for the user, recorded in `M1-RESULTS.md`.

### What M2 is

The feature the project exists for. A node whose children repeat becomes a table: one row
per child, columns collected from the union of their field names, with the literal/derived
distinction (§4.3) visible in every cell.

### What M2 is not

- **No per-column expansion.** §4.3 marks it *post-M2* explicitly. Ship flat summaries with
  a drill-in affordance; a chevron that explodes `engine` into `engine.type` + `engine.kw`
  under a spanning header is a refinement, and building it now means designing the column
  model around a case that has never been used in anger.
- **No multiple stacked grids.** The largest qualifying group renders as a grid; everything
  else renders in list mode beneath it. §4.3 defers the rest to post-v1.
- **No editing.** Still M3. Cells are read-only, sorting and filtering are view-only, and
  `isReadOnly` stays pinned.
- **No search.** M4. The quick filter in E7 filters the *rendered group's rows* by
  substring; it is not `§6`'s find, does not touch the intern table's search index, and must
  not grow toward it.
- **No document-wide shape catalog.** §4.3 raises it only to defer it, for the
  single-occurrence ambiguity that E9's manual override already resolves.

### Hard rules

The M0 and M1 rules stand. Four that this milestone will specifically strain:

1. **No object per node, and no object per row or per cell.** This is where it will be
   hardest to hold. A 2 M-child node is the normal case, and every grid library on earth
   takes an array of row objects. Rows are `NodeRef`s; a cell is computed from
   `(rowNodeRef, columnNameId)` on demand, for visible cells only. If a `Cell[][]` appears,
   the milestone has gone wrong.
2. **Nothing above `src/formats/` tests a format id.** The grid is where D-030's folding
   earns its keep: `<name>Golf</name>` and `"name": "Golf"` must produce the same cell
   through the same code. A branch on `formatId` here means the unification claim failed —
   stop and report.
3. **Derived text must never be stylable as literal.** §4.3's governing rule. The
   literal/derived/absent kind belongs in the cell *model* (E4), not in the component that
   renders it, so that CSV export (E8) and screen readers (§11.5) can both see it.
4. **Detection and column collection are bounded work.** Both walk children of a node that
   may have millions. E1 and E3 carry explicit budgets; exceeding one is a "stop and
   report," not a reason to add a spinner.

---

# Tasks

## E1 — Group detection

**Files:** `src/renderer/components/Detail/gridDetection.ts`, `test/gridDetection.test.ts`

Pure logic, no React — the same `*Model.ts`/`*Logic.ts` split every other view uses.

§4.3's algorithm, exactly:

1. Group **composite** children by resolved name id. For XML this is the id of the resolved
   `(URI, localName)` pair rather than the prefix (§2), so two sections using different
   prefixes for one namespace group together. If namespace resolution isn't reachable from
   the store yet, use the raw `nameId` and **record it as a known gap** rather than
   inventing a resolution layer here.
2. A group qualifies with **≥ 2 members** and **≥ 5% of composite children**.
3. The **largest qualifying group** is the grid. Everything else falls to list mode beneath.
4. Non-composite children never enter a group.

**Grouping keys on name alone** (D-013). An earlier draft folded attribute and child names
into a shape signature; that splits `<car>` into separate groups the moment one carries an
optional field, which is the opposite of the feature's purpose. Optional fields widen the
column set — they do not fragment the table.

**Coverage is a floor, not a majority** (D-014). Two groups cannot both exceed 80%, so a
majority threshold makes a second qualifying group arithmetically impossible. The floor
exists only to suppress one-off children.

Both thresholds are **named constants, exported**, because §13 lists the 5% floor as a
guess needing real documents.

**Budget:** one pass over the children, `nameId` reads and a counter per distinct id. No
decoding, no allocation per child. **Under 50 ms for 2 M children** — measure it in E10, but
write it so the number is plausible by construction.

**Acceptance:** `cars-200mb.xml`'s `garage` node detects one `car` group. A node with
40 `<book>` and 3 `<magazine>` picks `book`, leaves the magazines to list mode, and reports
both. A node with one `<car>` produces **no** grid (`≥ 2 members`), which is the
single-occurrence ambiguity E9's override resolves. Scalar children never form a group.

## E2 — Transparent wrappers

**Files:** `src/renderer/components/Detail/transparentWrapper.ts`, plus Tree compaction

`<cars><elements><car/><car/></elements></cars>` selected at `cars` naively yields a
one-row table containing the word "elements". §4.3 calls this among the first things a user
hits.

A node is a transparent wrapper when **all** hold:

- exactly one composite child, **and**
- no scalar facets (no attributes), **and**
- no text content of its own

The third condition's old "no *non-whitespace* text" qualifier is dead — insignificant
whitespace isn't in the model (D-030), so the test is simply whether the node has a value or
a `Text` child.

**Deliberately narrow** (D-015): a node carrying attributes *and* a single child holds real
information and is not transparent.

Descend recursively to a depth limit of ~3, then render the grid for the first node with
repeating children. The header shows the skipped path as a breadcrumb chip, `cars › elements`,
every segment clickable.

**Comments on skipped nodes are not lost.** A descended-through wrapper may carry an
attached comment; surface it in the destination's comment block, labelled with the segment
it came from (`cars: Fleet inventory…`). Compaction must never hide documentation.

**The Tree applies the same rule**, compacting single-child chains into one row, still
expandable. A setting, on by default. Precedent: VS Code compacting `src/main/java`.

**This task owns a §13 question.** "Wrapper descent depth — the limit is ~3, but Appendix A
reaches it in a deliberately small example (root → `garage` → `cars` → `elements`). Is 3 too
tight, or should descent be unbounded and simply stop at the first node with repeating
children?" Try both against Appendix A and the fixtures; record which, and why, in
`M2-RESULTS.md`.

**Acceptance:** Appendix A's document renders `garage`'s grid when `garage` is selected,
with the skipped path shown. A wrapper with an attribute is not descended through. A
skipped node's comment appears, labelled. Tree compaction is reversible by expanding.

## E3 — Column collection

**Files:** `src/renderer/components/Detail/gridColumns.ts`

Columns = union of the group's **first-level field names**, ordered by **first appearance,
then by frequency** (§4.3). A field is an attribute or a child node — the same union that
makes an XML attribute and a JSON property the same kind of column (rule 2).

**This is the one place M2 can fall over on scale, and it needs measuring before it needs
optimizing.** Frequency ordering requires visiting every member's first-level fields:
`cars-200mb.xml`'s `car` group is roughly 940 K members × ~6 fields ≈ 5.6 M `nameId` reads.
That is probably 50–100 ms — tolerable once, on selection, but a visible hitch, and 2.5×
that at 500 MB.

**Build the straightforward full scan first and measure it (E10).** Then, and only then:

- If it lands inside a frame budget, ship it and record the number.
- If it does not, the fix is **not** a spinner. Collect from a bounded prefix (~1000 rows)
  for first paint and complete in the background — but note the trap before choosing it:
  frequency ordering computed from a sample and then revised **reorders columns under the
  user**, which is worse than a brief wait. If sampling is needed, freeze the order from the
  sample and let later discoveries append only.

**Column cap ~60**, with a column picker beyond it. Cap by the same frequency order, so the
columns a user is most likely to want survive the cut.

**Column kind is per column for the header, per cell for the body** (D-017). The header shows
the **widest** kind present — composite over scalar, repeating over single — so it signals
the maximum complexity the column contains. A tooltip gives the breakdown ("engine —
composite in 12 of 40 rows"). Computing that breakdown is part of the same pass.

**Acceptance:** a group where one member has an extra field yields a column set including
it, with that member's row showing values and every other row showing *absent*. Column
order is stable across re-selection of the same node. A 61st field is dropped from the
default set and reachable through the picker.

## E4 — The cell model

**File:** `src/renderer/components/Detail/gridCell.ts`

The literal/derived/absent kind, computed from `(row, column)` — **not** stored per cell.
§4.3's table, in full:

| Field | Renders | Kind |
|---|---|---|
| Attribute `color="red"` | `red` | literal |
| Scalar child `<name>Golf</name>` | `Golf` | literal |
| Empty element `<sunroof/>` | presence marker | derived |
| Composite child `<engine>…</engine>` | `diesel · 110` ▸ | derived |
| Repeated scalar, 3× `<owner>` | `Smith, Jones` ×3 | derived |
| Repeated composite, 3× `<part>` | `3 items` ▸ | derived |
| Mixed content `<desc>a <b>x</b></desc>` | text, marked mixed | derived |
| Absent | `—` | absent |

**Why repeated scalars are dimmed** (D-016): an undimmed `Smith, Jones` is indistinguishable
from a single field whose literal value is the string `"Smith, Jones"`. The `×3` badge
carries the multiplicity; the dimming carries the fact that the joined text is NodePad's
construction, not the document's.

**Kind is per cell, not per column** (D-017). `<engine><type>diesel</type></engine>` in one
row and `<engine>petrol</engine>` in the next means the second cell renders `petrol`
undimmed, in the same column.

Decode **only for visible cells** (invariant 1). A cell's text comes from
`sourceBuffer.slice` over the node's value span, at render time.

**Acceptance:** every row of the table above, for both an XML and a JSON document, through
the same code path. A test asserts no branch on `formatId` exists in this module.

## E5 — Grid rendering

**Files:** `src/renderer/components/Detail/Grid.tsx`, `Grid.css`

**Both rows and columns virtualized** (§4.3). `@tanstack/react-virtual` is already a
dependency and D8's Tree is the precedent for the row axis; columns need the same treatment
because a 60-column table at any useful width scrolls horizontally.

- **Leading row-header column** showing the row's index **in document order**, which does
  not change when a view-only sort is applied (E6). A number that reshuffles with the sort
  tells the user nothing.
- **No key-attribute detection.** Guessing that `id`/`name`/`key` is the row's identity is
  magic that will be wrong on real documents. Any column can be **pinned** left by the user
  instead — explicit, and works regardless of naming.
- **Column header icons** from the Fluent set (§9.5): `@` for an XML attribute, a text glyph
  for a scalar, braces or a tree glyph for a composite, stacked layers for repeating. These
  are the first real consumers of `IconRef` — M2b owns resolving it properly, so until then
  use whatever placeholder D8's Tree glyphs use and **do not build a second icon mechanism**.
- **Numeric columns right-align with tabular figures**, everything else left-aligns.
  Detected from values. §4.3 calls this cheap and most of what separates a professional
  table from an amateur one.
- **Row height 22–24 px** (§9.4), matching Tree.
- **ARIA `grid` pattern** (§11.5), with `aria-rowcount`/`aria-colcount` reporting **document**
  counts, not rendered counts — the same constraint D8 met for `aria-setsize`.
- **Derived cells carry a screen-reader label** distinguishing them from literal values
  (§11.5), because the dimming that conveys it visually is invisible to assistive tech.

**Acceptance:** `cars-200mb.xml`'s `car` grid scrolls in both axes with no frame over 32 ms.
`aria-rowcount` reports the true member count on a 2 M-row group. Both themes checked for
alternating rows, focus rings and the dimmed derived style (§9.6 names these as the three
things that rot first).

## E6 — Sorting and pinning

- **Scalar columns sort by value.** Composite columns are **not sortable** — a sort that
  silently means something other than what it appears to mean is worse than no sort, and the
  header tooltip says so.
- **Sort is view-only and must be visibly distinct from reordering the document.** M2 has no
  document reordering at all, so the risk is a user believing their file changed. Say so in
  the UI, not just in this plan.
- Sorting 2 M rows means an index permutation over `NodeRef`s — an `Int32Array`, not a
  sorted array of row objects (rule 1). Sort keys are decoded on demand; a full decode of
  2 M values to sort them is a "stop and report."
- Pinning a column moves it left of the scrolling region, alongside the row-header column.

**Acceptance:** sorting does not change the row-header column's numbers. Sorting a 2 M-row
group stays responsive or reports why it cannot. A composite column's header shows it is
unsortable rather than silently ignoring the click.

## E7 — Filtering

Quick filter box plus per-column filters. Substring, case-insensitive, over the **displayed**
cell text.

Filtering to a subset must not disturb the row-header column's document-order numbers —
the same reasoning as E6.

**This is not search** (§6, M4). It filters the rendered group's rows. It does not index, it
does not cross documents, and it does not touch the intern table.

**Acceptance:** filtering a 2 M-row group narrows the table without materializing all rows.
Clearing restores the original order and numbering.

## E8 — Copy as CSV / TSV / Markdown

**v1 rule: copy the cell text as displayed**, including derived summaries (§4.3).

This is **knowingly imperfect** and the plan says so on purpose: CSV has no styling, so the
literal/derived distinction is lost on export, and `3 items` can be mistaken for a stored
value. Accepted because export is a convenience feature.

**This task owns a §13 question.** "CSV export semantics — v1 copies displayed text, losing
the literal/derived distinction. What do users actually expect: expansion, a marker, or empty
cells?" Do not answer it by guessing — ship the documented v1 rule and note in
`M2-RESULTS.md` that it is awaiting real usage.

Register all three as palette commands (invariant 10).

**Acceptance:** round-trips through a spreadsheet for a simple grid. Quoting and escaping
are correct for values containing the delimiter, quotes and newlines.

## E9 — Interactions and synchronization

- **Activating a cell selects the corresponding node in every view** (§4.3).
- **Selecting a node always shows that node's own contents**, never the parent's grid with
  the row highlighted (D-018). Row-highlighting would couple table navigation to tree
  navigation at the cost of making it harder to drill into an individual child.
- Composite cells show a **drill-in affordance**, not truncated text — activating it selects
  the composite node, which per D-018 shows *its* contents.
- **Manual grid/list override, remembered per node name for the session.** This is what
  resolves §4.3's single-occurrence ambiguity (`<cars><car/></cars>` — a table of one, or a
  single object?).
- Full keyboard navigation: arrows between cells, `Home`/`End`, page keys, and every action
  reachable from the palette.

**Acceptance:** activating a cell moves Tree, Raw and the breadcrumb together. The override
survives navigating away and back within a session. Keyboard-only operation of every grid
feature.

## E10 — Measurement pass

Write `docs/plans/M2-RESULTS.md` in the shape of `M1-RESULTS.md`. Numbers this milestone owes:

1. **Detection cost** (E1) and **column collection cost** (E3) on `cars-200mb.xml` and
   `cars-500mb.xml`. These are the two that decide whether the straightforward
   implementation ships or needs bounding.
2. **Grid scroll frame time**, both axes, on a 2 M-row group — the grid's own equivalent of
   the Tree measurement M1 owed.
3. **Tree scroll frame time**, inherited from M1: its done-criterion said "tree scrolls with
   no frame over 32 ms" and `M1-RESULTS.md` records it as unmeasured. Same harness, same
   run — cheap to add here, and it closes an open M1 criterion rather than letting it lapse.
4. **Wrap's first-paint cost** (§13), also inherited: D12 asked "is a loading state enough,
   or should the first window be smaller when wrap is about to be turned on? Try both,
   record the result," and M1 did not. Unrelated to the grid, but it is the last M1 question
   still open and it will not get cheaper to answer later.
5. **Peak RSS against the 800 MB bar**, also inherited. `M1-RESULTS.md` reports 776.1 MB for
   `cars-200mb.xml` but its own harness holds the file's bytes twice, so that figure is an
   upper bound containing a known artifact of unknown size — the M1 criterion it was meant
   to satisfy is not actually met. Release the source `ArrayBuffer` before sampling, or read
   through the product's own IPC path, and take the number properly.

§13 questions this milestone should also close: **grid coverage floor** (E1's 5%) and
**wrapper descent depth** (E2's ~3), both against real documents rather than fixtures where
possible.

**Acceptance:** every figure reproduces on a fresh run. Each question above is answered or
explicitly re-scoped with a reason.

---

# Definition of done for M2

- [ ] A node with repeating composite children renders as a grid; the rest fall to list mode
- [ ] The same document shape produces the same grid in XML and JSON, through one code path
- [ ] Literal, derived and absent cells are visually and programmatically distinct
- [ ] Transparent wrappers are descended through, with the skipped path shown and skipped
      comments surfaced
- [ ] Both axes virtualized; `cars-200mb.xml`'s `car` grid scrolls with no frame over 32 ms
- [ ] `aria-rowcount`/`aria-colcount` report document counts; derived cells are labelled for
      screen readers
- [ ] Sort is view-only, scalar-only, and does not renumber the row-header column
- [ ] Copy as CSV/TSV/Markdown, quoting correct, all three in the palette
- [ ] Manual grid/list override, remembered per node name for the session
- [ ] Keyboard-only operation of every grid feature
- [ ] Both themes checked for alternating rows, focus rings and the derived style
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean
- [ ] `docs/plans/M2-RESULTS.md` written; `DECISIONS.md` updated for anything settled
- [ ] **No per-column expansion, no stacked grids, no editing, no search**

## Report back on any of these

- Column collection at 200 MB not fitting a frame budget — E3 names the trap in the obvious
  workaround, and the choice between "brief wait" and "columns that reorder themselves" is
  the user's, not the agent's
- Any place the grid needs to know the format id because `FormatCapabilities` cannot express
  what it needs — that is D-030's unification claim failing, and it is the single most
  important thing this milestone can discover
- Namespace resolution turning out to be unreachable from the store for E1's grouping key
- The 5% floor or the ~3 descent depth producing obviously wrong results on a real document
- Anything in `CONCEPT.md` §4.3 that turns out to be wrong once built. It is the longest and
  most detailed section in the concept, and the least tested against anything real.
