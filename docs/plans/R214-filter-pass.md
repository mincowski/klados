# R214 — the grid filter pass: faster, interruptible, and a cache sized in bytes

<!-- status: open -->

**Open.** Raised by the project lead after R213 (`docs/plans/R213-grid-view-state.md`) measured a
seven-second frozen window switching back to a filtered table on the 200 MB fixture: *"we claim
Klados works well with large files. So we should pay a bit attention to that."* R213's cache fixed
the *second* visit. This round is about the first one, and about typing: the filter pass itself
freezes the window for seconds, cannot be cancelled, and runs again after every pause in typing
longer than the 200 ms debounce — on the 200 MB fixture, a slow typist pays a full pass per character.

**Depends on R213 landing first** — § 1 replaces R213's two-entry rule in `gridResultCache.ts`.

Four parts, in the order they are worth doing:

1. **A memory budget for the result cache** (§ 1) — every table's order kept, up to a byte budget,
   shown in the Statistics panel.
2. **An interruptible pass** (§ 2) — no frozen window, and a stale pass is abandoned.
3. **Narrowing** (§ 3) — each character typed forward scans only the previous matches.
4. **A byte prefilter** (§ 4) — measured before writing this plan, and worth building (§ 4's table),
   but **built only if the differential test in § 4 holds across every format**. The project lead's
   condition: implement it if the tests show a benefit.

## 0. What the pass costs, measured

`spike/r214-filter-pass.ts` (re-runnable: `npx tsx spike/r214-filter-pass.ts [fixture] [runs]`),
Node 24, Windows 11, median of 3 runs, the `<car>` group, 10 visible columns:

| | 10 MB (31,655 rows) | 200 MB (633,268 rows) |
|---|---|---|
| `filterIndices`, full pass, no match | 161 ms | **2,996 ms** |
| structural walk only (attributes, children, name ids) | 17 ms | 321 ms |
| `rowFields`: walk + building cells + **decoding to strings** | 144 ms | 2,763 ms |
| + `toLowerCase` | 139 ms | 2,856 ms |
| `includes` and loop overhead (difference) | 22 ms | 139 ms |
| per row | 5.1 µs | 4.7 µs |

**About 90% of the pass is producing each cell's display text** — the structural walk is ~10%,
folding case and the substring test are noise. That is what § 4 avoids, and why § 3 helps so much:
the cost is per row visited, not per byte compared.

**A discrepancy to explain before anything is built**: the same pass took **5,854 ms** in the
running application (R213 § 9, typing `Golf`), against 2,996 ms here. Either the renderer is twice
as slow at this work as Node, or the pass runs twice per commit. `Grid.tsx`'s `filterResult` memo
depends on `columns`, and anything that gives `columns` a new identity after the commit would rerun
it. **Measure in the renderer first** (a `performance.mark` around `filterIndices`, one commit); if
it runs twice, that is a 2× fix before any of the rest.

## 1. The result cache: a byte budget and a queue

R213 keeps at most two tables' display orders. The project lead's call: keep **every** table's
order, bounded by memory rather than by count, oldest out first.

- **Budget, not count.** An entry costs 4 bytes per *visible* row (`order.byteLength`), so filtered
  tables are cheap and a sorted, unfiltered large group is the expensive case: 2.5 MB for the 633K
  `<car>` group, 8 MB at two million rows. **Provisional budget: 64 MB** — about 25 fully sorted
  car-sized tables, and effectively unlimited for small and medium files. **The value is the project
  lead's call**; a fixed figure is proposed over one scaled to document size because the cost of a
  table is its row count, which a document's byte size predicts badly (a CSV is 4–7× denser in
  rows than XML, `FINDINGS.md`).
