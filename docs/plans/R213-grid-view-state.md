# R213 — keep a table's sort, columns and filters when switching group tabs

<!-- status: built -->

**Built.** A table keeps its sort, extra columns, pins and widths per group name per document, and
its filters, filter row, active cell and scroll offset per node — § 3's split, built as recommended.
Both node switching and tab switching are covered (§ 2). **§ 5's measurement turned out too slow on
the 200 MB fixture** (7.0 s to switch back to a filtered, sorted group), so the project lead chose a
bounded cache of display order, which § 7 had rejected in its unbounded form: switching back is now
0.5 s. **The mechanism § 3 said to verify was worse than it assumed**: not only a full reparse but
*every edit* replaces the store, which had been silently resetting R211's remembered tab on each
keystroke. D-105 records the keying and the cache. See § 9.

Raised by the project lead while accepting R211's tabs: switching to another group and back resets
the table, and *"we'll have to keep the sorting etc"*. R211 recorded it as a known limitation
(D-104) rather than an oversight, because keeping every group's grid mounted to preserve the state
would reintroduce the cost the tabs removed. This plan is the other way to keep it.

## 1. What is lost today, from the code

`Grid.tsx` holds all of its view state in component state, and `Detail.tsx` renders it with
`key={selectedTable.nameId}`, so a tab switch **unmounts the grid and discards everything below**.
Read from `Grid.tsx`, not recalled:

| State | Shape | Keyed by | Worth keeping? |
|---|---|---|---|
| `sort` | `{ nameId, direction }` | column name id | **yes** — the case raised |
| `extraColumns` | `Set<nameId>` | column name id | **yes** — the column picker's selection |
| `pinned` | `Set<nameId>` | column name id | **yes** |
| `widthOverrides` | `Map<nameId, px>` | column name id | **yes** — a resized column snapping back reads as a bug |
| `filters` / `filterInputs` | `{ quick, perColumn: Map<nameId, string> }` | column name id | **decision, § 3** |
| `filterRowOpen` | `boolean` | — | yes, with filters |
| `active` | `{ row, col }` | display position | decision, § 3 |
| scroll offset | on `parentRef` | display position | decision, § 3 |
| `pickerOpen`, `hiddenMatchesOpen`, `pendingExport` | transient | — | **no** — open menus and a pending confirmation must not reappear |

**Every piece worth keeping is O(columns), keyed by column name id. None of it is O(rows).** That is
what makes this cheap to store and is the property § 5 protects.

## 2. Tabs are the visible case, not the only one

The same state is also lost when the user selects another node and comes back: `Detail` renders the
selected node, so leaving it unmounts its grid. That was always true and rarely noticed, because it
took navigating away and back. R211 made the same loss one click away, on a control whose whole
purpose is going back and forth — which is why it surfaced now.

**The round must say which of the two it covers.** Tab switching is the requirement. Node switching
falls out of the same mechanism almost for free, depending on the keying in § 3 — but it also
changes behaviour that has been stable since M2, so it is a decision, not a side effect.

## 3. The decision this round has to make: what the state is keyed by

R211 already made one choice of this kind: **the selected tab is remembered by group name per
document** (`GridGroupPicker.tsx`), so stepping between sibling `<shelf>` nodes keeps `magazine`
open. The candidates here:

- **(a) Per group name, per document.** Sorting `book` by `year` on one shelf means every `book`
  table in the document sorts by `year`. Consistent with R211's tab memory, and it covers node
  switching too. **Right for the shape of a table** — sort, extra columns, pins, widths — because
  those describe how the user wants to read *that kind of record*.
- **(b) Per node and group.** Exactly "this table as I left it". **Right for filters**, because a
  filter describes content: carried to a sibling shelf, a quick filter of `Buddenbrooks` shows an
  empty table with nothing on screen explaining why — the same unexplained-emptiness this project
  has now fixed twice (the coverage cliff, the CSV rows).

**Provisional recommendation: split it.** Shape state keyed as (a); filters, the filter row, the
active cell and the scroll offset keyed as (b). This needs the project lead's call before building,
because it is the difference between "the app remembers how I like `book` tables" and "the app
remembers this one table".

**A mechanism the round must verify before relying on it** (`PLANNING.md` §2): whether column name
ids survive an edit. R211's tab memory is keyed by `NodeStore` and is lost when a reparse replaces
the store — acceptable for one remembered tab, less so for a carefully sorted, pinned, resized
table. Whether a splice keeps the interner (and so the ids) and whether a full reparse does not is
to be **checked against `subtreeSplice.ts` and the reparse path**, not assumed. If ids do not
survive, key durable state by column *name text* and resolve it to ids on restore. Node refs are
the less stable half of (b): they shift under edits, so (b) may need to be "until the document is
edited" and say so.

## 4. Mechanism

Lift the persistent half of `Grid`'s state out of the component into a small store — the same
module-level `WeakMap<NodeStore, …>` shape as R211's `rememberedGroup`, so it is scoped to one open
document and dropped with it. `Grid` is initialised from it on mount and writes back on change. **The
grid is still unmounted on a tab switch**; only its view state survives.

On restore:

