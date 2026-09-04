# R39–R40 — two grid follow-ups from using the table

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Decision: `docs/DECISIONS.md` D-068 (R39).

Both reported from the Detail pane's grid on `cars-10mb.xml`. Unrelated to each other beyond the
pane they live in; grouped because both are small and both are corrections to shipped behaviour.

---

## R39 — export throws away the distinction the grid displays

### What was reported

The `sunroof` column renders as a tick-mark column in the grid — some cars have `<sunroof/>`, others
have no such element — and exports as **entirely empty**.

### What is actually happening

The grid draws three different things (`Grid.tsx`'s `GridBodyCell`):

| cell state | grid shows |
|---|---|
| `CellKind.Absent` — no such field on this row | `—` |
| present, `text === null` — the field exists with no value (`<sunroof/>`) | `✓` |
| present with text | the text |

Export collapses the first two into one:

```ts
return cellOf(store, source, row, column.nameId).text ?? ''     // gridExport.ts
```

`gridExport.ts`'s own comment already admits it — *"absent and empty-but-present both export blank,
indistinguishably"* — recorded as a v1 imperfection. On a column where **every** present cell is a
presence marker, that imperfection is the entire column: the export contains no information at all.

This is not CSV-specific. `exportGrid` serves all three buttons, so Copy CSV, Copy TSV and Copy
Markdown are all affected.

### The fix, in two layers

**Layer 1 — per cell, no classification needed.** A presence marker exports as a token instead of
blank; `Absent` stays blank. This alone fixes the report: `sunroof` becomes a column of `true` and
empty rather than nothing at all.

**Layer 2 — per column, which is the report's own suggestion.** If every present cell in a column
is a presence marker, then the column really is boolean-shaped, and `Absent` means `false` rather
than "no such field". Exporting `true`/`false` is materially more useful to a spreadsheet than
`true`/blank.

### Why the column classification can be exact here, unlike `isNumericColumn`

The report asks whether the existing tick-mark detection can be built on. It can't directly — the
tick mark is a *per-cell* decision (`text === null`), not a column property, so there is no existing
column classifier to reuse. The nearest thing is `isNumericColumn`, which **samples** (200 present
values, 5000 rows scanned) because it must answer before the grid paints.

**Export is not under that constraint, and this matters more than it looks.** Sampling is fine for
deciding text alignment — a wrong answer is cosmetic. Sampling to decide whether an absent cell
exports as `false` would put wrong *data* in the output whenever row 20,000 disagrees with the first
200. Export already walks every row it emits, so it can classify exactly, and it should.

**Do it in one pass, not two.** The obvious implementation — classify, then serialize — doubles the
`cellOf` calls. R34 measured `cellOf`'s shape (O(row fan-out) per lookup, scanning the row's
attributes then its children); that it therefore dominates a wide export follows by inspection —
export is `rows × columns` such lookups and nothing else expensive — but was **not** separately
measured, so treat the doubling as a thing to avoid rather than a figure to quote. Instead decode each row once into a per-column buffer, track two
flags per column (`sawText`, `sawMarker`) as you go, and resolve the tokens in a final pass over the
already-decoded strings. No extra store access at all.

### The tokens

| format | presence marker | absent, boolean-shaped column | absent, ordinary column |
|---|---|---|---|
| CSV / TSV | `true` | `false` | *(empty)* |
| Markdown | `✓` | *(empty)* | *(empty)* |

The per-format divergence is deliberate and the file already works this way (`delimitedField` vs
`markdownField`): `gridExport.ts`'s own comment says the delimited formats target "a spreadsheet or
another program", where `true`/`false` parse natively, while Markdown is read by a person, where the
grid's own `✓` is the more faithful reproduction of what was on screen.

### Not changed

- **Export stays scoped to visible columns** (`docs/plans/R34-wide-grids.md` §5). This round is about what
  a cell *contains*, not which columns are included.
- **The literal/derived distinction stays unexported.** It is a different v1 imperfection recorded
  in the same comment, and unlike this one it does not empty a whole column.
- **A cell with `multiplicity > 1`** already exports its joined text; the `×2` badge remains a
  display-only affordance.

### Verify

- A fixture with a genuinely boolean-shaped column exports `true`/`false`; the same column with one
  row given real text exports that text, `true`, and blank — i.e. layer 2 correctly declines.