- **A queue ordered by when a table was last left.** Leaving a table moves its entry to the back,
  so a table the user keeps returning to is not the first evicted. (Strict first-in-first-out by
  first visit would evict exactly that table; this is what "FIFO" means here, and it is the same
  order R213's code already keeps.) Evict from the front until the new entry fits. **An entry larger
  than the whole budget is not cached** rather than evicting everything for it.
- **Keep what R213 established**: exact matching, only tables with a sort or filter write an entry,
  weak references to the store and buffer, everything dropped by an edit.
- **Shown in the Statistics panel's memory table** as its own row ("Grid views"), next to the undo
  stack — an exact `byteLength` sum, the same kind of figure as every other row there
  (`memoryBudget.ts`), and included in the total. **Render it** (`PLANNING.md` §1) in both themes
  before settling the label.
- **Per document or global?** The cache today is global and filters by tab. A budget per document
  would let one huge file starve nothing else; a global budget is simpler and bounds the app. **The
  plan proposes global**, since the Statistics panel already shows cross-tab memory; say so if not.

## 2. An interruptible pass

The pass runs synchronously inside a `useMemo`, so the window is frozen until it ends and keystrokes
typed meanwhile queue up behind it.

- **Run it in slices** of about 8 ms (~1,600 rows at today's cost; § 0), yielding between slices,
  outside render. The grid keeps showing its previous rows until the pass finishes.
- **A new commit cancels the running pass.** No pass ever finishes for a filter the user has already
  changed.
- **Feedback while it runs.** Something must say the table is not yet filtered — a quiet progress
  indication by the quick filter box, not a modal or a spinner over the grid. **A visual decision:
  render candidates and let the project lead choose** (`PLANNING.md` §1). It should not appear at all
  for a pass that finishes within a frame or two, or small files will flicker.
- **The sort is the same problem** (0.9 s on the 200 MB fixture, R213 § 9) and shares the mechanism
  if it can be sliced; a comparison sort cannot be paused mid-way as simply as a scan. **The round
  says whether the sort is included**, and if not, records it as owed.
- **Every consumer of the order must cope with "not ready yet"**: the grid, the row count in the
  header, `Copy Grid as …` (which must use a finished order, or wait), R213's cache write on unmount
  (which must not store a partial order), and the keyboard navigation bounds.

## 3. Narrowing

When the new quick filter contains the previous one (`Gol` → `Golf`), only rows that matched the
previous one **anywhere** can match — visible *or* hidden columns, since hidden matches are counted
too (R34 §5). Measured: **186 ms instead of 2,937 ms** on the 200 MB fixture, identical result.

- Keep the previous pass's "matched anywhere" row set alongside its result. It is O(matches), and
  one per mounted grid — not cached, dropped with the grid.
- Only for the quick filter's *extension*; deleting a character, changing a column filter, or
  showing a different column set runs a full pass. A column filter can narrow the same way, per
  column; the round decides whether that is worth it.
- Typing forward is the common case this exists for: each character gets cheaper.

## 4. The byte prefilter — measured, and conditional

**The idea.** A row can only match if its own value bytes contain the needle, so scan bytes first —
no decoding — and run the unchanged exact check only on the rows that pass. The exact check stays
the one source of truth; the prefilter only removes rows, so its result is identical *if* it never
removes a row that would have matched.

**Why that "if" is the whole round.** The quick filter matches **displayed** cell text, which is not
the bytes:

- **Separators** join parts: `diesel · 110`, `Smith, Jones`, mixed content joined by spaces. A needle
  spanning one (`Golf, Po`) is in no single value's bytes.
- **Generated labels**: `3 items`, `4 fields`, `0 items`. Their digits and words exist in no byte.
- **`toLowerCase` maps two non-ASCII characters to ASCII**: U+212A KELVIN SIGN to `k`, U+0130 to `i̇`.
- **Removed or bounded text** (quote stripping, the 120-character cell bound, trimming) only ever
  makes the display a *subset* of the bytes — a false candidate, never a missed row. Safe.
- **Markup is not display**: scanning a row's whole span matches its tag names, so `car` made every
  row a candidate. Scanning only value spans fixes that.

**The rule the bench implements**, and the round must re-derive rather than copy:

1. Split the needle on the separator characters; take the **longest ASCII run** as the token. A
   needle with no ASCII run is not prefiltered.
2. If the token contains `k` or `i` and the group's bytes contain U+212A or U+0130, not prefiltered.
3. A row is a candidate if its attribute values, or the own values of any node in its subtree,
   contain the token (ASCII case-folded).
4. If the token is all digits or a substring of `items`/`fields`, a row is **also** a candidate if any
   of its cells could show a generated count (a repeated composite field, or a composite whose
   children carry no value).

**Measured**, 200 MB fixture; every result compared for exact equality (indices, hidden-match count,
hidden-match columns) and a mismatch aborts the bench:

| needle | matches | candidates | today | prefiltered | |
|---|---|---|---|---|---|
| `Golf` | 39,654 | 39,654 | 2,851 ms | 500 ms | 5.7× |
| `WVW99` | 7,130 | 7,130 | 2,842 ms | 342 ms | 8.3× |
| `zzzz` | 0 | 0 | 2,854 ms | 310 ms | 9.2× |
| `car` (a tag name) | 0 | 0 | 2,875 ms | 331 ms | 8.7× |
| `Zaragoza` | 126,417 | 126,417 | 2,816 ms | 887 ms | 3.2× |
| `electric` | 159,003 | 159,003 | 3,328 ms | 1,542 ms | 2.2× |
| `2016` | 23,500 | 23,500 | 3,098 ms | 1,073 ms | 2.9× |
| `hybrid 1` (spans a separator) | 0 | 157,885 | 2,836 ms | 947 ms | 3.0× |
| `e` (in almost every row) | 621,836 | 621,836 | 2,659 ms | 2,953 ms | **0.9×** |

The scan alone is **~290 ms** per 633K rows; everything above it is the exact check on candidates.
The 10 MB fixture shows the same shape (3–9×). A first version that scanned whole row spans was
slower (`car` 1.0×, and digit and `k`/`i` needles fell back): recorded in the bench as section 2.

**What the bench does not prove**, and the round must:

- **Correctness beyond one fixture.** The cars fixture has no repeated composites, no JSON arrays, no
  mixed content and no KELVIN SIGN. **Acceptance for this part is a differential property test**:
  generated XML, JSON, TOML and CSV documents (XML and TOML generators exist in
  `test/xmlFormat.test.ts` and `test/tomlFormat.test.ts`; JSON and CSV need one), random
  needles drawn from their own cell text plus separators, digits, `items`, `k`, `i`, and injected
  U+212A/U+0130 — prefiltered result equal to the plain pass, every time. **If it cannot be made to
  hold, § 4 is not built**, and the rest of the round stands without it.
- **Per-column filters** use the same rule scoped to one column's spans; not measured yet.
- **A losing case exists**: a needle in nearly every row costs ~10% more. Guard it — stop
  prefiltering once candidates pass a measured fraction of the rows, and fall back.
- **The group scan for U+212A/U+0130 costs 516 ms** on 200 MB as written, a byte loop. Do it once
  per document (or with `Uint8Array.prototype.indexOf` on the lead byte), not per filter.
- **The 2× renderer discrepancy** in § 0 may change every absolute figure here; the ratios are what
  matter.
- **Non-ASCII needles** keep the decoded path, except that an ASCII run inside them can still serve
  as the token.

## 5. Non-functional expectations (`PLANNING.md` §3)

- **No frozen window from the filter**: on the 200 MB fixture no main-thread task longer than
  ~50 ms while a filter runs, measured with a long-task observer in the built application.
- **Typing forward** (`G`, `Go`, `Gol`, `Golf`, a character every 400 ms) on 200 MB: each commit
  after the first finishes in under half a second.
- **A first filter** on 200 MB: measured before and after, stated, with § 4's contribution separable.
- **Cache memory never exceeds the budget**, asserted in bytes; the Statistics panel figure equals
  the cache's own sum.
- **Small files do not regress**: the 10 MB fixture's filter and switch times from R213 § 9 stay
  within noise, and no progress indication flickers on them.

## 6. Acceptance

1. § 0's discrepancy explained, and fixed if the pass runs twice.
2. The cache holds every table's order within the byte budget, oldest-left first out; an entry larger
   than the budget is not cached; asserted in bytes.
3. The Statistics panel shows the cache's size, rendered in both themes, and the total includes it.
4. The filter pass never freezes the window on the 200 MB fixture (§ 5), and a changed filter cancels
   the running pass.
5. The progress indication is chosen from renderings, and does not appear for fast passes.
6. Narrowing gives identical results to a full pass (visible and hidden matches), asserted, and meets
   § 5's typing figure.
7. **§ 4 is built only if the differential property test holds across XML, JSON, TOML and CSV**; if
   built, its guard against common needles is measured, and results equal the plain pass.
8. Export, keyboard bounds, row counts and R213's cache write never see a partial order.
9. Before/after figures for § 5 recorded in the Results section, on both fixtures.
10. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 7. Rejected

**Moving the pass to a worker.** The renderer owns the store and reads it synchronously (D-044); a
worker would need the store's buffers shared or copied, for a pass slicing already keeps off the
frame budget.

**A per-document index of cell text** (an inverted index or trigram set built at load). It would make
filtering near-instant, and it is O(document) memory and load time spent on every file for a feature
many sessions never use — the opposite trade from § 1's budget.

**Caching filter results per needle** (so deleting a character is instant too). Narrowing covers the
common direction; the other direction is a full pass, sliced.

**A bitset per filter result** (1 bit per row, 80 KB for 633K rows) instead of an index array. Smaller
for results that keep most rows, but a sorted order still needs 4 bytes per row, and with § 1's
budget the saving does not pay for a second representation.

## 8. Version

**Ask on landing.**