- **Columns that no longer exist are dropped silently.** An edit can remove the column a sort or pin
  refers to; restoring must not throw, must not sort by nothing, and must not leave a ghost pin.
- **Filters commit immediately**, not through the 200 ms keystroke debounce (`FILTER_DEBOUNCE_MS`) —
  a restored filter is not typing.
- **Transient state never restores** (§ 1's last row).

## 5. Non-functional expectations (`PLANNING.md` §3)

- **Store view state, never results.** Do not cache `displayIndices` or a sorted order per group: an
  `Int32Array` of display indices is 4 bytes per row, **8 MB per group for a two-million-row group**,
  and one per group per document is exactly the O(rows) retention invariant 2's spirit rules out.
  Restoring re-derives the order from the stored `{ nameId, direction }` and filters.
- **So restoring costs a filter pass and a sort** — O(members) and O(n log n) over that group — on
  every switch back. **The round measures that switch latency** on `spike/fixtures/cars-10mb.xml`
  and the 200 MB fixture and records it. If it is too slow, that measurement is where caching is
  reconsidered, with its memory stated; not before.
- **Nothing per keystroke becomes more expensive.** Writing state back on change must not add work
  to the filter-typing path the debounce exists to protect.

## 6. Acceptance

1. Sort a group, switch to another tab and back: **same column, same direction**.
2. The column picker's extra columns, pinned columns and resized widths survive the same round trip.
3. **Groups do not share state**: sorting `book` leaves `magazine` unsorted.
4. Filters behave as § 3 decides, asserted both ways — kept where they should be, *not* carried where
   they should not.
5. A restored sort or pin naming a column that no longer exists is dropped without an error, and
   the table renders.
6. Open menus and a pending export confirmation do not reappear after a switch.
7. The stored state holds nothing sized by row count — asserted on its shape.
8. The palette's `Copy Grid as CSV/TSV/Markdown` export the **restored** order and filters.
9. Switch latency on the 10 MB and 200 MB fixtures is measured and recorded (§ 5).
10. Whether column name ids survive a splice and a full reparse is verified and recorded (§ 3), and
    the keying follows from what was found.
11. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 7. Rejected

**Keeping every group's grid mounted and hidden.** Preserves everything with no new code, and is
the cost D-104 rejected the stack for: one live virtualizer and one column collection per group,
whatever the group count.

**Caching sorted or filtered index arrays.** O(rows) per group per document (§ 5).

**Persisting view state across application restarts.** Session restore persists paths only (R29,
by design); widening it is a separate question with its own privacy and staleness answers.

## 8. Version

**Ask on landing.** Candidate: patch — behaviour the user already expects, no new capability.

## 9. Results — built

### What landed

- **`gridViewState.ts`** — the view state, keyed as § 3 recommended: **shape** (sort, extra
  columns, pins, widths) per group name per document; **contents** (quick and column filters, the
  filter row, the active cell, the scroll offset) per node and group. Names are stored as text and
  resolved to this grid's column ids at mount. A name the group lacks is dropped on restore and
  **kept in the stored shape**, so changing a sibling's table does not erase what another node's had.
  Contents are bounded to 200 nodes per document (oldest out), an untouched table writes nothing, and
  contents written under a different node count are discarded because a node ref is a position.
- **`Grid.tsx`** — initialised from it at mount; the shape written when it changes (never per filter
  keystroke), the contents written once at unmount. **The text in the filter boxes** is what is kept,
  not the debounced commit, so a filter typed a moment before switching away survives. Filters restore
  committed, not through the debounce. The scroll offset restores before the first paint
  (`initialOffset`), and the effects that follow the active cell no longer run until it moves.
- **`Detail.tsx`** — the grid is keyed per interner, node and group, so a node switch remounts it
  and restores (§ 2: node switching is covered, not only tabs). The remembered tab moved into the same
  store and key.
- **`gridResultCache.ts`** — the bounded cache of display order below, which § 5 said would be
  reconsidered only on a measurement. It was.
- **D-105** records the keying and the cache; D-104 and `R210-grid-grouping.md` are annotated in
  place where they called the reset a known limitation. `FINDINGS.md` gains one entry (below).

### § 3's mechanism, verified — and worse than asked

The plan asked whether name ids survive a splice and a full reparse. Read from
`documentSession.ts`, `subtreeSplice.ts` and `parseClient.ts`:

- **Every edit replaces `document.store` and `document.sourceBuffer`.** A splice builds a new
  `NodeStore` from the old one's buffers; `applyEdit` builds a new `SourceBuffer`. So **nothing
  keyed by either object's identity survives one keystroke** — and R211's remembered tab was a
  `WeakMap<NodeStore, number>`. Typing in Raw has been snapping the tabs back to the first group
  since R211 shipped. Now asserted: a new store for the same file keeps the tab.
- **A splice keeps the `Interner`** (`request.interner`), so ids survive it. **A full reparse builds
  a new one** in the worker (`Interner.fromBuffers`), and an id can differ for the same name — the
  test builds that case explicitly and asserts the ids differ before asserting the sort survives.
- So the keying followed (acceptance 10): **tab and path for the document, text for names**, and a
  mounted grid is also keyed by its interner, remounting across a full reparse rather than holding
  ids that may now name other columns.

### § 5's measurement, and the cache it led to

Built application, `electron .` via Playwright, Windows 11, 1280×800. Each figure runs from clicking
the tab to two animation frames after the grid committed, so it includes up to ~33 ms of frame
alignment. Fixtures are `spike/fixtures/cars-*.xml` with two `<dealer>` elements appended, so the
node has a second group to switch to. Median of 5 runs (10 MB) or 3 (200 MB).

| Switch back to `car` | 10 MB, re-derived | 10 MB, cached | 200 MB, re-derived | 200 MB, cached |
|---|---|---|---|---|
| no sort, no filter | 88 ms | 101 ms | 490 ms | 478 ms |
| sorted by `year` | 149 ms | 101 ms | **1,397 ms** | 572 ms |
| sorted + quick filter `Golf` | 353 ms | 93 ms | **6,965 ms** | 519 ms |

**The 200 MB figures were too slow**: a frozen window for seven seconds after clicking a tab. The
filter pass is the bulk of it — typing `Golf` into the same table takes **5,854 ms** after the
debounce, so restoring was paying exactly what typing had. Reported rather than shipped; the project
lead chose a bounded cache of results, the option this plan's § 7 had rejected in its unbounded
per-group form:

- **Display order only, 4 bytes per visible row** (`Int32Array`): 2.5 MB for this fixture, 8 MB for
  a two-million-row group. The filter's document-order result is recovered by a numeric sort of the
  same indices rather than stored twice.
- **At most two entries; once a grid mounts, at most one belongs to a grid not on screen.** One slot
  was the proposal, and would not have worked: it always holds the grid just left, never the one
  being returned to, so flipping between two sorted groups never hits. Two, with the rule enforced
  at mount, is one extra group's order — 16 MB worst case only while Detail shows no table at all.
- **Only a grid with a sort or a filter leaves an entry**; the no-state row above is column
  collection and mounting, which the cache does not and need not touch.
- **Exact**: store, buffer, node, group, sort, extra columns and the *committed* filters must all
  match. A filter inside its debounce misses, and an edit misses.
- **Weak references to the store and buffer**, so a cache entry never keeps a superseded document
  alive.

**Nothing else stored is sized by row count** (acceptance 7), asserted on the stored shape of a
20,000-row group. The cache is the one exception, and its size is asserted in bytes.

**Not addressed, and the cause of the slow row**: the filter pass itself. 5.9 s per commit on the
200 MB fixture, uncancellable, and paid again after any pause in typing longer than the 200 ms
debounce. R213 stops a tab switch from paying it twice; it does not make typing a filter faster.

### What the review and the tests found

- **Widths were reset on every edit**, not only on a group change: the effect clearing them listed
  `store` and `members`, which every edit replaces. Found by reading the code while removing it —
  not reproduced in the application — and gone, since a different group or node is now a different,
  keyed grid.
- **The column-follow effect re-ran when the pinned-column count settled** after the first viewport
  measurement, scrolling a restored horizontal offset away before the user touched anything. Both
  follow effects now wait until the active cell moves. The test for it passed without the fix at
  first — the active cell was in the pinned column, where the effect returns early — and was
  rewritten until it failed without the fix.
- **A pending export prompt outlived its grid.** It lives in the notification stack, so after a
  switch its "Copy Anyway" reached a grid with nothing pending and did nothing. Dismissed with its grid.
- **Reading the active tab inside `DetailContent` keyed its first two renders differently**: the
  first tab is minted lazily by whichever code first reads the active session, which can be the grid
  mounting below. Found because R211's "clicking a tab swaps the table" failed when run alone and
  passed in its file. `Detail` passes the tab in.
- **A literal NUL byte** reached `gridViewState.ts` through a `\u0000` separator written by an
  editing tool, which made git treat the file as binary. Replaced with `|`.
- **Mutation checks**: disabling restore fails 9 of the view-state tests; a cache lookup that never
  matches fails both reuse tests; storing the sorted order as the filter's result fails the unsort
  test; the column-follow and export-prompt fixes each fail their test when reverted.

### Acceptance

1. **Met** — sort, switch, back: same column and direction, same rows.
2. **Met** — pins, a resized width and a column-picker extra column survive, each asserted.
3. **Met** — sorting `book` leaves `magazine` unsorted.
4. **Met, both ways** — the filter is kept on its node and is not carried to the sibling shelf, which
   does get the shared sort.
5. **Met** — a sort and pin on `isbn` render nothing on the shelf without it, and come back on the
   shelf with it after a pin was changed in between.
6. **Met** — the column picker comes back closed, and a pending export prompt is dismissed.
7. **Met** — asserted on shape; the cache is the stated exception.
8. **Met** — `Copy Grid as CSV` after a round trip exports the restored filter and order.
9. **Met, and it changed the design** — the table above.
10. **Met** — the section above; the keying followed from it.
11. **Met** — `npm test` 2,201 passing, 5 skipped; typecheck and lint clean (lint's three warnings
    are the existing incompatible-library ones).

### Version

Asked on landing.