- A column where the marker rows sit **past** any plausible sample window (row 5000+) still
  classifies correctly — this is the assertion that proves the exact classification, and it is the
  one a sampled implementation would fail.
- Export cost on a wide table does not regress against R34's figures (the one-pass requirement).

---

## R40 — the row-number column is taller than the cells beside it

### Measured

Real Electron, `cars-10mb.xml`, one grid row:

| cell | `position` | rendered height |
|---|---|---|
| `.grid-row` (the row itself) | absolute | **23 px** (`ROW_HEIGHT`) |
| `.grid-row-header-cell` (the `#` column) | `sticky` | **23 px** |
| ordinary virtualized cell | `absolute` | **18.4 px** |
| `.grid-cell-derived` (italic) | `absolute` | **20 px** |

So it is not only the row-number cell disagreeing with the rest — **the body cells disagree with
each other**, because an italic derived cell's line box is taller than an upright one.

### Cause

`.grid-row` is `display: flex`, so anything left in flow stretches to the row's height. The
row-header cell and the pinned cells are `position: sticky`, which keeps them flex items — they get
23 px. The virtualized cells are `position: absolute; top: 0` with **no height**, which takes them
out of flow entirely, so they shrink to their own content.

That is also why this survived review: pin a column and it looks correct, because a pinned cell is
sticky.

### Fix

Give the absolutely-positioned body cells the row's height — `height: '100%'` alongside the existing
inline `top: 0`, or `bottom: 0`. The project lead's preference is the taller height, which is
`ROW_HEIGHT` and therefore already what the row is; nothing else changes.

Check the header row and the filter row in the same pass — both use `.grid-cell` with the same
sticky/absolute split, so both plausibly have the same discrepancy.

### Verify

Browser project: every `.grid-cell` in a row reports the same `getBoundingClientRect().height` as
its `.grid-row`, on a row containing at least one derived (italic) cell and one absent cell. jsdom
cannot answer this — it is the exact class of bug `docs/FINDINGS.md`'s "real layout needs the
browser project" entry exists for.

---

## Results — built

**R39** landed as the plan specified: `gridExport.ts`'s `decodeExportRow` calls `rowFields` once
per row (R34's own O(rowFanOut) primitive), classifying each visible column's cell as `Absent`,
`Marker` (present, `text === null`), or `Text`. `isBooleanShaped` then does one more pass per
column — `true` only if every row's cell for that column was `Absent` or `Marker`, never `Text` —
and a final resolve pass serializes per the plan's own token table (`true`/`false`/blank for
CSV/TSV, `✓`/blank/blank for Markdown). No `cellOf` call happens more than once per row regardless
of column count, satisfying the "one pass" requirement without a separate classify-then-serialize
split.

`estimateExportBytes` (the confirmation-dialog size estimate, sampling ≤20 rows) was left calling
`cellOf` directly rather than routed through the new per-row decode — it doesn't need the one-pass
guarantee at that sample size, and reusing `decodeExportRow`'s richer per-row `Map` there would
have been machinery this narrow, small-sample use has no reason to pay for.

**R40** landed as specified: the virtualized body cell's inline style (`Grid.tsx`, the
`colVirtualizer.getVirtualItems().map` branch inside `GridBodyRow`) gained `height: '100%'`
alongside its existing `top: 0` — matching what the header row and filter row's own virtualized
cells already had. Checking those two (per the plan's own instruction) confirmed they did not
share the bug; only the body cell was missing it.

`test/gridExport.test.ts` gained an `exportGrid — presence markers (R39)` block: a genuinely
boolean-shaped column exports `true`/`false` (and `✓`/blank for Markdown); a column with one row
given real text declines the boolean classification; and a fixture with marker rows starting past
row 5000 — deliberately past any plausible sample window — still classifies exactly, the assertion
a sampled classifier (`isNumericColumn`'s own shape) would fail. Each "absent" row in these
fixtures carries an unrelated `name` field so it still qualifies as a group member at all
(`collectGroupMembers` requires `hasChildren` — a `<car></car>` with literally nothing inside it
isn't a row, an early finding that reshaped the fixtures before the assertions were even written).

`test/grid.test.tsx` gained a `Grid row height (R40)` block: every `.grid-cell` in a row (including
a derived/italic one and an absent one) reports the same `getBoundingClientRect().height` as its
`.grid-row`, run in the browser project since jsdom has no real layout to measure this against.

`npm run typecheck` and the full `vitest` suite (101 files, 1196 tests) are clean.
