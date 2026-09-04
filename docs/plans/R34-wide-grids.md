# R34 — the grid on wide tables

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Decision: `docs/DECISIONS.md` D-066.

Prompted by the CSV question — can the existing grid carry a table with hundreds of columns without
new views or architectural change? — but **none of this is CSV-specific.** Every defect here is
live today for any XML or JSON document with more than 60 columns. CSV would only make wide
documents routine instead of rare, so this round stands on its own merits whether or not CSV is
ever built.

---

## 1. What was measured

A wide table pushed through the real `detectGrid` → `collectColumns` → `isNumericColumn` path
(harness was scratch, not committed; regenerate from §5's fixture description if needed):

| rows × cols | source | nodes | parse | **collectColumns** | numeric | store | rendered |
|---|---|---|---|---|---|---|---|
| 20k × 6 | 1.9 MB | 140k | 86 ms | **10 ms** | 5 ms | 2.79× | 6 |
| 20k × 20 | 6.5 MB | 420k | 152 ms | **29 ms** | 6 ms | 2.45× | 20 |
| 20k × 50 | 16.7 MB | 1.0M | 390 ms | **89 ms** | 20 ms | 2.32× | 50 |
| 20k × 100 | 34.7 MB | 2.0M | 664 ms | **252 ms** | 38 ms | 2.21× | 60 (+40) |
| 20k × 200 | 74.7 MB | 4.0M | 1359 ms | **824 ms** | 65 ms | 2.04× | 60 (+140) |
| 5k × 500 | 47.8 MB | 2.5M | 987 ms | **1165 ms** | 156 ms | 1.99× | 60 (+440) |
| 2k × 1000 | 38.5 MB | 2.0M | 731 ms | **1603 ms** | 303 ms | 1.98× | 60 (+940) |

**The good news, and it is the answer to the original question: rendering is already bounded.** The
grid virtualizes columns (`colVirtualizer`, `horizontal: true`) *and* caps rendered columns at
`GRID_COLUMN_CAP = 60`, so a 1000-column table puts 60 columns in the DOM. Width never reaches the
renderer. **No new view work is needed.**

Everything below is a bounded, local fix to something behind that.

---

## 2. `collectColumns` is O(rows × columns²)

At fixed 20k rows, 50 → 200 columns (4×) costs 89 → 824 ms (9.4×). Per-field cost rises from 82 ns
at 6 columns to 213 ns at 200 to 872 ns at 1000.

The cause is documented in the code, and the comment states the assumption it rests on:

> *"A member's fan-out is ~6 fields, where a linear scan beats a `Map` lookup outright"*

`findField` scans the member's own field list linearly for every field on every member. That is
correct for XML and JSON, where fan-out really is ~6. A table breaks it: every row has exactly as
many fields as the table has columns.

**Fix: hybrid.** Keep the linear scan below a threshold (~16 fields, where it genuinely wins) and
switch to a `Map` above it. The scratch arrays and the per-member reuse that E10's rewrite
introduced all stay — this changes the lookup inside them, nothing else. **Keep that rewrite's
own measured wins intact**; re-run its `cars-200mb.xml` figure to prove the narrow case did not
regress, because that is exactly what a naive "just use a Map" would break.

Extrapolated: a 500 MB, 200-column CSV spends ~13 s here today, ~3–4 s after.

---

## 3. `numericColumns` runs over every column, on every change

```ts
const numericColumns = useMemo(
  () => new Set(orderedColumns.filter((c) => isNumericColumn(...)).map((c) => c.nameId)),
  [orderedColumns, store, sourceBuffer, members]
)
```

`isNumericColumn` is individually bounded (200 present values, 5000 rows scanned) but it runs for
**every ordered column, not the rendered ones** — and the memo depends on `orderedColumns`, so
**every tick in the column picker re-runs the entire set**. Ticking 940 checkboxes means 940
increasingly expensive synchronous recomputes; the last one blocks for ~300 ms at 2k rows and
~750 ms once the 5000-row scan limit is reached.

**Fix: memoize per `nameId`** so a newly shown column costs one column's work rather than all of
them, and compute lazily for columns actually rendered. It only decides text alignment and sort
comparison — the same "expensive answer to a cosmetic question" shape `isNumericColumn` was already
cut down for once (1522 ms → sampled), now on the other axis.

---

## 4. Pinned columns bypass the virtualizer

`pinned` is a plain `Set` with no limit, and both `GridHeaderRow` and `GridBodyRow` do:

```ts
const pinnedColumns = orderedColumns.slice(0, pinnedCount)
...
{pinnedColumns.map((column, i) => ( ... ))}
```

That runs **outside** `colVirtualizer`, once per visible row. Pin 100 columns × ~50 visible rows =
5000 live cells; pin 1000 and virtualization is gone entirely. This is the only genuinely unbounded
rendering path in the grid, and it is reachable today on any wide document.

**A cap was proposed and rejected** (D-066): it reads as an arbitrary restriction, and pin order is
legitimately used to arrange columns — for a screenshot, or just to read two distant columns
together.

**Fix: degrade instead of forbidding.** Sticky positioning is meaningless once pinned width exceeds
the viewport — you have not kept anything in sight, you have filled the screen. So pin as many as
you like; only the ones that *fit* stay sticky, and the rest render as ordinary **virtualized**
leading columns in the same order. `orderedColumns` is already `[pinned…, rest…]`, so this is a
change to how `pinnedCount` splits into "sticky" versus "virtualized", not a new mechanism.

Worth naming separately, not built here: what pin order is being used for is **column reordering**.
If that is wanted, it deserves to be its own affordance rather than a side effect of pinning.

---

## 5. The quick filter — rewrite row-major, scope visibly (D-066)

Today `filterIndices` is **column-major**, and both problems come from that one shape:

```ts
const anyMatch = columns.some((c) =>
  cellTextLower(store, source, row, c.nameId).includes(quick)
)
```

- **Incomplete.** `columns` is the *visible* set, so a row whose only match sits in an unticked
  overflow column is silently dropped. The grid looks like it answered "rows matching anywhere" and
  actually answered "rows matching in the 60 columns I happen to be showing."
- **Slow.** `cellOf` finds a cell by scanning the row's attributes and then its children for a
  matching `nameId`, and decodes text per cell. So this is O(visibleColumns × rowFanOut) per row —
  on a 1000-field row with 60 visible columns, 60,000 operations per row, *with* the cap.

**Fix: iterate the row's own fields once.** O(rowFanOut) per row, ~60× less work on that row, and
the gap widens as tables get wider. Correct by construction, since `collectColumns` collects every
distinct field name — "all the row's fields" and "all collected columns" are the same set.

**Scope stays visible-column, and the scan reports what it excluded.** Restricting the match to
visible columns is one `Set` lookup per field, and counting rows that matched *only* in hidden
columns is free in the same pass:

> `12 rows` — *47 more match in hidden columns* **[show]**

Clicking it reveals **the columns that actually matched**, bounded by the result rather than by the
overflow list — which answers "why did this row match?" precisely, without layout shifting under
the user as they type. **Do not auto-enable columns while typing.**

### Not changed, and why

- **Per-column filters already handle this correctly.** Un-ticking a column clears its filter, drops
  the sort if sorted by it, and unpins it — with a comment saying exactly why. Leave it alone.
- **Export stays scoped to visible columns.** `exportGrid` takes `orderedColumns`, and "export what
  I am looking at" is a defensible contract rather than a correctness bug. Revisit only if it bites.

---

## 6. The column cap stays, and can be generous

`GRID_COLUMN_CAP = 60` stays as a *display* default. Once §5 lands, the cap no longer affects what
the filter finds, which is what made it feel wrong — it becomes purely "how many columns are shown
before you choose more," and the picker's ceiling can be high.

**A hard ceiling on the picker is still worth having** to keep §3 and §4 honest, but it should be
high enough never to be met in ordinary use, and it must say why when it is met.

---

## 7. Verify in the real app

**The measurements in §1 are headless — the data path only.** Actual DOM rendering, scroll frame
time with 60 columns live, and horizontal scrolling smoothness were **not** measured. That needs
the browser project (R10), and it is the cheaper half of the work.

Assert, against real Chromium:

- A wide table (≥200 columns) renders a bounded number of cells — count them; this is the
  regression guard for §4.
- Ticking a column in the picker does not re-run `isNumericColumn` for every column (§3) — assert
  the call count, not the wall time.
- The quick filter's excluded-match count is correct against a document with a known match in a
  hidden column (§5).

---

## 8. A finding for `docs/FINDINGS.md`, not a task

The node store measured **~2.0–2.8× the XML source** across §1's fixtures. CSV encodes the same
node count in roughly 2.5× fewer bytes — no tags, no closing tags — so the same table as CSV costs
**~4–7× the file size**. A 200 MB CSV would be ~1 GB of node store alone, against §8's ~2.5×
budget.

That is inherent to modelling every field as a node (D-030), not a grid defect and not fixable
here. It means **CSV's practical ceiling is lower than XML's** — roughly 100–200 MB rather than
500 MB — and it should be stated before anyone promises otherwise.

---

## Results — built

All of §2–§6 landed; §7's browser-project assertions are in `test/grid.test.tsx`, alongside the
existing headless `gridColumns.test.ts`/`gridSort.test.ts`/`gridFilter.test.ts` coverage.

- **§2** (`gridColumns.ts`): `collectColumns`'s `findField` is now hybrid — a linear scan below 16
  fields per member (where it still wins, per the original measurement), a `Map` at and above it,
  built lazily from whatever the linear scan already found the moment a member crosses the
  threshold. Re-measured against a synthetic wide-table harness (scratch, matching §1's own note
  that it's regenerable, not committed): 20k×200 dropped from the plan's 824 ms to 343 ms, 5k×500
  from 1165 ms to 207 ms, 2k×1000 from 1603 ms to 196 ms. The narrow case (20k×6, ~10 ms) was
  unaffected, confirming the threshold keeps E10's original win intact.
- **§3** (`Grid.tsx`): `numericColumns` replaced by an `isNumeric(column)` accessor backed by a
  `Map<nameId, boolean>` cache, reset only when `store`/`sourceBuffer`/`members` change (a genuinely
  new document), not on every `orderedColumns` change. Ticking one column in the picker now costs
  that column's own answer, not the whole set's.
- **§4** (`Grid.tsx`): pinning has no cap (D-066's rejection of one stands). Instead, a
  `ResizeObserver` on the scroll container tracks viewport width, and `stickyCount =
  min(pinnedCount, columns that fit)` decides the sticky/virtualized split — `orderedColumns` is
  already `[pinned…, rest…]`, so pins beyond what fits simply render as ordinary virtualized leading
  columns, same order, never bypassing the virtualizer. `GridHeaderRow`/`GridFilterRow`/
  `GridBodyRow`'s `pinnedCount` prop is renamed `stickyCount` throughout to name what it now means.
- **§5** (`gridCell.ts`/`gridFilter.ts`): `gridCell.ts` gained `rowFields`, a single O(rowFanOut)
  structural pass over a row's own attributes and children (the same attribute-wins tie-break
  `collectColumns` uses), decoding each distinct field once — factored out of `cellOf` without
  changing its behavior. `filterIndices` is row-major now: one `rowFields` call per row, each
  field checked against the visible-column `Set` once. It returns `{ indices, hiddenMatchCount,
  hiddenMatchColumns }` instead of a bare array — a match confined to a column outside the visible
  set is excluded from `indices` (scope stays visible-column, per §5's own "not changed" section)
  but counted, and the distinct hidden columns that matched are named. `Grid.tsx` surfaces this as
  a "`N` more match in hidden columns" toggle beside the quick filter; clicking it reveals the
  matched column names in a small list — never auto-enabled, never while typing.
- **§6** (`gridColumns.ts`): `GRID_COLUMN_CAP` stays at 60 as a display default. A new
  `GRID_COLUMN_PICKER_CAP = 500` bounds the picker itself — generous relative to §1's measured
  1000-column case, disabled (not hidden) once reached, with a notification stating why on the
  attempt that hits it.
- **§7**: `test/grid.test.tsx` (real Chromium) asserts a >=200-column table renders a bounded cell
  count (§4's regression guard), that ticking a picker checkbox doesn't re-run `isNumericColumn`
  for every column (§3, call-count via a `vi.mock` wrapper — `vi.spyOn` can't touch an ESM named
  export in Vitest's browser mode), and that the quick filter's hidden-match count and revealed
  column name are correct against a document with a known match in an overflow column (§5).

`npm run typecheck`, `npm run lint` (baseline warnings only), `npx stylelint`, and the full
`vitest` suite (100 files, 1177 tests, node + browser projects) are all clean.
